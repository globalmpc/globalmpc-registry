import { keccak_256 } from "@noble/hashes/sha3";

/** 0x 접두 소문자 hex. 이 패키지 밖으로 나가는 모든 해시는 이 형식이다. */
export type Hex = `0x${string}`;

const HEX_CHARS = "0123456789abcdef";

export function bytesToHex(bytes: Uint8Array): Hex {
  let out = "0x";
  for (const byte of bytes) {
    out += HEX_CHARS[byte >> 4]! + HEX_CHARS[byte & 0x0f]!;
  }
  return out as Hex;
}

export function hexToBytes(hex: string): Uint8Array {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (body.length % 2 !== 0) {
    throw new Error(`hex 길이가 홀수다: ${hex}`);
  }
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const parsed = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(parsed)) {
      throw new Error(`hex가 아니다: ${hex}`);
    }
    out[i] = parsed;
  }
  return out;
}

export function keccak256(input: Uint8Array): Hex {
  return bytesToHex(keccak_256(input));
}

/** 32바이트 hex인지 확인한다. leaf·root·proof 항목은 전부 이 형식이어야 한다. */
export function isBytes32(value: string): value is Hex {
  return /^0x[0-9a-f]{64}$/.test(value);
}

export function assertBytes32(value: string, label: string): asserts value is Hex {
  if (!isBytes32(value)) {
    throw new Error(`${label}은 32바이트 소문자 hex여야 한다: ${value}`);
  }
}
