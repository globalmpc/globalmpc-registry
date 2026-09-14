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
 * **투표 결과가 법적 승인이 아니다.** 이 화면이 가장 조심해야 하는 것은 통과한
 * 제안을 "승인됐다"로 읽게 만드는 것이다. 그래서 각 제안의 `limitations`를
 * 목록에서부터 함께 보여준다.
 *
 * 정족수 미달과 부결을 다른 문구로 표시한다 — 다음에 할 일이 다르다.
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
   * 정족수의 분모 — 09 §9.6.
   *
   * 토큰이 연결되지 않은 제안은 이 값 없이 투표를 열 수 없다. 던진 표의 합을
   * 분모로 쓰면 정족수가 항상 통과하고 `no_quorum`이 나올 수 없다.
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
        {/* 통과한 제안을 "승인됐다"로 읽는 것이 가장 위험한 오해다. */}
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
              정족수의 분모 — 09 §9.6.

              던진 표의 합을 분모로 쓰면 정족수가 항상 통과한다. 토큰이
              연결되면 스냅숏 블록의 총공급이 이 값을 대신한다.
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
            {/* 법적 사실·개인 자격·검토 결과는 투표로 만들어지지 않는다. */}
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
                        {/* 정족수 미달과 부결은 다음에 할 일이 다르다. */}
                        {proposal.tally.reason}
                      </div>
                    </td>
                    {/*
                      무게가 어디서 왔는가 — 04 §4.5.

                      수동 무게로 집계된 결과를 온체인 근거로 읽으면 안 된다.
                      집계 옆에 두어 숫자와 함께 읽히게 한다.
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
                      정족수 — 09 §9.6.

                      비율만 보이면 무엇의 비율인지 알 수 없다. 분모와 그
                      출처를 같이 둔다 — 사람이 넣은 분모로 계산된 정족수를
                      온체인 근거로 읽으면 안 된다.
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
          스냅숏이 있는 제안이 하나라도 있으면 입력값이 그 제안에는 쓰이지
          않는다. 서버가 무시하는 값을 편집 가능한 채로 두면 자기 무게를 정할 수
          있다고 읽힌다.
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
              {/* 토큰 무게는 18 decimals다. 문자열로 다뤄 정밀도를 지킨다. */}
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
 * 다음에 갈 수 있는 상태.
 *
 * 마감(`succeeded`·`defeated`·`no_quorum`)은 **집계가 말하는 하나만** 보여준다.
 * 셋을 다 보여주면 표를 무시하고 고르는 것처럼 읽힌다 — 서버가 거절하지만
 * 화면이 그런 선택지를 제시할 이유가 없다.
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
