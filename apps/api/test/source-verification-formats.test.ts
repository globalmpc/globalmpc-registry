import { generateKeyPairSync } from "node:crypto";
import { expect, it } from "vitest";
import {
  extractObservedFields,
  MAX_BULK_EXTRACT_BYTES,
  verifyDetachedSignature,
} from "../src/services/source-verification.js";
const bytes = (s: string) => Buffer.from(s, "utf8");
it("reads only the first JSON record's fields so later records cannot conceal a removed column", () => {
  expect(
    extractObservedFields(
      bytes('[{"license":"a"},{"license":"b","removed":"false assurance"}]'),
      "application/json",
    ),
  ).toEqual({ ok: true, fields: ["license"] });
  expect(
    extractObservedFields(
      bytes('{"license":"a","issuer":"office"}'),
      "application/json; charset=utf-8",
    ),
  ).toEqual({ ok: true, fields: ["license", "issuer"] });
});
it.each(["{invalid", "null", "[]", "[[1]]", '"text"'])(
  "refuses a JSON export without a readable record (%s)",
  (source) => {
    const result = extractObservedFields(bytes(source), "application/json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/JSON|record object/);
      expect(result.nextAction).toBeTruthy();
    }
  },
);
it("handles CSV escaped quotes and refuses empty, oversized or headerless files", () => {
  expect(
    extractObservedFields(
      bytes('\ufeff"license, key","office ""name"""\n1,2'),
      "text/csv",
    ),
  ).toEqual({ ok: true, fields: ["license, key", 'office "name"'] });
  for (const content of [
    new Uint8Array(),
    bytes("\n \n"),
    bytes(",, "),
    new Uint8Array(MAX_BULK_EXTRACT_BYTES + 1),
  ])
    expect(extractObservedFields(content, "text/csv").ok).toBe(false);
  expect(extractObservedFields(bytes("pdf"), "application/pdf")).toMatchObject({
    ok: false,
  });
});
it("distinguishes unreadable public keys from malformed signature data", () => {
  expect(
    verifyDetachedSignature({
      bytes: bytes("document"),
      signature: bytes("signature"),
      publicKeyPem: "not a key",
    }),
  ).toMatchObject({ ok: false, signatureValid: null });
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeyPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  expect(
    verifyDetachedSignature({
      bytes: bytes("document"),
      signature: bytes("malformed"),
      publicKeyPem,
    }),
  ).toMatchObject({ ok: false, signatureValid: false });
});
