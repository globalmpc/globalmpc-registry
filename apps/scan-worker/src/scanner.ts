/**
 * Virus scan — spec 05 §5.2, 06 §6.7.
 *
 * Uploads enter quarantine and are promoted to evidence only after passing the scan. Until now
 * that "scan" was a person entering the result — quarantine was a formality.
 *
 * **The scan does not run in the API process.** If infected files passed through API memory,
 * the process receiving uploads would also be the one handling scan targets. A separate worker
 * reads the quarantine object, hands it to ClamAV, and writes only the result to the DB.
 *
 * ClamAV uses the INSTREAM protocol:
 *
 *   zINSTREAM\0  → <4-byte length><chunk>... → <4-byte 0> → "stream: OK\0" or
 *                                               "stream: <signature name> FOUND\0"
 *
 * The `z` prefix means "command is null-terminated". **No space between the prefix and the
 * command** — ClamAV answers `UNKNOWN COMMAND`.
 */

import { connect, type Socket } from "node:net";

export type ScanVerdict =
  | { readonly kind: "clean" }
  /** Infected. `signature` is what matched — needed to check false positives. */
  | { readonly kind: "infected"; readonly signature: string }
  /** The scan itself failed. **Distinct from infected** — a scanner outage must not be recorded as infected. */
  | { readonly kind: "error"; readonly reason: string; readonly unavailable?: true };

export interface ScannerOptions {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs: number;
  /** INSTREAM chunk size. Must be smaller than ClamAV's default StreamMaxLength. */
  readonly chunkBytes: number;
}

export const DEFAULT_SCANNER_OPTIONS: Omit<ScannerOptions, "host" | "port"> = {
  timeoutMs: 30_000,
  chunkBytes: 64 * 1024,
};

/** Match the multipart API limit and the configured ClamAV 2000M inspection limit. */
export const MAX_SCAN_BYTES = 2000 * 1024 * 1024;
const MAX_SCAN_DEADLINE_MS = 10 * 60 * 1000;

/** A single absolute budget, allowing 8 MiB/s plus the configured processing allowance. */
export function scanDeadlineMs(byteSize: number, baseTimeoutMs = DEFAULT_SCANNER_OPTIONS.timeoutMs): number {
  if (!Number.isSafeInteger(byteSize) || byteSize < 0 || byteSize > MAX_SCAN_BYTES
    || !Number.isFinite(baseTimeoutMs) || baseTimeoutMs <= 0) throw new RangeError("Invalid scan size or timeout");
  return Math.min(MAX_SCAN_DEADLINE_MS, baseTimeoutMs + Math.ceil(byteSize / (1024 * 1024)) * 125);
}

/**
 * Turns a ClamAV response into a verdict.
 *
 * Kept free of IO because the three branches — infected, clean, error — are the core of this
 * code, and a real daemon makes an infected response hard to reproduce (it needs an EICAR file
 * and depends on signature DB updates).
 */
export function parseClamResponse(raw: string): ScanVerdict {
  const line = raw.replace(/\0+$/, "").trim();

  if (line === "stream: OK") return { kind: "clean" };

  // Every FOUND is infected, including `Heuristics.*`. The encrypted-archive and scan-limit
  // alerts arrive this way — a file clamd could not look inside must not be promoted.
  const found = /^stream:\s*(.+?)\s+FOUND$/.exec(line);
  if (found) return { kind: "infected", signature: found[1]! };

  // Anything ending in ERROR or in an unknown format is an error. Passing an undecided result
  // as clean is the same as having no scan.
  return { kind: "error", reason: line || "empty response" };
}

/** ClamAV INSTREAM frame. 4-byte big-endian length + payload. */
function frame(chunk: Uint8Array): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(chunk.byteLength, 0);
  return Buffer.concat([header, Buffer.from(chunk)]);
}

export function scanBytes(bytes: Uint8Array, options: ScannerOptions): Promise<ScanVerdict> {
  if (bytes.byteLength > MAX_SCAN_BYTES) return Promise.resolve({ kind: "error", reason: "file exceeds scanner size limit" });
  const timeoutMs = scanDeadlineMs(bytes.byteLength, options.timeoutMs);
  return new Promise((resolve) => {
    let settled = false;
    let connected = false;
    const transportError = (reason: string): ScanVerdict => ({
      kind: "error", reason, ...(!connected ? { unavailable: true as const } : {}),
    });
    const finish = (verdict: ScanVerdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(verdict);
    };

    const socket: Socket = connect({ host: options.host, port: options.port });
    socket.setTimeout(timeoutMs);
    // An idle timeout alone lets a faulty peer retain the worker indefinitely by dripping data.
    const deadline = setTimeout(() => finish(transportError("scan timeout")), timeoutMs);

    const chunks: Buffer[] = [];
    let responseBytes = 0;

    let offset = 0;
    let terminated = false;
    const writeChunks = () => {
      if (settled || terminated) return;
      while (offset < bytes.byteLength) {
        const chunk = frame(bytes.subarray(offset, offset + options.chunkBytes));
        offset += options.chunkBytes;
        // Keep at most the socket's bounded write buffer, rather than copying a 2 GiB upload
        // into queued frames before the event loop can enforce its absolute deadline.
        if (!socket.write(chunk)) return;
      }
      terminated = true;
      socket.write(Buffer.alloc(4));
    };
    socket.on("drain", writeChunks);
    socket.on("connect", () => {
      connected = true;
      socket.write("zINSTREAM\0");
      writeChunks();
    });

    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      responseBytes += chunk.byteLength;
      if (responseBytes > 4096) {
        finish({ kind: "error", reason: "scanner response exceeds 4096 bytes" });
        return;
      }
      chunks.push(chunk);
    });
    socket.on("end", () => finish(parseClamResponse(Buffer.concat(chunks).toString("utf8"))));

    // Timeouts and connection failures are not infections. Marking every upload infected while
    // the scanner is down would mass-produce irreversible states.
    socket.on("timeout", () => finish(transportError("scan timeout")));
    socket.on("error", (error) => finish(transportError(error.message)));
  });
}

/** Probe before leasing an upload: infrastructure downtime must not spend its retry budget. */
export function scannerAvailable(options: Pick<ScannerOptions, "host" | "port" | "timeoutMs">): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect({ host: options.host, port: options.port });
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(available);
    };
    const deadline = setTimeout(() => finish(false), options.timeoutMs);
    socket.setTimeout(options.timeoutMs);
    const chunks: Buffer[] = [];
    let responseBytes = 0;
    const complete = () => finish(Buffer.concat(chunks).toString("utf8").replace(/\0+$/, "").trim() === "PONG");
    socket.on("connect", () => socket.write("zPING\0"));
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      responseBytes += chunk.byteLength;
      if (responseBytes > 4096) { finish(false); return; }
      chunks.push(chunk);
      if (chunk.includes(0) || chunk.includes(10)) complete();
    });
    socket.on("end", complete);
    socket.on("timeout", () => finish(false));
    socket.on("error", () => finish(false));
  });
}
