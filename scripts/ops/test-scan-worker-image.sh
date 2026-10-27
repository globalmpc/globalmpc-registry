#!/bin/bash
# Explicit two-container Docker smoke test; downloads real official signatures.
# Build images first with docker/Dockerfile.workers (WORKER=scan-worker) and Dockerfile.clamav.
set -euo pipefail
worker_image=${1:-mpc/scan-worker:local}
scanner_image=${2:-mpc/clamav:local}
large_scan_mib=${LARGE_SCAN_MIB:-300}
if [[ ! "$large_scan_mib" =~ ^[0-9]+$ ]] || ((large_scan_mib < 257 || large_scan_mib > 2000)); then
  echo 'LARGE_SCAN_MIB must be between 257 and 2000.' >&2; exit 1
fi
name="registry-separated-scan-$$"
scanner="$name-clamav"
worker="$name-worker"
database="$name-database-fixture"
volume="$name-signatures"
scratch="$name-scratch"
scan_network="$name-private"
update_network="$name-updates"
app_network="$name-app"
mock_secrets=$(mktemp -d)
cleanup() {
  docker container rm --force "$worker" "$scanner" "$database" >/dev/null 2>&1 || true
  docker volume rm "$volume" "$scratch" >/dev/null 2>&1 || true
  docker network rm "$scan_network" "$update_network" "$app_network" >/dev/null 2>&1 || true
  rm -r -- "$mock_secrets"
}
trap cleanup EXIT
# Only deliberately fake credentials enter this drill. They are mounted solely in the worker.
chmod 755 "$mock_secrets"
for secret in worker_database_url object_secret_key scan_service_key; do
  printf 'isolated-smoke-%s\n' "$secret" > "$mock_secrets/$secret"
  chmod 444 "$mock_secrets/$secret"
