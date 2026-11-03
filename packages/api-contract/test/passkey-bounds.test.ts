import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { passkeyAuthenticationRequest } from "../src/mfa.js";

const b64 = (bytes: number) => randomBytes(bytes).toString("base64url");

/**
 * Every signature a passkey of an offered algorithm produces must fit the request bound, or the
 * passkey is enrolled and then refused at every sign-in. ES256 ≈ 72 bytes, RS256 256, ML-DSA-44
 * 2420 (FIPS 204), which `@simplewebauthn/server` offers first on runtimes with PQC support.
 */
it.each([
  ["ES256", 72],
  ["RS256", 256],
  ["ML-DSA-44", 2420],
])("accepts a %s passkey assertion", (_algorithm, signatureBytes) => {
  const parsed = passkeyAuthenticationRequest.safeParse({
    response: {
      id: b64(32),
      rawId: b64(32),
      type: "public-key",
      response: {
        clientDataJSON: b64(200),
        authenticatorData: b64(37),
        signature: b64(signatureBytes),
        userHandle: b64(16),
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    },
  });
  expect(parsed.success).toBe(true);
});

it("still bounds the signature", () => {
  const parsed = passkeyAuthenticationRequest.safeParse({
    response: {
      id: b64(32),
      rawId: b64(32),
      type: "public-key",
      response: { clientDataJSON: b64(200), authenticatorData: b64(37), signature: b64(4000) },
      clientExtensionResults: {},
    },
  });
  expect(parsed.success).toBe(false);
});
