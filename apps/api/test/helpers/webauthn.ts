import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";

/**
 * A software WebAuthn authenticator for tests — an ES256 (P-256) key made with node:crypto, and
 * the authenticator data, attestation object and assertion signature WebAuthn L3 defines.
 *
 * Nothing in the API is mocked: the responses this produces go through
 * `@simplewebauthn/server`'s real verification. Each knob below breaks exactly one property the
 * server must check (origin, RP ID, challenge, user verification, counter), so a test that
 * passes the knob shows that check refusing.
 */

const b64url = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString("base64url");
const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest();

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export interface CeremonyOverrides {
  /** The origin the "browser" reports. Default: the expected one. */
  readonly origin?: string;
  /** The RP ID whose hash goes into the authenticator data. Default: the options' RP ID. */
  readonly rpId?: string;
  /** The challenge echoed in clientDataJSON. Default: the options' challenge. */
  readonly challenge?: string;
  /** Whether the authenticator reports user verification. Default: true. */
  readonly userVerified?: boolean;
  /** The sign counter to report. Default: the authenticator's next value. */
  readonly counter?: number;
}

export class SoftAuthenticator {
  readonly credentialId = randomBytes(32);
  private readonly privateKey: KeyObject;
  private readonly publicJwk: { x: string; y: string };
  /** The last counter reported. `countFrom: null` keeps it at 0, as synced passkeys do. */
  private counter: number;

  constructor(
    private readonly defaults: { readonly origin: string; readonly rpId: string },
    options: { readonly countFrom?: number | null } = {},
  ) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    this.publicJwk = { x: jwk.x, y: jwk.y };
    this.counter = options.countFrom === null ? 0 : (options.countFrom ?? 0);
    this.counts = options.countFrom !== null;
  }

  private readonly counts: boolean;

  get id(): string {
    return b64url(this.credentialId);
  }

  private nextCounter(override?: number): number {
    if (override !== undefined) return override;
    if (!this.counts) return 0;
    this.counter += 1;
    return this.counter;
  }

  private cosePublicKey(): Uint8Array {
    return isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, new Uint8Array(Buffer.from(this.publicJwk.x, "base64url"))],
        [-3, new Uint8Array(Buffer.from(this.publicJwk.y, "base64url"))],
      ]),
    );
  }

  private authenticatorData(rpId: string, flags: number, counter: number, attested: boolean): Buffer {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(counter);
    const parts: Buffer[] = [sha256(rpId), Buffer.from([flags]), count];
    if (attested) {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), length, this.credentialId, Buffer.from(this.cosePublicKey()));
    }
    return Buffer.concat(parts);
  }

  private clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), "utf8");
  }

  /** A `RegistrationResponseJSON` for `navigator.credentials.create(options)`. */
  register(options: { challenge: string; rp?: { id?: string } }, overrides: CeremonyOverrides = {}) {
    const rpId = overrides.rpId ?? options.rp?.id ?? this.defaults.rpId;
    const flags = FLAG_UP | FLAG_AT | (overrides.userVerified === false ? 0 : FLAG_UV);
    const authData = this.authenticatorData(rpId, flags, this.counter, true);
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", new Uint8Array(authData)],
      ]) as never,
    );
    const clientDataJSON = this.clientData(
      "webauthn.create",
      overrides.challenge ?? options.challenge,
      overrides.origin ?? this.defaults.origin,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key" as const,
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform" as const,
    };
  }

  /** An `AuthenticationResponseJSON` for `navigator.credentials.get(options)`. */
  assert(options: { challenge: string; rpId?: string }, overrides: CeremonyOverrides = {}) {
    const rpId = overrides.rpId ?? options.rpId ?? this.defaults.rpId;
    const flags = FLAG_UP | (overrides.userVerified === false ? 0 : FLAG_UV);
    const authData = this.authenticatorData(rpId, flags, this.nextCounter(overrides.counter), false);
    const clientDataJSON = this.clientData(
      "webauthn.get",
      overrides.challenge ?? options.challenge,
      overrides.origin ?? this.defaults.origin,
    );
    // ES256 over authenticatorData ‖ SHA-256(clientDataJSON), DER-encoded (WebAuthn §6.3.3).
    const signature = sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), this.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key" as const,
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
      },
      clientExtensionResults: {},
    };
  }
}

/** A base64url challenge that no server issued. */
export function strayChallenge(): string {
  return randomBytes(32).toString("base64url");
}
