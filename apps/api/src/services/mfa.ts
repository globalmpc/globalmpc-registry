import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { Secret, TOTP } from "otpauth";

/**
 * Second-factor primitives — WP3. No I/O here: storage and the rules about who may do what are
 * the database's (migrations 0115–0117) and the routes' (`routes/mfa.ts`).
 */

/**
 * HKDF `info` for the TOTP secret key (plan D10). The raw `SESSION_SECRET` is never a key; each
 * purpose gets its own derived key, so one purpose's key says nothing about another's.
 */
export const TOTP_SECRET_KEY_INFO = "mpc/totp-secret/v1";
/** Bumped with the key derivation; stored per row so a future rotation can tell rows apart. */
export const TOTP_KEY_VERSION = 1;

/** RFC 6238 defaults every authenticator app supports. Changing them strands every enrolment. */
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const TOTP_ALGORITHM = "SHA1";
const TOTP_SECRET_BYTES = 20;
/** Steps either side of now that are accepted: ±30 s of clock drift. */
export const TOTP_WINDOW_STEPS = 1;

export const TOTP_ISSUER = "MPC Registry";

export function deriveTotpKey(sessionSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", sessionSecret, Buffer.alloc(0), TOTP_SECRET_KEY_INFO, 32));
}

/**
 * Binds a ciphertext to its row and subject (GCM additional data). A ciphertext copied onto
 * another subject's row fails authentication instead of yielding that subject a known secret.
 */
function totpAad(totpId: string, subjectId: string): Buffer {
  return Buffer.from(`mpc/totp/${totpId}/${subjectId}`, "utf8");
}

export function encryptTotpSecret(
  key: Buffer,
  secret: Uint8Array,
  binding: { readonly totpId: string; readonly subjectId: string },
): { ciphertext: Buffer; nonce: Buffer } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(totpAad(binding.totpId, binding.subjectId));
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final(), cipher.getAuthTag()]);
  return { ciphertext, nonce };
}

/** Throws when the key, the binding or the bytes are not the ones it was encrypted with. */
export function decryptTotpSecret(
  key: Buffer,
  sealed: { readonly ciphertext: Uint8Array; readonly nonce: Uint8Array },
  binding: { readonly totpId: string; readonly subjectId: string },
): Uint8Array {
  const body = Buffer.from(sealed.ciphertext);
  const tag = body.subarray(body.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.nonce));
  decipher.setAAD(totpAad(binding.totpId, binding.subjectId));
  decipher.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]));
}

export function newTotpSecret(): Uint8Array {
  return new Uint8Array(randomBytes(TOTP_SECRET_BYTES));
}

function totpFor(secret: Uint8Array, label = "account"): TOTP {
  return new TOTP({
    issuer: TOTP_ISSUER,
    label,
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    secret: new Secret({ buffer: secret.slice().buffer }),
  });
}

/** The `otpauth://` URI and the base32 secret an authenticator app takes. Shown once, at setup. */
export function totpProvisioning(secret: Uint8Array, label: string): { uri: string; base32: string } {
  const totp = totpFor(secret, label);
  return { uri: totp.toString(), base32: totp.secret.base32 };
}

/**
 * The 30-second step a code is valid for, within ±1 step of `now`, or null. The step — not just
 * "valid" — is what the database records, so the same code (or an older one) is refused after.
 */
export function matchTotpStep(secret: Uint8Array, code: string, now = Date.now()): number | null {
  const delta = totpFor(secret).validate({ token: code, timestamp: now, window: TOTP_WINDOW_STEPS });
  if (delta === null) return null;
  return TOTP.counter({ period: TOTP_PERIOD_SECONDS, timestamp: now }) + delta;
}

/** A code for a step — tests and nothing else need to produce one. */
export function totpCodeAt(secret: Uint8Array, timestamp: number): string {
  return totpFor(secret).generate({ timestamp });
}

// --- Recovery codes ----------------------------------------------------------

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const RECOVERY_CODE_COUNT = 10;
/** 16 base32 characters = 80 bits: a plain hash is enough (plan D10), no key to rotate. */
const RECOVERY_CODE_LENGTH = 16;

function randomBase32(length: number): string {
  // 256 is a multiple of 32, so taking the low five bits of each byte is unbiased.
  return [...randomBytes(length)].map((byte) => BASE32[byte & 31]).join("");
}

/** `ABCD-EFGH-JKLM-NPQR`: grouped for reading off paper. */
export function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () =>
    randomBase32(RECOVERY_CODE_LENGTH).match(/.{4}/g)!.join("-"),
  );
}

/** Case and dashes do not matter to the holder; the hash is of the bare upper-case code. */
export function normalizeRecoveryCode(input: string): string | null {
  const bare = input.replace(/-/g, "").toUpperCase();
  return new RegExp(`^[${BASE32}]{${RECOVERY_CODE_LENGTH}}$`).test(bare) ? bare : null;
}

export function hashRecoveryCode(code: string): string {
  const bare = normalizeRecoveryCode(code);
  if (bare === null) throw new Error("not a recovery code");
  return createHash("sha256").update(bare, "utf8").digest("hex");
}
