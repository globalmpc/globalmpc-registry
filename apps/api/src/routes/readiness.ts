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
  explainRequirementResult,
  parseRuleSet,
  type Requirement,
  type RequirementFacts,
  type RequirementResult,
} from "@mpc/policy";
import { badRequest, conflict, notFound, unprocessable } from "../errors.js";
import type { AppConfig } from "../config.js";
import { newSignatureNonce } from "../services/attestation-signing.js";
import {
  buildGateDecisionTypedData,
  gateDecisionMessage,
  hashGateDecisionPayload,
  humanReadableGateDecision,
  recoverGateDecisionSigner,
} from "../services/gate-decision-signing.js";
import {
  assertAuthorized,
  projectResource,
  sessionFacts,
} from "../plugins/authorize.js";
import { hashRequest, withIdempotency } from "../plugins/idempotency.js";
import { recordAudit } from "../audit.js";
import { enqueueEvent } from "../outbox.js";
import { requireMutationContext, requireReadContext } from "./shared.js";
import {
  deriveJurisdictionContext,
  deriveProjectContext,
} from "../services/readiness-context.js";

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
 * - A decision is signed (§11.3). The approver's wallet signs the decision content through a
 *   single-use request, and the server records it only if the recovered signer is that
 *   approver's current wallet.
 * - watch → go needs a rationale and at least one condition (§11.3).
 */

/**
 * The decision content. The signature request and the signed submission carry the same fields,
 * and the signature commits to them (§11.3: decision snapshot/hash, assumption, sign).
 *
 * Assumptions and conditions are trimmed and blank lines dropped, so what is hashed is what the
 * approver saw — a stray empty line is not a condition.
 */
const lines = z
  .array(z.string())
  .default([])
  .transform((items) => items.map((item) => item.trim()).filter((item) => item !== ""));

const decisionContentSchema = z.object({
  gateId: z.string().min(1),
  decision: z.enum(["go", "hold", "rework", "stop"]),
  inputAssessmentId: z.string().guid(),
  rationale: z.string().trim().min(1, "A decision requires a rationale"),
  assumptions: lines,
  conditions: lines,
});

type DecisionContent = z.infer<typeof decisionContentSchema>;

const createDecisionSchema = decisionContentSchema.extend({
  signatureRequestId: z.string().guid(),
  // A 65-byte EIP-712 signature. It used to default to "" and was stored unchecked.
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/, "An EIP-712 signature is required"),
});

/** How long a gate decision signature request stays usable. Same as attestation requests. */
const SIGNATURE_REQUEST_TTL_MS = 10 * 60 * 1000;

const GATE_RESOURCE = (tenantId: string, projectId: string) =>
  projectResource(tenantId, projectId, {
    state: "assessed",
    statesAllowingAction: ["assessed"],
    // Gate decisions require independence (02 §2.4).
    separationSensitive: true,
  });

interface DecisionBasis {
  readonly id: string;
  readonly status: ReadinessStatus;
  readonly inputSnapshotHash: string;
}

/**
 * The assessment a decision rests on, and whether that decision may be recorded on it.
 *
 * Checked on both the signature request and the submission: nobody should be asked to sign a
 * decision the server will refuse, and the refusal does not depend on the screen having asked.
 */
