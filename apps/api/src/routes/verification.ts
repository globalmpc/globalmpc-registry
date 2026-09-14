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
 * Verification Case와 Attestation — spec 03 §3단계, 04 §4.4, 07 §7.2.
 *
 * 이 라우트가 지키는 것:
 *
 * - `limitations` 없는 서명은 불가능하다(AC-01). 도메인 검사 + DB CHECK 두 겹.
 * - 서버는 대리 서명하지 않는다. 서명 요청을 만들고 결과를 검증만 한다.
 * - signature request는 한 번만 쓰인다.
 * - 서명 시점의 evidence snapshot이 바뀌면 그 요청은 무효다.
 * - 서명 당시 credential 상태를 보존한다(AC-17).
 */

const SIGNATURE_REQUEST_TTL_MS = 10 * 60 * 1000;

const createCaseSchema = z.object({
  projectId: z.string().uuid(),
  schemaId: z.string().uuid(),
  claimIds: z.array(z.string().uuid()).min(1, "근거 없는 검토는 만들 수 없다"),
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
  limitations: z.string().min(1, "limitations는 비워 둘 수 없다"),
});

const submitSignatureSchema = z.object({
  signatureRequestId: z.string().uuid(),
  signature: z.string().regex(/^0x[0-9a-f]+$/),
});