done
# The worker must not carry parser binaries/configuration or scanner database mounts.
docker run --rm --entrypoint node "$worker_image" --input-type=module -e '
import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {X509Certificate} from "node:crypto";
import {rootCertificates} from "node:tls";
assert.notEqual(process.getuid(),0);
for(const path of ["/etc/clamav","/var/lib/clamav","/usr/sbin/clamd"]) assert.equal(existsSync(path),false,path);
const names=rootCertificates.flatMap(pem=>new X509Certificate(pem).subject.split("\n"));
for(const name of ["emSign ECC Root CA - G3","emSign Root CA - C1","emSign ECC Root CA - C3"]) {
  assert.ok(!names.includes(`CN=${name}`),`Distrusted Node root retained: ${name}`);
}
assert.ok(names.includes("CN=emSign Root CA - G1"));
'
# freshclam uses the OS trust bundle, so inspect that separately from Node's bundle.
docker run --rm --entrypoint node "$scanner_image" --input-type=module -e '
import assert from "node:assert/strict";
import {readFileSync,existsSync,statSync} from "node:fs";
import {X509Certificate} from "node:crypto";
assert.notEqual(process.getuid(),0);
assert.equal(existsSync("/app"),false);
assert.equal(existsSync("/repo"),false);
assert.equal(statSync("/var/tmp/clamav").mode&0o777,0o700);
const certificates=readFileSync("/etc/ssl/certs/ca-certificates.crt","utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
assert.ok(certificates?.length);
const names=certificates.flatMap(pem=>new X509Certificate(pem).subject.split("\n"));
for(const name of ["emSign ECC Root CA - G3","emSign Root CA - C1","emSign ECC Root CA - C3"]) {
  assert.ok(!names.includes(`CN=${name}`),`Distrusted system root retained: ${name}`);
}
assert.ok(names.includes("CN=emSign Root CA - G1"));
'
docker network create --internal "$scan_network" >/dev/null
docker network create "$update_network" >/dev/null
docker network create --internal "$app_network" >/dev/null
# An exclusive outbound network lets freshclam update without attaching the worker to it.
docker create --name "$scanner" --init --read-only \
  --network "$update_network" \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m,mode=1777 \
  --mount "type=volume,source=$volume,target=/var/lib/clamav" \
  --mount "type=volume,source=$scratch,target=/var/tmp/clamav" \
  --cap-drop ALL --security-opt no-new-privileges:true \
  "$scanner_image" >/dev/null
docker network connect --alias clamav "$scan_network" "$scanner"
docker start "$scanner" >/dev/null
ready=false
for ((attempt=0; attempt<300; attempt++)); do
  if [[ "$(docker inspect --format '{{.State.Running}}' "$scanner")" != true ]]; then
    docker logs "$scanner" >&2
    echo 'ClamAV exited before signature bootstrap/readiness completed.' >&2
    exit 1
  fi
  if docker exec "$scanner" /usr/local/bin/healthcheck.sh >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  docker logs "$scanner" >&2
  echo 'Official signature bootstrap timed out after 300 seconds; check network/CDN access.' >&2
  exit 1
fi
# A fixture database lives only on the app network; no real database is contacted.
docker run -d --name "$database" --init --read-only --network "$app_network" \
  --network-alias fixture-database --tmpfs /tmp:rw,noexec,nosuid,size=16m,mode=1777 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  "$worker_image" node -e 'require("node:net").createServer(socket=>socket.end("fixture database only\n")).listen(5432,"0.0.0.0",()=>require("node:fs").writeFileSync("/tmp/database-ready","ready"))' >/dev/null
for ((attempt=0; attempt<100; attempt++)); do
  if docker exec "$database" test -f /tmp/database-ready >/dev/null 2>&1; then break; fi
  sleep 0.05
done
docker exec "$database" test -f /tmp/database-ready
fixture_ip=$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$database")
docker run -d --name "$worker" --init --read-only --network "$scan_network" \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m,mode=1777 \
  --mount "type=bind,source=$mock_secrets,target=/run/secrets,readonly" \
  --env DATABASE_URL=file:/run/secrets/worker_database_url \
  --env OBJECT_SECRET_ACCESS_KEY=file:/run/secrets/object_secret_key \
  --env SCAN_SERVICE_PRIVATE_KEY=file:/run/secrets/scan_service_key \
  --cap-drop ALL --security-opt no-new-privileges:true \
  "$worker_image" node -e 'setInterval(()=>{},1000)' >/dev/null
docker network connect "$app_network" "$worker"
# Neither service uses a shared/host PID namespace or publishes a host port.
for container in "$scanner" "$worker"; do
  [[ -z "$(docker inspect --format '{{.HostConfig.PidMode}}' "$container")" ]]
  [[ "$(docker inspect --format '{{len .HostConfig.PortBindings}}' "$container")" == 0 ]]
  [[ "$(docker inspect --format '{{len .NetworkSettings.Networks}}' "$container")" == 2 ]]
done
# Positive control: the worker can reach the fixture on its separate app network.
docker exec "$worker" node --input-type=module -e '
import assert from "node:assert/strict";
import {connect} from "node:net";
const body=await new Promise((resolve,reject)=>{
  const socket=connect({host:"fixture-database",port:5432});
  let data="";
  socket.setTimeout(3000,()=>socket.destroy(new Error("Fixture database timed out")));
  socket.on("data",chunk=>{data+=chunk.toString();});
  socket.on("end",()=>resolve(data));
  socket.on("error",reject);
});
assert.equal(body,"fixture database only\n");
'
# Negative control by actual peer IP, so a DNS failure cannot hide cross-network access.
docker exec --env MOCK_DATABASE_IP="$fixture_ip" "$scanner" node --input-type=module -e '
import assert from "node:assert/strict";
import {connect} from "node:net";
const reached=await new Promise(resolve=>{
  const socket=connect({host:process.env.MOCK_DATABASE_IP,port:5432});
  const finish=value=>{socket.destroy();resolve(value);};
  socket.setTimeout(1000,()=>finish(false));
  socket.on("connect",()=>finish(true));
  socket.on("error",()=>finish(false));
});
assert.equal(reached,false,"scanner can reach the worker-only app network");
'
# Same numeric UID is not a shared process/filesystem namespace: only the worker sees credentials.
docker exec "$worker" node --input-type=module -e '
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
for(const [variable,file] of [["DATABASE_URL","worker_database_url"],["OBJECT_SECRET_ACCESS_KEY","object_secret_key"],["SCAN_SERVICE_PRIVATE_KEY","scan_service_key"]]) {
  assert.equal(process.env[variable],`file:/run/secrets/${file}`);
  assert.equal(readFileSync(`/run/secrets/${file}`,"utf8"),`isolated-smoke-${file}\n`);
}
'
docker exec --env WORKER_HOST_PID="$(docker inspect --format '{{.State.Pid}}' "$worker")" "$scanner" node --input-type=module -e '
import assert from "node:assert/strict";
import {existsSync,readdirSync,readFileSync} from "node:fs";
assert.equal(existsSync(`/proc/${process.env.WORKER_HOST_PID}`),false,"worker host PID is visible in scanner namespace");
for(const variable of ["DATABASE_URL","OBJECT_SECRET_ACCESS_KEY","SCAN_SERVICE_PRIVATE_KEY"]) assert.equal(process.env[variable],undefined);
for(const file of ["worker_database_url","object_secret_key","scan_service_key"]) assert.equal(existsSync(`/run/secrets/${file}`),false);
for(const pid of readdirSync("/proc").filter(value=>/^\d+$/.test(value))) {
  let environment;
  try { environment=readFileSync(`/proc/${pid}/environ`,"utf8"); } catch { continue; }
  assert.ok(!environment.includes("isolated-smoke-"),"worker credential crossed into scanner process namespace");
}
'
docker exec --env LARGE_SCAN_MIB="$large_scan_mib" "$worker" node --import tsx --input-type=module -e '
import assert from "node:assert/strict";
import {scanBytes,scanDeadlineMs,scannerAvailable} from "./src/scanner.ts";
const options={host:"clamav",port:3310,timeoutMs:30000,chunkBytes:65536};
assert.equal(await scannerAvailable({...options,timeoutMs:2000}),true);
assert.equal((await scanBytes(Buffer.from("plain harmless document"),options)).kind,"clean");
const eicar=Buffer.from("WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FSLVNUQU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCo=","base64");
const verdict=await scanBytes(eicar,options);
assert.equal(verdict.kind,"infected");
assert.match(verdict.signature,/Eicar/i);
// Use the real size-aware client; default 300 MiB exceeds tmpfs, max 2000 exercises the API limit.
const size=Number(process.env.LARGE_SCAN_MIB)*1024*1024;
assert.ok(scanDeadlineMs(size,options.timeoutMs)>options.timeoutMs);
assert.equal((await scanBytes(Buffer.alloc(size,65),options)).kind,"clean");
'
# The real updater remains a required scanner child. No worker process shares this namespace.
docker exec "$scanner" node --input-type=module -e '
import assert from "node:assert/strict";
import {readdirSync,readFileSync} from "node:fs";
const processes=readdirSync("/proc").filter(value=>/^\d+$/.test(value)).filter(pid=>{
  try { return readFileSync(`/proc/${pid}/comm`,"utf8").trim()==="freshclam"; } catch { return false; }
});
assert.equal(processes.length,1);
process.kill(Number(processes[0]),"SIGTERM");
'
for ((attempt=0; attempt<100; attempt++)); do
  [[ "$(docker inspect --format '{{.State.Running}}' "$scanner")" == true ]] || break
  sleep 0.1
done
[[ "$(docker inspect --format '{{.State.Running}}' "$scanner")" == false ]]
[[ "$(docker inspect --format '{{.State.ExitCode}}' "$scanner")" != 0 ]]
# Scanner loss is an error, never clean or infected, so uploads cannot be promoted.
docker exec "$worker" node --import tsx --input-type=module -e '
import assert from "node:assert/strict";
import {scanBytes,scannerAvailable} from "./src/scanner.ts";
assert.equal(await scannerAvailable({host:"clamav",port:3310,timeoutMs:2000}),false);
const verdict=await scanBytes(Buffer.from("plain harmless document"),{host:"clamav",port:3310,timeoutMs:3000,chunkBytes:65536});
assert.equal(verdict.kind,"error");
assert.ok(verdict.reason);
'
echo "Separated scanner images: official HTTPS bootstrap, credential isolation, clean/EICAR/$large_scan_mib MiB scan, updater failure and fail-closed client passed"
