import type { ActorContext } from "@mpc/db";
import { authorizedProjectLookup } from "../services/authorized-project-lookup.js";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import type { z } from "zod";
import { withActor } from "@mpc/db";
import { checkPublishable } from "@mpc/domain";
import {
  createRegistryDraftRequest,
  publicProjection,
  registryDraftListQuery,
  administratorProjectProjection,
  administratorSoloProjectProjection,
  administratorPublicKey,
  ADMINISTRATOR_PUBLICATION_POLICY,
  ADMINISTRATOR_PUBLICATION_SCHEMA,
  approveRegistryDraftDisclosureRequest,
  rejectRegistryDraftRequest,
} from "@mpc/api-contract";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { assertAuthorized, sessionFacts, registryResource, projectResource, visibleProjectScope } from "../plugins/authorize.js";
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
  registrySubjectProjectId,
  assertEvidenceLedgerProjection,
} from "../services/registry-publication.js";

/**
 * Registry drafts — spec 02 §2.8, 05 §5.7·§5.9, 07 §7.2.
 *
 * The first of two steps. A draft is checked against everything the server knows — the
 * allowlist, the subject's identity and lifecycle, the evidence snapshot, the source terms —
 * and recorded. It is not public, not anchorable, and not a registry version. Publication
 * (`registry.ts`) applies an independent reviewer or the restricted administrator path.
 */

/** Immutable draft subject resolves scope before an idempotency response can be replayed. */
export async function draftPublicationTarget(sql: postgres.Sql, actor: ActorContext, draftId: string) {
  type Target = { project_id: string | null; proposed_by_subject_id: string };
  const [row] = await withActor(sql, actor, tx => tx<Target[]>`
    SELECT CASE WHEN d.registry_type='project' THEN d.subject_id ELSE vc.project_id END AS project_id, d.proposed_by_subject_id
    FROM core.registry_publication_drafts d
    LEFT JOIN core.verification_attestations a ON d.registry_type='verification' AND a.id=d.subject_id
    LEFT JOIN core.verification_cases vc ON vc.id=a.case_id
    WHERE d.id=${draftId}
  `);
  if (!row?.project_id) throw notFound("Draft not found");
  return { projectId: row.project_id, proposer: row.proposed_by_subject_id };
}

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
  administrator_publication_prepared: boolean;
  disclosure_approved_by_subject_id: string | null;
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

