import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { z } from "zod";
import type { Hex as ViemHex } from "viem";
import { withTenant } from "@mpc/db";
import {
  attestationMachine,
  canTransition,
  checkAttestationSignable,
  evaluateCredentialApplicability,
  verificationCaseMachine,
  type AttestationState,
  type AttestationType,
  type ConflictStatus,
  type CredentialCurrentStatus,
  type VerificationCaseState,
} from "@mpc/domain";
import type { AppConfig } from "../config.js";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../errors.js";
import {
  assertAuthorized,
  projectResource,
  sessionFacts,
  tenantResource,
} from "../plugins/authorize.js";
import { hashRequest, withIdempotency } from "../plugins/idempotency.js";
import { ROLE_ASSIGNMENT_BOUND, recordAudit } from "../audit.js";
import { enqueueEvent } from "../outbox.js";
import {
  assertVersionMatches,
  requireIfMatch,
  requireMutationContext,
  requireReadContext,
} from "./shared.js";
import { buildEvidenceSnapshot } from "../services/evidence-snapshot.js";
import {
  buildTypedData,
  hashAttestationPayload,
  humanReadablePayload,
  newSignatureNonce,
  recoverAttestationSigner,
  uuidToBytes32,
  type AttestationMessage,
} from "../services/attestation-signing.js";

/**
 * Verification Case and Attestation — spec 03 §stage 3, 04 §4.4, 07 §7.2.
 *
 * What this route guarantees:
 *
 * - A signature without `limitations` is impossible (AC-01). Two layers: domain check + DB CHECK.
 * - The server does not sign on anyone's behalf. It only creates signature requests and
 *   verifies results.
 * - A signature request is used only once.
 * - If the evidence snapshot changes after the request, the request is void.
 * - Credential status at signing time is preserved (AC-17).
 */

const SIGNATURE_REQUEST_TTL_MS = 10 * 60 * 1000;

const createCaseSchema = z.object({
  projectId: z.string().uuid(),
  schemaId: z.string().uuid(),
  claimIds: z.array(z.string().uuid()).min(1, "A review cannot be created without evidence"),
  reviewerSubjectId: z.string().uuid(),
  credentialId: z.string().uuid(),
  conflictStatus: z.enum(["none", "disclosed_resolved", "unresolved"]).default("none"),
});

const createAttestationSchema = z.object({
  assignmentId: z.string().uuid(),
  attestationType: z.enum([
    "professional_signoff",
    "laboratory_accreditation",
    "independent_assurance",
    "legal_notarization",
    "cryptographic_attestation",
  ]),
  claimScope: z.array(z.string().uuid()).min(1),
  findings: z.array(z.record(z.string())).default([]),
  citations: z.array(z.record(z.string())).default([]),
  limitations: z.string().min(1, "limitations cannot be empty"),
});

const submitSignatureSchema = z.object({
  signatureRequestId: z.string().uuid(),
  signature: z.string().regex(/^0x[0-9a-f]+$/),
});

/**
 * The project the resource belongs to.
 *
 * Authorization runs **outside** the idempotency block. Replay returns the stored response
 * as is, so inside it a request replaying someone else's key would skip authorization.
 */
async function caseProjectId(
  sql: postgres.Sql,
  tenantId: string,
  caseId: string,
): Promise<string> {
  const [row] = await withTenant(sql, { tenantId }, (tx) =>
    tx<{ project_id: string }[]>`
      SELECT project_id FROM core.verification_cases WHERE id = ${caseId}
    `,
  );
  if (!row) throw notFound("Verification case not found");
  return row.project_id;
}

async function attestationProjectId(
  sql: postgres.Sql,
  tenantId: string,
  attestationId: string,
): Promise<string> {
  const [row] = await withTenant(sql, { tenantId }, (tx) =>
    tx<{ project_id: string }[]>`
      SELECT vc.project_id
      FROM core.verification_attestations a
      JOIN core.verification_cases vc ON vc.id = a.case_id
      WHERE a.id = ${attestationId}
    `,
  );
  if (!row) throw notFound("Attestation not found");
  return row.project_id;
}

/**
 * The drafting checks for a signature request (W-085), outside the idempotency block.
 *
 * The response carries the draft's typed data and human-readable payload, and the request row is
 * the only way to sign. Inside the block a replay of the assignee's key would return that response
 * to anyone in the tenant without running these checks.
 *
 * Ownership comes first, so a non-assignee cannot learn whether someone else's draft is signed.
 */
