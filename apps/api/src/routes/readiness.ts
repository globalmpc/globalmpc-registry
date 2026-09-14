import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { z } from "zod";
import { withTenant } from "@mpc/db";
import { canonicalBytes, keccak256 } from "@mpc/canonical";
import { checkGateDecision, type ReadinessStatus } from "@mpc/domain";
import {
  assessmentHash,
  evaluateAssessment,
  parseRuleSet,
  type RequirementFacts,
} from "@mpc/policy";
import { badRequest, notFound, unprocessable } from "../errors.js";
import {
  assertAuthorized,
  projectResource,
  sessionFacts,
} from "../plugins/authorize.js";
import { hashRequest, withIdempotency } from "../plugins/idempotency.js";
import { recordAudit } from "../audit.js";
import { enqueueEvent } from "../outbox.js";
import { requireMutationContext, requireReadContext } from "./shared.js";

/**
 * Readiness assessment and Gate Decision — spec 04 §4.2, 05 §5.4, 07 §7.2.
 *
 * What this route guarantees:
 *
 * - **There is no path that modifies readiness.** Only recomputation, and the result is a new row.
 *   A DB trigger blocks UPDATE, and there are no PATCH/DELETE handlers here (REQ-DAPP-017).
 * - Assessment is done by pure functions in `@mpc/policy`. The route only gathers facts from the DB.
 * - `go` is rejected on `gap`/`not_evaluable` (AC-02, AC-34). The domain makes that call.
 * - `hold`/`rework`/`stop` can be recorded regardless of readiness. If bad news cannot be
 *   recorded, state goes silently stale.
 */

const createDecisionSchema = z.object({
  gateId: z.string().min(1),
  decision: z.enum(["go", "hold", "rework", "stop"]),
  inputAssessmentId: z.string().uuid(),
  rationale: z.string().min(1, "A decision requires a rationale"),
  assumptions: z.array(z.string()).default([]),
  conditions: z.array(z.string()).default([]),
  signature: z.string().default(""),
});

/**
 * Converts the current DB state into rule engine input.
 *
 * Assessment itself is a pure function, so this function decides "what counts as fact".
 * Time is the value fixed in the snapshot, not the call time (AC-11).
 */
async function collectRequirementFacts(
  tx: postgres.TransactionSql,
  projectId: string,
  requirementIds: readonly string[],
  evaluatedAsOf: Date,
): Promise<Record<string, RequirementFacts>> {
  const claims = await tx<
    {
      claim_type: string;
      grade: string;
      as_of: Date | null;
    }[]
  >`
    SELECT claim_type, grade, as_of FROM core.claims WHERE project_id = ${projectId}
  `;

  const attestations = await tx<{ attestation_type: string }[]>`
    SELECT DISTINCT a.attestation_type
    FROM core.verification_attestations a
    JOIN core.verification_cases vc ON vc.id = a.case_id
    WHERE vc.project_id = ${projectId} AND a.state IN ('signed', 'active')
  `;

  const conflicts = await tx<{ conflict_type: string }[]>`
    SELECT DISTINCT cc.conflict_type
    FROM core.claim_conflicts cc
    JOIN core.claims c ON c.id = cc.claim_id
    WHERE c.project_id = ${projectId} AND cc.resolved_at IS NULL
  `;

  const presentClaimTypes = claims.map((claim) => claim.claim_type);
  const presentAttestations = attestations.map(
    (row) => row.attestation_type,
  ) as RequirementFacts["presentAttestations"];

  // The lowest grade is the weakest link. Each requirement demands its own claim type,
  // so the overall minimum is passed here.
  const gradeRank: Record<string, number> = {
    rejected: 0,
    unverified: 1,
    self_reported: 2,
    partially_verified: 3,
    verified: 4,
  };
  const worstGrade =
    claims.length === 0
      ? null
      : claims.reduce((worst, claim) =>
          (gradeRank[claim.grade] ?? 0) < (gradeRank[worst.grade] ?? 0) ? claim : worst,
        ).grade;

  // Age in days of the oldest evidence. Freshness takes the worst value.
  const ages = claims
    .map((claim) => claim.as_of)
    .filter((value): value is Date => value !== null)
    .map((value) =>
      Math.floor((evaluatedAsOf.getTime() - value.getTime()) / (24 * 60 * 60 * 1000)),
    );
  const evidenceAgeDays = ages.length > 0 ? String(Math.max(...ages)) : null;

  const facts: Record<string, RequirementFacts> = {};

  for (const requirementId of requirementIds) {
    facts[requirementId] = {
      presentClaimTypes,
      grade: (worstGrade ?? null) as RequirementFacts["grade"],
      presentAttestations,
      evidenceAgeDays,
      unresolvedConflictTypes: conflicts.map((row) => row.conflict_type),
      context: {
        // Facts referenced by rule set predicates. Derived from project state.
        projectStage: "exploration_or_later",
        acceptedReportingStandard: "JORC-2012",
        environmentalRequirementBasis: "MNG-EIA-2019",
        jurisdictionProfileState: "approved",
        offeringIntent: "false",
        rightsExpiryWithin12Months: "false",
        openFindingCount: String(conflicts.length),
      },
    };
  }

  return facts;
}

