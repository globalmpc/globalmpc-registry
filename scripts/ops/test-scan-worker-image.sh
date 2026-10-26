#!/bin/bash
# Explicit network/Docker smoke test: downloads real official signatures into an isolated volume.
# Build first: docker build -f docker/Dockerfile.workers --build-arg WORKER=scan-worker -t mpc/scan-worker:local .
set -euo pipefail
image=${1:-mpc/scan-worker:local}
name="registry-readiness-scan-$$"
volume="$name-signatures"
scratch="$name-scratch"
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  docker volume rm "$scratch" >/dev/null 2>&1 || true
}
trap cleanup EXIT
# Missing system trust roots caused freshclam error 77 despite all stub lifecycle tests passing.
docker run --rm --entrypoint sh "$image" -ec 'test -s /etc/ssl/certs/ca-certificates.crt'
# Node and freshclam use different trust stores. Neither may retain the three roots
# removed by NSS 3.131.1; the unaffected emSign G1 root must remain usable.
docker run --rm --entrypoint node "$image" --input-type=module -e '
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {X509Certificate} from "node:crypto";
import {rootCertificates} from "node:tls";
const system=readFileSync("/etc/ssl/certs/ca-certificates.crt","utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
assert.ok(system?.length);
for(const certificates of [system,rootCertificates]) {
  const names=certificates.flatMap(pem=>new X509Certificate(pem).subject.split("\n"));
  for(const removed of ["emSign ECC Root CA - G3","emSign Root CA - C1","emSign ECC Root CA - C3"]) {
    assert.ok(!names.includes(`CN=${removed}`),`Distrusted root retained: ${removed}`);
  }
  assert.ok(names.includes("CN=emSign Root CA - G1"),"Unaffected G1 root was removed");
}
'
docker run -d --name "$name" --init --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m,mode=1777 \
  --mount "type=volume,source=$volume,target=/var/lib/clamav" \
  --mount "type=volume,source=$scratch,target=/var/tmp/clamav" \
  --cap-drop ALL --security-opt no-new-privileges:true \
  "$image" node -e 'require("node:fs").writeFileSync("/tmp/smoke-worker-ready", "ready"); setInterval(()=>{},1000)' >/dev/null
ready=false
for ((attempt=0; attempt<300; attempt++)); do
  if [[ "$(docker inspect --format '{{.State.Running}}' "$name")" != true ]]; then
    docker logs "$name" >&2
    echo 'Image exited before signature bootstrap/readiness completed.' >&2
    exit 1
  fi
  if docker exec "$name" test -f /tmp/smoke-worker-ready >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  docker logs "$name" >&2
  echo 'Official signature bootstrap timed out after 300 seconds; check network/CDN access.' >&2
  exit 1
fi
docker exec "$name" node --import tsx --input-type=module -e '
import assert from "node:assert/strict";
import {scanBytes} from "./src/scanner.ts";
const options={host:"127.0.0.1",port:3310,timeoutMs:30000,chunkBytes:65536};
assert.equal((await scanBytes(Buffer.from("plain harmless document"),options)).kind,"clean");
const eicar=Buffer.from("WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FSLVNUQU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCo=","base64");
const verdict=await scanBytes(eicar,options);
assert.equal(verdict.kind,"infected");
assert.match(verdict.signature,/Eicar/i);
// Exercise the actual worker client and its normal 30-second timeout as well.
assert.equal((await scanBytes(Buffer.alloc(300*1024*1024,65),options)).kind,"clean");
'
# INSTREAM writes the complete input to the configured scratch directory. This exceeds
# the unchanged 256 MiB /tmp tmpfs and catches accidentally moving scratch back there.
docker exec "$name" node --input-type=module -e '
import assert from "node:assert/strict";
import {connect} from "node:net";
import {once} from "node:events";
const socket=connect({host:"127.0.0.1",port:3310});
socket.setTimeout(120000,()=>socket.destroy(new Error("Large scan timed out")));
let response="";
socket.on("data",data=>{response+=data.toString();});
const completed=once(socket,"end");
await once(socket,"connect");
socket.write("zINSTREAM\0");
const frame=Buffer.alloc(1024*1024+4,65);
frame.writeUInt32BE(1024*1024,0);
for(let mib=0;mib<300;mib++) {
  if(!socket.write(frame)) await once(socket,"drain");
}
socket.write(Buffer.alloc(4));
await completed;
assert.equal(response.replace(/\0+$/,""),"stream: OK");
'
# The real updater, rather than a stub, is a required supervised child.
docker exec "$name" sh -c 'kill -TERM $(pgrep -x freshclam)'
for ((attempt=0; attempt<100; attempt++)); do
  [[ "$(docker inspect --format '{{.State.Running}}' "$name")" == true ]] || break
  sleep 0.1
done
[[ "$(docker inspect --format '{{.State.Running}}' "$name")" == false ]]
[[ "$(docker inspect --format '{{.State.ExitCode}}' "$name")" != 0 ]]
echo 'scan-worker image: official HTTPS bootstrap, clean/EICAR/300 MiB scan, and updater failure passed'