async function authorizeSignatureRequest(
  sql: postgres.Sql,
  tenantId: string,
  attestationId: string,
  session: ReturnType<typeof requireMutationContext>["session"],
): Promise<ReturnType<typeof assertAuthorized>> {
  const [row] = await withTenant(sql, { tenantId }, (tx) =>
    tx<
      {
        state: string;
        project_id: string;
        case_state: string;
        assignment_subject: string;
        conflict_status: ConflictStatus;
        assignment_revoked: Date | null;
        credential_status: CredentialCurrentStatus;
      }[]
    >`
      SELECT a.state, vc.project_id, vc.state AS case_state,
             asg.subject_id AS assignment_subject, asg.conflict_status,
             asg.revoked_at AS assignment_revoked,
             c.current_status AS credential_status
      FROM core.verification_attestations a
      JOIN core.verification_cases vc ON vc.id = a.case_id
      JOIN core.assignments asg ON asg.id = a.assignment_id
      JOIN core.credentials c ON c.id = a.credential_id
      WHERE a.id = ${attestationId}
    `,
  );
  if (!row) throw notFound("Attestation not found");

  if (row.assignment_subject !== session.subjectId) {
    throw forbidden(
      "ASSIGNMENT_NOT_OWNED",
      "This assignment belongs to another reviewer",
      { requiredAction: "Request a signature on a case assigned to you" },
    );
  }

  // The same order as before the move: a signed draft answers 409 before the case state, which
  // signing moved on, is judged.
  if (row.state !== "draft") {
    throw conflict("ATTESTATION_ALREADY_SIGNED", "Attestation is already signed");
  }

  return assertAuthorized(
    session,
    "attestation.sign",
    projectResource(tenantId, row.project_id, {
      state: row.case_state,
      statesAllowingAction: ["assigned", "in_review", "changes_requested"],
      requiresCredential: true,
      requiresAssignment: true,
      separationSensitive: true,
    }),
    sessionFacts(session, {
      hasRequiredCredential: row.credential_status === "valid",
      hasRequiredAssignment: row.assignment_revoked === null,
      conflictStatus: row.conflict_status,
    }),
  );
}

async function disputeProjectId(
  sql: postgres.Sql,
  tenantId: string,
  disputeId: string,
): Promise<string> {
  const [row] = await withTenant(sql, { tenantId }, (tx) =>
    tx<{ project_id: string }[]>`
      SELECT vc.project_id
      FROM core.attestation_disputes d
      JOIN core.verification_attestations a ON a.id = d.attestation_id
      JOIN core.verification_cases vc ON vc.id = a.case_id
      WHERE d.id = ${disputeId}
    `,
  );
  if (!row) throw notFound("Dispute not found");
  return row.project_id;
}