export function parseBody<T>(schema: z.ZodType<T, unknown>, body: unknown): T {
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
  draftId: string,
): Promise<DraftRow | undefined> {
  const [row] = await tx<DraftRow[]>`
    SELECT * FROM core.registry_publication_drafts
    WHERE id = ${draftId}
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
    administratorPublicationPrepared: row.administrator_publication_prepared,
    disclosureApproved: row.disclosure_approved_by_subject_id !== null,
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
    const { session, actor, idempotencyKey } = requireMutationContext(request);
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
    const projectId = await authorizedProjectLookup(session, "registry.draft",
      () => withActor(sql, actor, tx => registrySubjectProjectId(tx, registryType, data.subjectId)), id => id);

    const effectiveRole = assertAuthorized(
      session,
      "registry.draft",
      projectResource(projectId, { sensitivity: "public" }),
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

    const response = await withActor(sql, actor, (tx) =>
      withIdempotency(tx, idempotencyKey, requestHash, async () => {
        if (registryType === "project") {
          await tx`SELECT id FROM core.projects WHERE id = ${projectId} FOR UPDATE`;
        }
        const subject = await resolvePublicationSubject(
          tx,
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
          tx, registryType, subject.projectId, data.projection, new Date(asOf),
        );

        assertDraftMatchesSubject(data, subject);

        const proposedAt = new Date(asOf);
        const projection = prepareDraftProjection(data, subject, proposedAt);
        const publicKey = registryType === "project" ? await projectDraftPublicKey(tx, data, projectId) : data.publicKey;
        const policyVersion = data.prepareAdministratorPublication ? ADMINISTRATOR_PUBLICATION_POLICY : data.policyVersion;
        const schemaVersion = data.prepareAdministratorPublication ? ADMINISTRATOR_PUBLICATION_SCHEMA : data.schemaVersion;

        // A key already published for another subject is not reused. Appending a version to
        // it would publish one subject's facts under another's key.
        const [existing] = await tx<{ subject_id: string }[]>`
          SELECT subject_id FROM core.registry_entries
          WHERE registry_type = ${registryType} AND public_key = ${publicKey}
        `;
        if (existing && existing.subject_id !== data.subjectId) {
          throw conflict("REGISTRY_KEY_TAKEN", "This public key belongs to another subject");
        }

        const id = randomUUID();
        try {
          await tx`
            INSERT INTO core.registry_publication_drafts (
              id, registry_type, subject_id, public_key, projection,
              source_snapshot_hash, commercial_reuse, published_as_commercial_basis,
              policy_version, schema_version, contains_person_level_identifier,
              lawful_basis, purpose, retention, irreversibility_acknowledged_at,
              proposed_by_subject_id, proposed_at, administrator_publication_prepared
            ) VALUES (
              ${id}, ${registryType}, ${data.subjectId}, ${publicKey},
              ${tx.json(projection as never)}, ${subject.sourceSnapshotHash},
              ${subject.commercialReuse}, ${data.publishedAsCommercialBasis},
              ${policyVersion}, ${schemaVersion}, ${data.containsPersonLevelIdentifier},
              ${record?.lawfulBasis ?? null}, ${record?.purpose ?? null},
              ${record?.retention ?? null}, ${record ? new Date() : null},
              ${proposer}, ${proposedAt}, ${data.prepareAdministratorPublication}
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
          session,
          command: "registry.version.drafted",
          resourceType: "registry_publication_draft",
          resourceId: id,
          afterVersion: 1,
          correlationId,
          requestIp: request.clientIp,
          detail: {
            registryType,
            publicKey,
            sourceSnapshotHash: subject.sourceSnapshotHash,
            commercialReuse: subject.commercialReuse,
            containsPersonLevelIdentifier: data.containsPersonLevelIdentifier,
          },
        });

        const [row] = await tx<DraftRow[]>`
          SELECT * FROM core.registry_publication_drafts WHERE id = ${id}
        `;
        return { ...toDraft(row!), requestId, asOf };
      }),
    );
    return normalizeDraftResponse(response);
  });

  app.get("/api/v1/registry-entries/drafts", async (request) => {
    const { session, actor } = requireReadContext(request);
    const scope = visibleProjectScope(session, "registry.read");
    if (scope !== "all" && scope.length === 0) {
      assertAuthorized(session, "registry.read", registryResource({ sensitivity: "public", filteredByProjectScope: true }), sessionFacts(session));
    }
    const query = registryDraftListQuery.safeParse(request.query);
    if (!query.success) {
      throw badRequest("REQUEST_INVALID", "Query is invalid", { issues: query.error.issues });
    }
    const { subjectId, state } = query.data;
    const { requestId, asOf } = request.context;

    const rows = await withActor(sql, actor, (tx) =>
      tx<DraftRow[]>`
        SELECT d.* FROM core.registry_publication_drafts d
        LEFT JOIN core.verification_attestations a ON d.registry_type='verification' AND a.id=d.subject_id
        LEFT JOIN core.verification_cases vc ON vc.id=a.case_id
        WHERE ${scope === "all" ? tx`TRUE` : tx`(CASE WHEN d.registry_type='project' THEN d.subject_id ELSE vc.project_id END) = ANY(${scope as string[]}::uuid[])`}
          ${subjectId ? tx`AND d.subject_id = ${subjectId}` : tx``}
          ${state ? tx`AND d.state = ${state}::core.registry_draft_state` : tx``}
        ORDER BY d.proposed_at DESC
        LIMIT 100
      `,
    );
    return { items: rows.map(toDraft), requestId, asOf };
  });

  registerDraftDisclosureApproval(app, sql);

  app.post<{ Params: { draftId: string } }>(
    "/api/v1/registry-entries/drafts/:draftId/reject",
    async (request, reply) => {
      const { session, actor, idempotencyKey } = requireMutationContext(request);
      const expected = requireIfMatch(request);
      const target = await authorizedProjectLookup(session, "registry.draft.reject",
        () => draftPublicationTarget(sql, actor, request.params.draftId), (value) => value.projectId);
      const decider = subjectOf(session);
      const resource = projectResource(target.projectId, {
        sensitivity: "public", state: "pending", statesAllowingAction: ["pending"],
      });
      // Prefer administrator authority on an own draft, but allow an in-scope reviewer to reject it.
      const eligibleRoles = target.proposer === decider ? ["administrator", "reviewer"] : ["reviewer"];
      const effectiveRole = assertAuthorized(session, "registry.draft.reject", resource, sessionFacts(session), eligibleRoles);
      const body = parseBody(rejectRegistryDraftRequest, request.body);
      const { requestId, asOf, correlationId } = request.context;

      const response = await withActor(sql, actor, (tx) =>
        withIdempotency(tx, idempotencyKey, hashRequest(request), async () => {
          const draft = await lockDraft(tx, request.params.draftId);
          if (!draft) throw notFound("Draft not found");
          assertVersionMatches(expected, draft.version, "registry_publication_draft");
          if (draft.state !== "pending") {
            throw unprocessable("REGISTRY_DRAFT_ALREADY_DECIDED", "Draft is already decided", {
              state: draft.state,
            });
          }

          await tx`
            UPDATE core.registry_publication_drafts
            SET state = 'rejected', decided_by_subject_id = ${decider}, decided_at = now(),
                decision_reason = ${body.reason}, version = version + 1
            WHERE id = ${draft.id}
          `;

          await recordAudit(tx, {
            effectiveRole,
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
          const row = await lockDraft(tx, draft.id);
          return { ...toDraft(row!), requestId, asOf };
        }),
      );
      return normalizeDraftResponse(response);
    },
  );
}

function registerDraftDisclosureApproval(app: FastifyInstance, sql: postgres.Sql): void {
  app.post<{ Params: { draftId: string } }>(
    "/api/v1/registry-entries/drafts/:draftId/approve-disclosure",
    async (request, reply) => {
      const { session, actor, idempotencyKey } = requireMutationContext(request);
      const expected = requireIfMatch(request);
      const target = await authorizedProjectLookup(session, "registry.draft.approve",
        () => draftPublicationTarget(sql, actor, request.params.draftId), (value) => value.projectId);
      const reviewer = subjectOf(session);
      const effectiveRole = assertAuthorized(session, "registry.draft.approve", projectResource(target.projectId, {
        sensitivity: "public", separationSensitive: true,
      }), sessionFacts(session));
      if (reviewer === target.proposer) {
        throw unprocessable("REGISTRY_DRAFT_SELF_APPROVAL", "A different reviewer must approve disclosure");
      }
      parseBody(approveRegistryDraftDisclosureRequest, request.body);
      const { asOf, requestId, correlationId } = request.context;
      const response = await withActor(sql, actor, (tx) =>
        withIdempotency(tx, idempotencyKey, hashRequest(request), async () => {
          const draft = await lockDraft(tx, request.params.draftId);
          if (!draft) throw notFound("Draft not found");
          assertVersionMatches(expected, draft.version, "registry_publication_draft");
          if (draft.state !== "pending" || !draft.administrator_publication_prepared
            || draft.registry_type !== "project" || draft.disclosure_approved_by_subject_id !== null) {
            throw unprocessable("REGISTRY_DRAFT_DISCLOSURE_NOT_PENDING", "This draft is not awaiting disclosure approval");
          }
          await tx`SELECT set_config('app.registry_publication_session_id', ${session.sessionId}, true)`;
          const [approved] = await tx<DraftRow[]>`
            UPDATE core.registry_publication_drafts
            SET disclosure_approved_by_subject_id = ${reviewer},
                version = version + 1
            WHERE id = ${draft.id}
            RETURNING *
          `.catch((error: unknown) => {
            if ((error as { constraint_name?: string } | null)?.constraint_name === "registry_draft_disclosure_approval_authority") {
              throw forbidden("REGISTRY_DISCLOSURE_APPROVAL_DENIED", "This session can no longer approve disclosure");
            }
            throw error;
          });
          await recordAudit(tx, {
            effectiveRole, session, projectId: target.projectId, command: "registry.version.draft_disclosure_approved",
            resourceType: "registry_publication_draft", resourceId: draft.id,
            beforeVersion: draft.version, afterVersion: approved!.version, correlationId, requestIp: request.clientIp,
          });
          return { ...toDraft(approved!), requestId, asOf };
        }),
      );
      reply.header("etag", etagOf(response.version));
      return response;
    },
  );
}

/** Completed idempotency snapshots from before migration 0172 omit this field. */
function normalizeDraftResponse<T extends { administratorPublicationPrepared?: boolean }>(response: T & { disclosureApproved?: boolean }) {
  return { ...response, administratorPublicationPrepared: response.administratorPublicationPrepared ?? false,
    disclosureApproved: response.disclosureApproved ?? false };
}

function assertDraftMatchesSubject(
  data: z.infer<typeof createRegistryDraftRequest>,
  subject: PublicationSubject,
): void {
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
}

async function projectDraftPublicKey(
  tx: postgres.TransactionSql,
  data: z.infer<typeof createRegistryDraftRequest>,
  projectId: string,
): Promise<string> {
  const safeKey = administratorPublicKey(projectId);
  const [existing] = await tx<{ public_key: string }[]>`
    SELECT public_key FROM core.registry_entries
    WHERE registry_type = 'project' AND subject_id = ${projectId}
      AND public_key IN (${data.publicKey}, ${safeKey})
    ORDER BY (public_key = ${data.publicKey}) DESC LIMIT 1
  `;
  if (!existing && !data.prepareAdministratorPublication
    && /^PRJ-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(data.publicKey)) {
    throw unprocessable("REGISTRY_PUBLIC_KEY_RESERVED", "This public key format is reserved for Registry-generated project keys");
  }
  if (data.prepareAdministratorPublication && existing && existing.public_key !== safeKey) {
    throw unprocessable("ADMINISTRATOR_PUBLIC_KEY_REVIEW_REQUIRED", "This project has an existing public key. Create a reviewer publication draft to preserve its public history");
  }
  const [pending] = await tx`
    SELECT id FROM core.registry_publication_drafts
    WHERE registry_type = 'project' AND subject_id = ${projectId} AND state = 'pending'
    LIMIT 1
  `;
  if (pending) throw conflict("REGISTRY_DRAFT_PENDING", "A draft for this project is already waiting. Publish or reject it first");
  return existing?.public_key ?? (data.prepareAdministratorPublication ? safeKey : data.publicKey);
}

function prepareDraftProjection(
  data: z.infer<typeof createRegistryDraftRequest>,
  subject: PublicationSubject,
  proposedAt: Date,
): Record<string, unknown> {
  if (!data.prepareAdministratorPublication) return data.projection;

  if (data.registryType !== "project" || data.containsPersonLevelIdentifier || subject.projectVersion === undefined) {
    throw unprocessable("ADMINISTRATOR_PROJECTION_INELIGIBLE", "This draft requires independent publication");
  }
  const prepared = administratorProjectProjection.safeParse({
    ...data.projection,
    status: subject.publishedStatus,
    version: String(subject.projectVersion),
    asOf: proposedAt.toISOString(),
    sourceAge: null,
    staleStatus: "unknown",
  });
  if (!prepared.success) {
    throw unprocessable("ADMINISTRATOR_PROJECTION_INELIGIBLE", "This projection requires independent publication");
  }
  const solo = administratorSoloProjectProjection.safeParse({
    stableId: subject.projectId,
    hostCountry: subject.identity["hostCountry"],
    status: prepared.data.status,
    version: prepared.data.version,
    asOf: prepared.data.asOf,
    sourceAge: prepared.data.sourceAge,
    staleStatus: prepared.data.staleStatus,
    limitations: prepared.data.limitations,
    legalEffect: "none",
    disclaimerCodes: prepared.data.disclaimerCodes,
  });
  if (!solo.success) {
    throw unprocessable("ADMINISTRATOR_PROJECTION_INELIGIBLE", "This projection requires independent publication");
  }
  return solo.data;
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
    // `claimSummary` requires independent review at publication.
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
