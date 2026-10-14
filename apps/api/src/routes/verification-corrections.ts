import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { withTenant } from "@mpc/db";
import {
  attestationMachine,
  canChangeCredentialStatus,
  canTransition,
  verificationCaseMachine,
  type AttestationState,
  type CredentialCurrentStatus,
  type VerificationCaseState,
} from "@mpc/domain";
import {
  changeCredentialStatusRequest,
  reassignReviewerRequest,
  revokeAssignmentRequest,
  revokeAttestationRequest,
} from "@mpc/api-contract";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { assertAuthorized, projectResource, sessionFacts, tenantResource } from "../plugins/authorize.js";
import { hashRequest, withIdempotency } from "../plugins/idempotency.js";
import { recordAudit } from "../audit.js";
import { enqueueEvent } from "../outbox.js";
import { assignReviewer } from "../services/assignment.js";
import { reassessClaim, setProvenanceCause } from "../services/claim-state.js";
import {
  assertVersionMatches,
  requireIfMatch,
  requireMutationContext,
} from "./shared.js";

/**
 * Corrections to the review record — spec 02 §2.4·§2.6·§2.8, 04 §4.2, 07 §7.2,
 * REQ-DAPP-006·018·042·044.
 *
 * Every path here adds a fact; none deletes one. A revoked attestation keeps its signed body, a
 * revoked assignment keeps its row, a credential keeps its status history. The reader later can
 * always answer "what stood when, and who changed it".
 */

type Tx = postgres.TransactionSql;

/** Case states in which a reviewer still has work to do. After signing, the assignment is history. */
const REASSIGNABLE_CASE_STATES: readonly VerificationCaseState[] = [
  "assigned",
  "in_review",
  "changes_requested",
];

function invalidRequest(issues: unknown): never {
  throw badRequest("REQUEST_INVALID", "Request format is invalid", { issues });
}

async function assignmentContext(
  sql: postgres.Sql,
  tenantId: string,
  assignmentId: string,
): Promise<{ projectId: string }> {
  const [row] = await withTenant(sql, { tenantId }, (tx) =>
    tx<{ project_id: string }[]>`
      SELECT vc.project_id FROM core.assignments a
      JOIN core.verification_cases vc ON vc.id = a.case_id
      WHERE a.id = ${assignmentId}
    `,
  );
  if (!row) throw notFound("Assignment not found");
  return { projectId: row.project_id };
}

async function recordCaseTransition(
  tx: Tx,
  input: {
    tenantId: string;
    caseId: string;
    from: VerificationCaseState;
    to: VerificationCaseState;
    reason: string;
    actorSubjectId: string | null;
  },
): Promise<boolean> {
  if (!canTransition(verificationCaseMachine, input.from, input.to)) return false;
  await tx`UPDATE core.verification_cases SET state = ${input.to} WHERE id = ${input.caseId}`;
  await tx`
    INSERT INTO core.verification_case_transitions (
      id, tenant_id, case_id, from_state, to_state, reason, actor_subject_id
    ) VALUES (
      ${randomUUID()}, ${input.tenantId}, ${input.caseId}, ${input.from}, ${input.to},
      ${input.reason}, ${input.actorSubjectId}
    )
  `;
  return true;
}

