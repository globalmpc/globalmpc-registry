import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import type { z } from "zod";
import { withTenant } from "@mpc/db";
import { checkPublishable } from "@mpc/domain";
import {
  createRegistryDraftRequest,
  publicProjection,
  registryDraftListQuery,
  rejectRegistryDraftRequest,
} from "@mpc/api-contract";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { assertAuthorized, sessionFacts, tenantResource } from "../plugins/authorize.js";
import { hashRequest, withIdempotency } from "../plugins/idempotency.js";
import { recordAudit } from "../audit.js";
import {
  assertVersionMatches,
  etagOf,
  requireIfMatch,
  requireMutationContext,
  requireReadContext,
  type EnrolledSession,
} from "./shared.js";
import {
  type PublicationSubject,
  projectionMismatches,
  resolvePublicationSubject,
  assertEvidenceLedgerProjection,
} from "../services/registry-publication.js";

/**
 * Registry drafts — spec 02 §2.8, 05 §5.7·§5.9, 07 §7.2.
 *
 * The first of two steps. A draft is checked against everything the server knows — the
 * allowlist, the subject's identity and lifecycle, the evidence snapshot, the source terms —
 * and recorded. It is not public, not anchorable, and not a registry version. Publication
 * (`registry.ts`) is done by a different person.
 */

export interface DraftRow {
  id: string;
  registry_type: "project" | "verification";
  subject_id: string;
  public_key: string;
  projection: Record<string, unknown>;
  source_snapshot_hash: string;
  commercial_reuse: "confirmed" | "unconfirmed" | "prohibited";
  published_as_commercial_basis: boolean;
  policy_version: string;
  schema_version: string;
  contains_person_level_identifier: boolean;
  lawful_basis: string | null;
  purpose: string | null;
  retention: string | null;
  irreversibility_acknowledged_at: Date | null;
  proposed_by_subject_id: string;
  proposed_at: Date;
  state: "pending" | "published" | "rejected";
  decided_by_subject_id: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
  person_identifier_publication_approved: boolean;
  entry_version_id: string | null;
  version: number;
}

export function parseBody<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw badRequest("REQUEST_INVALID", "Request format is invalid", { issues: parsed.error.issues });
  }
  return parsed.data;
}

/** A draft names the person who made it. A session without a subject has no one to name. */
export function subjectOf(session: EnrolledSession): string {
  if (!session.subjectId) {
    throw forbidden("SUBJECT_REQUIRED", "This session is not bound to a person");
  }
  return session.subjectId;
}

export async function lockDraft(
  tx: postgres.TransactionSql,
  tenantId: string,
  draftId: string,
): Promise<DraftRow | undefined> {
  const [row] = await tx<DraftRow[]>`
    SELECT * FROM core.registry_publication_drafts
    WHERE tenant_id = ${tenantId} AND id = ${draftId}
    FOR UPDATE
  `;
  return row;
}

export function toDraft(row: DraftRow) {
  return {
    id: row.id,
    registryType: row.registry_type,
    subjectId: row.subject_id,
    publicKey: row.public_key,
    projection: row.projection,
    sourceSnapshotHash: row.source_snapshot_hash,
    commercialReuse: row.commercial_reuse,
    publishedAsCommercialBasis: row.published_as_commercial_basis,
    policyVersion: row.policy_version,
    schemaVersion: row.schema_version,
    containsPersonLevelIdentifier: row.contains_person_level_identifier,
    personIdentifierRecord: row.contains_person_level_identifier
      ? {
          lawfulBasis: row.lawful_basis!,
          purpose: row.purpose!,
          retention: row.retention!,
          irreversibilityAcknowledgedAt: row.irreversibility_acknowledged_at!.toISOString(),
        }
      : null,
    proposedBySubjectId: row.proposed_by_subject_id,
    proposedAt: row.proposed_at.toISOString(),
    state: row.state,
    decidedBySubjectId: row.decided_by_subject_id,
    decidedAt: row.decided_at?.toISOString() ?? null,
    decisionReason: row.decision_reason,
    entryVersionId: row.entry_version_id,
    version: row.version,
  };
}

