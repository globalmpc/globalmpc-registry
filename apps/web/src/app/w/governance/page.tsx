"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  castVote,
  createProposal,
  listProposals,
  newIdempotencyKey,
  transitionProposal,
  type GovernanceProposal,
} from "@/lib/api";
import { useSession } from "@/lib/session";
import { ErrorNotice } from "@/components/ErrorNotice";

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
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    if (!token) return;
    try {
      setProposals((await listProposals(token)).items);
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

  const roles = session?.roleBindings?.map((binding) => binding.role) ?? [];
  const canPropose = roles.some((role) => role.endsWith("_proposer") || role === "mpc_operator");
  const canVote = roles.some((role) => role.endsWith("_voter") || role === "mpc_operator");

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

      <div className="notice" style={{ color: "var(--alert)" }} data-testid="governance-boundary">
        <div className="title">What this decision does not create</div>
        {/* Reading a passed proposal as "approved" is the most dangerous misreading. */}
        A vote creates no legal fact, no permit, and no contractual effect. Even when a proposal
        passes, execution is a separate act and does not happen automatically. It changes neither
        a reviewer’s standing nor the outcome of a review.
      </div>

      {canPropose ? (
        <div className="panel">
          <h2>Create a proposal</h2>
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
          <button
            className="primary"
            data-testid="create-proposal"
            disabled={
              busy ||
              title.trim().length === 0 ||
              rationale.trim().length === 0 ||
              eligibleWeight.length === 0 ||
              /^0+$/.test(eligibleWeight)
            }
            onClick={() =>
              void run((activeToken) =>
                createProposal(
                  activeToken,
                  {
                    space: "protocol",
                    proposalType: "attestation_schema_approval",
                    title: title.trim(),
                    rationale: rationale.trim(),
                    eligibleWeight,
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
      ) : null}

      <div className="panel">
        <h2>Proposals</h2>
        {proposals.length === 0 ? (
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
              <tbody>
                {proposals.map((proposal) => (
                  <tr key={proposal.id}>
                    <td className="mono meta">{proposal.space}</td>
                    <td>
                      {proposal.title}
                      <div className="meta">{proposal.rationale}</div>
                    </td>
                    <td>
                      <span className="mono" data-testid={`proposal-state-${proposal.id}`}>
                        {proposal.state}
                      </span>
                    </td>
                    <td className="mono meta">
                      For {proposal.tally.forWeight} / against {proposal.tally.againstWeight} /
                      abstain{" "}
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
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        {canVote && proposal.state === "voting"
                          ? (["for", "against", "abstain"] as const).map((choice) => (
                              <button
                                key={choice}
                                data-testid={`vote-${choice}-${proposal.id}`}
                                disabled={busy}
                                onClick={() =>
                                  void run((activeToken) =>
                                    castVote(
                                      activeToken,
                                      proposal.id,
                                      { choice, weight },
                                      newIdempotencyKey(),
                                    ),
                                  )
                                }
                              >
                                {choice === "for" ? "For" : choice === "against" ? "Against" : "Abstain"}
                              </button>
                            ))
                          : null}

                        {canPropose
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

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
              An integer string. It is not used on proposals that have a snapshot — there the
              weight is the on-chain balance at the start of voting, and the server ignores this
              input.
            </div>
          </div>
        ) : null}

        {canPropose ? (
          <div className="field">
            <label htmlFor="reason">Reason for the state change (required)</label>
            <input
              id="reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
        ) : null}
      </div>
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
    case "execution_pending":
      return ["executed", "failed"];
    default:
      return [];
  }
}