export async function registerVerificationCorrectionRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  // --- Attestation revocation ------------------------------------------------

  /**
   * Revokes a signed attestation — 07 §7.2 `POST /attestations/{id}/revoke`.
   *
   * **Only its signer.** An attestation is a person's professional judgment; withdrawing it is
   * theirs to do. Anyone else who finds it wrong raises a dispute, which takes it out of standing
   * without putting words in the signer's mouth. `break_glass` cannot change an attestation
   * (02 §2.8), so no operations role is here.
   *
   * The signed body is untouched. The claims it covered are reassessed without it.
   */
  app.post<{ Params: { attestationId: string } }>(
    "/api/v1/attestations/:attestationId/revoke",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      const parsed = revokeAttestationRequest.safeParse(request.body);
      if (!parsed.success) invalidRequest(parsed.error.issues);

      const [owner] = await withTenant(sql, { tenantId }, (tx) =>
        tx<{ project_id: string; signer_subject: string }[]>`
          SELECT vc.project_id, asg.subject_id AS signer_subject
          FROM core.verification_attestations a
          JOIN core.verification_cases vc ON vc.id = a.case_id
          JOIN core.assignments asg ON asg.id = a.assignment_id
          WHERE a.id = ${request.params.attestationId}
        `,
      );
      if (!owner) throw notFound("Attestation not found");
      if (owner.signer_subject !== session.subjectId) {
        throw forbidden("ATTESTATION_NOT_OWNED", "Only the signer can revoke this attestation", {
          requiredAction: "Raise a dispute instead",
        });
      }
      const effectiveRole = assertAuthorized(
        session,
        "attestation.revoke",
        projectResource(tenantId, owner.project_id),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      const { reason } = parsed.data;

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
          const [attestation] = await tx<
            {
              id: string;
              state: AttestationState;
              case_id: string;
              case_state: VerificationCaseState;
              claim_scope: string[];
            }[]
          >`
            SELECT a.id, a.state, a.case_id, vc.state AS case_state, a.claim_scope
            FROM core.verification_attestations a
            JOIN core.verification_cases vc ON vc.id = a.case_id
            WHERE a.id = ${request.params.attestationId}
            FOR UPDATE OF a
          `;
          if (!attestation) throw notFound("Attestation not found");

          if (!canTransition(attestationMachine, attestation.state, "revoked")) {
            throw conflict("INVALID_STATE_TRANSITION", "This attestation cannot be revoked", {
              fromState: attestation.state,
              toState: "revoked",
              allowedTransitions: [...(attestationMachine.transitions[attestation.state] ?? [])],
            });
          }

          await tx`
            UPDATE core.verification_attestations
            SET state = 'revoked', revoked_at = now(), revoked_by = ${session.subjectId ?? null},
                revocation_reason = ${reason}
            WHERE id = ${attestation.id}
          `;

          const caseRevoked = await recordCaseTransition(tx, {
            tenantId,
            caseId: attestation.case_id,
            from: attestation.case_state,
            to: "revoked",
            reason: `Attestation revoked: ${reason}`,
            actorSubjectId: session.subjectId ?? null,
          });

          await setProvenanceCause(tx, `attestation_revoked:${attestation.id}`, session.subjectId ?? null);
          const reassessed = [];
          for (const claimId of [...attestation.claim_scope].sort()) {
            reassessed.push(await reassessClaim(tx, claimId));
          }

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            projectId: owner.project_id,
            session,
            command: "verification.attestation.revoked",
            resourceType: "verification_attestation",
            resourceId: attestation.id,
            reason,
            correlationId,
            requestIp: request.clientIp,
            detail: {
              fromState: attestation.state,
              caseRevoked,
              claims: reassessed.map((claim) => ({
                claimId: claim.claimId,
                fromState: claim.fromState,
                toState: claim.toState,
                grade: claim.grade,
              })),
            },
          });

          await enqueueEvent(tx, {
            tenantId,
            eventType: "verification_attestation.revoked",
            aggregateId: attestation.id,
            aggregateVersion: 1,
            projectId: owner.project_id,
            payload: { attestationId: attestation.id, reason },
            correlationId,
          });
          if (caseRevoked) {
            await enqueueEvent(tx, {
              tenantId,
              eventType: "verification.case.revoked",
              aggregateId: attestation.case_id,
              aggregateVersion: 1,
              projectId: owner.project_id,
              payload: { attestationId: attestation.id },
              correlationId,
            });
          }

          return {
            id: attestation.id,
            state: "revoked",
            previousState: attestation.state,
            revocationReason: reason,
            caseState: caseRevoked ? "revoked" : attestation.case_state,
            claims: reassessed.map((claim) => ({
              claimId: claim.claimId,
              verificationState: claim.toState,
              grade: claim.grade,
            })),
            requestId,
            asOf,
          };
        }),
      );
    },
  );

  // --- Assignment revocation and reassignment -------------------------------

  /**
   * Removes the reviewer from a case — REQ-DAPP-018·044.
   *
   * The row stays with who removed it and why. The reviewer's unsigned drafts stay too, but can
   * no longer be signed: signing checks for an active assignment.
   */
  app.post<{ Params: { assignmentId: string } }>(
    "/api/v1/assignments/:assignmentId/revoke",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      const parsed = revokeAssignmentRequest.safeParse(request.body);
      if (!parsed.success) invalidRequest(parsed.error.issues);

      const { projectId } = await assignmentContext(sql, tenantId, request.params.assignmentId);
      const effectiveRole = assertAuthorized(
        session,
        "claim.curate",
        projectResource(tenantId, projectId),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      const { reason } = parsed.data;

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
          const current = await lockAssignment(tx, request.params.assignmentId);
          if (current.revoked_at !== null) {
            throw conflict("ASSIGNMENT_ALREADY_REVOKED", "This assignment is already revoked", {
              revokedAt: current.revoked_at.toISOString(),
            });
          }

          await revokeAssignmentRow(tx, current.id, session.subjectId ?? null, reason);

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            projectId,
            session,
            command: "verification.assignment.revoked",
            resourceType: "assignment",
            resourceId: current.id,
            reason,
            correlationId,
            requestIp: request.clientIp,
            detail: { caseId: current.case_id, reviewerSubjectId: current.subject_id },
          });

          await enqueueEvent(tx, {
            tenantId,
            eventType: "verification.assignment.revoked",
            aggregateId: current.case_id,
            aggregateVersion: 1,
            projectId,
            payload: { assignmentId: current.id },
            correlationId,
          });

          return {
            id: current.id,
            caseId: current.case_id,
            reviewerSubjectId: current.subject_id,
            active: false,
            revokeReason: reason,
            requestId,
            asOf,
          };
        }),
      );
    },
  );

  /**
   * Appoints a different reviewer — 07 §7.2 `POST /verification-cases/{id}/assignments`.
   *
   * The path names the assignment being replaced, so two people reassigning at once cannot both
   * succeed: the second finds it is no longer the case's latest. If it is still active it is
   * revoked in the same transaction. The new reviewer passes every check the first one did.
   */
  app.post<{ Params: { assignmentId: string } }>(
    "/api/v1/assignments/:assignmentId/reassignments",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      const parsed = reassignReviewerRequest.safeParse(request.body);
      if (!parsed.success) invalidRequest(parsed.error.issues);

      const { projectId } = await assignmentContext(sql, tenantId, request.params.assignmentId);
      const effectiveRole = assertAuthorized(
        session,
        "claim.curate",
        projectResource(tenantId, projectId),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      const data = parsed.data;

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
          const current = await lockAssignment(tx, request.params.assignmentId);

          const [latest] = await tx<{ id: string }[]>`
            SELECT id FROM core.assignments WHERE case_id = ${current.case_id}
            ORDER BY (revoked_at IS NULL) DESC, assigned_at DESC, id LIMIT 1
          `;
          if (latest?.id !== current.id) {
            throw conflict(
              "ASSIGNMENT_SUPERSEDED",
              "This case has already been reassigned. Reread it and decide again.",
              { currentAssignmentId: latest?.id ?? null },
            );
          }

          if (current.revoked_at === null) {
            await revokeAssignmentRow(tx, current.id, session.subjectId ?? null, data.reason);
          }

          const claims = await tx<{ claim_id: string }[]>`
            SELECT claim_id FROM core.verification_case_claims WHERE case_id = ${current.case_id}
          `;

          const assignment = await assignReviewer(tx, {
            tenantId,
            caseId: current.case_id,
            projectId,
            claimIds: claims.map((row) => row.claim_id),
            reviewerSubjectId: data.reviewerSubjectId,
            credentialId: data.credentialId,
            conflictStatus: data.conflictStatus,
            assignerSubjectId: session.subjectId ?? null,
          });

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            projectId,
            session,
            command: "verification.assignment.reassigned",
            resourceType: "verification_case",
            resourceId: current.case_id,
            reason: data.reason,
            correlationId,
            requestIp: request.clientIp,
            detail: {
              replacedAssignmentId: current.id,
              assignmentId: assignment.id,
              reviewerSubjectId: data.reviewerSubjectId,
              independenceReviewed: assignment.independenceReviewed,
              independenceGaps: assignment.independenceGaps,
            },
          });

          await enqueueEvent(tx, {
            tenantId,
            eventType: "verification.case.assigned",
            aggregateId: current.case_id,
            aggregateVersion: 1,
            projectId,
            payload: { assignmentId: assignment.id, replacedAssignmentId: current.id },
            correlationId,
          });

          return {
            id: assignment.id,
            caseId: current.case_id,
            reviewerSubjectId: data.reviewerSubjectId,
            active: true,
            replacedAssignmentId: current.id,
            independenceReviewed: assignment.independenceReviewed,
            independenceGaps: assignment.independenceGaps,
            requestId,
            asOf,
          };
        }),
      );
    },
  );

  // --- Credential status ----------------------------------------------------

  /**
   * Changes a credential's status — 02 §2.6·§2.8 "credential check", REQ-DAPP-042·044.
   *
   * Past attestations keep the status they were signed under (AC-17); only what the credential
   * can support from now on changes. Rules the route adds to the transition table:
   *
   * - the holder never changes their own credential's status;
   * - `security_operator` acts under `break_glass` (02 §2.6), which may revoke or suspend a
   *   credential but not restore or expire one;
   * - a suspension is lifted by someone other than who imposed it — otherwise it would be one
   *   person's discretion, not a control.
   */
  app.post<{ Params: { credentialId: string } }>(
    "/api/v1/credentials/:credentialId/status",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      const expectedVersion = requireIfMatch(request);
      const parsed = changeCredentialStatusRequest.safeParse(request.body);
      if (!parsed.success) invalidRequest(parsed.error.issues);

      const effectiveRole = assertAuthorized(
        session,
        "credential.status.change",
        tenantResource(tenantId),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      const { status: toStatus, reason } = parsed.data;

      if (
        effectiveRole === "security_operator" &&
        toStatus !== "revoked" &&
        toStatus !== "suspended"
      ) {
        throw forbidden(
          "BREAK_GLASS_SCOPE_EXCEEDED",
          "Emergency authority can revoke or suspend a credential, not restore or expire it",
        );
      }

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
          const [credential] = await tx<
            {
              id: string;
              subject_id: string;
              current_status: CredentialCurrentStatus;
              version: number;
            }[]
          >`
            SELECT id, subject_id, current_status, version FROM core.credentials
            WHERE id = ${request.params.credentialId}
            FOR UPDATE
          `;
          if (!credential) throw notFound("Credential not found");
          assertVersionMatches(expectedVersion, credential.version, "credential");

          if (credential.subject_id === session.subjectId) {
            throw forbidden(
              "CREDENTIAL_SELF_STATUS_CHANGE",
              "A credential holder cannot change their own credential's status",
            );
          }

          if (!canChangeCredentialStatus(credential.current_status, toStatus)) {
            throw conflict("INVALID_STATE_TRANSITION", "This credential status change is not allowed", {
              fromState: credential.current_status,
              toState: toStatus,
            });
          }

          if (credential.current_status === "suspended" && toStatus === "valid") {
            const [suspension] = await tx<{ actor_subject_id: string | null }[]>`
              SELECT actor_subject_id FROM core.credential_status_events
              WHERE credential_id = ${credential.id} AND to_status = 'suspended'
              ORDER BY occurred_at DESC, id LIMIT 1
            `;
            if (suspension?.actor_subject_id === session.subjectId) {
              throw forbidden(
                "REINSTATEMENT_BY_SUSPENDER",
                "The person who suspended a credential cannot lift the suspension",
              );
            }
          }

          const [updated] = await tx<{ version: number; revoked_at: Date | null }[]>`
            UPDATE core.credentials
            SET current_status = ${toStatus},
                revoked_at = CASE WHEN ${toStatus}::text = 'revoked' THEN now() ELSE revoked_at END,
                version = version + 1
            WHERE id = ${credential.id}
            RETURNING version, revoked_at
          `;

          await tx`
            INSERT INTO core.credential_status_events (
              id, tenant_id, credential_id, from_status, to_status, reason, actor_subject_id
            ) VALUES (
              ${randomUUID()}, ${tenantId}, ${credential.id}, ${credential.current_status},
              ${toStatus}, ${reason}, ${session.subjectId ?? null}
            )
          `;

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            session,
            command: "credential.status.changed",
            resourceType: "credential",
            resourceId: credential.id,
            beforeVersion: credential.version,
            afterVersion: updated!.version,
            reason,
            correlationId,
            requestIp: request.clientIp,
            detail: { fromStatus: credential.current_status, toStatus },
          });

          // 07 §7.4 `credential.expired|revoked` come from the status trigger (0066), so they are
          // not enqueued here a second time. A suspension and lifting one have no trigger event;
          // each is its own fact.
          const liftsSuspension = toStatus === "valid" && credential.current_status === "suspended";
          if (toStatus === "suspended" || liftsSuspension) {
            await enqueueEvent(tx, {
              tenantId,
              eventType: `credential.${liftsSuspension ? "reinstated" : "suspended"}`,
              aggregateId: credential.id,
              aggregateVersion: updated!.version,
              payload: { fromStatus: credential.current_status, toStatus, reason },
              correlationId,
            });
          }

          return {
            id: credential.id,
            subjectId: credential.subject_id,
            previousStatus: credential.current_status,
            currentStatus: toStatus,
            revokedAt: updated!.revoked_at?.toISOString() ?? null,
            version: updated!.version,
            requestId,
            asOf,
          };
        }),
      );
    },
  );
}

