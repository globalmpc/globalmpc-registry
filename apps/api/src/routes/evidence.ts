import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { z } from "zod";
import { withTenant } from "@mpc/db";
import {
  checkChannelReady,
  detectSchemaDrift,
  SOURCE_RESULTS,
  SOURCE_RESULT_BEHAVIOUR,
  computeClaimGrade,
  type EvidenceTier,
  type SourceResult,
  type VerificationState,
} from "@mpc/domain";
import { structuredClaimInput, correctClaimRequest } from "@mpc/api-contract";
import { resolveCatalogClaim } from "../services/catalog-claims.js";
import { badRequest, conflict, notFound, unprocessable } from "../errors.js";
import { capRows } from "../list-window.js";
import {
  assertAuthorized,
  projectResource,
  sessionFacts,
} from "../plugins/authorize.js";
import { hashRequest, withIdempotency } from "../plugins/idempotency.js";
import { resolveSecret } from "@mpc/config";
import type { ObjectStore } from "@mpc/storage";
import {
  BULK_EXTRACTOR_VERSION,
  extractObservedFields,
  SIGNATURE_VERIFIER_VERSION,
  verifyDetachedSignature,
} from "../services/source-verification.js";
import { recordAudit } from "../audit.js";
import { enqueueEvent } from "../outbox.js";
import { recomputeGrade, setProvenanceCause } from "../services/claim-state.js";
import {
  assertVersionMatches,
  requireIfMatch,
  requireMutationContext,
  requireReadContext,
} from "./shared.js";

/**
 * Source Receipt and Claim — spec 05 §5.12, 07 §7.11.
 *
 * These two resources are the entry point of the evidence lifecycle. What this file enforces:
 *
 * - `SOURCE_RESULT_BEHAVIOUR` owns the 12 receipt results. The route does not decide
 *   `retryable` on its own.
 * - API secrets are not stored. Only the connection's `secret_reference` is referenced.
 * - Claim values are decimal strings. A number is rejected.
 * - `computeClaimGrade` computes the grade. The route holds no grading rules.
 */

const hex32 = z.string().regex(/^0x[0-9a-f]{64}$/, "Must be 32-byte lowercase hex");

/**
 * Finite list of authentication **methods** — 05 §5.12.
 *
 * A free-form string would store values like `"bearer sk-live-..."` verbatim.
 * Meeting the requirement "store no API secret, token, or private key; record only a
 * secret reference" means fixing the method itself as an enum. The actual credential
 * lives only where `source_connections.secret_reference` points.
 */
const AUTHENTICATION_METHODS = [
  "mtls",
  "oauth2",
  "mtls+oauth2",
  "api_key_reference",
  "signed_document",
  "official_seal",
  "manual_verification",
  "none",
] as const;

const createReceiptSchema = z.object({
  connectionId: z.string().uuid(),
  authorityId: z.string().uuid(),
  result: z.enum(SOURCE_RESULTS),
  collectionMethod: z.enum([
    "authenticated_api",
    "official_bulk_export",
    "verifiable_signed_document",
    "manual_official_registry_confirmation",
  ]),
  queryBasis: z.record(z.string()),
  endpointOrDocumentRef: z.string().min(1),
  authenticationMethod: z.enum(AUTHENTICATION_METHODS),
  /**
   * Hash of the original the requester holds — REQ-DAPP-049.
   *
   * `null` when no original was received (source unavailable, no answer): absent is recorded
   * as absent. 32 zero bytes are refused because they read as the hash of an original that does
   * not exist. When `documentUploadId` is sent, the server takes the document's hash instead.
   */
  rawHash: hex32
    .refine((value) => !/^0x0{64}$/.test(value), "A zero hash stands for no original; send null")
    .nullable()
    .default(null),
  /**
   * Terms, reuse, disclosure and versions belong to the connection. Sent values override (a
   * manual record may rest on a different document); omitted ones come from the connection
   * instead of a value the screen made up.
   */
  sourceSchemaVersion: z.string().min(1).optional(),
  adapterVersion: z.string().min(1).optional(),
  normalizationVersion: z.string().nullable().default(null),
  termsLicense: z.string().min(1).optional(),
  commercialReuse: z.enum(["confirmed", "unconfirmed", "prohibited"]).optional(),
  disclosurePermission: z
    .enum(["public", "restricted", "confidential", "pii", "whistleblower"])
    .optional(),
  asOf: z.string().datetime(),
  effectiveAt: z.string().datetime().nullable().default(null),
  /**
   * Per-channel evidence **inputs** — AC-29.
   *
   * This used to accept `signatureValid` and `observedFields` **as results**.
   * That made the requester's statement the evidence for confirmation. Now it accepts only
   * the **targets** to verify, and the server produces the result.
   *
   * - `documentUploadId` — an already uploaded file. It must be in the same project and
   *   must have passed scanning.
   * - `signatureBase64` — a detached signature over that document. The connection holds the public key.
   */
  documentUploadId: z.string().uuid().nullable().default(null),
  signatureBase64: z.string().min(1).nullable().default(null),
  limitations: z.array(z.string()).default([]),
});

