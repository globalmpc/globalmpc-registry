import { keccak_256 } from "@noble/hashes/sha3";

/** 0x-prefixed lowercase hex. Every hash leaving this package uses this format. */
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
    throw new Error(`Odd hex length: ${hex}`);
  }
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const parsed = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(parsed)) {
      throw new Error(`Not hex: ${hex}`);
    }
    out[i] = parsed;
  }
  return out;
}

export function keccak256(input: Uint8Array): Hex {
  return bytesToHex(keccak_256(input));
}

/** Checks for 32-byte hex. Every leaf, root, and proof entry must use this format. */
export function isBytes32(value: string): value is Hex {
  return /^0x[0-9a-f]{64}$/.test(value);
}

export function assertBytes32(value: string, label: string): asserts value is Hex {
  if (!isBytes32(value)) {
    throw new Error(`${label} must be 32-byte lowercase hex: ${value}`);
  }
}
