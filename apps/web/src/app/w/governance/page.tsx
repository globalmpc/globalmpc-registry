"use client";

import Link from "next/link";
import {
  canRecordExecutionFor,
  EMPTY_EXECUTION_RECORD,
  type ExecutionRecordFields,
} from "@/lib/execution-record";
import { useCallback, useEffect, useState } from "react";
import {
  castVote,
  createProposal,
  listProposals,
  newIdempotencyKey,
  recordProposalExecution,
  transitionProposal,
  type ExecutionMode,
  type GovernanceProposal,
} from "@/lib/api";
import { useSession } from "@/lib/session";
import { ErrorNotice } from "@/components/ErrorNotice";
import { TruncatedNotice } from "@/components/TruncatedNotice";
import { GovernanceCentralizationPanel } from "@/components/GovernanceCentralization";

/** Proposal types per space — the domain's allowlists (09 §9.2·§9.3). */
const PROPOSAL_TYPES = {
  protocol: "attestation_schema_approval",
  project: "independent_valuation_request",
} as const;

const EXECUTION_MODES: readonly ExecutionMode[] = [
  "record_only",
  "onchain_bounded",
  "offchain_required",
];

/**
 * Governance — spec 04 §4.5, 11 §11.3, OD-06.
 *
 * **A vote result is not legal approval.** The main risk on this screen is making a passed
 * proposal read as "approved". So each proposal's `limitations` are shown
 * alongside it, starting in the list.
 *
 * No quorum and defeated get different wording — the next step differs.
 */
