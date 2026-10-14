import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { z } from "zod";
import { governanceAction, recordExecutionRequest } from "@mpc/api-contract";
import { withTenant } from "@mpc/db";
import {
  canTransition,
  checkProposalSpace,
  checkVoteEligibility,
  EXECUTION_MODES,
  isForbiddenTarget,
  proposalMachine,
  tallyVotes,
  voterSpaceOf,
  type GovernanceSpace,
  type ProposalState,
} from "@mpc/domain";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { capRows } from "../list-window.js";
import {
  assertAuthorized,
  projectResource,
  sessionFacts,
  tenantResource,
  visibleProjectScope,
} from "../plugins/authorize.js";
import { hashRequest, withIdempotency } from "../plugins/idempotency.js";
import type { Session } from "../plugins/session.js";
import { registerGovernanceCentralizationRoute } from "./governance-centralization.js";
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
 * What this route guarantees:
 *
 * - **A vote does not create off-chain facts** (invariant 12). A passed proposal only
 *   becomes `executed`; authority, credential, and legal status stay unchanged.
 *   Every response carries that fact in `limitations`.
 * - **A proposal cannot target anything outside its space.** Protocol governance cannot
 *   decide the disposition of a specific project, and vice versa.
 * - **Forbidden targets cannot be proposed in any space.** Legal facts, personal
 *   credentials, and review outcomes are not made by vote.
 * - **Quorum and pass threshold use the values at proposal time.** Changing the rules
 *   later cannot overturn the result.
 * - **Missing quorum and defeat are distinct.** The next step differs.
 * - **Each space has its own proposers and voters** (02 §2.2, REQ-DAPP-021). The role that
 *   acts must belong to the proposal's space, and a project voter votes only on the project
 *   its binding names.
 * - **Execution is recorded, not declared** (09 §9.7, REQ-DAPP-020). Leaving
 *   `execution_pending` takes an Execution Record from the execution recorder; the vote
 *   result and the execution state stay separate.
 */

/**
 * What this record does not create.
 *
 * Sent with every response. Even if the UI forgets, the API says it — reading a governance
 * result as legal approval is the most dangerous misreading.
 */
const GOVERNANCE_LIMITATIONS = [
  "A vote result does not create legal facts, permits, or contractual effect",
  "Executing a passed proposal is a separate act and does not happen automatically",
  "This result does not change reviewer credentials or review outcomes",
] as const;

const createSchema = z.object({
  space: z.enum(["protocol", "project"]),
  projectId: z.string().uuid().nullable().default(null),
  proposalType: z.string().min(1),
  title: z.string().min(1),
  rationale: z.string().min(1, "Proposal rationale cannot be empty"),
  quorumNumerator: z.number().int().positive().default(1),
  quorumDenominator: z.number().int().positive().default(4),
  thresholdNumerator: z.number().int().positive().default(1),
  thresholdDenominator: z.number().int().positive().default(2),
  /**
   * Candidate quorum denominator.
   *
   * Ignored for proposals whose on-chain total supply is readable. Proposals where it is not
   * need this value to open voting — computed without a denominator, quorum always
   * passes.
   */
  eligibleWeight: z
    .string()
    .regex(/^[1-9]\d*$/, "Quorum denominator must be an integer string of 1 or more")
    .nullable()
    .default(null),
  /**
   * Conflict-of-interest disclosure — 09 §9.4, REQ-DAPP-022.
   *
   * Only the disclosure is recorded. Which conflicts block a vote is undecided
   * (OD-10 to OD-12), so no gate is applied here.
   */
  conflictDisclosure: z.string().trim().min(1, "The conflict-of-interest disclosure cannot be empty"),
  executionMode: z.enum(EXECUTION_MODES),
});

/**
 * States reached only through an Execution Record — 09 §9.7.
 *
 * A reason line is not evidence that anything was executed.
 */
const EXECUTION_OUTCOMES: readonly string[] = ["executed", "failed", "disputed"];