interface LockedAssignment {
  id: string;
  case_id: string;
  subject_id: string;
  revoked_at: Date | null;
}

/** Locks the assignment and its case, and checks the case still has review work to reassign. */
async function lockAssignment(tx: Tx, assignmentId: string): Promise<LockedAssignment> {
  const [row] = await tx<(LockedAssignment & { case_state: VerificationCaseState })[]>`
    SELECT a.id, a.case_id, a.subject_id, a.revoked_at, vc.state AS case_state
    FROM core.assignments a
    JOIN core.verification_cases vc ON vc.id = a.case_id
    WHERE a.id = ${assignmentId}
    FOR UPDATE OF a, vc
  `;
  if (!row) throw notFound("Assignment not found");
  if (!REASSIGNABLE_CASE_STATES.includes(row.case_state)) {
    throw conflict(
      "CASE_NOT_REASSIGNABLE",
      "The reviewer of a case that is signed or closed cannot be changed",
      { caseState: row.case_state, allowedStates: REASSIGNABLE_CASE_STATES },
    );
  }
  return row;
}

async function revokeAssignmentRow(
  tx: Tx,
  assignmentId: string,
  actorSubjectId: string | null,
  reason: string,
): Promise<void> {
  await tx`
    UPDATE core.assignments
    SET revoked_at = now(), revoked_by = ${actorSubjectId}, revoke_reason = ${reason}
    WHERE id = ${assignmentId}
  `;
}