async function loadDecisionBasis(
  tx: postgres.TransactionSql,
  projectId: string,
  content: DecisionContent,
): Promise<DecisionBasis> {
  const [assessment] = await tx<
    {
      id: string;
      gate_id: string;
      status: ReadinessStatus;
      requirement_results: RequirementResult[];
      input_snapshot_hash: string;
    }[]
  >`
    SELECT id, gate_id, status, requirement_results, input_snapshot_hash
    FROM core.compliance_assessments
    WHERE id = ${content.inputAssessmentId} AND project_id = ${projectId}
  `;

  if (!assessment) throw notFound("Input assessment not found");

  // A decision on one gate cannot borrow the readiness of another.
  if (assessment.gate_id !== content.gateId) {
    throw unprocessable("GATE_ASSESSMENT_MISMATCH", "The assessment was made for a different gate", {
      assessmentGateId: assessment.gate_id,
      gateId: content.gateId,
    });
  }

  const applicable = assessment.requirement_results.filter((result) => result.applicable);

  // The domain makes the call. The route does not check for gaps itself.
  const check = checkGateDecision({
    decision: content.decision,
    requirementStatuses: applicable.map((result) => result.status),
    hasAssessment: true,
    rationale: content.rationale,
    conditions: content.conditions,
  });

  if (!check.allowed) {
    throw unprocessable(check.reason, "That decision cannot be recorded at this readiness", {
      blockingRequirementIndexes: check.blockingRequirementIndexes,
      // AC-34: indexes alone leave the approver asking what is missing and who fills it.
      blockingRequirements: check.blockingRequirementIndexes.map((index) => {
        const result = applicable[index]!;
        return {
          index,
          requirementId: result.requirementId,
          status: result.status,
          reasonCode: result.reasonCode,
          ...explainRequirementResult(result),
        };
      }),
      assessmentStatus: assessment.status,
    });
  }

  return {
    id: assessment.id,
    status: assessment.status,
    inputSnapshotHash: assessment.input_snapshot_hash,
  };
}

/**
 * Converts the current DB state into rule engine input.
 *
 * Assessment itself is a pure function, so this function decides "what counts as fact".
 * Time is the value fixed in the snapshot, not the call time (AC-11).
 *
 * **Per requirement, not per project (REQ-DAPP-007).** Each requirement reads the claims of its
 * own required types: its weakest grade, its oldest evidence, the attestations that cover those
 * claims and the conflicts raised on them. A project-wide minimum let a weak claim of one type
 * fail every requirement, and a strong claim of another type pass one it never touched.
 */
