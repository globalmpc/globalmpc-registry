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
 * Public Governance — spec 11 §11.2.
 *
 * Governance existed only inside the workspace. Governance visible only after sign-in is a participant
 * roster, not governance — people affected by the rules must be able to read how they changed
 * without an account.
 *
 * **Only protocol space appears.** Project space proposals are a specific project's internal
 * decisions, with no basis for making them public (0027).
 *
 * **No voter roster.** The tally is the basis for the verdict, but it is not a roster (AC-32).
 */

/** Weight is a decimal string. Only digit grouping is added; it is never converted to number. */
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
          {/* From current state alone, "ended without quorum" and "cancelled" look the same. */}
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
