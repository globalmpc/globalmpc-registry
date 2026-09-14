import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { z } from "zod";
import { withTenant } from "@mpc/db";
import {
  canTransition,
  checkProposalSpace,
  isForbiddenTarget,
  proposalMachine,
  tallyVotes,
  type ProposalState,
} from "@mpc/domain";
import { badRequest, conflict, notFound, unprocessable } from "../errors.js";
import {
  assertAuthorized,
  projectResource,
  sessionFacts,
  tenantResource,
  visibleProjectScope,
} from "../plugins/authorize.js";
import { hashRequest, withIdempotency } from "../plugins/idempotency.js";
import { recordAudit } from "../audit.js";
import { enqueueEvent } from "../outbox.js";
import {
  assertVersionMatches,
  requireIfMatch,
  requireMutationContext,
  requireReadContext,
} from "./shared.js";
import {
  resolveVoteWeight,
  snapshotBlockFor,
  type BalanceReader,
} from "../services/vote-weight.js";

/**
 * Governance — spec 04 §4.5, OD-06.
 *
 * 이 라우트가 지키는 것:
 *
 * - **투표가 오프체인 사실을 만들지 않는다**(불변조건 12). 통과한 제안은
 *   `executed`가 될 뿐이고 authority·credential·법적 상태는 그대로다.
 *   응답의 `limitations`가 그 사실을 매번 함께 보낸다.
 * - **space 밖의 대상을 제안할 수 없다.** protocol governance가 특정 프로젝트의
 *   처분을 정할 수 없고, 그 반대도 같다.
 * - **금지 대상은 어떤 space에서도 제안할 수 없다.** 법적 사실·개인 자격·검토
 *   결과는 투표로 만들어지지 않는다.
 * - **정족수와 통과 기준은 제안 시점 값을 쓴다.** 나중에 규칙을 바꿔 결과를
 *   뒤집을 수 없다.
 * - **정족수 미달과 부결을 구분한다.** 다음에 할 일이 다르다.
 */

/**
 * 이 기록이 만들지 않는 것.
 *
 * 응답마다 함께 보낸다. 화면이 잊어도 API가 말한다 — 거버넌스 결과를 법적
 * 승인으로 읽는 것이 가장 위험한 오해다.
 */
const GOVERNANCE_LIMITATIONS = [
  "투표 결과는 법적 사실·인허가·계약 효력을 만들지 않는다",
  "통과한 제안의 집행은 별도 행위이며 자동으로 일어나지 않는다",
  "이 결과는 검토자의 자격이나 검토 결과를 바꾸지 않는다",
] as const;

const createSchema = z.object({
  space: z.enum(["protocol", "project"]),
  projectId: z.string().uuid().nullable().default(null),
  proposalType: z.string().min(1),
  title: z.string().min(1),
  rationale: z.string().min(1, "제안 이유는 비워 둘 수 없다"),
  quorumNumerator: z.number().int().positive().default(1),
  quorumDenominator: z.number().int().positive().default(4),
  thresholdNumerator: z.number().int().positive().default(1),
  thresholdDenominator: z.number().int().positive().default(2),
  /**
   * 정족수의 분모 후보.
   *
   * 온체인 총공급을 읽을 수 있는 제안에서는 무시된다. 읽을 수 없는 제안은
   * 이 값이 있어야 투표를 열 수 있다 — 분모 없이 계산하면 정족수가 항상
   * 통과한다.
   */
  eligibleWeight: z
    .string()
    .regex(/^[1-9]\d*$/, "정족수 분모는 1 이상의 정수 문자열이어야 한다")
    .nullable()
    .default(null),
});

const voteSchema = z.object({
  choice: z.enum(["for", "against", "abstain"]),
  /**
   * 수동 무게.
   *
   * **온체인 스냅숏이 있으면 무시된다.** 던지는 사람이 자기 무게를 정할 수
   * 없어야 한다 — 그것은 투표가 아니라 선언이다. 토큰이 설정되지 않은 제안에서만
   * 쓰이고, 그 경우 응답이 `manual`이라고 밝힌다.
   */
  weight: z.string().regex(/^\d+$/, "무게는 음이 아닌 정수 문자열이어야 한다").optional(),
});