/**
 * Decimal string. Numbers are not accepted, to preserve "the original unit and reference
 * date" as `05 §5.9` requires. A floating-point round trip changes the value.
 */
const decimalString = z
  .string()
  .regex(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/, "Value must be a decimal string");

const createClaimSchema = z
  .object({
    ...structuredClaimInput,
    claimType: z.string().min(1),
    valueText: z.union([decimalString, z.string().min(1)]),
    unit: z.string().nullable().default(null),
    asOf: z.string().date().nullable().default(null),
    sourceCoordinate: z.record(z.string()),
    /**
     * The Source Receipt this value came from — AC-04, AC-21.
     *
     * `sourceCoordinate` is a position within the document, not which lookup produced it.
     * Without this reference, claims from a source cannot be found when that source is revoked.
     *
     * Nullable because a manual-entry path remains. **Missing evidence is not filled in
     * as present** — `core.claims_without_evidence` surfaces it instead.
     */
    sourceReceiptId: z.string().uuid().nullable().default(null),
    evidenceTier: z.enum(["P1", "P2", "P3", "P4", "P5"]).nullable().default(null),
    /**
     * Accepted only as `unreviewed`, and `attestationTypes` only empty (REQ-DAPP-004).
     *
     * These used to be taken from the submitter as given, so a claim could arrive already
     * `independently_assured` with attestations nobody signed. The fields stay in the request so
     * that a client still sending them is told why, instead of having them silently dropped.
     */
    verificationState: z
      .enum([
        "unreviewed",
        "machine_checked",
        "analyst_checked",
        "independently_assured",
        "rejected",
      ])
      .default("unreviewed"),
    attestationTypes: z
      .array(
        z.enum([
          "professional_signoff",
          "laboratory_accreditation",
          "independent_assurance",
          "legal_notarization",
          "cryptographic_attestation",
        ]),
      )
      .default([]),
  })
  .superRefine((value, ctx) => {
    // A numeric claim cannot be stored without a unit. A unitless value cannot later
    // be restored to what it meant.
    const isNumeric = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value.valueText);
    if (isNumeric && (value.unit === null || value.unit.trim() === "")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["unit"],
        message: "A numeric claim requires a unit",
      });
    }
  });

interface ReceiptRow {
  id: string;
  project_id: string | null;
  connection_id: string;
  authority_id: string;
  collection_method: string;
  result: SourceResult;
  raw_hash: string | null;
  source_schema_version: string;
  adapter_version: string;
  terms_license: string;
  commercial_reuse: string;
  received_at: Date;
  as_of: Date;
  effective_at: Date | null;
  freshness_status: string;
  correlation_id: string;
  limitations: string[];
  processing_state?: string | null;
}

function toReceiptView(row: ReceiptRow, requestId: string, asOf: string) {
  const behaviour = SOURCE_RESULT_BEHAVIOUR[row.result];
  return {
    id: row.id,
    projectId: row.project_id,
    connectionId: row.connection_id,
    authorityId: row.authority_id,
    collectionMethod: row.collection_method,
    result: row.result,
    // The domain owns the meaning of the 12 results. The route does not reinterpret them.
    retryable: behaviour.retryable,
    nextAction: behaviour.nextAction,
    permitsCanonicalAcceptance: behaviour.permitsCanonicalAcceptance,
    rawHash: row.raw_hash,
    sourceSchemaVersion: row.source_schema_version,
    adapterVersion: row.adapter_version,
    termsLicense: row.terms_license,
    commercialReuse: row.commercial_reuse,
    receivedAt: row.received_at.toISOString(),
    asOf: row.as_of.toISOString(),
    effectiveAt: row.effective_at?.toISOString() ?? null,
    freshnessStatus: row.freshness_status,
    correlationId: row.correlation_id,
    limitations: row.limitations,
    // Set by the DB on insert (0061). `quarantined` values must not be read as observations.
    processingState: row.processing_state ?? null,
    requestId,
    responseAsOf: asOf,
  };
}

interface ClaimRow {
  catalog_entry_id: string | null;
  catalog_version: number | null;
  structured_values: Record<string, string | boolean> | null;
  document_upload_ids: string[];
  id: string;
  project_id: string;
  claim_type: string;
  value_text: string;
  unit: string | null;
  as_of: Date | null;
  source_coordinate: Record<string, string>;
  evidence_tier: EvidenceTier | null;
  verification_state: VerificationState;
  grade: string;
  excluded_by_rule: boolean;
  source_receipt_id: string | null;
  stale_since: Date | null;
  stale_reason: string | null;
  supersedes_claim_id: string | null;
  superseded_by_claim_id: string | null;
  version: number;
}

