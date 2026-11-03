import { createECDH, createHmac, createPrivateKey, createPublicKey } from "node:crypto";

/**
 * The demo people every spec signs in as (WP7).
 *
 * Each is an account like any other: an email address it signs in with (an emailed code) and a
 * passkey as its second factor, plus a wallet that is **only a signing key** — nothing signs in
 * with it. The seed writes all three; `connectAs` uses the first two through the real screens and
 * the wallet only when a screen asks for a signature.
 *
 * **No key is in the repository.** `playwright.config.ts` generates the wallet keys on every run
 * and hands them down as `E2E_DEMO_ACCOUNT_KEYS` (workers re-read the config, so a value already
 * there is reused, never regenerated). The passkeys are derived from those keys, as the scan
 * service's token is (`scan-service-token.ts`): CI passes only that one variable from the seed
 * step to the Playwright shards, and a passkey generated per process would differ between the
 * seed that stores its public key and the spec whose authenticator signs. A key in the repository
 * would let anyone who knows it act as that role wherever the seed ran.
 */

export const DEMO_PEOPLE = [
  "Operator A",
  "Operator B",
  "Operator C",
  "Reader A",
  "Steward A",
  "Approver A",
  "Reviewer A",
  "Proposer A",
  "Voter A",
  "Publisher A",
] as const;

export type DemoPerson = (typeof DEMO_PEOPLE)[number];

/** `Operator A` → `operator-a@e2e.example` — the address the seed gives the account. */
export function demoEmail(label: string): string {
  return `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@e2e.example`;
}

/** A passkey: the credential id (base64url), its PKCS#8 private key (base64) and public point. */
export interface DemoPasskey {
  readonly credentialId: string;
  readonly privateKey: string;
  readonly x: string;
  readonly y: string;
}

/**
 * `label`'s passkey, derived from the run's wallet keys: the same in every process of one run, new
 * on every run. The P-256 scalar is an HMAC of the keys; the rare value outside the curve order is
 * skipped by counting on.
 */
export function demoPasskey(label: string, env: NodeJS.ProcessEnv = process.env): DemoPasskey {
  const keys = env["E2E_DEMO_ACCOUNT_KEYS"];
  if (!keys) throw new Error("E2E_DEMO_ACCOUNT_KEYS is unset. Run through playwright.config.ts.");
  if (!(label in (JSON.parse(keys) as Record<string, string>))) {
    throw new Error(`E2E_DEMO_ACCOUNT_KEYS has no "${label}".`);
  }
  const derive = (purpose: string) =>
    createHmac("sha256", keys).update(`mpc/e2e/passkey/v1/${purpose}/${label}`).digest();
  for (let attempt = 0; ; attempt += 1) {
    const scalar = derive(`key/${attempt}`);
    const ecdh = createECDH("prime256v1");
    try {
      ecdh.setPrivateKey(scalar);
    } catch {
      continue;
    }
    const point = ecdh.getPublicKey();
    const jwk = {
      kty: "EC",
      crv: "P-256",
      d: scalar.toString("base64url"),
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33, 65).toString("base64url"),
    };
    const privateKey = createPrivateKey({ key: jwk, format: "jwk" });
    return {
      credentialId: derive("credential").toString("base64url"),
      privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
      x: jwk.x,
      y: jwk.y,
    };
  }
}

function fromEnv<T>(name: string): Readonly<Record<string, T>> {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is unset. Run through playwright.config.ts.`);
  return JSON.parse(raw) as Record<string, T>;
}

/** The wallet key of `label` — a signing key bound to the account, never a sign-in. */
export function demoWalletKey(label: string): `0x${string}` {
  const key = fromEnv<string>("E2E_DEMO_ACCOUNT_KEYS")[label];
  if (!key) throw new Error(`E2E_DEMO_ACCOUNT_KEYS has no "${label}".`);
  return key as `0x${string}`;
}

/**
 * The passkey's public key as the authenticator would have returned it at registration: a COSE
 * EC2 key (RFC 9053) — kty EC2, alg ES256, crv P-256, x, y.
 */
export function cosePublicKey(passkey: DemoPasskey): Buffer {
  const x = Buffer.from(passkey.x, "base64url");
  const y = Buffer.from(passkey.y, "base64url");
  if (x.length !== 32 || y.length !== 32) throw new Error("not a P-256 point");
  // The pair must be the private key's: a mismatch would only show as a refused passkey.
  const derived = createPublicKey(
    createPrivateKey({ key: Buffer.from(passkey.privateKey, "base64"), format: "der", type: "pkcs8" }),
  ).export({ format: "jwk" }) as { x: string; y: string };
  if (derived.x !== passkey.x || derived.y !== passkey.y) throw new Error("passkey key pair mismatch");
  return Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    x,
    Buffer.from([0x22, 0x58, 0x20]),
    y,
  ]);
}