export default function GovernancePage() {
  const { token, loading: sessionLoading, session } = useSession();
  const [proposals, setProposals] = useState<GovernanceProposal[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const [title, setTitle] = useState("");
  const [rationale, setRationale] = useState("");
  const [weight, setWeight] = useState("100");
  /**
   * Quorum denominator — 09 §9.6.
   *
   * A proposal with no linked token cannot open voting without this value. Using the sum of
   * votes cast as the denominator always meets quorum, so `no_quorum` could never occur.
   */
  const [eligibleWeight, setEligibleWeight] = useState("");
  // The server caps the list and says so.
  const [truncated, setTruncated] = useState(false);
  const [reason, setReason] = useState("");
  const [space, setSpace] = useState<"protocol" | "project">("protocol");
  const [projectId, setProjectId] = useState("");
  /**
   * Conflict-of-interest disclosure — 09 §9.4, REQ-DAPP-022.
   *
   * Required: "none known" is a statement the proposer answers for, not an empty field.
   */
  const [disclosure, setDisclosure] = useState("");
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("record_only");
  // Execution record — 09 §9.7. Evidence by reference and hash; the document stays private.
  const [executionRecord, setExecutionRecord] =
    useState<ExecutionRecordFields>(EMPTY_EXECUTION_RECORD);
  const setRecordField = (field: keyof ExecutionRecordFields) => (value: string) =>
    setExecutionRecord((current) => ({ ...current, [field]: value }));

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const page = await listProposals(token);
      setProposals(page.items);
      setTruncated(page.truncated);
      setError(null);
    } catch (caught) {
      setError(caught);
    }
  }, [token]);

  useEffect(() => {
    if (!sessionLoading) void load();
  }, [load, sessionLoading]);

  async function run(step: (activeToken: string) => Promise<unknown>) {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await step(token);
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  if (!sessionLoading && !token) {
    return (
      <p className="sub">
        No account is connected. <Link href="/">Connect an account →</Link>
      </p>
    );
  }

  /**
   * Roles per space — 02 §2.2·§2.3.
   *
   * Each space has its own proposer and voter. The MPC operator administers proposals but
   * neither proposes nor votes. The server decides; these only avoid offering buttons it
   * would refuse.
   */
  const roles = session?.roleBindings?.map((binding) => binding.role) ?? [];
  const proposableSpaces = (["protocol", "project"] as const).filter((candidate) =>
    roles.includes(`${candidate}_proposer`),
  );
  const canPropose = proposableSpaces.length > 0;
  const createSpace = proposableSpaces.includes(space) ? space : proposableSpaces[0];
  const canVoteIn = (proposalSpace: string) => roles.includes(`${proposalSpace}_voter`);
  const canVote = roles.some((role) => role === "protocol_voter" || role === "project_voter");
  const canAdminister = (proposalSpace: string) =>
    roles.includes(`${proposalSpace}_proposer`) || roles.includes("mpc_operator");
  const canAdministerAny = canPropose || roles.includes("mpc_operator");
  const canRecordExecution = roles.includes("execution_recorder");
  const awaitingRecord = proposals.filter(
    (proposal) => proposal.state === "execution_pending" || proposal.state === "disputed",
  );

  const renderCreateAProposal = () => {
    return canPropose && createSpace ? (
      <div className="panel">
        <h2>Create a proposal</h2>
        {proposableSpaces.length > 1 ? (
          <div className="field">
            <label htmlFor="space">Space</label>
            <select
              id="space"
              value={createSpace}
              onChange={(event) => setSpace(event.target.value as "protocol" | "project")}
            >
              {proposableSpaces.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {candidate}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <p className="meta">
            Space: <span className="mono">{createSpace}</span> — your role proposes only here.
          </p>
        )}
        {createSpace === "project" ? (
          <div className="field">
            <label htmlFor="projectId">Project ID</label>
            <input
              id="projectId"
              className="mono"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value.trim())}
            />
          </div>
        ) : null}
        <div className="field">
          <label htmlFor="title">Title</label>
          <input id="title" value={title} onChange={(event) => setTitle(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="rationale">Rationale (required)</label>
          <input
            id="rationale"
            value={rationale}
            onChange={(event) => setRationale(event.target.value)}
            placeholder="What should change, and why"
          />
        </div>
        <div className="field">
          <label htmlFor="eligibleWeight">Eligible weight (required)</label>
          <input
            id="eligibleWeight"
            className="mono"
            value={eligibleWeight}
            onChange={(event) => setEligibleWeight(event.target.value.replace(/\D/g, ""))}
            placeholder="Total weight entitled to vote"
          />
          {/*
                  Quorum denominator — 09 §9.6.

                  Using the sum of votes cast as the denominator always meets quorum. Once a token
                  is linked, total supply at the snapshot block replaces this value.
                */}
          <p className="meta">
            The denominator for quorum, not the sum of votes cast. Once a governance token is
            connected, the total supply at the snapshot block replaces this.
          </p>
        </div>
        <div className="field">
          <label htmlFor="disclosure">Conflict disclosure (required)</label>
          <input
            id="disclosure"
            value={disclosure}
            onChange={(event) => setDisclosure(event.target.value)}
            placeholder="Who may gain from this proposal, including you — or state that none is known"
          />
          <p className="meta">
            Shown with the proposal, publicly for protocol proposals. It cannot be edited afterwards.
          </p>
        </div>
        <div className="field">
          <label htmlFor="executionMode">Execution mode</label>
          <select
            id="executionMode"
            value={executionMode}
            onChange={(event) => setExecutionMode(event.target.value as ExecutionMode)}
          >
            {EXECUTION_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </select>
        </div>
        <button
          className="primary"
          data-testid="create-proposal"
          disabled={
            busy ||
            title.trim().length === 0 ||
            rationale.trim().length === 0 ||
            eligibleWeight.length === 0 ||
            /^0+$/.test(eligibleWeight) ||
            disclosure.trim().length === 0 ||
            (createSpace === "project" && projectId.length === 0)
          }
          onClick={() =>
            void run((activeToken) =>
              createProposal(
                activeToken,
                {
                  space: createSpace,
                  projectId: createSpace === "project" ? projectId : null,
                  proposalType: PROPOSAL_TYPES[createSpace],
                  title: title.trim(),
                  rationale: rationale.trim(),
                  eligibleWeight,
                  conflictDisclosure: disclosure.trim(),
                  executionMode,
                },
                newIdempotencyKey(),
              ),
            )
          }
        >
          Propose
        </button>
        <p className="meta" style={{ marginTop: 10 }}>
          {/* Legal facts, individual credentials, and review results are not created by vote. */}
          Overriding readiness, approving legal issuance, and altering review content are not
          proposable. The server refuses them.
        </p>
      </div>
    ) : null;
  };

  const renderProposals = () => {
    const renderProposalRow = (proposal: (typeof proposals)[number]) => {
      const renderProposalActions = () => {
        return (
          <td>
            <div className="row" style={{ gap: 6 }}>
              {canVoteIn(proposal.space) && proposal.state === "voting"
                ? (["for", "against", "abstain"] as const).map((choice) => (
                    <button
                      key={choice}
                      data-testid={`vote-${choice}-${proposal.id}`}
                      disabled={busy}
                      onClick={() =>
                        void run((activeToken) =>
                          castVote(activeToken, proposal.id, { choice, weight }, newIdempotencyKey()),
                        )
                      }
                    >
                      {choice === "for" ? "For" : choice === "against" ? "Against" : "Abstain"}
                    </button>
                  ))
                : null}

              {canRecordExecution &&
              (proposal.state === "execution_pending" || proposal.state === "disputed")
                ? (["executed", "failed"] as const).map((outcome) => (
                    <button
                      key={outcome}
                      data-testid={`record-${outcome}-${proposal.id}`}
                      disabled={busy || !canRecordExecutionFor(executionRecord, proposal.id)}
                      onClick={() =>
                        void run(async (activeToken) => {
                          await recordProposalExecution(
                            activeToken,
                            proposal.id,
                            proposal.version,
                            {
                              outcome,
                              executor: executionRecord.executor.trim(),
                              authority: executionRecord.authority.trim(),
                              executedAction: executionRecord.executedAction.trim(),
                              evidenceReference: executionRecord.evidenceReference.trim(),
                              evidenceHash: executionRecord.evidenceHash,
                              limitations: [executionRecord.limitation.trim()],
                            },
                            newIdempotencyKey(),
                          );
                          // A written record is final; nothing typed for it carries over.
                          setExecutionRecord(EMPTY_EXECUTION_RECORD);
                        })
                      }
                    >
                      Record {outcome}
                    </button>
                  ))
                : null}

              {canAdminister(proposal.space)
                ? nextStates(proposal).map((next) => (
                    <button
                      key={next}
                      data-testid={`advance-${next}-${proposal.id}`}
                      disabled={busy || reason.trim().length === 0}
                      onClick={() =>
                        void run((activeToken) =>
                          transitionProposal(
                            activeToken,
                            proposal.id,
                            proposal.version,
                            { toState: next, reason: reason.trim() },
                            newIdempotencyKey(),
                          ),
                        )
                      }
                    >
                      {next}
                    </button>
                  ))
                : null}
            </div>
          </td>
        );
      };

      return (
        <tr key={proposal.id}>
          <td className="mono meta">{proposal.space}</td>
          <td>
            {proposal.title}
            <div className="meta">{proposal.rationale}</div>
            <div className="meta" data-testid={`disclosure-${proposal.id}`}>
              Conflict disclosure:{" "}
              {proposal.conflictDisclosure ??
                "not recorded — created before disclosures were required"}
            </div>
            <div className="meta mono">Execution mode: {proposal.executionMode ?? "—"}</div>
          </td>
          <td>
            <span className="mono" data-testid={`proposal-state-${proposal.id}`}>
              {proposal.state}
            </span>
            {/*
                            Execution is its own column of facts — 09 §9.7. A passed vote is not
                            an execution; only a recorded execution with evidence is.
                          */}
            {proposal.execution.state ? (
              <div className="meta" data-testid={`execution-${proposal.id}`}>
                Execution: {proposal.execution.state}
                {proposal.execution.records.map((record) => (
                  <div key={record.id}>
                    {record.outcome} by {record.executor} under {record.authority}:{" "}
                    {record.executedAction}
                    <div className="mono">Evidence {record.evidenceHash}</div>
                  </div>
                ))}
              </div>
            ) : null}
          </td>
          <td className="mono meta">
            For {proposal.tally.forWeight} / against {proposal.tally.againstWeight} / abstain{" "}
            {proposal.tally.abstainWeight}
            <div className="meta">
              {/* No quorum and defeated call for different next steps. */}
              {proposal.tally.reason}
            </div>
          </td>
          {/*
                          Where the weight came from — 04 §4.5.

                          A tally from manual weights must not read as on-chain evidence.
                          Placed next to the tally so it is read with the numbers.
                        */}
          <td className="meta" data-testid={`weight-source-${proposal.id}`}>
            {proposal.weightSource === "onchain_snapshot" ? (
              <>
                <span>On-chain snapshot</span>
                <div className="mono">Block {proposal.snapshotBlock}</div>
              </>
            ) : (
              <>
                <span>Entered manually</span>
                <div>No token snapshot — tallied with weights a person entered</div>
              </>
            )}
          </td>
          {/*
                          Quorum — 09 §9.6.

                          A bare ratio does not say what it is a ratio of. Show the denominator
                          and its source — a quorum computed from a person-entered denominator
                          must not read as on-chain evidence.
                        */}
          <td className="mono meta" data-testid={`quorum-${proposal.id}`}>
            {proposal.quorum.numerator}/{proposal.quorum.denominator}
            <div>{proposal.tally.quorumMet ? "Met" : "Not met"}</div>
            {proposal.eligibleWeight === null ? (
              <div>Denominator is fixed when voting opens</div>
            ) : (
              <div>
                of {proposal.eligibleWeight}
                {proposal.eligibleWeightSource === "onchain_total_supply"
                  ? " (total supply on chain)"
                  : " (entered manually)"}
              </div>
            )}
          </td>
          {renderProposalActions()}
        </tr>
      );
    };

    const renderProposalTable = () => {
      return proposals.length === 0 ? (
        <p className="sub" style={{ margin: 0 }}>
          There are no proposals. There is no data here; this is not a permission problem.
        </p>
      ) : (
        <div className="table-scroll">
          <table data-testid="proposal-table">
            <thead>
              <tr>
                <th>space</th>
                <th>Title</th>
                <th>State</th>
                <th>Tally</th>
                <th>Weight basis</th>
                <th>Quorum</th>
                <th />
              </tr>
            </thead>
            <tbody>{proposals.map(renderProposalRow)}</tbody>
          </table>
        </div>
      );
    };

    const renderExecutionRecord = () => {
      return canRecordExecution ? (
        <div className="field-group" data-testid="execution-record-form">
          <h2 style={{ marginTop: 14 }}>Execution record</h2>
          <p className="meta">
            Records what was done off chain after a vote, and on what evidence. It does not change the
            vote result.
          </p>
          <div className="field">
            <label htmlFor="executionTarget">For proposal</label>
            <select
              id="executionTarget"
              value={executionRecord.targetProposalId}
              onChange={(event) => setRecordField("targetProposalId")(event.target.value)}
            >
              <option value="">Choose the proposal this record is for</option>
              {awaitingRecord.map((proposal) => (
                <option key={proposal.id} value={proposal.id}>
                  {proposal.title}
                </option>
              ))}
            </select>
          </div>
          {(
            [
              ["executor", "Executed by", executionRecord.executor, setRecordField("executor")],
              [
                "executionAuthority",
                "Under authority",
                executionRecord.authority,
                setRecordField("authority"),
              ],
              [
                "executedAction",
                "What was executed",
                executionRecord.executedAction,
                setRecordField("executedAction"),
              ],
              [
                "evidenceReference",
                "Evidence reference",
                executionRecord.evidenceReference,
                setRecordField("evidenceReference"),
              ],
              [
                "evidenceHash",
                "Evidence hash (0x + 64 hex)",
                executionRecord.evidenceHash,
                setRecordField("evidenceHash"),
              ],
              [
                "executionLimitation",
                "What this record does not establish",
                executionRecord.limitation,
                setRecordField("limitation"),
              ],
            ] as const
          ).map(([id, label, value, set]) => (
            <div className="field" key={id}>
              <label htmlFor={id}>{label}</label>
              <input
                id={id}
                className={id === "evidenceHash" ? "mono" : undefined}
                value={value}
                onChange={(event) =>
                  set(
                    id === "evidenceHash"
                      ? event.target.value.trim().toLowerCase()
                      : event.target.value,
                  )
                }
              />
            </div>
          ))}
        </div>
      ) : null;
    };

    return (
      <div className="panel">
        <h2>Proposals</h2>
        {renderProposalTable()}

        {/*
              If any proposal has a snapshot, the entered value is not used for
              it. Leaving a value the server ignores editable reads as if you could set
              your own weight.
            */}
        {canVote ? (
          <div className="field" style={{ marginTop: 14 }}>
            <label htmlFor="weight">Vote weight</label>
            <input
              id="weight"
              className="mono"
              value={weight}
              onChange={(event) => setWeight(event.target.value)}
            />
            <div className="meta">
              {/* Token weight has 18 decimals. Handle it as a string to keep precision. */}
              An integer string. It is not used on proposals that have a snapshot — there the weight
              is the on-chain balance at the start of voting, and the server ignores this input.
            </div>
          </div>
        ) : null}

        {renderExecutionRecord()}

        {canAdministerAny ? (
          <div className="field">
            <label htmlFor="reason">Reason for the state change (required)</label>
            <input id="reason" value={reason} onChange={(event) => setReason(event.target.value)} />
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Governance</h1>
          <p className="sub">
            Protocol and project decisions are recorded separately. A vote does not create an
            off-chain fact.
          </p>
        </div>
        <Link href="/w/projects">← Projects</Link>
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      {truncated ? (
        <TruncatedNotice shown={proposals.length} noun="proposals, newest first" testId="proposals-truncated" />
      ) : null}

      <div className="notice" style={{ color: "var(--alert)" }} data-testid="governance-boundary">
        <div className="title">What this decision does not create</div>
        {/* Reading a passed proposal as "approved" is the most dangerous misreading. */}
        A vote creates no legal fact, no permit, and no contractual effect. Even when a proposal
        passes, execution is a separate act and does not happen automatically. It changes neither
        a reviewer’s standing nor the outcome of a review.
      </div>

      <GovernanceCentralizationPanel />

      {renderCreateAProposal()}

      {renderProposals()}
    </>
  );
}

/**
 * States reachable next.
 *
 * For closing (`succeeded`/`defeated`/`no_quorum`), show **only the one the tally indicates**.
 * Showing all three reads as picking regardless of the votes — the server rejects that, but
 * the screen has no reason to offer the choice.
 */
function nextStates(proposal: GovernanceProposal): string[] {
  switch (proposal.state) {
    case "draft":
      return ["review"];
    case "review":
      return ["announced"];
    case "announced":
      return ["voting"];
    case "voting":
      return [proposal.tally.provisionalOutcome];
    case "succeeded":
      return ["timelocked"];
    case "timelocked":
      return ["recorded"];
    case "recorded":
      return ["execution_pending"];
    // Leaving execution_pending takes an execution record (09 §9.7), not a transition.
    default:
      return [];
  }
}