function toClaimView(row: ClaimRow, requestId: string, asOf: string) {
  return {
    id: row.id,
    projectId: row.project_id,
    claimType: row.claim_type,
    catalogEntryId: row.catalog_entry_id ?? null,
    catalogVersion: row.catalog_version ?? null,
    structuredValues: row.structured_values ?? null,
    documentUploadIds: row.document_upload_ids ?? [],
    valueText: row.value_text,
    unit: row.unit,
    asOf: row.as_of ? row.as_of.toISOString().slice(0, 10) : null,
    sourceCoordinate: row.source_coordinate,
    evidenceTier: row.evidence_tier,
    verificationState: row.verification_state,
    grade: row.grade,
    excludedByRule: row.excluded_by_rule,
    /**
     * Evidence and its state — AC-04, AC-21.
     *
     * `null` means "no evidence" and is not hidden. `stale` does not mean there was no
     * review; it means the evidence that review stood on has shifted — so it is shown
     * separately from `verificationState`.
     */
    sourceReceiptId: row.source_receipt_id,
    stale: row.stale_since !== null,
    staleSince: row.stale_since?.toISOString() ?? null,
    staleReason: row.stale_reason,
    supersedesClaimId: row.supersedes_claim_id,
    supersededByClaimId: row.superseded_by_claim_id,
    version: row.version,
    requestId,
    responseAsOf: asOf,
  };
}

/**
 * The project a claim belongs to.
 *
 * Authorization runs **outside** the idempotency block. A replay returns the stored response
 * as is, so inside it a request replaying someone else's key would skip authorization.
 */
async function claimProjectId(
  sql: postgres.Sql,
  tenantId: string,
  claimId: string,
): Promise<string> {
  const [row] = await withTenant(sql, { tenantId }, (tx) =>
    tx<{ project_id: string }[]>`SELECT project_id FROM core.claims WHERE id = ${claimId}`,
  );
  if (!row) throw notFound("Claim not found");
  return row.project_id;
}

/**
 * The server produces confirmation evidence.
 *
 * Each of the four channels has its own confirmation condition, and **none is met by
 * an assertion in the request body.**
 *
 * - `authenticated_api` — confirmed only on the path where the server calls the source (`/collect`).
 * - `verifiable_signed_document` — verifies the uploaded bytes with the connection's public key.
 * - `official_bulk_export` — extracts fields directly from the uploaded file and compares them.
 * - `manual_official_registry_confirmation` — a second review by another person.
 */
interface ConfirmationEvidence {
  readonly channelEvidence: Record<string, unknown>;
  /** Binds the raw hash to the document. The requester-supplied value is not used. */
  readonly rawHash: string | null;
}

interface UploadForVerification {
  readonly id: string;
  readonly object_key: string;
  readonly content_hash: string;
  readonly content_type: string;
  readonly byte_size: string;
  readonly state: string;
  readonly revoked_at: Date | null;
}

/** Upload states usable as confirmation evidence. An unscanned file is not evidence. */
const VERIFIABLE_UPLOAD_STATES = new Set(["scanned_clean", "promoted"]);

async function loadVerifiableUpload(
  tx: postgres.TransactionSql,
  projectId: string,
  uploadId: string,
): Promise<UploadForVerification> {
  const [upload] = await tx<UploadForVerification[]>`
    SELECT id, object_key, content_hash, content_type, byte_size, state::text AS state, revoked_at
    FROM core.object_uploads
    WHERE id = ${uploadId} AND project_id = ${projectId}
  `;
  if (!upload) throw notFound("Upload not found");

  if (!VERIFIABLE_UPLOAD_STATES.has(upload.state)) {
    // Using an unscanned file as confirmation evidence would reduce quarantine to a formality.
    throw unprocessable(
      "UPLOAD_NOT_VERIFIABLE",
      "An upload that has not passed scanning cannot be confirmation evidence",
      { state: upload.state, nextAction: "Retry after scanning completes" },
    );
  }
  if (upload.revoked_at !== null) {
    // A revoked document cannot be an active basis (04 §4.6 rule 3), however valid its signature.
    throw unprocessable("UPLOAD_REVOKED", "A revoked document cannot be confirmation evidence", {
      revokedAt: upload.revoked_at.toISOString(),
      nextAction: "Use the corrected version of this document",
    });
  }
  return upload;
}

async function readUploadBytes(
  store: ObjectStore,
  upload: UploadForVerification,
): Promise<Uint8Array> {
  const bytes = await store.get(upload.object_key);
  if (!bytes) {
    // The DB row exists but the object does not. Do not confirm — a record without its object is not evidence.
    throw unprocessable("UPLOAD_OBJECT_MISSING", "Uploaded original not found in storage", {
      nextAction: "Check the backup restore state and upload the file again",
    });
  }
  return bytes;
}

/**
 * Produces per-channel confirmation evidence.
 *
 * Every failure is a 422 — the request is well-formed, and **the evidence does not meet
 * the requirement**. Either way, `nextAction` states what else is needed.
 */
async function buildConfirmationEvidence(
  tx: postgres.TransactionSql,
  input: {
    readonly store: ObjectStore;
    readonly projectId: string;
    readonly connectionId: string;
    readonly collectionMethod: string;
    readonly documentUploadId: string | null;
    readonly signatureBase64: string | null;
    readonly subjectId: string | null;
  },
): Promise<ConfirmationEvidence> {
  switch (input.collectionMethod) {
    /**
     * API collection is confirmed only on the path where the server makes the call.
     *
     * This route is where a person writes in results. If `authenticated_api` could be
     * confirmed here, one could **record "called and checked" without calling**.
     * That record would be indistinguishable from one made by `/collect`.
     */
    case "authenticated_api":
      throw unprocessable(
        "CONFIRMATION_REQUIRES_SERVER_COLLECTION",
        "API collection is confirmed only through the server lookup path",
        {
          nextAction:
            "POST /api/v1/source-connections/{connectionId}/collect to run the lookup. " +
            "If the source is not auto-callable, use the manual check path",
        },
      );

    case "verifiable_signed_document":
      return verifySignedDocumentEvidence(tx, input);

    case "official_bulk_export":
      return extractBulkEvidence(tx, input);

    // A manual check has no signature and no file. A second review is the only evidence, and
    // another person creates it on a separate route — it cannot be created here.
    default:
      return { channelEvidence: {}, rawHash: null };
  }
}