/**
 * 리소스가 걸린 프로젝트.
 *
 * 인가는 멱등 블록 **밖에서** 한다. replay는 저장된 응답을 그대로 돌려주므로,
 * 안에 두면 남의 key를 재생한 요청이 인가를 지나지 않는다.
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
  if (!row) throw notFound("verification case를 찾을 수 없다");
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
  if (!row) throw notFound("attestation을 찾을 수 없다");
  return row.project_id;
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
  if (!row) throw notFound("이의를 찾을 수 없다");
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
      throw badRequest("REQUEST_INVALID", "요청 형식이 올바르지 않다", {
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

        // 검토 범위를 보존한다. snapshot 해시는 바뀌었는지만 알려 줄 뿐
        // 무엇이었는지 복원하지 못한다(0011).
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

  // --- Case 목록 -----------------------------------------------------------

  /**
   * 배정된 검토자가 자기 case를 찾는 경로.
   *
   * 배정을 만드는 사람(`data_steward`)과 서명하는 사람(reviewer)은 다르다.
   * 목록이 없으면 검토자는 자기 배정에 도달할 방법이 없다. 읽기는 RLS가
   * tenant로 막고, 서명 가능 여부는 attestation 생성 시점에 따로 판정한다 —
   * 보이는 것과 할 수 있는 것은 다른 질문이다.
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

  // --- Case 상태 전이 ------------------------------------------------------

  /**
   * 검토 case 상태를 바꾼다 — 04 §4.4.
   *
   * 보완 요청·반려·취소를 기록하는 경로다. 이것이 없으면 검토는 "서명하거나
   * 아무 일도 없거나" 둘뿐이고, 잘못된 근거를 발견해도 남길 자리가 없다.
   *
   * 전이 가능 여부는 도메인 상태기계가 판정한다. 라우트가 조건을 다시 쓰면
   * 상태기계와 갈라진다.
   *
   * `signed` 이후로는 이 경로로 갈 수 없다. 서명된 검토를 되돌리는 것은 상태
   * 변경이 아니라 이의 제기(dispute)나 supersede다.
   */
  const transitionSchema = z.object({
    toState: z.enum(["in_review", "changes_requested", "declined", "cancelled"]),
    reason: z.string().min(1, "상태를 바꾼 이유는 비워 둘 수 없다"),
  });

  app.post<{ Params: { caseId: string } }>(
    "/api/v1/verification-cases/:caseId/transitions",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      const expectedVersion = requireIfMatch(request);

      const parsed = transitionSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "요청 형식이 올바르지 않다", {
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
          if (!current) throw notFound("verification case를 찾을 수 없다");

          assertVersionMatches(expectedVersion, current.version, "verification_case");

          if (!canTransition(verificationCaseMachine, current.state, toState)) {
            throw conflict("INVALID_STATE_TRANSITION", "허용되지 않는 상태 전이다", {
              fromState: current.state,
              toState,
              // 다음에 무엇을 할 수 있는지 알려준다. 막기만 하면 사용자는 추측한다.
              allowedTransitions: [...(verificationCaseMachine.transitions[current.state] ?? [])],
            });
          }

          await tx`
            UPDATE core.verification_cases SET state = ${toState}
            WHERE id = ${current.id}
          `;

          // 왜 바뀌었는지를 남긴다. 현재 상태만 있으면 다음 사람이 판단할
          // 근거가 없다.
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

  // --- Attestation 이의 제기 ------------------------------------------------

  /**
   * 서명된 attestation에 이의를 제기한다 — 04 §4.2.
   *
   * **서명을 지우지 않는다.** 서명 당시의 판단은 그대로 남고 `disputed`라는 새
   * 사실이 추가된다. 서명을 삭제하면 "누가 무엇을 언제 판단했는가"를 잃고,
   * 그것은 잘못된 검토를 감추는 것과 구분되지 않는다.
   *
   * 이의는 검토가 틀렸다는 판정이 아니다. 다시 볼 필요가 있다는 표시다.
   */
  const disputeSchema = z.object({
    reasonCode: z.string().min(1),
    detail: z.string().min(1, "이의 제기 사유는 비워 둘 수 없다"),
  });

  app.post<{ Params: { attestationId: string } }>(
    "/api/v1/attestations/:attestationId/disputes",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);

      const parsed = disputeSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "요청 형식이 올바르지 않다", {
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
          if (!attestation) throw notFound("attestation을 찾을 수 없다");

          // 이미 disputed면 상태는 그대로 두고 이의만 추가한다. 다른 사람이
          // 다른 이유로 제기할 수 있어야 하고, 하나가 열려 있다고 나머지를
          // 막으면 두 번째 지적이 기록될 자리가 없다.
          const alreadyDisputed = attestation.state === "disputed";
          if (!alreadyDisputed && !canTransition(attestationMachine, attestation.state, "disputed")) {
            throw conflict("INVALID_STATE_TRANSITION", "이 상태에서는 이의를 제기할 수 없다", {
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

          // 상태만 바뀐다. payload_hash·signature·limitations는 그대로다.
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
            // 서명 본문은 바뀌지 않았다. 같은 해시가 그대로 남는다.
            payloadHash: attestation.payload_hash,
            reasonCode: parsed.data.reasonCode,
            requestId,
            asOf,
          };
        }),
      );
    },
  );

  // --- 이의 조회와 해소 ------------------------------------------------------

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
        // 해소된 이의도 함께 보여준다. 감추면 "한 번 문제가 제기됐다"는 사실이
        // 사라지고, 그것은 잘못된 검토를 덮는 것과 구분되지 않는다.
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
   * 이의 해소 — 04 §4.2.
   *
   * **이의 기록을 지우지 않는다.** `resolved_at`과 결과가 덧붙을 뿐이다.
   *
   * `upheld`(이의가 맞았다)면 attestation을 `active`로 되돌리지 않는다 — 검토가
   * 틀렸다는 것이 확인된 상태에서 그것을 유효로 표시할 수 없다. supersede나
   * revoke는 별도 결정이다.
   *
   * `dismissed`(검토가 유지된다)면 남은 미해소 이의가 없을 때만 `active`로
   * 돌아간다. 하나라도 남아 있으면 여전히 다시 볼 필요가 있다는 뜻이다.
   */
  const resolveSchema = z.object({
    outcome: z.enum(["upheld", "dismissed"]),
    resolution: z.string().min(1, "해소 근거는 비워 둘 수 없다"),
  });

  app.post<{ Params: { disputeId: string } }>(
    "/api/v1/disputes/:disputeId/resolution",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);

      const parsed = resolveSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "요청 형식이 올바르지 않다", {
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
          if (!dispute) throw notFound("이의를 찾을 수 없다");

          if (dispute.resolved_at) {
            throw conflict("DISPUTE_ALREADY_RESOLVED", "이미 해소된 이의다", {
              resolvedAt: dispute.resolved_at.toISOString(),
            });
          }

          await tx`
            UPDATE core.attestation_disputes
            SET resolved_at = now(), resolution = ${`${outcome}: ${resolution}`}
            WHERE id = ${dispute.id}
          `;

          // 남은 미해소 이의가 있으면 attestation은 disputed로 남는다.
          const [remaining] = await tx<{ count: string }[]>`
            SELECT count(*)::text AS count FROM core.attestation_disputes
            WHERE attestation_id = ${dispute.attestation_id} AND resolved_at IS NULL
          `;

          let attestationState = "disputed";
          if (outcome === "dismissed" && Number(remaining?.count ?? "1") === 0) {
            // 검토가 유지된다. 이의가 모두 풀렸으므로 active로 돌아간다.
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
            // 이의가 인정되면 검토를 유효로 되돌리지 않는다. supersede·revoke는
            // 별도 결정이다.
            attestationState,
            unresolvedDisputes: Number(remaining?.count ?? "0"),
            requestId,
            asOf,
          };
        }),
      );
    },
  );

  // --- Attestation 초안 ----------------------------------------------------

  app.post<{ Params: { caseId: string } }>(
    "/api/v1/verification-cases/:caseId/attestations",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);

      const parsed = createAttestationSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "요청 형식이 올바르지 않다", {
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

          if (!context) throw notFound("verification case를 찾을 수 없다");

          /**
           * 배정된 사람만 자기 배정으로 작성한다 — 02 §2.9, 불변조건 13.
           *
           * 이 검사가 없으면 검토자 역할을 가진 누구나 **남의 assignmentId**로
           * 초안을 만들 수 있고, 그 행에는 배정자의 지갑 주소가 서명자로 박힌다.
           * 최종 서명은 복구된 주소를 배정자 지갑과 대조하므로 위조 서명까지는
           * 가지 않지만, 그때까지 남의 이름으로 된 findings가 남는다.
           *
           * 역할 검사로는 막지 못한다 — 같은 tenant의 검토자는 전부 같은 역할을
           * 갖기 때문이다.
           */
          if (context.assignment_subject !== session.subjectId) {
            throw forbidden(
              "ASSIGNMENT_NOT_OWNED",
              "이 배정은 다른 검토자의 것이다",
              { requiredAction: "자기에게 배정된 case에서 작성한다" },
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

          // 서명 가능 여부는 도메인이 판정한다. 라우트가 조건을 다시 쓰지 않는다.
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
            throw unprocessable(check.reason, "이 조건에서는 서명할 수 없다");
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

  // --- 서명 요청 -----------------------------------------------------------

  app.post<{ Params: { attestationId: string } }>(
    "/api/v1/attestations/:attestationId/signature-requests",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request.body ?? {});

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
            }[]
          >`
            SELECT a.*, p.project_key,
                   vc.evidence_snapshot_hash AS current_snapshot
            FROM core.verification_attestations a
            JOIN core.verification_cases vc ON vc.id = a.case_id
            JOIN core.projects p ON p.id = vc.project_id
            WHERE a.id = ${request.params.attestationId}
          `;

          if (!attestation) throw notFound("attestation을 찾을 수 없다");
          if (attestation.state !== "draft") {
            throw conflict("ATTESTATION_ALREADY_SIGNED", "이미 서명된 attestation이다");
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
            effectiveRole: ROLE_ASSIGNMENT_BOUND,
            tenantId,
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
              // bigint는 JSON으로 직렬화되지 않는다. 클라이언트가 다시 bigint로
              // 만들 수 있도록 decimal string으로 보낸다.
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

  // --- 서명 제출 -----------------------------------------------------------

  app.post<{ Params: { attestationId: string } }>(
    "/api/v1/attestations/:attestationId/signatures",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);

      const parsed = submitSignatureSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "요청 형식이 올바르지 않다");
      }

      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request.body);

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          // 요청을 원자적으로 소비한다. 두 번째 제출은 행을 찾지 못한다.
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
              "이 서명 요청은 이미 사용됐거나 만료됐다",
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

          if (!attestation) throw notFound("attestation을 찾을 수 없다");

          // snapshot substitution 방어: 서명 요청 이후 근거가 바뀌었으면 무효다.
          if (attestation.current_snapshot !== signatureRequest.evidence_snapshot_hash) {
            throw conflict(
              "EVIDENCE_SNAPSHOT_CHANGED",
              "서명 요청 이후 근거가 바뀌었다. 새 요청을 만들어야 한다",
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

          // 서명 유효성과 권한은 다른 사실이다(불변조건 13). 복구된 주소가
          // assignment의 검토자인지 별도로 대조한다.
          if (
            attestation.reviewer_wallet === null ||
            signer !== attestation.reviewer_wallet.toLowerCase()
          ) {
            throw badRequest(
              "SIGNATURE_SIGNER_MISMATCH",
              "서명자가 이 case에 배정된 검토자가 아니다",
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