export async function registerVerificationRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
  config: AppConfig,
): Promise<void> {
  // --- Verification Case ---------------------------------------------------

  app.post("/api/v1/verification-cases", async (request) => {
    const { session, tenantId, idempotencyKey } = requireMutationContext(request);

    const parsed = createCaseSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest("REQUEST_INVALID", "Request format is invalid", {
        issues: parsed.error.issues,
      });
    }

    const effectiveRole = assertAuthorized(
      session,
      "claim.curate",
      projectResource(tenantId, parsed.data.projectId),
      sessionFacts(session),
    );

    const { requestId, asOf, correlationId } = request.context;
    const requestHash = hashRequest(request.body);
    const data = parsed.data;

    return withTenant(sql, { tenantId }, (tx) =>
      withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
        const snapshot = await buildEvidenceSnapshot(tx, data.projectId, data.claimIds);

        const caseId = randomUUID();
        await tx`
          INSERT INTO core.verification_cases (
            id, tenant_id, project_id, schema_id, state, evidence_snapshot_hash
          ) VALUES (
            ${caseId}, ${tenantId}, ${data.projectId}, ${data.schemaId},
            'assigned', ${snapshot.hash}
          )
        `;

        // Preserves the review scope. The snapshot hash only tells whether it changed; it cannot
        // restore what it was (0011).
        for (const claimId of snapshot.claimIds) {
          await tx`
            INSERT INTO core.verification_case_claims (tenant_id, case_id, claim_id)
            VALUES (${tenantId}, ${caseId}, ${claimId})
          `;
        }

        const assignmentId = randomUUID();
        await tx`
          INSERT INTO core.assignments (
            id, tenant_id, case_id, subject_id, credential_id,
            independence_reviewed, conflict_status
          ) VALUES (
            ${assignmentId}, ${tenantId}, ${caseId}, ${data.reviewerSubjectId},
            ${data.credentialId}, true, ${data.conflictStatus}
          )
        `;

        await recordAudit(tx, {
          effectiveRole,
          tenantId,
          projectId: data.projectId,
          session,
          command: "verification.case.assigned",
          resourceType: "verification_case",
          resourceId: caseId,
          correlationId,
          requestIp: request.ip,
          detail: { assignmentId, claimCount: data.claimIds.length },
        });

        await enqueueEvent(tx, {
          tenantId,
          eventType: "verification.case.assigned",
          aggregateId: caseId,
          aggregateVersion: 1,
          projectId: data.projectId,
          payload: { evidenceSnapshotHash: snapshot.hash },
          correlationId,
        });

        return {
          id: caseId,
          assignmentId,
          projectId: data.projectId,
          schemaId: data.schemaId,
          state: "assigned",
          evidenceSnapshotHash: snapshot.hash,
          claimIds: snapshot.claimIds,
          requestId,
          asOf,
        };
      }),
    );
  });

  // --- Case list -----------------------------------------------------------

  /**
   * The path by which an assigned reviewer finds their own cases.
   *
   * The assigner (`data_steward`) and the signer (reviewer) are different people.
   * Without a list the reviewer has no way to reach their assignment. RLS limits reads to the
   * tenant; whether signing is allowed is judged separately when the attestation is created —
   * what one can see and what one can do are different questions.
   */
  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/verification-cases",
    async (request) => {
      const { session, tenantId } = requireReadContext(request);

      assertAuthorized(
        session,
        "verification.read",
        projectResource(tenantId, request.params.projectId),
        sessionFacts(session),
      );

      const { requestId, asOf } = request.context;

      const rows = await withTenant(sql, { tenantId }, (tx) =>
        tx<
          {
            id: string;
            project_id: string;
            schema_id: string;
            state: string;
            evidence_snapshot_hash: string;
            assignment_id: string;
            reviewer_subject_id: string;
            assigned_at: Date;
            claim_ids: string[] | null;
            version: number;
            transitions: unknown[] | null;
          }[]
        >`
          SELECT vc.id, vc.project_id, vc.schema_id, vc.state,
                 vc.evidence_snapshot_hash, vc.version,
                 a.id AS assignment_id, a.subject_id AS reviewer_subject_id,
                 a.assigned_at,
                 (
                   SELECT coalesce(
                     json_agg(
                       json_build_object(
                         'fromState', ct.from_state,
                         'toState', ct.to_state,
                         'reason', ct.reason,
                         'occurredAt', ct.occurred_at
                       ) ORDER BY ct.occurred_at
                     ),
                     '[]'::json
                   )
                   FROM core.verification_case_transitions ct
                   WHERE ct.case_id = vc.id
                 ) AS transitions,
                 (
                   SELECT array_agg(cc.claim_id ORDER BY cc.claim_id)
                   FROM core.verification_case_claims cc
                   WHERE cc.case_id = vc.id
                 ) AS claim_ids
          FROM core.verification_cases vc
          JOIN core.assignments a ON a.case_id = vc.id AND a.revoked_at IS NULL
          WHERE vc.project_id = ${request.params.projectId}
          ORDER BY a.assigned_at DESC
        `,
      );

      return {
        items: rows.map((row) => ({
          id: row.id,
          projectId: row.project_id,
          assignmentId: row.assignment_id,
          schemaId: row.schema_id,
          state: row.state,
          evidenceSnapshotHash: row.evidence_snapshot_hash,
          claimIds: row.claim_ids ?? [],
          reviewerSubjectId: row.reviewer_subject_id,
          assignedAt: row.assigned_at.toISOString(),
          version: row.version,
          transitions: row.transitions ?? [],
        })),
        requestId,
        asOf,
      };
    },
  );

  // --- Case state transition -----------------------------------------------

  /**
   * Changes a review case's state — 04 §4.4.
   *
   * Records requests for changes, rejections, and cancellations. Without it a review is either
   * "signed or nothing", and finding bad evidence leaves nowhere to record it.
   *
   * The domain state machine judges whether a transition is allowed. If the route rewrote
   * the conditions it would diverge from the state machine.
   *
   * After `signed` this path is closed. Reversing a signed review is not a state change but
   * a dispute or a supersede.
   */
  const transitionSchema = z.object({
    toState: z.enum(["in_review", "changes_requested", "declined", "cancelled"]),
    reason: z.string().min(1, "Reason for the state change cannot be empty"),
  });

  app.post<{ Params: { caseId: string } }>(
    "/api/v1/verification-cases/:caseId/transitions",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      const expectedVersion = requireIfMatch(request);

      const parsed = transitionSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "Request format is invalid", {
          issues: parsed.error.issues,
        });
      }

      const effectiveRole = assertAuthorized(
        session,
        "claim.curate",
        projectResource(tenantId, await caseProjectId(sql, tenantId, request.params.caseId)),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request.body);
      const { toState, reason } = parsed.data;

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          const [current] = await tx<
            { id: string; state: VerificationCaseState; version: number; project_id: string }[]
          >`
            SELECT id, state, version, project_id FROM core.verification_cases
            WHERE id = ${request.params.caseId}
            FOR UPDATE
          `;
          if (!current) throw notFound("Verification case not found");

          assertVersionMatches(expectedVersion, current.version, "verification_case");

          if (!canTransition(verificationCaseMachine, current.state, toState)) {
            throw conflict("INVALID_STATE_TRANSITION", "State transition not allowed", {
              fromState: current.state,
              toState,
              // Tells what can be done next. Blocking alone leaves the user guessing.
              allowedTransitions: [...(verificationCaseMachine.transitions[current.state] ?? [])],
            });
          }

          await tx`
            UPDATE core.verification_cases SET state = ${toState}
            WHERE id = ${current.id}
          `;

          // Records why it changed. With only the current state, the next person has no
          // basis for judgment.
          await tx`
            INSERT INTO core.verification_case_transitions (
              id, tenant_id, case_id, from_state, to_state, reason, actor_subject_id
            ) VALUES (
              ${randomUUID()}, ${tenantId}, ${current.id}, ${current.state},
              ${toState}, ${reason}, ${session.subjectId ?? null}
            )
          `;

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            projectId: current.project_id,
            session,
            command: "verification.case.transitioned",
            resourceType: "verification_case",
            resourceId: current.id,
            beforeVersion: current.version,
            afterVersion: current.version + 1,
            reason,
            correlationId,
            requestIp: request.ip,
            detail: { fromState: current.state, toState },
          });

          await enqueueEvent(tx, {
            tenantId,
            eventType: "verification.case.transitioned",
            aggregateId: current.id,
            aggregateVersion: current.version + 1,
            projectId: current.project_id,
            payload: { fromState: current.state, toState },
            correlationId,
          });

          return {
            id: current.id,
            state: toState,
            previousState: current.state,
            version: current.version + 1,
            reason,
            requestId,
            asOf,
          };
        }),
      );
    },
  );

  // --- Attestation dispute --------------------------------------------------

  /**
   * Disputes a signed attestation — 04 §4.2.
   *
   * **The signature is not erased.** The judgment at signing time stays, and a new fact,
   * `disputed`, is added. Deleting the signature loses "who judged what, when", which
   * is indistinguishable from hiding a bad review.
   *
   * A dispute is not a ruling that the review is wrong. It marks that it needs another look.
   */
  const disputeSchema = z.object({
    reasonCode: z.string().min(1),
    detail: z.string().min(1, "Dispute reason cannot be empty"),
  });

  app.post<{ Params: { attestationId: string } }>(
    "/api/v1/attestations/:attestationId/disputes",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);

      const parsed = disputeSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "Request format is invalid", {
          issues: parsed.error.issues,
        });
      }

      const effectiveRole = assertAuthorized(
        session,
        "attestation.dispute",
        projectResource(
          tenantId,
          await attestationProjectId(sql, tenantId, request.params.attestationId),
        ),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request.body);

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          const [attestation] = await tx<
            { id: string; state: AttestationState; payload_hash: string; case_id: string }[]
          >`
            SELECT id, state, payload_hash, case_id FROM core.verification_attestations
            WHERE id = ${request.params.attestationId}
            FOR UPDATE
          `;
          if (!attestation) throw notFound("Attestation not found");

          // If already disputed, the state stays and only the dispute is added. Others must be
          // able to raise disputes for other reasons; blocking the rest because one is open
          // leaves nowhere to record a second finding.
          const alreadyDisputed = attestation.state === "disputed";
          if (!alreadyDisputed && !canTransition(attestationMachine, attestation.state, "disputed")) {
            throw conflict("INVALID_STATE_TRANSITION", "Cannot dispute in this state", {
              fromState: attestation.state,
              toState: "disputed",
              allowedTransitions: [
                ...(attestationMachine.transitions[attestation.state] ?? []),
              ],
            });
          }

          await tx`
            INSERT INTO core.attestation_disputes (
              id, tenant_id, attestation_id, reason_code, detail, raised_by_subject_id
            ) VALUES (
              ${randomUUID()}, ${tenantId}, ${attestation.id}, ${parsed.data.reasonCode},
              ${parsed.data.detail}, ${session.subjectId ?? null}
            )
          `;

          // Only the state changes. payload_hash, signature, and limitations stay unchanged.
          await tx`
            UPDATE core.verification_attestations SET state = 'disputed'
            WHERE id = ${attestation.id}
          `;

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            session,
            command: "verification.attestation.disputed",
            resourceType: "verification_attestation",
            resourceId: attestation.id,
            reason: parsed.data.reasonCode,
            correlationId,
            requestIp: request.ip,
          });

          await enqueueEvent(tx, {
            tenantId,
            eventType: "verification_attestation.disputed",
            aggregateId: attestation.id,
            aggregateVersion: 1,
            payload: { reasonCode: parsed.data.reasonCode },
            correlationId,
          });

          return {
            id: attestation.id,
            state: "disputed",
            previousState: attestation.state,
            // The signed body did not change. The same hash remains.
            payloadHash: attestation.payload_hash,
            reasonCode: parsed.data.reasonCode,
            requestId,
            asOf,
          };
        }),
      );
    },
  );

  // --- Dispute lookup and resolution ----------------------------------------

  app.get<{ Params: { attestationId: string } }>(
    "/api/v1/attestations/:attestationId/disputes",
    async (request) => {
      const { session, tenantId } = requireReadContext(request);

      assertAuthorized(
        session,
        "verification.read",
        projectResource(
          tenantId,
          await attestationProjectId(sql, tenantId, request.params.attestationId),
        ),
        sessionFacts(session),
      );

      const { requestId, asOf } = request.context;

      const rows = await withTenant(sql, { tenantId }, (tx) =>
        tx<
          {
            id: string;
            attestation_id: string;
            reason_code: string;
            detail: string;
            raised_at: Date;
            resolved_at: Date | null;
            resolution: string | null;
          }[]
        >`
          SELECT id, attestation_id, reason_code, detail, raised_at, resolved_at, resolution
          FROM core.attestation_disputes
          WHERE attestation_id = ${request.params.attestationId}
          ORDER BY raised_at DESC
        `,
      );

      return {
        // Resolved disputes are shown too. Hiding them erases the fact that "an issue was once
        // raised", which is indistinguishable from covering up a bad review.
        items: rows.map((row) => ({
          id: row.id,
          attestationId: row.attestation_id,
          reasonCode: row.reason_code,
          detail: row.detail,
          raisedAt: row.raised_at.toISOString(),
          resolvedAt: row.resolved_at?.toISOString() ?? null,
          outcome: row.resolution ? row.resolution.split(":")[0]! : null,
          resolution: row.resolution,
        })),
        requestId,
        asOf,
      };
    },
  );

  /**
   * Dispute resolution — 04 §4.2.
   *
   * **The dispute record is not erased.** `resolved_at` and the outcome are only appended.
   *
   * If `upheld` (the dispute was right), the attestation does not return to `active` — once the
   * review is confirmed wrong it cannot be marked valid. Supersede or revoke is a separate
   * decision.
   *
   * If `dismissed` (the review stands), it returns to `active` only when no unresolved
   * disputes remain. Any remaining one means it still needs another look.
   */
  const resolveSchema = z.object({
    outcome: z.enum(["upheld", "dismissed"]),
    resolution: z.string().min(1, "Resolution rationale cannot be empty"),
  });

  app.post<{ Params: { disputeId: string } }>(
    "/api/v1/disputes/:disputeId/resolution",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);

      const parsed = resolveSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "Request format is invalid", {
          issues: parsed.error.issues,
        });
      }

      const effectiveRole = assertAuthorized(
        session,
        "attestation.dispute",
        projectResource(
          tenantId,
          await disputeProjectId(sql, tenantId, request.params.disputeId),
        ),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request.body);
      const { outcome, resolution } = parsed.data;

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          const [dispute] = await tx<
            { id: string; attestation_id: string; resolved_at: Date | null }[]
          >`
            SELECT id, attestation_id, resolved_at FROM core.attestation_disputes
            WHERE id = ${request.params.disputeId}
            FOR UPDATE
          `;
          if (!dispute) throw notFound("Dispute not found");

          if (dispute.resolved_at) {
            throw conflict("DISPUTE_ALREADY_RESOLVED", "Dispute is already resolved", {
              resolvedAt: dispute.resolved_at.toISOString(),
            });
          }

          await tx`
            UPDATE core.attestation_disputes
            SET resolved_at = now(), resolution = ${`${outcome}: ${resolution}`}
            WHERE id = ${dispute.id}
          `;

          // While unresolved disputes remain, the attestation stays disputed.
          const [remaining] = await tx<{ count: string }[]>`
            SELECT count(*)::text AS count FROM core.attestation_disputes
            WHERE attestation_id = ${dispute.attestation_id} AND resolved_at IS NULL
          `;

          let attestationState = "disputed";
          if (outcome === "dismissed" && Number(remaining?.count ?? "1") === 0) {
            // The review stands. All disputes are resolved, so it returns to active.
            await tx`
              UPDATE core.verification_attestations SET state = 'active'
              WHERE id = ${dispute.attestation_id} AND state = 'disputed'
            `;
            attestationState = "active";
          }

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            session,
            command: "verification.dispute.resolved",
            resourceType: "attestation_dispute",
            resourceId: dispute.id,
            reason: outcome,
            correlationId,
            requestIp: request.ip,
            detail: { attestationId: dispute.attestation_id, attestationState },
          });

          return {
            id: dispute.id,
            attestationId: dispute.attestation_id,
            outcome,
            resolution,
            resolvedAt: new Date().toISOString(),
            // An upheld dispute does not restore the review to valid. Supersede or revoke is a
            // separate decision.
            attestationState,
            unresolvedDisputes: Number(remaining?.count ?? "0"),
            requestId,
            asOf,
          };
        }),
      );
    },
  );

  // --- Attestation draft ----------------------------------------------------

  app.post<{ Params: { caseId: string } }>(
    "/api/v1/verification-cases/:caseId/attestations",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);

      const parsed = createAttestationSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "Request format is invalid", {
          issues: parsed.error.issues,
        });
      }

      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request.body);
      const data = parsed.data;

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          const [context] = await tx<
            {
              case_state: string;
              schema_state: string;
              schema_id: string;
              project_id: string;
              assignment_subject: string;
              credential_id: string;
              conflict_status: ConflictStatus;
              assignment_revoked: Date | null;
              credential_status: CredentialCurrentStatus;
              credential_scope: string[];
              signer_wallet: string | null;
            }[]
          >`
            SELECT
              vc.state AS case_state, s.state AS schema_state, vc.schema_id,
              vc.project_id, a.subject_id AS assignment_subject, a.credential_id,
              a.conflict_status, a.revoked_at AS assignment_revoked,
              c.current_status AS credential_status, c.credential_scope,
              w.wallet_address AS signer_wallet
            FROM core.verification_cases vc
            JOIN core.attestation_schemas s ON s.id = vc.schema_id
            JOIN core.assignments a ON a.id = ${data.assignmentId} AND a.case_id = vc.id
            JOIN core.credentials c ON c.id = a.credential_id
            LEFT JOIN core.wallet_identities w
              ON w.subject_id = a.subject_id AND w.disabled_at IS NULL
            WHERE vc.id = ${request.params.caseId}
          `;

          if (!context) throw notFound("Verification case not found");

          /**
           * Only the assignee drafts under their own assignment — 02 §2.9, invariant 13.
           *
           * Without this check anyone with the reviewer role could draft with **someone else's
           * assignmentId**, and that row would carry the assignee's wallet as signer. Final signing
           * checks the recovered address against the assignee's wallet, so it stops short of a forged
           * signature, but until then findings under someone else's name remain.
           *
           * A role check cannot stop this — every reviewer in the same tenant has the same
           * role.
           */
          if (context.assignment_subject !== session.subjectId) {
            throw forbidden(
              "ASSIGNMENT_NOT_OWNED",
              "This assignment belongs to another reviewer",
              { requiredAction: "Draft from a case assigned to you" },
            );
          }

          const effectiveRole = assertAuthorized(
            session,
            "attestation.sign",
            projectResource(tenantId, context.project_id, {
              state: context.case_state,
              statesAllowingAction: ["assigned", "in_review", "changes_requested"],
              requiresCredential: true,
              requiresAssignment: true,
              separationSensitive: true,
            }),
            sessionFacts(session, {
              hasRequiredCredential: context.credential_status === "valid",
              hasRequiredAssignment: context.assignment_revoked === null,
              conflictStatus: context.conflict_status,
            }),
          );

          // The domain judges whether signing is allowed. The route does not restate the conditions.
          const check = checkAttestationSignable({
            attestationType: data.attestationType,
            claimScope: data.claimScope,
            limitations: data.limitations,
            conflictStatus: context.conflict_status,
            credentialValidAtSigningTime: context.credential_status === "valid",
            credentialScopeCoversClaims: context.credential_scope.length > 0,
            hasActiveAssignment: context.assignment_revoked === null,
            schemaState: context.schema_state as "active",
            signerSubmittedEvidence: false,
          });

          if (!check.allowed) {
            throw unprocessable(check.reason, "Cannot sign under these conditions");
          }

          const attestationId = randomUUID();
          const payloadHash = hashAttestationPayload({
            findings: data.findings,
            citations: data.citations,
            limitations: data.limitations,
            claimScope: data.claimScope,
          });

          await tx`
            INSERT INTO core.verification_attestations (
              id, tenant_id, case_id, assignment_id, credential_id, schema_id,
              attestation_type, claim_scope, evidence_snapshot_hash,
              findings, citations, limitations, credential_status_snapshot,
              method_version, policy_version, payload_hash, signature,
              signer_wallet_address, signed_at, state
            ) VALUES (
              ${attestationId}, ${tenantId}, ${request.params.caseId}, ${data.assignmentId},
              ${context.credential_id}, ${context.schema_id}, ${data.attestationType},
              ${data.claimScope as string[]}::uuid[],
              (SELECT evidence_snapshot_hash FROM core.verification_cases WHERE id = ${request.params.caseId}),
              ${tx.json(data.findings)}, ${tx.json(data.citations)}, ${data.limitations},
              ${tx.json({
                credentialId: context.credential_id,
                statusAtSigning: context.credential_status,
                validAtAttestationTime: context.credential_status === "valid",
              })},
              '1', '1', ${payloadHash}, '', ${context.signer_wallet ?? "0x" + "0".repeat(40)},
              now(), 'draft'
            )
          `;

          await tx`
            UPDATE core.verification_cases SET state = 'in_review'
            WHERE id = ${request.params.caseId} AND state = 'assigned'
          `;

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            projectId: context.project_id,
            session,
            command: "verification.attestation.drafted",
            resourceType: "verification_attestation",
            resourceId: attestationId,
            correlationId,
            requestIp: request.ip,
          });

          return {
            id: attestationId,
            caseId: request.params.caseId,
            state: "draft",
            attestationType: data.attestationType,
            claimScope: data.claimScope,
            limitations: data.limitations,
            payloadHash,
            requestId,
            asOf,
          };
        }),
      );
    },
  );

  // --- Signature request ----------------------------------------------------

  app.post<{ Params: { attestationId: string } }>(
    "/api/v1/attestations/:attestationId/signature-requests",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request.body ?? {});
      const effectiveRole = await authorizeSignatureRequest(
        sql,
        tenantId,
        request.params.attestationId,
        session,
      );

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          const [attestation] = await tx<
            {
              id: string;
              case_id: string;
              assignment_id: string;
              credential_id: string;
              schema_id: string;
              attestation_type: AttestationType;
              claim_scope: string[];
              limitations: string;
              payload_hash: string;
              state: string;
              evidence_snapshot_hash: string;
              project_key: string;
              current_snapshot: string;
              project_id: string;
              case_state: string;
              assignment_subject: string;
              conflict_status: ConflictStatus;
              assignment_revoked: Date | null;
              credential_status: CredentialCurrentStatus;
            }[]
          >`
            SELECT a.*, p.project_key,
                   vc.evidence_snapshot_hash AS current_snapshot,
                   vc.project_id, vc.state AS case_state,
                   asg.subject_id AS assignment_subject, asg.conflict_status,
                   asg.revoked_at AS assignment_revoked,
                   c.current_status AS credential_status
            FROM core.verification_attestations a
            JOIN core.verification_cases vc ON vc.id = a.case_id
            JOIN core.projects p ON p.id = vc.project_id
            JOIN core.assignments asg ON asg.id = a.assignment_id
            JOIN core.credentials c ON c.id = a.credential_id
            WHERE a.id = ${request.params.attestationId}
          `;

          if (!attestation) throw notFound("Attestation not found");

          // Ownership and authorization ran before the idempotency block (W-085).
          if (attestation.state !== "draft") {
            throw conflict("ATTESTATION_ALREADY_SIGNED", "Attestation is already signed");
          }

          const requestRowId = randomUUID();
          const nonce = newSignatureNonce();
          const issuedAt = BigInt(Math.floor(Date.now() / 1000));
          const expiresAt = BigInt(Math.floor((Date.now() + SIGNATURE_REQUEST_TTL_MS) / 1000));

          const message: AttestationMessage = {
            attestationId: uuidToBytes32(attestation.id),
            schemaId: uuidToBytes32(attestation.schema_id),
            schemaVersion: 1,
            evidenceSnapshotHash: attestation.evidence_snapshot_hash as ViemHex,
            assignmentId: uuidToBytes32(attestation.assignment_id),
            credentialId: uuidToBytes32(attestation.credential_id),
            payloadHash: attestation.payload_hash as ViemHex,
            issuedAt,
            expiresAt,
            nonce,
          };

          await tx`
            INSERT INTO core.attestation_signature_requests (
              id, tenant_id, attestation_id, nonce, evidence_snapshot_hash,
              payload_hash, issued_at, expires_at
            ) VALUES (
              ${requestRowId}, ${tenantId}, ${attestation.id}, ${nonce},
              ${attestation.evidence_snapshot_hash}, ${attestation.payload_hash},
              to_timestamp(${Number(issuedAt)}), to_timestamp(${Number(expiresAt)})
            )
          `;

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            projectId: attestation.project_id,
            session,
            command: "verification.signature_request.created",
            resourceType: "verification_attestation",
            resourceId: attestation.id,
            correlationId,
            requestIp: request.ip,
          });

          const typedData = buildTypedData(config, message);

          return {
            signatureRequestId: requestRowId,
            humanReadablePayload: humanReadablePayload({
              projectKey: attestation.project_key,
              attestationType: attestation.attestation_type,
              claimCount: attestation.claim_scope.length,
              limitations: attestation.limitations,
              evidenceSnapshotHash: attestation.evidence_snapshot_hash,
            }),
            typedData: {
              domain: typedData.domain,
              types: typedData.types,
              primaryType: typedData.primaryType,
              // bigint does not serialize to JSON. Sent as a decimal string so the client can
              // turn it back into a bigint.
              message: {
                ...message,
                issuedAt: issuedAt.toString(),
                expiresAt: expiresAt.toString(),
              },
            },
            payloadHash: attestation.payload_hash,
            nonce,
            expiresAt: new Date(Number(expiresAt) * 1000).toISOString(),
            requestId,
            asOf,
          };
        }),
      );
    },
  );

  // --- Signature submission -------------------------------------------------

  app.post<{ Params: { attestationId: string } }>(
    "/api/v1/attestations/:attestationId/signatures",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);

      const parsed = submitSignatureSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "Request format is invalid");
      }

      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request.body);

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          // Consumes the request atomically. A second submission finds no row.
          const [signatureRequest] = await tx<
            {
              id: string;
              attestation_id: string;
              nonce: string;
              evidence_snapshot_hash: string;
              payload_hash: string;
              issued_at: Date;
              expires_at: Date;
            }[]
          >`
            UPDATE core.attestation_signature_requests
            SET consumed_at = now()
            WHERE id = ${parsed.data.signatureRequestId}
              AND attestation_id = ${request.params.attestationId}
              AND consumed_at IS NULL
              AND expires_at > now()
            RETURNING *
          `;

          if (!signatureRequest) {
            throw conflict(
              "SIGNATURE_REQUEST_UNUSABLE",
              "This signature request has already been used or has expired",
            );
          }

          const [attestation] = await tx<
            {
              id: string;
              case_id: string;
              assignment_id: string;
              credential_id: string;
              schema_id: string;
              state: string;
              claim_scope: string[];
              current_snapshot: string;
              project_id: string;
              reviewer_wallet: string | null;
              credential_status: CredentialCurrentStatus;
            }[]
          >`
            SELECT a.id, a.case_id, a.assignment_id, a.credential_id, a.schema_id,
                   a.state, a.claim_scope, vc.evidence_snapshot_hash AS current_snapshot,
                   vc.project_id, w.wallet_address AS reviewer_wallet,
                   c.current_status AS credential_status
            FROM core.verification_attestations a
            JOIN core.verification_cases vc ON vc.id = a.case_id
            JOIN core.assignments asg ON asg.id = a.assignment_id
            JOIN core.credentials c ON c.id = a.credential_id
            LEFT JOIN core.wallet_identities w
              ON w.subject_id = asg.subject_id AND w.disabled_at IS NULL
            WHERE a.id = ${request.params.attestationId}
          `;

          if (!attestation) throw notFound("Attestation not found");

          // Snapshot substitution defense: if the evidence changed after the signature request,
          // it is void.
          if (attestation.current_snapshot !== signatureRequest.evidence_snapshot_hash) {
            throw conflict(
              "EVIDENCE_SNAPSHOT_CHANGED",
              "Evidence changed after the signature request. Create a new request.",
            );
          }

          const message: AttestationMessage = {
            attestationId: uuidToBytes32(attestation.id),
            schemaId: uuidToBytes32(attestation.schema_id),
            schemaVersion: 1,
            evidenceSnapshotHash: signatureRequest.evidence_snapshot_hash as ViemHex,
            assignmentId: uuidToBytes32(attestation.assignment_id),
            credentialId: uuidToBytes32(attestation.credential_id),
            payloadHash: signatureRequest.payload_hash as ViemHex,
            issuedAt: BigInt(Math.floor(signatureRequest.issued_at.getTime() / 1000)),
            expiresAt: BigInt(Math.floor(signatureRequest.expires_at.getTime() / 1000)),
            nonce: signatureRequest.nonce as ViemHex,
          };

          const signer = await recoverAttestationSigner(
            config,
            message,
            parsed.data.signature as ViemHex,
          );

          // Signature validity and authorization are separate facts (invariant 13). Checks
          // separately that the recovered address is the assignment's reviewer.
          if (
            attestation.reviewer_wallet === null ||
            signer !== attestation.reviewer_wallet.toLowerCase()
          ) {
            throw badRequest(
              "SIGNATURE_SIGNER_MISMATCH",
              "Signer is not the reviewer assigned to this case",
            );
          }

          const applicability = evaluateCredentialApplicability({
            validAtAttestationTime: true,
            currentStatus: attestation.credential_status,
          });

          await tx`
            UPDATE core.verification_attestations
            SET signature = ${parsed.data.signature},
                signer_wallet_address = ${signer},
                signed_at = now(),
                state = 'signed'
            WHERE id = ${attestation.id}
          `;

          await tx`
            UPDATE core.verification_cases SET state = 'signed' WHERE id = ${attestation.case_id}
          `;

          await recordAudit(tx, {
            effectiveRole: ROLE_ASSIGNMENT_BOUND,
            tenantId,
            projectId: attestation.project_id,
            session,
            command: "verification.case.signed",
            resourceType: "verification_attestation",
            resourceId: attestation.id,
            correlationId,
            requestIp: request.ip,
            detail: { signer },
          });

          await enqueueEvent(tx, {
            tenantId,
            eventType: "verification_attestation.signed",
            aggregateId: attestation.id,
            aggregateVersion: 1,
            projectId: attestation.project_id,
            payload: { attestationId: attestation.id },
            correlationId,
          });

          return {
            id: attestation.id,
            state: "signed",
            signerWalletAddress: signer,
            evidenceSnapshotHash: signatureRequest.evidence_snapshot_hash,
            ongoingApplicability: applicability.ongoingApplicability,
            pastSignatureRemainsValid: applicability.pastSignatureRemainsValid,
            requestId,
            asOf,
          };
        }),
      );
    },
  );
}