/**
 * The person-identifier safeguards as `checkPublishable` reads them.
 *
 * Each one is true only because a record exists — the lawful basis, purpose and retention as
 * text, the acknowledgement as a time. `explicitPublicationApproval` is passed in: at drafting
 * it is not given yet, at publication it is the approver's own statement.
 */
export function safeguardsOf(
  record: {
    lawfulBasis: string | null;
    purpose: string | null;
    retention: string | null;
    acknowledgedAt: Date | null;
  },
  explicitPublicationApproval: boolean,
) {
  const present = (value: string | null) => value !== null && value.trim().length > 0;
  return {
    lawfulBasisRecorded: present(record.lawfulBasis),
    explicitPublicationApproval,
    purposeRecorded: present(record.purpose),
    retentionRecorded: present(record.retention),
    irreversibilityAcknowledged: record.acknowledgedAt !== null,
  };
}

function isUniqueViolation(caught: unknown, constraint: string): boolean {
  return (
    caught instanceof Error &&
    (caught as { code?: string }).code === "23505" &&
    caught.message.includes(constraint)
  );
}

export async function registerRegistryDraftRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  app.post("/api/v1/registry-entries", async (request) => {
    const { session, tenantId, idempotencyKey } = requireMutationContext(request);
    const data = parseBody(createRegistryDraftRequest, request.body);

    /**
     * The Asset Registry waits for R6 — OD-07.
     *
     * 05 §5.6 puts ERSP authorization and contract state in it, and 05 §5.7 keeps those
     * restricted until R6. There is nothing it could publish that R0–R5 has decided, so it is
     * refused by name rather than accepted with whatever the client sent. The read page stays.
     */
    if (data.registryType === "asset") {
      throw unprocessable(
        "REGISTRY_TYPE_NOT_AVAILABLE",
        "The Asset Registry cannot be published before R6",
        { registryType: "asset", decision: "OD-07" },
      );
    }
    const registryType = data.registryType;

    const effectiveRole = assertAuthorized(
      session,
      "registry.draft",
      tenantResource(tenantId, { sensitivity: "public" }),
      sessionFacts(session),
    );
    const proposer = subjectOf(session);

    // A person-level identifier needs its safeguards on record before anything else (AC-32).
    if (data.containsPersonLevelIdentifier && !data.personIdentifierRecord) {
      throw unprocessable(
        "PUBLICATION_PERSON_IDENTIFIER_GUARD",
        "Person-level identifiers need a lawful basis, purpose, retention and an irreversibility acknowledgement on record",
      );
    }
    const record = data.containsPersonLevelIdentifier ? data.personIdentifierRecord! : null;

    const { requestId, asOf, correlationId } = request.context;
    const requestHash = hashRequest(request);

    return withTenant(sql, { tenantId }, (tx) =>
      withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
        const subject = await resolvePublicationSubject(
          tx,
          tenantId,
          registryType,
          data.subjectId,
        );

        /**
         * Everything that does not depend on the second person.
         *
         * `disclosureApproved` and the explicit person-identifier approval are the publisher's
         * to give, so they are passed as given here — this call answers "could this be
         * published if approved?", and publication asks the full question again.
         */
        assertDraftPublishable(data, record, subject);

        // `.strict()` rejects fields outside the allowlist once more, and checks the shape.
        const projectionCheck = publicProjection.safeParse(data.projection);
        if (!projectionCheck.success) {
          throw unprocessable(
            "PUBLICATION_PROJECTION_INVALID",
            "Projection does not match the public schema",
            { issues: projectionCheck.error.issues },
          );
        }

        await assertEvidenceLedgerProjection(
          tx, tenantId, registryType, subject.projectId, data.projection, new Date(asOf),
        );

        if (subject.publicKey !== null && data.publicKey !== subject.publicKey) {
          throw unprocessable(
            "REGISTRY_PUBLIC_KEY_MISMATCH",
            "A Project Registry entry is published under the project's key",
            { expected: subject.publicKey },
          );
        }

        if (
          data.sourceSnapshotHash !== undefined &&
          data.sourceSnapshotHash !== subject.sourceSnapshotHash
        ) {
          throw unprocessable(
            "REGISTRY_SNAPSHOT_MISMATCH",
            "The evidence changed since this snapshot was taken, or it is not this subject's",
            { expected: subject.sourceSnapshotHash },
          );
        }

        const mismatched = projectionMismatches(data.projection, subject);
        if (mismatched.length > 0) {
          throw unprocessable(
            "PUBLICATION_PROJECTION_MISMATCH",
            "The projection states values that differ from the record it describes",
            { offendingFields: mismatched },
          );
        }

        // A key already published for another subject is not reused. Appending a version to
        // it would publish one subject's facts under another's key.
        const [existing] = await tx<{ subject_id: string }[]>`
          SELECT subject_id FROM core.registry_entries
          WHERE registry_type = ${registryType} AND public_key = ${data.publicKey}
        `;
        if (existing && existing.subject_id !== data.subjectId) {
          throw conflict("REGISTRY_KEY_TAKEN", "This public key belongs to another subject");
        }

        const id = randomUUID();
        try {
          await tx`
            INSERT INTO core.registry_publication_drafts (
              id, tenant_id, registry_type, subject_id, public_key, projection,
              source_snapshot_hash, commercial_reuse, published_as_commercial_basis,
              policy_version, schema_version, contains_person_level_identifier,
              lawful_basis, purpose, retention, irreversibility_acknowledged_at,
              proposed_by_subject_id
            ) VALUES (
              ${id}, ${tenantId}, ${registryType}, ${data.subjectId}, ${data.publicKey},
              ${tx.json(data.projection as never)}, ${subject.sourceSnapshotHash},
              ${subject.commercialReuse}, ${data.publishedAsCommercialBasis},
              ${data.policyVersion}, ${data.schemaVersion}, ${data.containsPersonLevelIdentifier},
              ${record?.lawfulBasis ?? null}, ${record?.purpose ?? null},
              ${record?.retention ?? null}, ${record ? new Date() : null},
              ${proposer}
            )
          `;
        } catch (caught) {
          if (isUniqueViolation(caught, "registry_drafts_one_pending_idx")) {
            throw conflict(
              "REGISTRY_DRAFT_PENDING",
              "A draft for this key is already waiting. Publish or reject it first",
            );
          }
          throw caught;
        }

        await recordAudit(tx, {
          effectiveRole,
          tenantId,
          session,
          command: "registry.version.drafted",
          resourceType: "registry_publication_draft",
          resourceId: id,
          afterVersion: 1,
          correlationId,
          requestIp: request.clientIp,
          detail: {
            registryType,
            publicKey: data.publicKey,
            sourceSnapshotHash: subject.sourceSnapshotHash,
            commercialReuse: subject.commercialReuse,
            containsPersonLevelIdentifier: data.containsPersonLevelIdentifier,
          },
        });

        const [row] = await tx<DraftRow[]>`
          SELECT * FROM core.registry_publication_drafts WHERE tenant_id = ${tenantId} AND id = ${id}
        `;
        return { ...toDraft(row!), requestId, asOf };
      }),
    );
  });

  app.get("/api/v1/registry-entries/drafts", async (request) => {
    const { session, tenantId } = requireReadContext(request);
    assertAuthorized(
      session,
      "registry.read",
      tenantResource(tenantId, { sensitivity: "public" }),
      sessionFacts(session),
    );
    const query = registryDraftListQuery.safeParse(request.query);
    if (!query.success) {
      throw badRequest("REQUEST_INVALID", "Query is invalid", { issues: query.error.issues });
    }
    const { subjectId, state } = query.data;
    const { requestId, asOf } = request.context;

    const rows = await withTenant(sql, { tenantId }, (tx) =>
      tx<DraftRow[]>`
        SELECT * FROM core.registry_publication_drafts
        WHERE tenant_id = ${tenantId}
          ${subjectId ? tx`AND subject_id = ${subjectId}` : tx``}
          ${state ? tx`AND state = ${state}::core.registry_draft_state` : tx``}
        ORDER BY proposed_at DESC
        LIMIT 100
      `,
    );
    return { items: rows.map(toDraft), requestId, asOf };
  });

  app.post<{ Params: { draftId: string } }>(
    "/api/v1/registry-entries/drafts/:draftId/reject",
    async (request, reply) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      const expected = requireIfMatch(request);
      const effectiveRole = assertAuthorized(
        session,
        "registry.publish",
        tenantResource(tenantId, {
          sensitivity: "public",
          state: "pending",
          statesAllowingAction: ["pending"],
        }),
        sessionFacts(session),
      );
      const body = parseBody(rejectRegistryDraftRequest, request.body);
      const decider = subjectOf(session);
      const { requestId, asOf, correlationId } = request.context;

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
          const draft = await lockDraft(tx, tenantId, request.params.draftId);
          if (!draft) throw notFound("Draft not found");
          assertVersionMatches(expected, draft.version, "registry_publication_draft");
          if (draft.state !== "pending") {
            throw unprocessable("REGISTRY_DRAFT_ALREADY_DECIDED", "Draft is already decided", {
              state: draft.state,
            });
          }

          // Turning a draft down publishes nothing, so it needs no second person.
          await tx`
            UPDATE core.registry_publication_drafts
            SET state = 'rejected', decided_by_subject_id = ${decider}, decided_at = now(),
                decision_reason = ${body.reason}, version = version + 1
            WHERE tenant_id = ${tenantId} AND id = ${draft.id}
          `;

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            session,
            command: "registry.version.draft_rejected",
            resourceType: "registry_publication_draft",
            resourceId: draft.id,
            beforeVersion: draft.version,
            afterVersion: draft.version + 1,
            reason: body.reason,
            correlationId,
            requestIp: request.clientIp,
          });

          reply.header("etag", etagOf(draft.version + 1));
          const row = await lockDraft(tx, tenantId, draft.id);
          return { ...toDraft(row!), requestId, asOf };
        }),
      );
    },
  );
}