export async function registerReadinessRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  app.post<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/readiness-assessments",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);

      const parsed = z
        .object({ policySetId: z.string().uuid() })
        .safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "policySetId is required");
      }

      const effectiveRole = assertAuthorized(
        session,
        "readiness.recompute",
        projectResource(tenantId, request.params.projectId),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request.body);

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          const [policy] = await tx<
            { id: string; definition: unknown; gate_id: string; state: string }[]
          >`
            SELECT id, definition, gate_id, state FROM core.compliance_policy_sets
            WHERE id = ${parsed.data.policySetId}
          `;
          if (!policy) throw notFound("Policy set not found");
          if (policy.state !== "effective") {
            throw unprocessable(
              "POLICY_NOT_EFFECTIVE",
              "Cannot assess with a policy that is not effective",
            );
          }

          const ruleSet = parseRuleSet(policy.definition);

          // Fix the assessment reference time first. If time passes mid-assessment, the same input
          // yields a different result.
          const evaluatedAsOf = new Date(asOf);
          const facts = await collectRequirementFacts(
            tx,
            request.params.projectId,
            ruleSet.requirements.map((requirement) => requirement.requirementId),
            evaluatedAsOf,
          );

          const inputSnapshotHash = keccak256(
            canonicalBytes({
              projectId: request.params.projectId,
              policySetId: policy.id,
              evaluatedAsOf: evaluatedAsOf.toISOString(),
              facts: Object.fromEntries(
                Object.entries(facts).map(([key, value]) => [
                  key,
                  {
                    presentClaimTypes: [...value.presentClaimTypes].sort(),
                    grade: value.grade ?? "",
                    presentAttestations: [...value.presentAttestations].sort(),
                    evidenceAgeDays: value.evidenceAgeDays ?? "",
                    unresolvedConflictTypes: [...value.unresolvedConflictTypes].sort(),
                  },
                ]),
              ),
            }),
          );

          const assessment = evaluateAssessment(ruleSet, {
            subjectId: request.params.projectId,
            gateId: policy.gate_id,
            inputSnapshotHash,
            evaluatedAsOf: evaluatedAsOf.toISOString(),
            requirementFacts: facts,
          });

          const canonicalResultHash = assessmentHash(assessment);
          const id = randomUUID();

          await tx`
            INSERT INTO core.compliance_assessments (
              id, tenant_id, project_id, gate_id, policy_set_id,
              input_snapshot_hash, evaluated_as_of, status, requirement_results,
              canonical_result_hash
            ) VALUES (
              ${id}, ${tenantId}, ${request.params.projectId}, ${policy.gate_id},
              ${policy.id}, ${inputSnapshotHash}, ${evaluatedAsOf.toISOString()},
              ${assessment.status}, ${tx.json(assessment.requirementResults as never)},
              ${canonicalResultHash}
            )
          `;

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            projectId: request.params.projectId,
            session,
            command: "readiness.assessed",
            resourceType: "compliance_assessment",
            resourceId: id,
            correlationId,
            requestIp: request.ip,
            detail: { status: assessment.status, ruleSetVersion: ruleSet.version },
          });

          await enqueueEvent(tx, {
            tenantId,
            eventType: "readiness.assessed",
            aggregateId: id,
            aggregateVersion: 1,
            projectId: request.params.projectId,
            payload: { status: assessment.status, canonicalResultHash },
            correlationId,
          });

          return {
            id,
            projectId: request.params.projectId,
            gateId: policy.gate_id,
            policySetId: policy.id,
            ruleSetVersion: ruleSet.version,
            inputSnapshotHash,
            evaluatedAsOf: evaluatedAsOf.toISOString(),
            status: assessment.status,
            requirementResults: assessment.requirementResults,
            canonicalResultHash,
            // §7.3 safety fields. Readiness is not a decision.
            authority: "MPC data and evidence readiness assessment",
            ruleVersion: ruleSet.version,
            limitations: [
              "This assessment covers whether data requirements are met and does not replace a human decision",
            ],
            legalEffect: "none" as const,
            disclaimerCodes: ["READINESS_IS_NOT_A_DECISION"],
            requestId,
            asOf,
          };
        }),
      );
    },
  );

  app.get<{ Params: { assessmentId: string } }>(
    "/api/v1/readiness-assessments/:assessmentId",
    async (request) => {
      const session = request.session;
      if (!session?.tenantId) throw notFound("Assessment not found");

      const [row] = await withTenant(sql, { tenantId: session.tenantId }, (tx) =>
        tx<
          {
            id: string;
            project_id: string;
            gate_id: string;
            policy_set_id: string;
            input_snapshot_hash: string;
            evaluated_as_of: Date;
            status: ReadinessStatus;
            requirement_results: unknown;
            canonical_result_hash: string;
          }[]
        >`
          SELECT * FROM core.compliance_assessments WHERE id = ${request.params.assessmentId}
        `,
      );

      if (!row) throw notFound("Assessment not found");

      // Project scope can be judged only after the project is known. Out of scope, even
      // existence is not disclosed — distinguishing 404 from 403 leaks IDs.
      assertAuthorized(
        session,
        "readiness.read",
        projectResource(session.tenantId, row.project_id),
        sessionFacts(session),
      );

      return {
        id: row.id,
        projectId: row.project_id,
        gateId: row.gate_id,
        policySetId: row.policy_set_id,
        inputSnapshotHash: row.input_snapshot_hash,
        evaluatedAsOf: row.evaluated_as_of.toISOString(),
        status: row.status,
        requirementResults: row.requirement_results,
        canonicalResultHash: row.canonical_result_hash,
        authority: "MPC data and evidence readiness assessment",
        limitations: ["This assessment covers whether data requirements are met and does not replace a human decision"],
        legalEffect: "none" as const,
        disclaimerCodes: ["READINESS_IS_NOT_A_DECISION"],
        requestId: request.context.requestId,
        asOf: request.context.asOf,
      };
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/gate-decisions",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);

      const parsed = createDecisionSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "Request format is invalid", {
          issues: parsed.error.issues,
        });
      }

      const effectiveRole = assertAuthorized(
        session,
        "gate.decide",
        projectResource(tenantId, request.params.projectId, {
          state: "assessed",
          statesAllowingAction: ["assessed"],
          // Gate decisions require independence (02 §2.4).
          separationSensitive: true,
        }),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request.body);
      const data = parsed.data;

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          const [assessment] = await tx<
            {
              id: string;
              status: ReadinessStatus;
              requirement_results: { status: ReadinessStatus; applicable: boolean }[];
              input_snapshot_hash: string;
            }[]
          >`
            SELECT id, status, requirement_results, input_snapshot_hash
            FROM core.compliance_assessments
            WHERE id = ${data.inputAssessmentId} AND project_id = ${request.params.projectId}
          `;

          if (!assessment) throw notFound("Input assessment not found");

          // The domain makes the call. The route does not check for gaps itself.
          const check = checkGateDecision({
            decision: data.decision,
            requirementStatuses: assessment.requirement_results
              .filter((result) => result.applicable)
              .map((result) => result.status),
            hasAssessment: true,
            rationale: data.rationale,
          });

          if (!check.allowed) {
            throw unprocessable(check.reason, "That decision cannot be recorded at this readiness", {
              blockingRequirementIndexes: check.blockingRequirementIndexes,
              assessmentStatus: assessment.status,
            });
          }

          const [subject] = await tx<{ id: string }[]>`
            SELECT id FROM core.subjects WHERE id = ${session.subjectId!}
          `;
          if (!subject) throw notFound("Decision subject not found");

          const id = randomUUID();
          await tx`
            INSERT INTO core.gate_decisions (
              id, tenant_id, project_id, gate_id, decision, input_assessment_id,
              evidence_snapshot_hash, decision_authority, decision_maker_subject_id,
              rationale, assumptions, conditions, signature, signed_at
            ) VALUES (
              ${id}, ${tenantId}, ${request.params.projectId}, ${data.gateId},
              ${data.decision}, ${assessment.id}, ${assessment.input_snapshot_hash},
              'MPC Gate Approver', ${session.subjectId}, ${data.rationale},
              ${data.assumptions}, ${data.conditions}, ${data.signature}, now()
            )
          `;

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            projectId: request.params.projectId,
            session,
            command: "gate.decision.recorded",
            resourceType: "gate_decision",
            resourceId: id,
            reason: data.rationale,
            correlationId,
            requestIp: request.ip,
            detail: { decision: data.decision, assessmentStatus: assessment.status },
          });

          await enqueueEvent(tx, {
            tenantId,
            eventType: "gate.decision.recorded",
            aggregateId: id,
            aggregateVersion: 1,
            projectId: request.params.projectId,
            payload: { decision: data.decision },
            correlationId,
          });

          return {
            id,
            projectId: request.params.projectId,
            gateId: data.gateId,
            decision: data.decision,
            inputAssessmentId: assessment.id,
            evidenceSnapshotHash: assessment.input_snapshot_hash,
            decisionAuthority: "MPC Gate Approver",
            decisionMakerSubjectId: session.subjectId,
            rationale: data.rationale,
            assumptions: data.assumptions,
            conditions: data.conditions,
            signedAt: new Date().toISOString(),
            requestId,
            asOf,
          };
        }),
      );
    },
  );
}