const transitionSchema = z.object({
  toState: z.enum([
    "review",
    "announced",
    "voting",
    "succeeded",
    "defeated",
    "no_quorum",
    "timelocked",
    "recorded",
    "execution_pending",
    "executed",
    "failed",
    "cancelled",
  ]),
  reason: z.string().min(1, "상태를 바꾼 이유는 비워 둘 수 없다"),
});

export interface GovernanceChain {
  /** 현재 head 블록. 스냅숏 시점을 정하는 데 쓴다. */
  headBlockNumber(): Promise<number>;
  readBalance: BalanceReader;
  /** 정족수의 분모. 무게와 같은 블록에서 읽는다. */
  readTotalSupply(input: {
    readonly tokenAddress: string;
    readonly blockNumber: number;
  }): Promise<bigint>;
  readonly tokenAddress: string | null;
  readonly chainId: number;
  readonly confirmationDepth: number;
}

/**
 * 이 space에서 온체인 스냅숏을 쓸 수 있는가 — 09 §9.1.
 *
 * `GOVERNANCE_TOKEN_ADDRESS`는 **MPC 토큰**이다. protocol space의 voter는 MPC
 * holder이고 project space의 voter는 해당 프로젝트의 AT holder다. 하나를 양쪽에
 * 쓰면 MPC 보유자가 남의 프로젝트 처분에 무게를 갖는다 — 02 §2.4 규칙 7·8이
 * 금지하는 것이다.
 *
 * AT 컨트랙트는 OD-07의 gate 뒤에 있어 아직 없다. 없는 것과 잘못된 것을 읽는
 * 것은 다르므로, project space는 온체인 경로를 열지 않고 수동 무게로 남는다.
 */
function chainForSpace(
  chain: GovernanceChain | undefined,
  space: "protocol" | "project",
): GovernanceChain | undefined {
  return space === "protocol" ? chain : undefined;
}

interface ProposalRow {
  readonly id: string;
  readonly space: "protocol" | "project";
  readonly project_id: string | null;
  readonly proposal_type: string;
  readonly title: string;
  readonly rationale: string;
  readonly state: ProposalState;
  readonly proposer_subject_id: string;
  readonly quorum_numerator: number;
  readonly quorum_denominator: number;
  readonly threshold_numerator: number;
  readonly threshold_denominator: number;
  readonly voting_opens_at: Date | null;
  readonly voting_closes_at: Date | null;
  readonly created_at: Date;
  readonly version: number;
  readonly snapshot_block: string | null;
  readonly snapshot_token_address: string | null;
  readonly snapshot_chain_id: number | null;
  readonly eligible_weight: string | null;
  readonly eligible_weight_source: "onchain_total_supply" | "manual" | null;
}

interface TallyRow {
  readonly for_weight: string;
  readonly against_weight: string;
  readonly abstain_weight: string;
}

/**
 * 사람이 넣은 분모로 계산된 정족수.
 *
 * 온체인 총공급을 읽을 수 없는 제안은 사람이 분모를 정한다. 그 값의 근거는
 * 코드 밖에 있으므로 결과를 온체인 근거로 읽으면 안 된다.
 */
const MANUAL_ELIGIBLE_WEIGHT_LIMITATION =
  "정족수의 분모는 사람이 지정한 값이며 온체인 총공급으로 확인되지 않았다";

async function loadProposal(
  tx: postgres.TransactionSql | postgres.Sql,
  proposalId: string,
): Promise<{
  row: ProposalRow;
  tally: TallyRow;
  transitions: unknown[];
} | null> {
  const [row] = await tx<ProposalRow[]>`
    SELECT * FROM core.governance_proposals WHERE id = ${proposalId}
  `;
  if (!row) return null;

  const [tally] = await tx<TallyRow[]>`
    SELECT
      coalesce(sum(weight) FILTER (WHERE choice = 'for'), 0)::text AS for_weight,
      coalesce(sum(weight) FILTER (WHERE choice = 'against'), 0)::text AS against_weight,
      coalesce(sum(weight) FILTER (WHERE choice = 'abstain'), 0)::text AS abstain_weight
    FROM core.governance_votes WHERE proposal_id = ${proposalId}
  `;

  const transitions = await tx`
    SELECT from_state AS "fromState", to_state AS "toState", reason,
           occurred_at AS "occurredAt"
    FROM core.governance_transitions
    WHERE proposal_id = ${proposalId}
    ORDER BY occurred_at
  `;

  return { row, tally: tally!, transitions: [...transitions] };
}

