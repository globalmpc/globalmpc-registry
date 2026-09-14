"use client";

import { useEffect, useState } from "react";
import {
  getPublicProposal,
  listPublicProposals,
  type PublicProposal,
  type PublicProposalDetail,
} from "@/lib/api";
import { ErrorNotice } from "@/components/ErrorNotice";

/**
 * 공개 Governance — spec 11 §11.2.
 *
 * 거버넌스는 워크스페이스 안에만 있었다. 로그인해야 보이는 거버넌스는 참여자
 * 명부이지 거버넌스가 아니다 — 규칙이 어떻게 바뀌었는지는 그 규칙에 영향을 받는
 * 사람이 계정 없이 읽을 수 있어야 한다.
 *
 * **protocol space만 나온다.** project space의 제안은 특정 프로젝트의 내부
 * 의사결정이며 공개 대상이라는 근거가 없다(0027).
 *
 * **투표자 명단이 없다.** 집계는 판정 근거이지만 명단은 아니다(AC-32).
 */

/** 무게는 decimal string이다. 자리수 구분만 넣고 number로 바꾸지 않는다. */
function weight(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export default function PublicGovernancePage() {
  const [items, setItems] = useState<PublicProposal[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [open, setOpen] = useState<PublicProposalDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let live = true;
    listPublicProposals({ limit: 20 })
      .then((page) => {
        if (!live) return;
        setItems(page.items);
        setCursor(page.nextCursor);
      })
      .catch((caught: unknown) => {
        if (live) setError(caught);
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, []);

  async function more() {
    if (!cursor) return;
    setBusy(true);
    try {
      const page = await listPublicProposals({ limit: 20, cursor });
      setItems((previous) => [...previous, ...page.items]);
      setCursor(page.nextCursor);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Governance</h1>
          <p className="sub">
            Protocol proposals and how each one resolved. Quorum and threshold are fixed when a
            proposal is created and cannot be changed afterwards to alter its outcome.
          </p>
        </div>
      </div>

      <div className="notice" style={{ color: "var(--alert)" }}>
        <div className="title">What is and is not shown</div>
        Protocol proposals appear here once they leave draft. Proposals scoped to a single project
        are that project&rsquo;s internal decision and are not published. Vote tallies are shown;
        individual voters are not.
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      <div className="panel" data-testid="public-governance-list">
        {items.length === 0 && !busy ? (
          <p className="sub" style={{ margin: 0 }}>
            No protocol proposal has left draft yet. This is not a permission problem.
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Proposal</th>
                  <th>Type</th>
                  <th>State</th>
                  <th>For</th>
                  <th>Against</th>
                  <th>Abstain</th>
                  <th>Voters</th>
                </tr>
              </thead>
              <tbody>
                {items.map((proposal) => (
                  <tr key={proposal.id}>
                    <td>
                      <button
                        onClick={() => {
                          void getPublicProposal(proposal.id).then(setOpen).catch(setError);
                        }}
                      >
                        {proposal.title}
                      </button>
                    </td>
                    <td className="mono">{proposal.proposalType}</td>
                    <td className="mono">{proposal.state}</td>
                    <td className="mono">{weight(proposal.tally.for)}</td>
                    <td className="mono">{weight(proposal.tally.against)}</td>
                    <td className="mono">{weight(proposal.tally.abstain)}</td>
                    <td className="mono">{proposal.tally.voterCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {cursor ? (
          <button style={{ marginTop: 14 }} disabled={busy} onClick={() => void more()}>
            {busy ? "Loading…" : "Load more"}
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="panel" data-testid="public-proposal-detail">
          <div className="page-head" style={{ marginBottom: 14 }}>
            <h2 style={{ margin: 0 }}>{open.title}</h2>
            <button onClick={() => setOpen(null)}>Close</button>
          </div>

          <dl className="dl">
            <dt>Rationale</dt>
            <dd>{open.rationale}</dd>
            <dt>State</dt>
            <dd className="mono">{open.state}</dd>
            <dt>Quorum</dt>
            <dd className="mono">
              {open.quorum.numerator}/{open.quorum.denominator}
            </dd>
            <dt>Threshold</dt>
            <dd className="mono">
              {open.threshold.numerator}/{open.threshold.denominator}
            </dd>
            <dt>Voting window</dt>
            <dd className="mono">
              {open.votingOpensAt ?? "—"} → {open.votingClosesAt ?? "—"}
            </dd>
          </dl>

          <h2 style={{ marginTop: 18 }}>How it got here</h2>
          {/* 현재 상태만 보면 "정족수 미달로 끝났다"와 "취소됐다"가 같아 보인다. */}
          {open.transitions.length === 0 ? (
            <p className="sub" style={{ margin: 0 }}>
              No recorded transition. The proposal is in its first published state.
            </p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>From</th>
                    <th>To</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {open.transitions.map((step) => (
                    <tr key={`${step.occurredAt}-${step.toState}`}>
                      <td className="mono meta">{step.occurredAt}</td>
                      <td className="mono">{step.fromState}</td>
                      <td className="mono">{step.toState}</td>
                      <td style={{ color: "var(--muted-foreground)" }}>{step.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
    </>
  );
}