const voteSchema = z.object({
  choice: z.enum(["for", "against", "abstain"]),
  /**
   * Manual weight.
   *
   * **Ignored when an on-chain snapshot exists.** A voter must not be able to set their own
   * weight — that is a declaration, not a vote. Used only for proposals with no token
   * configured, and the response then states `manual`.
   */
  weight: z.string().regex(/^\d+$/, "Weight must be a non-negative integer string").optional(),
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
  reason: z.string().min(1, "Reason for the state change cannot be empty"),
});

export interface GovernanceChain {
  /** Current head block. Used to fix the snapshot point. */
  headBlockNumber(): Promise<number>;
  readBalance: BalanceReader;
  /** Quorum denominator. Read at the same block as the weights. */
  readTotalSupply(input: {
    readonly tokenAddress: string;
    readonly blockNumber: number;
  }): Promise<bigint>;
  readonly tokenAddress: string | null;
  readonly chainId: number;
  readonly confirmationDepth: number;
}

/**
 * Whether this space can use an on-chain snapshot — 09 §9.1.
 *
 * `GOVERNANCE_TOKEN_ADDRESS` is the **MPC token**. Protocol-space voters are MPC
 * holders; project-space voters are that project's AT holders. Using one for both
 * gives MPC holders weight over another project's disposition — which 02 §2.4 rules 7 and 8
 * forbid.
 *
 * The AT contract sits behind the OD-07 gate and does not exist yet. Reading nothing and
 * reading the wrong thing differ, so project space keeps manual weight with no on-chain path.
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
  readonly conflict_disclosure: string | null;
  readonly execution_mode: (typeof EXECUTION_MODES)[number] | null;
}

interface ExecutionRecordRow {
  readonly id: string;
  readonly from_state: string;
  readonly outcome: "executed" | "failed" | "disputed";
  readonly recorder_subject_id: string;
  readonly executor: string;
  readonly authority: string;
  readonly executed_action: string;
  readonly contract_reference: string | null;
  readonly contract_hash: string | null;
  readonly external_reference: string | null;
  readonly effective_date: string | null;
  readonly evidence_reference: string;
  readonly evidence_hash: string;
  readonly limitations: string[];
  readonly recorded_at: Date;
}

interface TallyRow {
  readonly for_weight: string;
  readonly against_weight: string;
  readonly abstain_weight: string;
}

/**
 * Quorum computed from a human-entered denominator.
 *
 * For proposals whose on-chain total supply is unreadable, a person sets the denominator. Its
 * evidence lies outside the code, so the result must not be read as on-chain evidence.
 */
const MANUAL_ELIGIBLE_WEIGHT_LIMITATION =
  "The quorum denominator is a human-specified value and was not confirmed against on-chain total supply";

interface LoadedProposal {
  readonly row: ProposalRow;
  readonly tally: TallyRow;
  readonly transitions: unknown[];
  readonly executionRecords: ExecutionRecordRow[];
}

async function loadProposal(
  tx: postgres.TransactionSql | postgres.Sql,
  proposalId: string,
): Promise<LoadedProposal | null> {
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

  const executionRecords = await tx<ExecutionRecordRow[]>`
    SELECT id, from_state, outcome, recorder_subject_id, executor, authority, executed_action,
           contract_reference, contract_hash, external_reference,
           to_char(effective_date, 'YYYY-MM-DD') AS effective_date,
           evidence_reference, evidence_hash, limitations, recorded_at
    FROM core.governance_execution_records
    WHERE proposal_id = ${proposalId}
    ORDER BY recorded_at, id
  `;

  return {
    row,
    tally: tally!,
    transitions: [...transitions],
    executionRecords: [...executionRecords],
  };
}

/** Execution state, or null before the proposal reaches it. Never derived from the tally. */
function executionStateOf(state: ProposalState) {
  return state === "execution_pending" ||
    state === "executed" ||
    state === "failed" ||
    state === "disputed"
    ? state
    : null;
}