async function verifySignedDocumentEvidence(
  tx: postgres.TransactionSql,
  input: {
    readonly store: ObjectStore;
    readonly projectId: string;
    readonly connectionId: string;
    readonly documentUploadId: string | null;
    readonly signatureBase64: string | null;
  },
): Promise<ConfirmationEvidence> {
  if (!input.documentUploadId || !input.signatureBase64) {
    throw unprocessable(
      "SIGNATURE_EVIDENCE_MISSING",
      "A signed document cannot be confirmed without the document and a detached signature",
      { nextAction: "Send documentUploadId together with signatureBase64" },
    );
  }

  const [connection] = await tx<{ connection_key: string; signing_key_reference: string | null }[]>`
    SELECT connection_key, signing_key_reference FROM core.source_connections
    WHERE id = ${input.connectionId}
  `;
  if (!connection) throw notFound("Connection not found");

  /**
   * **Knowing the signer is different from the signature being valid.**
   *
   * Without a registered public key, even a valid signature cannot be attributed to
   * anyone. Confirming in that state would let anyone's signature count as source verification.
   */
  if (!connection.signing_key_reference) {
    throw unprocessable(
      "SIGNER_KEY_NOT_REGISTERED",
      "This connection has no registered signer public key",
      {
        connectionKey: connection.connection_key,
        nextAction: "Register the authority's public key in the connection's signing_key_reference",
      },
    );
  }

  let publicKeyPem: string;
  try {
    publicKeyPem = resolveSecret(connection.connection_key, connection.signing_key_reference);
  } catch (error) {
    // A reference-resolution failure message can contain paths and environment variable names.
    throw unprocessable("SIGNER_KEY_UNAVAILABLE", "Could not read the registered public key", {
      connectionKey: connection.connection_key,
      reason: error instanceof Error ? error.name : "UnknownError",
    });
  }

  const upload = await loadVerifiableUpload(tx, input.projectId, input.documentUploadId);
  const bytes = await readUploadBytes(input.store, upload);

  const check = verifyDetachedSignature({
    bytes,
    signature: new Uint8Array(Buffer.from(input.signatureBase64, "base64")),
    publicKeyPem,
  });

  if (!check.ok) {
    throw unprocessable("SIGNATURE_NOT_VERIFIED", check.reason, {
      nextAction: check.nextAction,
      signatureValid: String(check.signatureValid),
    });
  }

  return {
    /**
     * What the confirmation is bound to.
     *
     * Document hash, verifier version, and key reference are kept together. Without any one
     * of them, "what was checked then, under which rule" cannot be answered later.
     */
    channelEvidence: {
      signatureValid: true,
      signerRecognized: true,
      documentUploadId: upload.id,
      documentHash: upload.content_hash,
      signingKeyReference: connection.signing_key_reference,
      keyType: check.keyType,
      signatureAlgorithm: check.algorithm ?? "eddsa",
      verifierVersion: SIGNATURE_VERIFIER_VERSION,
      verifiedBy: "server",
    },
    rawHash: upload.content_hash,
  };
}

async function extractBulkEvidence(
  tx: postgres.TransactionSql,
  input: {
    readonly store: ObjectStore;
    readonly projectId: string;
    readonly connectionId: string;
    readonly documentUploadId: string | null;
  },
): Promise<ConfirmationEvidence> {
  if (!input.documentUploadId) {
    throw unprocessable(
      "BULK_FILE_MISSING",
      "A bulk export cannot be confirmed without a file",
      { nextAction: "Upload the file the source provided and send documentUploadId" },
    );
  }

  const upload = await loadVerifiableUpload(tx, input.projectId, input.documentUploadId);
  const bytes = await readUploadBytes(input.store, upload);

  // **Extract from the file directly.** Using a requester-supplied list only pretends to compare.
  const extraction = extractObservedFields(bytes, upload.content_type);
  if (!extraction.ok) {
    throw unprocessable("BULK_SCHEMA_UNREADABLE", extraction.reason, {
      nextAction: extraction.nextAction,
      contentType: upload.content_type,
    });
  }

  const [connection] = await tx<{ schema_fingerprint: string[] | null }[]>`
    SELECT schema_fingerprint FROM core.source_connections WHERE id = ${input.connectionId}
  `;
  const drift = detectSchemaDrift(connection?.schema_fingerprint ?? [], extraction.fields);

  if (drift.drifted) {
    throw unprocessable("SOURCE_SCHEMA_DRIFT", "A file that differs from the declared schema cannot be confirmed", {
      added: drift.added.join(", "),
      removed: drift.removed.join(", "),
      nextAction: "Review the schema change and update the connection's schema_fingerprint",
    });
  }

  // Without a declaration, no comparison took place. `checkChannelReady` blocks the same
  // case, but saying it here first tells the caller what to register.
  if (!drift.compared) {
    throw unprocessable(
      "SOURCE_SCHEMA_NOT_DECLARED",
      "The connection has no declared schema, so the file cannot be compared",
      { nextAction: "Register the expected columns in the connection's schema_fingerprint" },
    );
  }

  return {
    channelEvidence: {
      observedFields: extraction.fields,
      schemaDrift: drift,
      documentUploadId: upload.id,
      documentHash: upload.content_hash,
      extractorVersion: BULK_EXTRACTOR_VERSION,
      verifiedBy: "server",
    },
    rawHash: upload.content_hash,
  };
}