function toView(
  loaded: { row: ProposalRow; tally: TallyRow; transitions: unknown[] },
  requestId: string,
  asOf: string,
) {
  const { row, tally } = loaded;

  const forWeight = BigInt(tally.for_weight);
  const againstWeight = BigInt(tally.against_weight);
  const abstainWeight = BigInt(tally.abstain_weight);
  const participated = forWeight + againstWeight + abstainWeight;

  /**
   * 정족수의 분모.
   *
   * 투표를 열 때 고정된다. 그 전에는 표가 없으므로 어느 값을 써도 결과가 같다 —
   * 던진 표의 합으로 두면 `참여 × D >= 참여 × N`이 항상 참이 되어 정족수가
   * 통과만 하므로, 고정된 값이 있으면 반드시 그것을 쓴다.
   */
  const eligibleWeight =
    row.eligible_weight === null ? participated : BigInt(row.eligible_weight);

  const result = tallyVotes({
    forWeight,
    againstWeight,
    abstainWeight,
    eligibleWeight,
    quorumNumerator: row.quorum_numerator,
    quorumDenominator: row.quorum_denominator,
    thresholdNumerator: row.threshold_numerator,
    thresholdDenominator: row.threshold_denominator,
  });

  return {
    id: row.id,
    space: row.space,
    projectId: row.project_id,
    proposalType: row.proposal_type,
    title: row.title,
    rationale: row.rationale,
    state: row.state,
    proposerSubjectId: row.proposer_subject_id,
    quorum: {
      numerator: row.quorum_numerator,
      denominator: row.quorum_denominator,
    },
    threshold: {
      numerator: row.threshold_numerator,
      denominator: row.threshold_denominator,
    },
    votingOpensAt: row.voting_opens_at?.toISOString() ?? null,
    votingClosesAt: row.voting_closes_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    version: row.version,
    tally: {
      forWeight: forWeight.toString(),
      againstWeight: againstWeight.toString(),
      abstainWeight: abstainWeight.toString(),
      participatedWeight: participated.toString(),
      quorumMet: result.quorumMet,
      thresholdMet: result.thresholdMet,
      // 확정이 아니다. 마감 전에는 "지금 마감하면"이다.
      provisionalOutcome: result.outcome,
      reason: result.reason,
    },
    transitions: loaded.transitions,
    // 무게가 어디서 왔는지 밝힌다. 수동 무게로 집계된 결과를 온체인 근거로
    // 읽으면 안 된다.
    weightSource: row.snapshot_block ? "onchain_snapshot" : "manual",
    snapshotBlock: row.snapshot_block,
    /** 정족수의 분모. 투표를 열기 전에는 아직 고정되지 않아 null일 수 있다. */
    eligibleWeight: row.eligible_weight,
    eligibleWeightSource: row.eligible_weight_source,
    limitations: [
      ...GOVERNANCE_LIMITATIONS,
      ...(row.snapshot_block ? [`무게는 블록 ${row.snapshot_block} 시점의 잔고다`] : []),
      ...(row.eligible_weight_source === "manual" ? [MANUAL_ELIGIBLE_WEIGHT_LIMITATION] : []),
    ],
    requestId,
    asOf,
  };
}

/**
 * 제안이 걸린 프로젝트. 프로토콜 제안이면 null이다.
 *
 * 멱등 블록 **밖에서** 읽는다. replay는 저장된 응답을 그대로 돌려주므로, 안에
 * 두면 남의 key를 재생한 요청이 인가를 지나지 않는다.
 */
async function proposalProjectId(
  sql: postgres.Sql,
  tenantId: string,
  proposalId: string,
): Promise<string | null> {
  const [row] = await withTenant(sql, { tenantId }, (tx) =>
    tx<{ project_id: string | null }[]>`
      SELECT project_id FROM core.governance_proposals WHERE id = ${proposalId}
    `,
  );
  if (!row) throw notFound("제안을 찾을 수 없다");
  return row.project_id;
}