function toView(loaded: LoadedProposal, requestId: string, asOf: string) {
  const { row, tally } = loaded;

  const forWeight = BigInt(tally.for_weight);
  const againstWeight = BigInt(tally.against_weight);
  const abstainWeight = BigInt(tally.abstain_weight);
  const participated = forWeight + againstWeight + abstainWeight;

  /**
   * Quorum denominator.
   *
   * Fixed when voting opens. Before that there are no votes, so any value gives the same result —
   * using the sum of cast votes makes `participation × D >= participation × N` always true and
   * quorum always passes, so a fixed value, when present, is always used.
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
      // Not final. Before close it means "if closed now".
      provisionalOutcome: result.outcome,
      reason: result.reason,
    },
    transitions: loaded.transitions,
    // States where the weight came from. A result tallied with manual weight must not be
    // read as on-chain evidence.
    weightSource: row.snapshot_block ? "onchain_snapshot" : "manual",
    snapshotBlock: row.snapshot_block,
    /** Quorum denominator. May be null before voting opens, as it is not yet fixed. */
    eligibleWeight: row.eligible_weight,
    eligibleWeightSource: row.eligible_weight_source,
    conflictDisclosure: row.conflict_disclosure,
    executionMode: row.execution_mode,
    execution: {
      state: executionStateOf(row.state),
      records: loaded.executionRecords.map((record) => ({
        id: record.id,
        fromState: record.from_state,
        outcome: record.outcome,
        recorderSubjectId: record.recorder_subject_id,
        executor: record.executor,
        authority: record.authority,
        executedAction: record.executed_action,
        contractReference: record.contract_reference,
        contractHash: record.contract_hash,
        externalReference: record.external_reference,
        effectiveDate: record.effective_date,
        evidenceReference: record.evidence_reference,
        evidenceHash: record.evidence_hash,
        limitations: record.limitations,
        recordedAt: record.recorded_at.toISOString(),
      })),
    },
    limitations: [
      ...GOVERNANCE_LIMITATIONS,
      ...(row.snapshot_block ? [`Weight is the balance at block ${row.snapshot_block}`] : []),
      ...(row.eligible_weight_source === "manual" ? [MANUAL_ELIGIBLE_WEIGHT_LIMITATION] : []),
    ],
    requestId,
    asOf,
  };
}

/**
 * The project the proposal belongs to. Null for a protocol proposal.
 *
 * Read **outside** the idempotency block. Replay returns the stored response as is, so if
 * this were inside, a request replaying someone else's key would skip authorization.
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
  if (!row) throw notFound("Proposal not found");
  return row.project_id;
}

/** A proposal's space follows from its project: `proposal_space_scope` ties the two (0017). */
function spaceOfProject(projectId: string | null): "protocol" | "project" {
  return projectId === null ? "protocol" : "project";
}

/**
 * Voting eligibility by space — 02 §2.2, 09 §9.3, domain `checkVoteEligibility`.
 *
 * Role authorization alone does not say **which project** a `project_voter` may vote on: the
 * role reaches the whole tenant (`TENANT_WIDE_ROLES`), yet a project voter votes only on the AT
 * snapshot of its own project. So every voter binding is mapped to the space it votes in, and
 * the domain rule decides. A session with no voter binding at all falls through to the role
 * check, which names the role it needs.
 */
function assertVoteEligible(
  bindings: Session["roleBindings"],
  proposalProjectIdValue: string | null,
): void {
  const proposalSpace: GovernanceSpace =
    proposalProjectIdValue === null
      ? "protocol"
      : { kind: "project", projectId: proposalProjectIdValue };

  const voterBindings = bindings.filter(
    (binding) => binding.role === "protocol_voter" || binding.role === "project_voter",
  );
  if (voterBindings.length === 0) return;

  let reason: string = "GOVERNANCE_SPACE_MISMATCH";
  for (const binding of voterBindings) {
    const voterSpace = voterSpaceOf(binding);
    if (voterSpace === null) {
      reason = "GOVERNANCE_PROJECT_SCOPE_MISMATCH";
      continue;
    }
    const check = checkVoteEligibility(voterSpace, proposalSpace);
    if (check.allowed) return;
    reason = check.reason;
  }

  throw forbidden(reason, "Your voting rights do not cover this proposal's space", {
    space: proposalSpace === "protocol" ? "protocol" : "project",
  });
}

/** Proposal resource. A project proposal is judged within that project's scope. */
function proposalResource(tenantId: string, projectId: string | null) {
  return projectId === null
    ? tenantResource(tenantId, { sensitivity: "public" })
    : projectResource(tenantId, projectId, { sensitivity: "public" });
}