function assertDraftPublishable(
  data: z.infer<typeof createRegistryDraftRequest>,
  record: z.infer<typeof createRegistryDraftRequest>["personIdentifierRecord"] | null,
  subject: PublicationSubject,
): void {
  const publishCheck = checkPublishable({
    fields: Object.keys(data.projection),
    // The projection carries only allowlisted fields, and its identity fields are
    // checked against the record below. Per-field sensitivity of free-text fields such as
    // `claimSummary` is not derived yet; the approver reads them before publishing.
    sensitivity: "public",
    disclosureApproved: true,
    containsPersonLevelIdentifier: data.containsPersonLevelIdentifier,
    personIdentifierSafeguards: safeguardsOf(
      {
        lawfulBasis: record?.lawfulBasis ?? null,
        purpose: record?.purpose ?? null,
        retention: record?.retention ?? null,
        acknowledgedAt: record ? new Date() : null,
      },
      true,
    ),
    commercialReuse: subject.commercialReuse,
    publishedAsCommercialBasis: data.publishedAsCommercialBasis,
  });
  if (!publishCheck.allowed) {
    throw unprocessable(publishCheck.reason, "This projection cannot be published", {
      offendingFields: publishCheck.offendingFields,
      commercialReuse: subject.commercialReuse,
    });
  }
}