/** 제안 리소스. 프로젝트 제안이면 그 프로젝트 범위로 판정한다. */
function proposalResource(tenantId: string, projectId: string | null) {
  return projectId === null
    ? tenantResource(tenantId, { sensitivity: "public" })
    : projectResource(tenantId, projectId, { sensitivity: "public" });
}

export async function registerGovernanceRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
  chain?: GovernanceChain,
): Promise<void> {
  app.get("/api/v1/governance/proposals", async (request) => {
    const { session, tenantId } = requireReadContext(request);
    const { requestId, asOf } = request.context;

    /**
     * 목록도 제안과 같은 민감도로 본다.
     *
     * 여기만 `tenantResource`의 기본값(`restricted`)을 쓰고 있었다. 그래서
     * `wallet_only`인 `protocol_voter`는 **투표는 할 수 있는데 무엇에 투표하는지
     * 목록을 볼 수 없었다** — 화면에는 "제안이 없다"와 403이 함께 떴다.
     * 제안은 어느 경로에서든 `public`이다(같은 파일의 `proposalResource`).
     */
    assertAuthorized(
      session,
      "governance.read",
      proposalResource(tenantId, null),
      sessionFacts(session),
    );

    /**
     * 목록을 프로젝트 범위로 거른다 — 02 §2.1.
     *
     * 쓰기 경로는 제안의 프로젝트로 범위를 보는데 조회는 tenant 전체를 돌려주고
     * 있었다. 그러면 범위 밖 프로젝트의 제안 제목·근거·집계가 그대로 나간다 —
     * 손대지 못한다는 것이 보지 못한다는 뜻은 아니다.
     *
     * **프로토콜 제안(`project_id IS NULL`)은 거르지 않는다.** 그것은 프로젝트에
     * 매인 사안이 아니고, 투표권은 보유에서 나오지 소속에서 나오지 않는다(04 §4.5).
     */
    const visible = visibleProjectScope(session, "governance.read");

    const rows = await withTenant(
      sql,
      { tenantId },
      (tx) =>
        tx<{ id: string }[]>`
        SELECT id FROM core.governance_proposals
        WHERE project_id IS NULL
           OR ${visible === "all" ? tx`TRUE` : tx`project_id = ANY(${visible as string[]}::uuid[])`}
        ORDER BY created_at DESC LIMIT 100
      `,
    );

    const items = await withTenant(sql, { tenantId }, async (tx) => {
      const loaded = [];
      for (const { id } of rows) {
        const proposal = await loadProposal(tx, id);
        if (proposal) loaded.push(toView(proposal, requestId, asOf));
      }
      return loaded;
    });

    return { items, requestId, asOf };
  });

  app.get<{ Params: { proposalId: string } }>(
    "/api/v1/governance/proposals/:proposalId",
    async (request) => {
      const { session, tenantId } = requireReadContext(request);
      const { requestId, asOf } = request.context;

      const proposal = await withTenant(sql, { tenantId }, (tx) =>
        loadProposal(tx, request.params.proposalId),
      );
      if (!proposal) throw notFound("제안을 찾을 수 없다");

      // 프로젝트를 안 뒤에야 범위를 판정할 수 있다. 프로토콜 제안은 프로젝트에
      // 매이지 않으므로 tenant 범위로 본다.
      assertAuthorized(
        session,
        "governance.read",
        proposalResource(tenantId, proposal.row.project_id),
        sessionFacts(session),
      );

      return toView(proposal, requestId, asOf);
    },
  );

  app.post("/api/v1/governance/proposals", async (request) => {
    const { session, tenantId, idempotencyKey } = requireMutationContext(request);

    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest("REQUEST_INVALID", "요청 형식이 올바르지 않다", {
        issues: parsed.error.issues,
      });
    }

    /**
     * 프로젝트 제안은 그 프로젝트 범위 안에서만 만들 수 있다 — 04 §4.5.
     *
     * 프로토콜 제안(`projectId` 없음)은 프로젝트 경계가 없다.
     */
    const data = parsed.data;

    const effectiveRole = assertAuthorized(
      session,
      "governance.propose",
      data.projectId === null
        ? tenantResource(tenantId, { sensitivity: "public" })
        : projectResource(tenantId, data.projectId, { sensitivity: "public" }),
      sessionFacts(session),
    );

    // 금지 대상은 어떤 space에서도 제안할 수 없다. 법적 사실·개인 자격·검토
    // 결과는 투표로 만들어지지 않는다.
    if (isForbiddenTarget(data.proposalType)) {
      throw unprocessable("GOVERNANCE_TARGET_FORBIDDEN", "투표로 정할 수 없는 대상이다", {
        proposalType: data.proposalType,
      });
    }

    // space 판정은 도메인이 한다. 라우트가 목록을 다시 쓰면 둘이 갈라진다.
    const spaceCheck = checkProposalSpace(
      data.space === "protocol" ? "protocol" : { kind: "project", projectId: data.projectId ?? "" },
      data.proposalType,
    );
    if (!spaceCheck.allowed) {
      throw unprocessable(spaceCheck.reason, "이 space에서 제안할 수 없는 유형이다", {
        space: data.space,
        proposalType: data.proposalType,
      });
    }

    if (data.space === "project" && !data.projectId) {
      throw badRequest("PROPOSAL_PROJECT_REQUIRED", "project space에는 projectId가 필요하다");
    }

    const { requestId, asOf, correlationId } = request.context;
    const requestHash = hashRequest(request.body);

    return withTenant(sql, { tenantId }, (tx) =>
      withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
        const proposalId = randomUUID();

        await tx`
          INSERT INTO core.governance_proposals (
            id, tenant_id, space, project_id, proposal_type, title, rationale,
            proposer_subject_id, quorum_numerator, quorum_denominator,
            threshold_numerator, threshold_denominator, eligible_weight
          ) VALUES (
            ${proposalId}, ${tenantId}, ${data.space}, ${data.projectId},
            ${data.proposalType}, ${data.title}, ${data.rationale},
            ${session.subjectId!}, ${data.quorumNumerator}, ${data.quorumDenominator},
            ${data.thresholdNumerator}, ${data.thresholdDenominator}, ${data.eligibleWeight}
          )
        `;

        await recordAudit(tx, {
          effectiveRole,
          tenantId,
          ...(data.projectId ? { projectId: data.projectId } : {}),
          session,
          command: "governance.proposal.created",
          resourceType: "governance_proposal",
          resourceId: proposalId,
          correlationId,
          requestIp: request.ip,
          detail: { space: data.space, proposalType: data.proposalType },
        });

        const loaded = await loadProposal(tx, proposalId);
        return toView(loaded!, requestId, asOf);
      }),
    );
  });

  /**
   * 상태 전이.
   *
   * 투표 마감(`voting → succeeded|defeated|no_quorum`)은 **집계 결과와 일치해야
   * 한다.** 요청한 결과와 계산한 결과가 다르면 거절한다 — 그렇지 않으면 표를
   * 무시하고 결과를 선언할 수 있다.
   */
  app.post<{ Params: { proposalId: string } }>(
    "/api/v1/governance/proposals/:proposalId/transitions",
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
        "governance.propose",
        proposalResource(
          tenantId,
          await proposalProjectId(sql, tenantId, request.params.proposalId),
        ),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request.body);
      const { toState, reason } = parsed.data;

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          const [current] = await tx<ProposalRow[]>`
            SELECT * FROM core.governance_proposals
            WHERE id = ${request.params.proposalId}
            FOR UPDATE
          `;
          if (!current) throw notFound("제안을 찾을 수 없다");

          assertVersionMatches(expectedVersion, current.version, "governance_proposal");

          if (!canTransition(proposalMachine, current.state, toState)) {
            throw conflict("INVALID_STATE_TRANSITION", "허용되지 않는 상태 전이다", {
              fromState: current.state,
              toState,
              allowedTransitions: [...(proposalMachine.transitions[current.state] ?? [])],
            });
          }

          const loaded = await loadProposal(tx, current.id);
          const view = toView(loaded!, requestId, asOf);

          // 투표 마감은 집계와 일치해야 한다. 표를 무시하고 결과를 선언할 수 없다.
          const CLOSING = ["succeeded", "defeated", "no_quorum"];
          if (CLOSING.includes(toState) && view.tally.provisionalOutcome !== toState) {
            throw unprocessable("TALLY_MISMATCH", "집계 결과와 다른 상태로 마감할 수 없다", {
              requested: toState,
              computed: view.tally.provisionalOutcome,
              reason: view.tally.reason,
            });
          }

          /**
           * 투표를 열 때 스냅숏 블록과 정족수 분모를 함께 고정한다.
           *
           * head가 아니라 확정된 블록을 쓴다 — head는 재구성될 수 있고 그러면
           * 무게 근거가 사라진다. 분모도 같은 블록에서 읽어야 무게와 기준
           * 시점이 어긋나지 않는다.
           */
          const spaceChain = chainForSpace(chain, current.space);
          let snapshotBlock: number | null = null;
          let eligibleWeight: string | null = null;
          let eligibleWeightSource: "onchain_total_supply" | "manual" | null = null;

          if (toState === "voting") {
            if (spaceChain?.tokenAddress) {
              snapshotBlock = snapshotBlockFor(
                await spaceChain.headBlockNumber(),
                spaceChain.confirmationDepth,
              );

              let totalSupply: bigint;
              try {
                totalSupply = await spaceChain.readTotalSupply({
                  tokenAddress: spaceChain.tokenAddress,
                  blockNumber: snapshotBlock,
                });
              } catch (error) {
                // 조회 실패를 0으로 읽으면 정족수가 무조건 통과한다. 0은
                // "투표권이 없다"는 사실이고 실패는 "모른다"다.
                throw unprocessable(
                  "ELIGIBLE_WEIGHT_UNAVAILABLE",
                  "스냅숏 시점의 총공급을 읽지 못해 투표를 열 수 없다",
                  { blockNumber: String(snapshotBlock), reason: String(error).slice(0, 200) },
                );
              }

              // 0은 조회 실패와 다르지만 분모로는 똑같이 쓸 수 없다 —
              // `참여 × D >= 0 × N`이 항상 참이다. 잘못된 주소를 읽어도 0이
              // 나오므로 조용히 통과시키면 정족수가 사라진다. 판정은 catch
              // 밖에서 한다 — 안에 두면 "읽지 못했다"로 바뀐다.
              if (totalSupply === 0n) {
                throw unprocessable(
                  "ELIGIBLE_WEIGHT_ZERO",
                  "총공급이 0이라 정족수의 분모로 쓸 수 없다",
                  { blockNumber: String(snapshotBlock), tokenAddress: spaceChain.tokenAddress },
                );
              }

              eligibleWeight = totalSupply.toString();
              eligibleWeightSource = "onchain_total_supply";
            } else if (current.eligible_weight !== null) {
              eligibleWeight = current.eligible_weight;
              eligibleWeightSource = "manual";
            } else {
              // 분모 없이 열면 `참여 × D >= 참여 × N`이 항상 참이 되어
              // `no_quorum`이 구조적으로 나올 수 없다(09 §9.6).
              throw unprocessable(
                "ELIGIBLE_WEIGHT_REQUIRED",
                "정족수의 분모가 없어 투표를 열 수 없다",
                { space: current.space },
              );
            }
          }

          await tx`
            UPDATE core.governance_proposals
            SET state = ${toState},
                version = version + 1,
                voting_opens_at = ${toState === "voting" ? tx`now()` : current.voting_opens_at},
                snapshot_block = ${snapshotBlock ?? current.snapshot_block},
                snapshot_token_address = ${
                  snapshotBlock ? spaceChain!.tokenAddress : current.snapshot_token_address
                },
                snapshot_chain_id = ${
                  snapshotBlock ? spaceChain!.chainId : current.snapshot_chain_id
                },
                eligible_weight = ${eligibleWeight ?? current.eligible_weight},
                eligible_weight_source = ${eligibleWeightSource ?? current.eligible_weight_source}
            WHERE id = ${current.id}
          `;

          await tx`
            INSERT INTO core.governance_transitions (
              id, tenant_id, proposal_id, from_state, to_state, reason,
              actor_subject_id, tally_snapshot
            ) VALUES (
              ${randomUUID()}, ${tenantId}, ${current.id}, ${current.state},
              ${toState}, ${reason}, ${session.subjectId ?? null},
              ${tx.json(view.tally as never)}
            )
          `;

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            session,
            command: "governance.proposal.transitioned",
            resourceType: "governance_proposal",
            resourceId: current.id,
            beforeVersion: current.version,
            afterVersion: current.version + 1,
            reason,
            correlationId,
            requestIp: request.ip,
            /**
             * 분모의 출처를 함께 남긴다.
             *
             * 나중에 "그때 정족수의 분모가 어디서 왔나"를 물으면 답할 수 있어야
             * 한다. 제안 행에는 현재 값만 있고, 그것이 언제 무엇으로 정해졌는지는
             * 이 기록에만 남는다.
             */
            detail: {
              fromState: current.state,
              toState,
              ...(eligibleWeightSource
                ? { eligibleWeight: eligibleWeight!, eligibleWeightSource }
                : {}),
            },
          });

          await enqueueEvent(tx, {
            tenantId,
            eventType: "governance.proposal.transitioned",
            aggregateId: current.id,
            aggregateVersion: current.version + 1,
            payload: { fromState: current.state, toState },
            correlationId,
          });

          const after = await loadProposal(tx, current.id);
          return toView(after!, requestId, asOf);
        }),
      );
    },
  );

  /**
   * 투표.
   *
   * 같은 사람이 다시 던지면 갱신한다 — 두 표가 남으면 어느 것이 유효한지
   * 판정이 필요해진다. 투표 기간이 아니면 DB 트리거가 거절한다.
   */
  app.post<{ Params: { proposalId: string } }>(
    "/api/v1/governance/proposals/:proposalId/votes",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);

      const parsed = voteSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "요청 형식이 올바르지 않다", {
          issues: parsed.error.issues,
        });
      }

      const effectiveRole = assertAuthorized(
        session,
        "governance.vote",
        proposalResource(
          tenantId,
          await proposalProjectId(sql, tenantId, request.params.proposalId),
        ),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request.body);

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          const [proposal] = await tx<ProposalRow[]>`
            SELECT * FROM core.governance_proposals WHERE id = ${request.params.proposalId}
          `;
          if (!proposal) throw notFound("제안을 찾을 수 없다");

          if (proposal.state !== "voting") {
            throw conflict("VOTING_NOT_OPEN", "투표 기간이 아니다", {
              state: proposal.state,
            });
          }

          // 무게는 스냅숏에서 온다. 요청 본문의 값은 토큰이 설정되지 않은
          // 제안에서만 쓰인다.
          const resolved = await resolveVoteWeight(
            tx,
            {
              tenantId,
              proposalId: proposal.id,
              walletAddress: session.walletAddress,
              snapshotBlock: proposal.snapshot_block ? Number(proposal.snapshot_block) : null,
              snapshotTokenAddress: proposal.snapshot_token_address,
              manualWeight: parsed.data.weight ?? null,
            },
            // space 밖의 토큰으로 무게를 읽지 않는다. 스냅숏이 없는 제안에서는
            // 애초에 호출되지 않는다.
            chainForSpace(chain, proposal.space)?.readBalance ??
              (async () => {
                throw new Error("체인 클라이언트가 설정되지 않았다");
              }),
          );

          await tx`
            INSERT INTO core.governance_votes (
              id, tenant_id, proposal_id, voter_subject_id, choice, weight
            ) VALUES (
              ${randomUUID()}, ${tenantId}, ${proposal.id}, ${session.subjectId!},
              ${parsed.data.choice}, ${resolved.weight.toString()}
            )
            ON CONFLICT (proposal_id, voter_subject_id) DO UPDATE
            SET choice = EXCLUDED.choice, weight = EXCLUDED.weight, cast_at = now()
          `;

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            session,
            command: "governance.vote.cast",
            resourceType: "governance_proposal",
            resourceId: proposal.id,
            correlationId,
            requestIp: request.ip,
            // 무게는 남기지만 누가 무엇을 골랐는지는 votes 테이블에만 둔다.
            detail: {
              choice: parsed.data.choice,
              weightSource: resolved.source,
            },
          });

          const loaded = await loadProposal(tx, proposal.id);
          return toView(loaded!, requestId, asOf);
        }),
      );
    },
  );
}