export async function collectRequirementFacts(
  tx: postgres.TransactionSql,
  projectId: string,
  jurisdictionProfile: string,
  requirements: readonly Requirement[],
  evaluatedAsOf: Date,
): Promise<Record<string, RequirementFacts>> {
  const claims = await tx<
    {
      id: string;
      claim_type: string;
      grade: string;
      as_of: Date | null;
      value_text: string;
      excluded_by_rule: boolean;
      stale: boolean;
    }[]
  >`
    SELECT id, claim_type, grade, as_of, value_text, excluded_by_rule,
           (stale_since IS NOT NULL AND stale_since <= ${evaluatedAsOf}) AS stale
    FROM core.claims WHERE project_id = ${projectId}
      -- A corrected claim keeps its old version as history; only the current one is a fact.
      AND superseded_by_claim_id IS NULL
  `;

  // Only attestations that still stand at the evaluation time. `stale_candidate` (evidence
  // moved), superseded, revoked and disputed ones are not present, and neither is one whose
  // validity has run out (REQ-DAPP-026).
  const attestations = await tx<{ attestation_type: string; claim_scope: string[] }[]>`
    SELECT a.attestation_type, a.claim_scope
    FROM core.verification_attestations a
    JOIN core.verification_cases vc ON vc.id = a.case_id
    WHERE vc.project_id = ${projectId}
      AND a.state IN ('signed', 'active')
      AND (a.valid_until IS NULL OR a.valid_until > ${evaluatedAsOf})
  `;

  const conflicts = await tx<{ claim_id: string; conflict_type: string }[]>`
    SELECT cc.claim_id, cc.conflict_type
    FROM core.claim_conflicts cc
    JOIN core.claims c ON c.id = cc.claim_id
    WHERE c.project_id = ${projectId} AND cc.resolved_at IS NULL
      AND c.superseded_by_claim_id IS NULL
  `;

  // OD-43: the profile is data — the latest version in effect at evaluation time, whatever its
  // state, so a suspension reaches the rules instead of being skipped. With none, its state and
  // environmental basis are absent, and rules that depend on them report not_evaluable instead of
  // passing on a borrowed value.
  const [profile] = await tx<
    { state: string; environmental_requirement_basis: string | null }[]
  >`
    SELECT state, environmental_requirement_basis FROM core.jurisdiction_profiles
    WHERE jurisdiction = ${jurisdictionProfile} AND effective_from <= ${evaluatedAsOf}
    ORDER BY profile_version DESC
    LIMIT 1
  `;

  const presentClaimTypes = [...new Set(claims.map((claim) => claim.claim_type))];

  const context = {
    ...deriveProjectContext(claims, evaluatedAsOf),
    ...deriveJurisdictionContext(profile),
    openFindingCount: String(conflicts.length),
  };

  const facts: Record<string, RequirementFacts> = {};

  for (const requirement of requirements) {
    const relevant = claims.filter((claim) =>
      requirement.requiredClaimTypes.includes(claim.claim_type),
    );
    const relevantIds = new Set(relevant.map((claim) => claim.id));

    // The lowest grade among this requirement's claims is its weakest link.
    const grade =
      relevant.length === 0
        ? null
        : relevant.reduce((worst, claim) =>
            (GRADE_RANK[claim.grade] ?? 0) < (GRADE_RANK[worst.grade] ?? 0) ? claim : worst,
          ).grade;

    // Age of the oldest evidence. One claim with no as-of date makes the age unknown rather
    // than letting the dated claims speak for it.
    const evidenceAgeDays =
      relevant.length === 0 || relevant.some((claim) => claim.as_of === null)
        ? null
        : String(
            Math.max(
              ...relevant.map((claim) =>
                Math.floor((evaluatedAsOf.getTime() - claim.as_of!.getTime()) / DAY_MS),
              ),
            ),
          );

    facts[requirement.requirementId] = {
      presentClaimTypes,
      grade: grade as RequirementFacts["grade"],
      presentAttestations: [
        ...new Set(
          attestations
            .filter((attestation) => attestation.claim_scope.some((id) => relevantIds.has(id)))
            .map((attestation) => attestation.attestation_type),
        ),
      ] as RequirementFacts["presentAttestations"],
      evidenceAgeDays,
      unresolvedConflictTypes: [
        ...new Set(
          conflicts
            .filter((conflict) => relevantIds.has(conflict.claim_id))
            .map((conflict) => conflict.conflict_type),
        ),
      ],
      staleEvidence: [
        ...new Set(relevant.filter((claim) => claim.stale).map((claim) => claim.claim_type)),
      ],
      context,
    };
  }

  return facts;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const GRADE_RANK: Readonly<Record<string, number>> = {
  rejected: 0,
  unverified: 1,
  self_reported: 2,
  partially_verified: 3,
  verified: 4,
};

/** A stored or fresh requirement result with its AC-34 explanation. */
function withExplanation(result: RequirementResult) {
  return { ...result, ...explainRequirementResult(result) };
}

export async function registerReadinessRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
  config: AppConfig,
): Promise<void> {
  app.post<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/readiness-assessments",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);

      const parsed = z
        .object({ policySetId: z.string().guid() })
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
      const requestHash = hashRequest(request);

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          const [policy] = await tx<
            {
              id: string;
              definition: unknown;
              gate_id: string;
              state: string;
              jurisdiction_profile: string;
            }[]
          >`
            SELECT id, definition, gate_id, state, jurisdiction_profile
            FROM core.compliance_policy_sets
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
            policy.jurisdiction_profile,
            ruleSet.requirements,
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
                    staleEvidence: [...value.staleEvidence].sort(),
                    // Context now comes from project data and the jurisdiction profile, so it is
                    // input too. Absent keys are dropped; canonical bytes do not encode undefined.
                    context: Object.fromEntries(
                      Object.entries(value.context).filter(
                        (entry): entry is [string, string | readonly string[]] =>
                          entry[1] !== undefined,
                      ),
                    ),
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
            requestIp: request.clientIp,
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
            requirementResults: assessment.requirementResults.map(withExplanation),
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
        requirementResults: (row.requirement_results as RequirementResult[]).map(withExplanation),
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

  /**
   * Gate decision signature request — §11.3.
   *
   * The approver states the decision here and gets back what their wallet will sign. The
   * server refuses a decision it would refuse on submission, so no one signs a go that cannot
   * be recorded.
   */
  app.post<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/gate-decisions/signature-requests",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);

      const parsed = decisionContentSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "Request format is invalid", {
          issues: parsed.error.issues,
        });
      }

      const effectiveRole = assertAuthorized(
        session,
        "gate.decide",
        GATE_RESOURCE(tenantId, request.params.projectId),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request);
      const content = parsed.data;
      const projectId = request.params.projectId;

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          const basis = await loadDecisionBasis(tx, projectId, content);

          const [project] = await tx<{ project_key: string }[]>`
            SELECT project_key FROM core.projects WHERE id = ${projectId}
          `;
          if (!project) throw notFound("Project not found");

          const id = randomUUID();
          const nonce = newSignatureNonce();
          // Whole seconds: the typed data carries uint64 seconds, and the stored times must
          // rebuild the same message on submission.
          const issuedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
          const expiresAt = new Date(issuedAt.getTime() + SIGNATURE_REQUEST_TTL_MS);
          const payloadHash = hashGateDecisionPayload(content);

          await tx`
            INSERT INTO core.gate_decision_signature_requests (
              id, tenant_id, project_id, subject_id, input_assessment_id, gate_id,
              nonce, payload_hash, issued_at, expires_at
            ) VALUES (
              ${id}, ${tenantId}, ${projectId}, ${session.subjectId!}, ${basis.id},
              ${content.gateId}, ${nonce}, ${payloadHash}, ${issuedAt}, ${expiresAt}
            )
          `;

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            projectId,
            session,
            command: "gate.decision.signature_request.created",
            resourceType: "compliance_assessment",
            resourceId: basis.id,
            correlationId,
            requestIp: request.clientIp,
            detail: { decision: content.decision, signatureRequestId: id },
          });

          const message = gateDecisionMessage({
            projectId,
            gateId: content.gateId,
            decision: content.decision,
            inputAssessmentId: basis.id,
            evidenceSnapshotHash: basis.inputSnapshotHash,
            payloadHash,
            issuedAt,
            expiresAt,
            nonce,
          });
          const typedData = buildGateDecisionTypedData(config, message);

          return {
            signatureRequestId: id,
            humanReadablePayload: humanReadableGateDecision({
              projectKey: project.project_key,
              content,
              assessmentStatus: basis.status,
              evidenceSnapshotHash: basis.inputSnapshotHash,
            }),
            typedData: {
              domain: typedData.domain,
              types: typedData.types,
              primaryType: typedData.primaryType,
              // bigint does not serialize to JSON; the client turns the decimal string back.
              message: {
                ...message,
                issuedAt: message.issuedAt.toString(),
                expiresAt: message.expiresAt.toString(),
              },
            },
            payloadHash,
            nonce,
            expiresAt: expiresAt.toISOString(),
            requestId,
            asOf,
          };
        }),
      );
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
        GATE_RESOURCE(tenantId, request.params.projectId),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request);
      const data = parsed.data;
      const projectId = request.params.projectId;

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          const basis = await loadDecisionBasis(tx, projectId, data);

          // Consumes the request atomically. A second submission finds no row; a request issued
          // to another approver or another project is not usable here.
          const [signatureRequest] = await tx<
            {
              id: string;
              input_assessment_id: string;
              gate_id: string;
              nonce: string;
              payload_hash: string;
              issued_at: Date;
              expires_at: Date;
            }[]
          >`
            UPDATE core.gate_decision_signature_requests
            SET consumed_at = now()
            WHERE id = ${data.signatureRequestId}
              AND project_id = ${projectId}
              AND subject_id = ${session.subjectId!}
              AND consumed_at IS NULL
              AND expires_at > now()
            RETURNING id, input_assessment_id, gate_id, nonce, payload_hash, issued_at, expires_at
          `;
          if (!signatureRequest) {
            throw conflict(
              "SIGNATURE_REQUEST_UNUSABLE",
              "This signature request has already been used, has expired, or was issued to someone else",
            );
          }

          // The signature covers what was requested. A different decision, rationale or
          // condition list in the submission is a different decision.
          // This is a digest of decision content, not a secret or authentication token.
          // Its equality check binds the submitted content; signer recovery below authenticates it.
          const payloadHash = hashGateDecisionPayload(data);
          if (
            payloadHash !== signatureRequest.payload_hash ||
            signatureRequest.input_assessment_id !== basis.id ||
            signatureRequest.gate_id !== data.gateId
          ) {
            throw badRequest(
              "SIGNATURE_PAYLOAD_MISMATCH",
              "The submitted decision differs from the one the signature request was made for",
            );
          }

          let signer: string;
          try {
            signer = await recoverGateDecisionSigner(
              config,
              gateDecisionMessage({
                projectId,
                gateId: signatureRequest.gate_id,
                decision: data.decision,
                inputAssessmentId: signatureRequest.input_assessment_id,
                evidenceSnapshotHash: basis.inputSnapshotHash,
                payloadHash: signatureRequest.payload_hash,
                issuedAt: signatureRequest.issued_at,
                expiresAt: signatureRequest.expires_at,
                nonce: signatureRequest.nonce,
              }),
              data.signature.toLowerCase() as `0x${string}`,
            );
          } catch {
            throw badRequest("SIGNATURE_INVALID", "The signature could not be verified");
          }

          // Signature validity and authority are separate facts (invariant 13): the signer must
          // be a current wallet of the subject recording the decision.
          const wallets = await tx<{ wallet_address: string }[]>`
            SELECT wallet_address FROM core.wallet_identities
            WHERE subject_id = ${session.subjectId!} AND disabled_at IS NULL
          `;
          if (!wallets.some((wallet) => wallet.wallet_address.toLowerCase() === signer)) {
            throw badRequest(
              "SIGNATURE_SIGNER_MISMATCH",
              "The signer is not a current wallet of the person recording this decision",
            );
          }

          const id = randomUUID();
          const [recorded] = await tx<{ signed_at: Date }[]>`
            INSERT INTO core.gate_decisions (
              id, tenant_id, project_id, gate_id, decision, input_assessment_id,
              evidence_snapshot_hash, decision_authority, decision_maker_subject_id,
              rationale, assumptions, conditions, signature, signer_wallet_address,
              signature_request_id, signed_at
            ) VALUES (
              ${id}, ${tenantId}, ${projectId}, ${data.gateId},
              ${data.decision}, ${basis.id}, ${basis.inputSnapshotHash},
              'MPC Gate Approver', ${session.subjectId!}, ${data.rationale},
              ${data.assumptions}, ${data.conditions}, ${data.signature.toLowerCase()},
              ${signer}, ${signatureRequest.id}, now()
            )
            RETURNING signed_at
          `;

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            projectId,
            session,
            command: "gate.decision.recorded",
            resourceType: "gate_decision",
            resourceId: id,
            reason: data.rationale,
            correlationId,
            requestIp: request.clientIp,
            detail: { decision: data.decision, assessmentStatus: basis.status, signer },
          });

          await enqueueEvent(tx, {
            tenantId,
            eventType: "gate.decision.recorded",
            aggregateId: id,
            aggregateVersion: 1,
            projectId,
            payload: { decision: data.decision },
            correlationId,
          });

          return {
            id,
            projectId,
            gateId: data.gateId,
            decision: data.decision,
            inputAssessmentId: basis.id,
            evidenceSnapshotHash: basis.inputSnapshotHash,
            decisionAuthority: "MPC Gate Approver",
            decisionMakerSubjectId: session.subjectId,
            rationale: data.rationale,
            assumptions: data.assumptions,
            conditions: data.conditions,
            signerWalletAddress: signer,
            signedAt: recorded!.signed_at.toISOString(),
            requestId,
            asOf,
          };
        }),
      );
    },
  );
}
