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
  | { readonly kind: "error"; readonly reason: string };

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

/**
 * Turns a ClamAV response into a verdict.
 *
 * Kept free of IO because the three branches — infected, clean, error — are the core of this
 * code, and a real daemon makes an infected response hard to reproduce (it needs an EICAR file
 * and depends on signature DB updates).
 */
export function parseClamResponse(raw: string): ScanVerdict {
  const line = raw.replace(/\0+$/, "").trim();

  if (line.endsWith("OK")) return { kind: "clean" };

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
  return new Promise((resolve) => {
    let settled = false;
    const finish = (verdict: ScanVerdict) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(verdict);
    };

    const socket: Socket = connect({ host: options.host, port: options.port });
    socket.setTimeout(options.timeoutMs);

    const chunks: Buffer[] = [];

    socket.on("connect", () => {
      socket.write("zINSTREAM\0");

      for (let offset = 0; offset < bytes.byteLength; offset += options.chunkBytes) {
        socket.write(frame(bytes.subarray(offset, offset + options.chunkBytes)));
      }

      // A zero-length frame marks the end of the stream.
      socket.write(Buffer.alloc(4));
    });

    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => finish(parseClamResponse(Buffer.concat(chunks).toString("utf8"))));

    // Timeouts and connection failures are not infections. Marking every upload infected while
    // the scanner is down would mass-produce irreversible states.
    socket.on("timeout", () => finish({ kind: "error", reason: "scan timeout" }));
    socket.on("error", (error) => finish({ kind: "error", reason: error.message }));
  });
}