/**
 * Cap on the proposal list.
 *
 * A flag rather than pages: proposals arrive slowly and the newest are the ones still open to
 * act on. Past the cap the response says `truncated` so the screen does not read as complete.
 */
const PROPOSAL_LIST_LIMIT = 100;

export async function registerGovernanceRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
  chain?: GovernanceChain,
): Promise<void> {
  await registerGovernanceCentralizationRoute(app, sql);

  app.get("/api/v1/governance/proposals", async (request) => {
    const { session, tenantId } = requireReadContext(request);
    const { requestId, asOf } = request.context;

    /**
     * The list has the same sensitivity as a proposal.
     *
     * This was the only place using the `tenantResource` default (`restricted`). So a
     * `wallet_only` `protocol_voter` **could vote but could not list what it was voting
     * on** — the screen showed "no proposals" alongside a 403.
     * A proposal is `public` on every path (`proposalResource` in this file).
     */
    assertAuthorized(
      session,
      "governance.read",
      proposalResource(tenantId, null),
      sessionFacts(session),
    );

    /**
     * Filters the list to project scope — 02 §2.1.
     *
     * Write paths scope by the proposal's project, but reads returned the whole tenant. That
     * leaks titles, rationale, and tallies of out-of-scope projects' proposals — being
     * unable to modify something does not mean being unable to see it.
     *
     * **Protocol proposals (`project_id IS NULL`) are not filtered.** They are not tied to
     * a project, and voting rights come from holdings, not membership (04 §4.5).
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
        ORDER BY created_at DESC, id DESC LIMIT ${PROPOSAL_LIST_LIMIT + 1}
      `,
    );
    const window = capRows(rows, PROPOSAL_LIST_LIMIT);

    const items = await withTenant(sql, { tenantId }, async (tx) => {
      const loaded = [];
      for (const { id } of window.items) {
        const proposal = await loadProposal(tx, id);
        if (proposal) loaded.push(toView(proposal, requestId, asOf));
      }
      return loaded;
    });

    return { items, truncated: window.truncated, limit: window.limit, requestId, asOf };
  });

  app.get<{ Params: { proposalId: string } }>(
    "/api/v1/governance/proposals/:proposalId",
    async (request) => {
      const { session, tenantId } = requireReadContext(request);
      const { requestId, asOf } = request.context;

      const proposal = await withTenant(sql, { tenantId }, (tx) =>
        loadProposal(tx, request.params.proposalId),
      );
      if (!proposal) throw notFound("Proposal not found");

      // Scope can be judged only once the project is known. Protocol proposals are not tied to
      // a project, so they are judged at tenant scope.
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
      throw badRequest("REQUEST_INVALID", "Request format is invalid", {
        issues: parsed.error.issues,
      });
    }

    /**
     * A project proposal can be created only within that project's scope — 04 §4.5.
     *
     * A protocol proposal (no `projectId`) has no project boundary.
     */
    const data = parsed.data;

    // Checked before authorization: a project proposal without a project would otherwise be
    // judged at tenant scope, where the project boundary is not evaluated.
    if (data.space === "project" && !data.projectId) {
      throw badRequest("PROPOSAL_PROJECT_REQUIRED", "projectId is required for project space");
    }
    if (data.space === "protocol" && data.projectId) {
      throw badRequest("PROPOSAL_PROJECT_FORBIDDEN", "A protocol proposal has no projectId");
    }

    /**
     * The proposer's role must belong to the proposal's space — 02 §2.2.
     *
     * `protocol_proposer` is forbidden to create project asset proposals and
     * `project_proposer` to change protocol policy. Checking the proposal type against the
     * space alone let a protocol proposer create a project sale proposal.
     */
    const effectiveRole = assertAuthorized(
      session,
      governanceAction(data.space, "propose"),
      data.projectId === null
        ? tenantResource(tenantId, { sensitivity: "public" })
        : projectResource(tenantId, data.projectId, { sensitivity: "public" }),
      sessionFacts(session),
    );

    // Forbidden targets cannot be proposed in any space. Legal facts, personal credentials,
    // and review outcomes are not made by vote.
    if (isForbiddenTarget(data.proposalType)) {
      throw unprocessable("GOVERNANCE_TARGET_FORBIDDEN", "This target cannot be decided by vote", {
        proposalType: data.proposalType,
      });
    }

    // The domain judges the space. If the route rewrote the list, the two would diverge.
    const spaceCheck = checkProposalSpace(
      data.space === "protocol" ? "protocol" : { kind: "project", projectId: data.projectId ?? "" },
      data.proposalType,
    );
    if (!spaceCheck.allowed) {
      throw unprocessable(spaceCheck.reason, "This proposal type is not allowed in this space", {
        space: data.space,
        proposalType: data.proposalType,
      });
    }

    const { requestId, asOf, correlationId } = request.context;
    const requestHash = hashRequest(request);

    return withTenant(sql, { tenantId }, (tx) =>
      withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
        const proposalId = randomUUID();

        await tx`
          INSERT INTO core.governance_proposals (
            id, tenant_id, space, project_id, proposal_type, title, rationale,
            proposer_subject_id, quorum_numerator, quorum_denominator,
            threshold_numerator, threshold_denominator, eligible_weight,
            conflict_disclosure, execution_mode
          ) VALUES (
            ${proposalId}, ${tenantId}, ${data.space}, ${data.projectId},
            ${data.proposalType}, ${data.title}, ${data.rationale},
            ${session.subjectId!}, ${data.quorumNumerator}, ${data.quorumDenominator},
            ${data.thresholdNumerator}, ${data.thresholdDenominator}, ${data.eligibleWeight},
            ${data.conflictDisclosure}, ${data.executionMode}
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
          requestIp: request.clientIp,
          detail: {
            space: data.space,
            proposalType: data.proposalType,
            executionMode: data.executionMode,
          },
        });

        const loaded = await loadProposal(tx, proposalId);
        return toView(loaded!, requestId, asOf);
      }),
    );
  });

  /**
   * State transition.
   *
   * Closing a vote (`voting → succeeded|defeated|no_quorum`) **must match the tally.** A
   * requested result that differs from the computed one is rejected — otherwise votes could
   * be ignored and a result declared.
   */
  app.post<{ Params: { proposalId: string } }>(
    "/api/v1/governance/proposals/:proposalId/transitions",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      const expectedVersion = requireIfMatch(request);

      const parsed = transitionSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "Request format is invalid", {
          issues: parsed.error.issues,
        });
      }

      const { toState, reason } = parsed.data;

      // Leaving execution_pending takes evidence, which this endpoint does not accept.
      if (EXECUTION_OUTCOMES.includes(toState)) {
        throw conflict(
          "EXECUTION_RECORD_REQUIRED",
          "This state is reached only by recording the off-chain execution",
          {
            toState,
            path: `/api/v1/governance/proposals/${request.params.proposalId}/execution-records`,
          },
        );
      }

      /**
       * Administering a proposal stays inside its space — REQ-DAPP-021.
       *
       * A protocol proposer moving a project proposal forward is a cross-space mutation, the
       * same as creating one.
       */
      const projectId = await proposalProjectId(sql, tenantId, request.params.proposalId);
      const effectiveRole = assertAuthorized(
        session,
        governanceAction(spaceOfProject(projectId), "administer"),
        proposalResource(tenantId, projectId),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request);

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          const [current] = await tx<ProposalRow[]>`
            SELECT * FROM core.governance_proposals
            WHERE id = ${request.params.proposalId}
            FOR UPDATE
          `;
          if (!current) throw notFound("Proposal not found");

          assertVersionMatches(expectedVersion, current.version, "governance_proposal");

          if (!canTransition(proposalMachine, current.state, toState)) {
            throw conflict("INVALID_STATE_TRANSITION", "State transition not allowed", {
              fromState: current.state,
              toState,
              allowedTransitions: [...(proposalMachine.transitions[current.state] ?? [])],
            });
          }

          const loaded = await loadProposal(tx, current.id);
          const view = toView(loaded!, requestId, asOf);

          // Closing a vote must match the tally. A result cannot be declared by ignoring votes.
          const CLOSING = ["succeeded", "defeated", "no_quorum"];
          if (CLOSING.includes(toState) && view.tally.provisionalOutcome !== toState) {
            throw unprocessable("TALLY_MISMATCH", "Cannot close with a state that differs from the tally", {
              requested: toState,
              computed: view.tally.provisionalOutcome,
              reason: view.tally.reason,
            });
          }

          /**
           * Opening voting fixes the snapshot block and the quorum denominator together.
           *
           * Uses a finalized block, not head — head can be reorganized, and then the weight
           * evidence disappears. The denominator is read at the same block so weight and baseline
           * do not drift apart.
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
                // Reading a lookup failure as 0 makes quorum always pass. 0 is
                // the fact "no voting power"; failure is "unknown".
                throw unprocessable(
                  "ELIGIBLE_WEIGHT_UNAVAILABLE",
                  "Cannot open voting: total supply at the snapshot block could not be read",
                  { blockNumber: String(snapshotBlock), reason: String(error).slice(0, 200) },
                );
              }

              // 0 differs from a lookup failure but is equally unusable as a denominator —
              // `participation × D >= 0 × N` is always true. A wrong address also reads 0,
              // so passing it silently would erase quorum. The check runs outside
              // the catch — inside, it would turn into "could not read".
              if (totalSupply === 0n) {
                throw unprocessable(
                  "ELIGIBLE_WEIGHT_ZERO",
                  "Total supply is 0 and cannot serve as the quorum denominator",
                  { blockNumber: String(snapshotBlock), tokenAddress: spaceChain.tokenAddress },
                );
              }

              eligibleWeight = totalSupply.toString();
              eligibleWeightSource = "onchain_total_supply";
            } else if (current.eligible_weight !== null) {
              eligibleWeight = current.eligible_weight;
              eligibleWeightSource = "manual";
            } else {
              // Opening without a denominator makes `participation × D >= participation × N`
              // always true, so `no_quorum` can structurally never occur (09 §9.6).
              throw unprocessable(
                "ELIGIBLE_WEIGHT_REQUIRED",
                "Cannot open voting: no quorum denominator",
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
            requestIp: request.clientIp,
            /**
             * Records the denominator's source as well.
             *
             * Later, "where did the quorum denominator come from then?" must be answerable. The
             * proposal row holds only the current value; when and from what it was set is kept
             * only in this record.
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
   * Vote.
   *
   * A repeat vote by the same person updates the earlier one — two stored votes would need a
   * ruling on which is valid. Outside the voting period a DB trigger rejects it.
   */
  app.post<{ Params: { proposalId: string } }>(
    "/api/v1/governance/proposals/:proposalId/votes",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);

      const parsed = voteSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "Request format is invalid", {
          issues: parsed.error.issues,
        });
      }

      const projectId = await proposalProjectId(sql, tenantId, request.params.proposalId);
      assertVoteEligible(session.roleBindings, projectId);

      const effectiveRole = assertAuthorized(
        session,
        governanceAction(spaceOfProject(projectId), "vote"),
        proposalResource(tenantId, projectId),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request);

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          const [proposal] = await tx<ProposalRow[]>`
            SELECT * FROM core.governance_proposals WHERE id = ${request.params.proposalId}
          `;
          if (!proposal) throw notFound("Proposal not found");

          if (proposal.state !== "voting") {
            throw conflict("VOTING_NOT_OPEN", "Voting is not open", {
              state: proposal.state,
            });
          }

          // Weight comes from the snapshot. The request body value is used only for proposals
          // with no token configured.
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
            // Weight is never read from a token outside the space. For proposals without a snapshot
            // this is never called.
            chainForSpace(chain, proposal.space)?.readBalance ??
              (async () => {
                throw new Error("Chain client is not configured");
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
            requestIp: request.clientIp,
            // Weight is recorded, but who chose what stays only in the votes table.
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

  /**
   * Off-chain execution record — 09 §9.7, 02 §2.3 "Off-chain Execution", REQ-DAPP-020.
   *
   * The only way out of `execution_pending` (and `disputed`). The recorder states who executed,
   * under what authority, what was executed, and the evidence by reference and hash. The
   * record and the state change are written together; a DB trigger refuses the state change
   * without the record for any other writer.
   *
   * The tally is not touched — it is copied into the transition row as it stood, the same as
   * every other transition, so the record shows what the vote said when execution was recorded.
   */
  app.post<{ Params: { proposalId: string } }>(
    "/api/v1/governance/proposals/:proposalId/execution-records",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      const expectedVersion = requireIfMatch(request);

      const parsed = recordExecutionRequest.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "Request format is invalid", {
          issues: parsed.error.issues,
        });
      }

      const projectId = await proposalProjectId(sql, tenantId, request.params.proposalId);
      const effectiveRole = assertAuthorized(
        session,
        "governance.execution.record",
        proposalResource(tenantId, projectId),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request);
      const record = parsed.data;

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          const [current] = await tx<ProposalRow[]>`
            SELECT * FROM core.governance_proposals
            WHERE id = ${request.params.proposalId}
            FOR UPDATE
          `;
          if (!current) throw notFound("Proposal not found");

          assertVersionMatches(expectedVersion, current.version, "governance_proposal");

          if (
            (current.state !== "execution_pending" && current.state !== "disputed") ||
            !canTransition(proposalMachine, current.state, record.outcome)
          ) {
            throw conflict(
              "EXECUTION_NOT_PENDING",
              "Execution can be recorded only while it is pending or disputed",
              {
                state: current.state,
                outcome: record.outcome,
                allowedTransitions: [...(proposalMachine.transitions[current.state] ?? [])],
              },
            );
          }

          const view = toView((await loadProposal(tx, current.id))!, requestId, asOf);
          const recordId = randomUUID();

          await tx`
            INSERT INTO core.governance_execution_records (
              id, tenant_id, proposal_id, from_state, outcome, recorder_subject_id,
              executor, authority, executed_action, contract_reference, contract_hash,
              external_reference, effective_date, evidence_reference, evidence_hash, limitations
            ) VALUES (
              ${recordId}, ${tenantId}, ${current.id}, ${current.state}, ${record.outcome},
              ${session.subjectId!}, ${record.executor}, ${record.authority},
              ${record.executedAction}, ${record.contractReference}, ${record.contractHash},
              ${record.externalReference}, ${record.effectiveDate}, ${record.evidenceReference},
              ${record.evidenceHash}, ${record.limitations}
            )
          `;

          await tx`
            UPDATE core.governance_proposals
            SET state = ${record.outcome}, version = version + 1
            WHERE id = ${current.id}
          `;

          // The transition reason of a protocol proposal is public (0027). What was executed
          // can name contracts and parties, so it stays in the record, which is not public.
          const reason = `Execution recorded as ${record.outcome}`;
          await tx`
            INSERT INTO core.governance_transitions (
              id, tenant_id, proposal_id, from_state, to_state, reason,
              actor_subject_id, tally_snapshot
            ) VALUES (
              ${randomUUID()}, ${tenantId}, ${current.id}, ${current.state},
              ${record.outcome}, ${reason}, ${session.subjectId ?? null},
              ${tx.json(view.tally as never)}
            )
          `;

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            ...(projectId ? { projectId } : {}),
            session,
            command: "governance.execution.recorded",
            resourceType: "governance_proposal",
            resourceId: current.id,
            beforeVersion: current.version,
            afterVersion: current.version + 1,
            reason,
            correlationId,
            requestIp: request.clientIp,
            detail: {
              executionRecordId: recordId,
              fromState: current.state,
              outcome: record.outcome,
              evidenceHash: record.evidenceHash,
            },
          });

          // 07 §7.4 `execution.status.changed` — kept apart from the proposal's vote events.
          await enqueueEvent(tx, {
            tenantId,
            eventType: "execution.status.changed",
            aggregateId: current.id,
            aggregateVersion: current.version + 1,
            payload: {
              executionRecordId: recordId,
              fromState: current.state,
              toState: record.outcome,
            },
            correlationId,
          });

          const after = await loadProposal(tx, current.id);
          return toView(after!, requestId, asOf);
        }),
      );
    },
  );
}
