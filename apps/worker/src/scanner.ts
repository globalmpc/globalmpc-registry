/**
 * 바이러스 검사 — spec 05 §5.2, 06 §6.7.
 *
 * 업로드는 quarantine에 들어가고 검사를 통과해야 evidence로 승격된다. 지금까지
 * 그 "검사"는 사람이 결과를 입력하는 것이었다 — quarantine이 형식만 남는다.
 *
 * **검사는 API 프로세스에서 하지 않는다.** 감염 파일이 API 메모리를 지나면
 * 업로드를 받는 프로세스가 곧 검사 대상을 다루는 프로세스가 된다. 별도 worker가
 * quarantine 객체를 읽어 ClamAV에 넘기고 결과만 DB에 쓴다.
 *
 * ClamAV는 INSTREAM 프로토콜을 쓴다:
 *
 *   zINSTREAM\0  → <4바이트 길이><청크>... → <4바이트 0> → "stream: OK\0" 또는
 *                                             "stream: <서명명> FOUND\0"
 *
 * `z` 접두사는 "명령이 null로 끝난다"는 뜻이다. **접두사와 명령 사이에 공백을
 * 넣으면 안 된다** — ClamAV가 `UNKNOWN COMMAND`로 답한다.
 */

import { connect, type Socket } from "node:net";

export type ScanVerdict =
  | { readonly kind: "clean" }
  /** 감염. `signature`는 무엇으로 판정했는지다 — 오탐 확인에 필요하다. */
  | { readonly kind: "infected"; readonly signature: string }
  /** 검사 자체가 실패. **감염과 구분한다** — 스캐너 장애를 감염으로 기록하면 안 된다. */
  | { readonly kind: "error"; readonly reason: string };

export interface ScannerOptions {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs: number;
  /** INSTREAM 청크 크기. ClamAV 기본 StreamMaxLength보다 작아야 한다. */
  readonly chunkBytes: number;
}

export const DEFAULT_SCANNER_OPTIONS: Omit<ScannerOptions, "host" | "port"> = {
  timeoutMs: 30_000,
  chunkBytes: 64 * 1024,
};

/**
 * ClamAV 응답을 판정으로 바꾼다.
 *
 * IO 없이 분리한 이유: 감염·정상·오류 세 갈래가 이 코드의 핵심인데, 실제
 * 데몬으로는 감염 응답을 재현하기 어렵다(EICAR 파일이 필요하고 DB 갱신에
 * 의존한다).
 */
export function parseClamResponse(raw: string): ScanVerdict {
  const line = raw.replace(/\0+$/, "").trim();

  if (line.endsWith("OK")) return { kind: "clean" };

  const found = /^stream:\s*(.+?)\s+FOUND$/.exec(line);
  if (found) return { kind: "infected", signature: found[1]! };

  // ERROR로 끝나거나 형식을 모르는 응답은 전부 오류다. 판정하지 못한 것을
  // 정상으로 넘기면 검사가 없는 것과 같아진다.
  return { kind: "error", reason: line || "empty response" };
}

/** ClamAV INSTREAM 프레임. 4바이트 big-endian 길이 + 본문. */
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

      // 길이 0 프레임이 스트림의 끝을 알린다.
      socket.write(Buffer.alloc(4));
    });

    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => finish(parseClamResponse(Buffer.concat(chunks).toString("utf8"))));

    // 타임아웃과 연결 실패는 감염이 아니다. 스캐너가 죽었을 때 모든 업로드를
    // 감염으로 표시하면 되돌릴 수 없는 상태가 대량으로 만들어진다.
    socket.on("timeout", () => finish({ kind: "error", reason: "scan timeout" }));
    socket.on("error", (error) => finish({ kind: "error", reason: error.message }));
  });
}