/**
 * Caps on the Data Room's receipt and claim panels.
 *
 * A flag rather than pages: both are panels on a screen whose document list already pages,
 * and a project carries far fewer of these than documents. Past the cap the response says
 * `truncated` and `total`, so the panel can say rows were left out.
 */
const SOURCE_RECEIPT_LIMIT = 100;
const CLAIM_LIMIT = 200;

export async function registerEvidenceRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
  store: ObjectStore,
): Promise<void> {
  // --- Source Receipt ------------------------------------------------------

  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/source-receipts",
    async (request) => {
      const { session, tenantId } = requireReadContext(request);

      assertAuthorized(
        session,
        "evidence.read",
        projectResource(tenantId, request.params.projectId),
        sessionFacts(session),
      );

      const { rows, total } = await withTenant(sql, { tenantId }, async (tx) => {
        const page = await tx<ReceiptRow[]>`
          SELECT * FROM core.source_receipts
          WHERE project_id = ${request.params.projectId}
          ORDER BY as_of DESC, id DESC LIMIT ${SOURCE_RECEIPT_LIMIT + 1}
        `;
        const [count] = await tx<{ total: number }[]>`
          SELECT count(*)::int AS total FROM core.source_receipts
          WHERE project_id = ${request.params.projectId}
        `;
        return { rows: page, total: count?.total ?? 0 };
      });
      const window = capRows(rows, SOURCE_RECEIPT_LIMIT);

      return {
        items: window.items.map((row) =>
          toReceiptView(row, request.context.requestId, request.context.asOf),
        ),
        truncated: window.truncated,
        limit: window.limit,
        total,
        requestId: request.context.requestId,
        asOf: request.context.asOf,
      };
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/source-receipts",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);

      /**
       * Freshness is the server's to compute — REQ-DAPP-049.
       *
       * A requester writing `fresh` states an age nobody measured. Refused rather than ignored,
       * so a caller that still sends it learns why its value is not what was stored.
       */
      if (
        request.body !== null &&
        typeof request.body === "object" &&
        "freshnessStatus" in (request.body as Record<string, unknown>)
      ) {
        throw badRequest(
          "FRESHNESS_IS_SERVER_COMPUTED",
          "freshnessStatus is computed by the server and cannot be sent",
        );
      }

      const parsed = createReceiptSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "Request format is invalid", {
          issues: parsed.error.issues,
        });
      }

      const effectiveRole = assertAuthorized(
        session,
        "source.upload",
        projectResource(tenantId, request.params.projectId),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request);

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          const id = randomUUID();
          const data = parsed.data;

          // The receipt is bound to a real connection of this tenant and to that connection's
          // authority. Naming another authority would attribute the answer to someone else.
          const [connection] = await tx<
            {
              authority_id: string;
              terms_license: string;
              commercial_reuse: string;
              disclosure_permission: string;
              source_schema_version: string;
              adapter_version: string;
            }[]
          >`
            SELECT authority_id, terms_license, commercial_reuse,
                   disclosure_permission::text AS disclosure_permission,
                   source_schema_version, adapter_version
            FROM core.source_connections WHERE id = ${data.connectionId}
          `;
          if (!connection) throw notFound("Connection not found");
          if (connection.authority_id !== data.authorityId) {
            throw unprocessable(
              "CONNECTION_AUTHORITY_MISMATCH",
              "The authority is not the one this connection reaches",
              { connectionAuthorityId: connection.authority_id },
            );
          }

          /**
           * The server produces confirmation evidence — AC-29.
           *
           * Non-confirmed results do not pass through here. **A failure must be kept as a
           * failure** — otherwise the next person repeats the same attempt.
           */
          const evidence = data.result === "confirmed_from_source"
            ? await buildConfirmationEvidence(tx, {
                store,
                projectId: request.params.projectId,
                connectionId: data.connectionId,
                collectionMethod: data.collectionMethod,
                documentUploadId: data.documentUploadId,
                signatureBase64: data.signatureBase64,
                subjectId: session.subjectId ?? null,
              })
            : ({ channelEvidence: {}, rawHash: null } satisfies ConfirmationEvidence);

          /**
           * Passes the domain check once more.
           *
           * Called with the values built above — not the request body. A DB CHECK blocks the
           * same thing, but tripping it returns a 500 and the caller cannot tell **what else
           * is needed**.
           */
          const ready = checkChannelReady({
            method: data.collectionMethod,
            result: data.result,
            signatureValid:
              (evidence.channelEvidence["signatureValid"] as boolean | undefined) ?? null,
            observedFields:
              (evidence.channelEvidence["observedFields"] as string[] | undefined) ?? null,
            // A manual check cannot have a second reviewer at creation. It is confirmed after
            // another person checks it on a separate route.
            firstConfirmedBy: session.subjectId,
            secondConfirmedBy: null,
          });
          if (!ready.ok) {
            throw unprocessable("CHANNEL_REQUIREMENT_UNMET", ready.reason, {
              collectionMethod: data.collectionMethod,
              nextAction: ready.nextAction,
            });
          }

          const channelEvidence = evidence.channelEvidence;
          /**
           * Binds the raw hash to the document.
           *
           * With a referenced document — on any result — the hash is the document's, taken from
           * the scanned upload. A requester hash that disagrees is refused rather than replaced:
           * if that value were unrelated to the document, "re-fetch the original for this hash
           * and compare" would not hold, and silently swapping it hides the disagreement.
           */
          const rawHash = await resolveReceiptHash(tx, request.params.projectId, data, evidence);

          /**
           * Freshness is computed here, not sent. How old is too old is a per-source rule the
           * jurisdiction profile owns (OD-16 is still pending), and without that rule the only
           * honest value is `unknown`.
           */
          const freshnessStatus = "unknown";

          const [receipt] = await tx<ReceiptRow[]>`
            INSERT INTO core.source_receipts (
              id, tenant_id, project_id, connection_id, authority_id, collection_method,
              result, query_basis, endpoint_or_document_ref, authentication_method,
              raw_hash, source_schema_version, adapter_version, normalization_version,
              terms_license, commercial_reuse, disclosure_permission,
              received_at, as_of, effective_at, freshness_status, correlation_id, limitations,
              channel_evidence, first_confirmed_by
            ) VALUES (
              ${id}, ${tenantId}, ${request.params.projectId}, ${data.connectionId},
              ${data.authorityId}, ${data.collectionMethod}, ${data.result},
              ${tx.json(data.queryBasis)}, ${data.endpointOrDocumentRef},
              ${data.authenticationMethod}, ${rawHash},
              ${data.sourceSchemaVersion ?? connection.source_schema_version},
              ${data.adapterVersion ?? connection.adapter_version}, ${data.normalizationVersion},
              ${data.termsLicense ?? connection.terms_license},
              ${data.commercialReuse ?? connection.commercial_reuse},
              ${data.disclosurePermission ?? connection.disclosure_permission},
              now(), ${data.asOf}, ${data.effectiveAt}, ${freshnessStatus},
              ${correlationId}, ${data.limitations},
              ${tx.json(channelEvidence as never)}, ${session.subjectId}
            )
            RETURNING *
          `;

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            projectId: request.params.projectId,
            session,
            command: "source_receipt.received",
            resourceType: "source_receipt",
            resourceId: id,
            correlationId,
            requestIp: request.clientIp,
            // The result goes into the audit log. Which result it was is what gets reproduced later.
            detail: { result: data.result, collectionMethod: data.collectionMethod },
          });

          await enqueueEvent(tx, {
            tenantId,
            eventType: "source_receipt.received",
            aggregateId: id,
            aggregateVersion: 1,
            projectId: request.params.projectId,
            payload: { result: data.result, authorityId: data.authorityId },
            correlationId,
          });

          return toReceiptView(receipt!, requestId, asOf);
        }),
      );
    },
  );

  // --- Claim ---------------------------------------------------------------

  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/claims",
    async (request) => {
      const { session, tenantId } = requireReadContext(request);

      assertAuthorized(
        session,
        "evidence.read",
        projectResource(tenantId, request.params.projectId),
        sessionFacts(session),
      );

      const { rows, total } = await withTenant(sql, { tenantId }, async (tx) => {
        const page = await tx<ClaimRow[]>`
          SELECT * FROM core.claims
          WHERE project_id = ${request.params.projectId}
          ORDER BY claim_type, id LIMIT ${CLAIM_LIMIT + 1}
        `;
        const [count] = await tx<{ total: number }[]>`
          SELECT count(*)::int AS total FROM core.claims
          WHERE project_id = ${request.params.projectId}
        `;
        return { rows: page, total: count?.total ?? 0 };
      });
      const window = capRows(rows, CLAIM_LIMIT);

      return {
        items: window.items.map((row) =>
          toClaimView(row, request.context.requestId, request.context.asOf),
        ),
        truncated: window.truncated,
        limit: window.limit,
        total,
        requestId: request.context.requestId,
        asOf: request.context.asOf,
      };
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/claims",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);

      const parsed = createClaimSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "Request format is invalid", {
          issues: parsed.error.issues,
        });
      }

      const effectiveRole = assertAuthorized(
        session,
        "claim.curate",
        projectResource(tenantId, request.params.projectId),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request);

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          const id = randomUUID();
          const data = parsed.data;

          // The verification state is an outcome of review; a submitter cannot declare it.
          if (data.verificationState !== "unreviewed" || data.attestationTypes.length > 0) {
            throw unprocessable(
              "CLAIM_ASSESSMENT_NOT_SETTABLE",
              "A claim starts unreviewed. Its verification state moves only when an attestation is signed, revoked or superseded",
              { verificationState: data.verificationState, attestationTypes: data.attestationTypes },
            );
          }

          const structured = await resolveCatalogClaim(tx, request.params.projectId, data.claimType, data);

          // Domain rules compute the grade.
          const grade = computeClaimGrade({
            verificationState: "unreviewed",
            evidenceTier: data.evidenceTier,
            attestationTypes: [],
            unresolvedConflictCount: 0,
            excludedByRule: false,
          });

          await setProvenanceCause(tx, "claim_submitted", session.subjectId ?? null);
          // `submitted_by` is what lets 02 §2.4 rule 1 tell whether a reviewer judges their own evidence.
          const [claim] = await tx<ClaimRow[]>`
            INSERT INTO core.claims (
              id, tenant_id, project_id, claim_type, value_text, unit, as_of,
              source_coordinate, evidence_tier, verification_state, grade,
              source_receipt_id, submitted_by, catalog_entry_id, catalog_version, structured_values, document_upload_ids
            ) VALUES (
              ${id}, ${tenantId}, ${request.params.projectId}, ${data.claimType},
              ${data.valueText}, ${data.unit}, ${data.asOf},
              ${tx.json(data.sourceCoordinate)}, ${data.evidenceTier},
              'unreviewed', ${grade}, ${data.sourceReceiptId}, ${session.subjectId ?? null},
              ${structured.catalogEntryId}, ${structured.catalogVersion}, ${structured.structuredValues === null ? null : tx.json(structured.structuredValues)}, ${structured.documentUploadIds}::uuid[]
            )
            RETURNING *
          `;

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            projectId: request.params.projectId,
            session,
            command: "claim.created",
            resourceType: "claim",
            resourceId: id,
            afterVersion: 1,
            correlationId,
            requestIp: request.clientIp,
            detail: { claimType: data.claimType, grade },
          });

          await enqueueEvent(tx, {
            tenantId,
            eventType: "provenance.grade.changed",
            aggregateId: id,
            aggregateVersion: 1,
            projectId: request.params.projectId,
            payload: { claimType: data.claimType, grade },
            correlationId,
          });

          return toClaimView(claim!, requestId, asOf);
        }),
      );
    },
  );

  app.post<{ Params: { claimId: string } }>(
    "/api/v1/claims/:claimId/conflicts",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      // Recording a conflict recomputes the grade and bumps the claim's version.
      // If two people write to the same claim at once, one judgment is overwritten without a trace.
      const expectedVersion = requireIfMatch(request);

      const parsed = z
        .object({ conflictType: z.string().min(1) })
        .safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "Request format is invalid");
      }

      const effectiveRole = assertAuthorized(
        session,
        "claim.curate",
        projectResource(tenantId, await claimProjectId(sql, tenantId, request.params.claimId)),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request);

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          // Lock the row, then check the version. Without the lock, another transaction can slip
          // in between the check and the update and void the check.
          const [current] = await tx<{ version: number }[]>`
            SELECT version FROM core.claims
            WHERE id = ${request.params.claimId}
            FOR UPDATE
          `;
          if (!current) throw notFound("Claim not found");
          assertVersionMatches(expectedVersion, current.version, "claim");

          await tx`
            INSERT INTO core.claim_conflicts (id, tenant_id, claim_id, conflict_type)
            VALUES (${randomUUID()}, ${tenantId}, ${request.params.claimId}, ${parsed.data.conflictType})
          `;

          // A conflict can lower the grade. Recompute immediately —
          // a stale grade must not feed readiness.
          const grade = await recomputeGrade(tx, request.params.claimId);

          const [claim] = await tx<ClaimRow[]>`
            SELECT * FROM core.claims WHERE id = ${request.params.claimId}
          `;

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            session,
            command: "claim.conflict.recorded",
            resourceType: "claim",
            resourceId: request.params.claimId,
            correlationId,
            requestIp: request.clientIp,
            detail: { conflictType: parsed.data.conflictType, grade },
          });

          await enqueueEvent(tx, {
            tenantId,
            eventType: "provenance.grade.changed",
            aggregateId: request.params.claimId,
            aggregateVersion: claim!.version,
            payload: { grade, reason: "conflict_recorded" },
            correlationId,
          });

          return toClaimView(claim!, requestId, asOf);
        }),
      );
    },
  );

  /**
   * Corrects a claim — REQ-DAPP-006, invariant 4.
   *
   * The old claim is not edited (migration 0063 rejects it). The correction is a new claim of the
   * same type that supersedes it; the old one records its successor and is marked stale, which
   * moves active attestations over it to re-review (AC-21). The new version starts `unreviewed`:
   * its value is new and no one has reviewed it.
   */
  app.post<{ Params: { claimId: string } }>(
    "/api/v1/claims/:claimId/versions",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      const expectedVersion = requireIfMatch(request);

      const parsed = correctClaimRequest.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "Request format is invalid", {
          issues: parsed.error.issues,
        });
      }
      const data = parsed.data;
      if (/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(data.valueText) && !data.unit?.trim()) {
        throw badRequest("REQUEST_INVALID", "A numeric claim requires a unit");
      }

      const projectId = await claimProjectId(sql, tenantId, request.params.claimId);
      const effectiveRole = assertAuthorized(
        session,
        "claim.curate",
        projectResource(tenantId, projectId),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
          const [previous] = await tx<(ClaimRow & { superseded_by_claim_id: string | null })[]>`
            SELECT * FROM core.claims WHERE id = ${request.params.claimId} FOR UPDATE
          `;
          if (!previous) throw notFound("Claim not found");
          assertVersionMatches(expectedVersion, previous.version, "claim");
          if (previous.superseded_by_claim_id !== null) {
            throw conflict("CLAIM_ALREADY_SUPERSEDED", "This claim was already corrected", {
              supersededByClaimId: previous.superseded_by_claim_id,
            });
          }

          if (previous.catalog_entry_id && (data.catalogEntryId === null || data.structuredValues == null)) {
            throw unprocessable("CLAIM_STRUCTURED_CORRECTION_REQUIRED", "A structured correction must retain its catalog and provide replacement structured values");
          }
          const structured = await resolveCatalogClaim(tx, projectId, previous.claim_type, {
            ...data,
            catalogEntryId: data.catalogEntryId === undefined ? previous.catalog_entry_id : data.catalogEntryId,
            documentUploadIds: data.documentUploadIds ?? previous.document_upload_ids,
          });
          const id = randomUUID();
          const grade = computeClaimGrade({
            verificationState: "unreviewed",
            evidenceTier: data.evidenceTier,
            attestationTypes: [],
            unresolvedConflictCount: 0,
            excludedByRule: false,
          });

          await setProvenanceCause(tx, `claim_corrected:${previous.id}`, session.subjectId ?? null);
          const [claim] = await tx<ClaimRow[]>`
            INSERT INTO core.claims (
              id, tenant_id, project_id, claim_type, value_text, unit, as_of,
              source_coordinate, evidence_tier, verification_state, grade,
              source_receipt_id, submitted_by, supersedes_claim_id, correction_reason,
              catalog_entry_id, catalog_version, structured_values, document_upload_ids
            ) VALUES (
              ${id}, ${tenantId}, ${projectId}, ${previous.claim_type},
              ${data.valueText}, ${data.unit}, ${data.asOf},
              ${tx.json(data.sourceCoordinate)}, ${data.evidenceTier},
              'unreviewed', ${grade}, ${data.sourceReceiptId}, ${session.subjectId ?? null},
              ${previous.id}, ${data.reason}, ${structured.catalogEntryId}, ${structured.catalogVersion},
              ${structured.structuredValues === null ? null : tx.json(structured.structuredValues)}, ${structured.documentUploadIds}::uuid[]
            )
            RETURNING *
          `;

          // Stale, so the propagation trigger (0023) sends active attestations over the old value
          // to re-review. Its signatures and history stay.
          await tx`
            UPDATE core.claims
            SET superseded_by_claim_id = ${id}, superseded_at = now(),
                stale_since = coalesce(stale_since, now()),
                stale_reason = coalesce(stale_reason, ${`Superseded by claim ${id}: ${data.reason}`}),
                version = version + 1
            WHERE id = ${previous.id}
          `;

          await tx`
            INSERT INTO core.lineage_edges (id, tenant_id, from_id, to_id, relation_type)
            VALUES (${randomUUID()}, ${tenantId}, ${id}, ${previous.id}, 'supersedes')
          `;

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            projectId,
            session,
            command: "claim.corrected",
            resourceType: "claim",
            resourceId: id,
            beforeVersion: previous.version,
            afterVersion: 1,
            reason: data.reason,
            correlationId,
            requestIp: request.clientIp,
            detail: { supersedesClaimId: previous.id, claimType: previous.claim_type, grade },
          });

          await enqueueEvent(tx, {
            tenantId,
            eventType: "evidence.version.superseded",
            aggregateId: previous.id,
            aggregateVersion: previous.version + 1,
            projectId,
            payload: { claimId: previous.id, supersededBy: id },
            correlationId,
          });
          await enqueueEvent(tx, {
            tenantId,
            eventType: "provenance.grade.changed",
            aggregateId: id,
            aggregateVersion: 1,
            projectId,
            payload: { claimType: previous.claim_type, grade, supersedesClaimId: previous.id },
            correlationId,
          });

          return toClaimView(claim!, requestId, asOf);
        }),
      );
    },
  );
}

async function resolveReceiptHash(
  tx: postgres.TransactionSql,
  projectId: string,
  data: Pick<z.infer<typeof createReceiptSchema>, "documentUploadId" | "rawHash">,
  evidence: ConfirmationEvidence,
): Promise<string | null> {
  const documentHash =
    evidence.rawHash ??
    (data.documentUploadId
      ? (await loadVerifiableUpload(tx, projectId, data.documentUploadId)).content_hash
      : null);
  if (documentHash !== null && data.rawHash !== null && data.rawHash !== documentHash) {
    throw unprocessable(
      "RAW_HASH_DOCUMENT_MISMATCH",
      "The raw hash does not match the referenced document",
      { documentHash },
    );
  }
  return documentHash ?? data.rawHash;
}
