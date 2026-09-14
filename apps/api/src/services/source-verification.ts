import { createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";

/**
 * Server-side basis for source confirmation — 2026-09-10 audit A1.
 *
 * What the audit found: when a person with `source.upload` created a receipt and
 * **sent `signatureValid: true` themselves**, the document was stored as `confirmed_from_source`.
 * Bulk export `observedFields` was also written by the requester. That is,
 * **the uploader's statement was promoted to an independent source verification result**.
 *
 * On that path confirmation meant not "we verified" but "the uploader said so". Source grade
 * is the product's core, so that difference defines what the whole product means.
 *
 * This file has **the server produce** the basis for confirmation. Two kinds:
 *
 * 1. Signed documents — verified from the uploaded bytes, a detached signature, and the public
 *    key registered on the connection.
 * 2. Bulk export — the field list is **extracted directly** from the uploaded file.
 *
 * Neither trusts values in the request body.
 */

/**
 * Verifier version.
 *
 * Stored with the confirmation basis. Bumped when verification rules change — if it cannot be
 * reproduced which rules confirmed a past receipt, that confirmation loses its basis.
 */
export const SIGNATURE_VERIFIER_VERSION = "sig-1";
export const BULK_EXTRACTOR_VERSION = "bulk-1";

/**
 * Cap on what is loaded into memory to extract fields.
 *
 * Differs from the upload cap (2 GiB). The whole file is loaded as a string here, so it must
 * be much smaller. Over the cap nothing is confirmed and it goes to a person — silently reading
 * only the head would judge later columns as missing.
 */
export const MAX_BULK_EXTRACT_BYTES = 32 * 1024 * 1024;

export type VerificationFailure = {
  readonly ok: false;
  readonly reason: string;
  readonly nextAction: string;
};

export type SignatureCheck =
  | {
      readonly ok: true;
      /** The signature verified with this key. */
      readonly signatureValid: true;
      readonly keyType: string;
      readonly algorithm: string | null;
    }
  | (VerificationFailure & {
      /** false means verification failed; null means verification could not be attempted. */
      readonly signatureValid: false | null;
    });

/**
 * Verifies a detached signature with a public key.
 *
 * **The requester does not choose the algorithm.** The key type decides it —
 * Ed25519 takes no separate hash (hence `null`); RSA and EC use SHA-256.
 * If the requester could choose, picking a weak combination would bypass verification.
 */
export function verifyDetachedSignature(input: {
  readonly bytes: Uint8Array;
  readonly signature: Uint8Array;
  readonly publicKeyPem: string;
}): SignatureCheck {
  let key: KeyObject;
  try {
    key = createPublicKey(input.publicKeyPem);
  } catch {
    // Failing to read the key differs from a wrong signature. The former is our config problem.
    return {
      ok: false,
      signatureValid: null,
      reason: "Could not read the public key registered on the connection",
      nextAction: "Check the PEM public key that the connection's signing_key_reference points to",
    };
  }

  const keyType = key.asymmetricKeyType ?? "unknown";
  // Ed25519 and Ed448 take no algorithm argument. Passing one makes verification throw.
  const algorithm = keyType === "ed25519" || keyType === "ed448" ? null : "sha256";

  let valid: boolean;
  try {
    valid = cryptoVerify(algorithm, input.bytes, key, input.signature);
  } catch {
    // Signature bytes that do not fit the format land here. Treated as verification failure —
    // a signature we cannot verify is the same as none.
    return {
      ok: false,
      signatureValid: false,
      reason: "Could not verify the signature",
      nextAction: "Check that the signature file is a detached signature for this document",
    };
  }

  if (!valid) {
    return {
      ok: false,
      signatureValid: false,
      reason: "The signature does not match the document",
      nextAction: "Check whether the document was altered or signed by a different signer",
    };
  }

  return { ok: true, signatureValid: true, keyType, algorithm };
}

export type FieldExtraction =
  | { readonly ok: true; readonly fields: readonly string[] }
  | VerificationFailure;

/** A UTF-8 BOM attaches invisibly to the first column name. */
function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

/**
 * Splits one CSV header line into column names.
 *
 * Preserves commas inside quotes. Only the header is read, so there is no full CSV parser —
 * body parsing is not needed for this verdict, and code that does not exist cannot be wrong.
 */
function parseCsvHeader(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;

    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      fields.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  fields.push(current.trim());
  return fields;
}

/**
 * Extracts the fields observed in the file.
 *
 * **The list sent by the requester is not used.** That list may be unrelated to the file, and
 * then the schema drift comparison only pretends to compare.
 */
export function extractObservedFields(
  bytes: Uint8Array,
  contentType: string,
): FieldExtraction {
  if (bytes.byteLength === 0) {
    return {
      ok: false,
      reason: "The schema cannot be read from an empty file",
      nextAction: "Re-upload the file provided by the source",
    };
  }
  if (bytes.byteLength > MAX_BULK_EXTRACT_BYTES) {
    return {
      ok: false,
      reason: `The file exceeds the cap for reading the schema (${MAX_BULK_EXTRACT_BYTES} bytes)`,
      nextAction: "Upload it split into partial files that include the header, or use the manual check path",
    };
  }

  const text = stripBom(Buffer.from(bytes).toString("utf8"));
  const media = contentType.split(";")[0]!.trim().toLowerCase();

  if (media === "text/csv" || media === "text/plain" || media === "application/vnd.ms-excel") {
    const header = text.split(/\r?\n/).find((line) => line.trim().length > 0);
    if (!header) {
      return {
        ok: false,
        reason: "No header line",
        nextAction: "Upload a file with column names on the first line",
      };
    }
    const fields = parseCsvHeader(header).filter((field) => field.length > 0);
    if (fields.length === 0) {
      return {
        ok: false,
        reason: "Could not read column names from the header",
        nextAction: "Upload a file with column names on the first line",
      };
    }
    return { ok: true, fields };
  }

  if (media === "application/json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        ok: false,
        reason: "Not readable as JSON",
        nextAction: "Check that this is the file provided by the source",
      };
    }

    // For an array of records, the first record's keys are the columns. Do not scan all of them
    // for a union — a union marks fields present only in later records as "present", which hides
    // removed columns (the more dangerous case).
    const record = Array.isArray(parsed) ? parsed[0] : parsed;
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      return {
        ok: false,
        reason: "Could not find a record object",
        nextAction: "Upload a file shaped as an array of records or an object",
      };
    }
    return { ok: true, fields: Object.keys(record as Record<string, unknown>) };
  }

  return {
    ok: false,
    reason: `The schema cannot be read from this format: ${media}`,
    nextAction: "Upload the original received as CSV or JSON, or use the manual check path",
  };
}
