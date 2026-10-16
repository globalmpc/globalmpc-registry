"use client";

import Link from "next/link";
import { use, useState } from "react";
import {
  newIdempotencyKey,
  recomputeReadiness,
  recordGateDecision,
  requestGateDecisionSignature,
  type GateDecision,
  type ReadinessAssessment,
} from "@/lib/api";
import { useSession } from "@/lib/session";
import { Address } from "@/components/Address";
import { ErrorNotice } from "@/components/ErrorNotice";
import { ReadinessBadge } from "@/components/StatusBadge";
import type { ReadinessStatus } from "@mpc/domain";

/**
 * Gate Decision — spec 11 §11.3.
 *
 * **A separate screen from the Readiness Matrix.** On the same screen it reads as "readiness is
 * ok, so it passes". Readiness is an input; the decision is a separate record a person signs.
 *
 * With any `gap`/`not_evaluable`, the go button is disabled and the server independently
 * rejects (AC-02, AC-34). Disabling on screen is guidance, not a control. Each blocking
 * requirement shows its cause, the evidence it needs and the next action — a count alone
 * leaves the approver asking who has to do what.
 *
 * The decision is signed with the approver's wallet (decision, rationale, assumptions and
 * conditions). A watch → go needs at least one condition.
 */
export default function GateDecisionPage({
  params,
}: {
  params: Promise<{ id: string; gateId: string }>;
}) {
  const { id, gateId } = use(params);
  const { token, signTypedData } = useSession();

  const [assessment, setAssessment] = useState<ReadinessAssessment | null>(null);
  const [decision, setDecision] = useState<GateDecision | null>(null);
  const [signedPayload, setSignedPayload] = useState<string | null>(null);
  const [rationale, setRationale] = useState("");
  const [assumptions, setAssumptions] = useState("");
  const [conditions, setConditions] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function loadAssessment() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      setAssessment(
        await recomputeReadiness(token, id, DEMO_POLICY_SET_ID, newIdempotencyKey()),
      );
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  /** Request → wallet signature → submission. The server checks the signer is this approver. */
  async function decide(value: "go" | "hold" | "rework" | "stop") {
    if (!token || !assessment) return;
    setBusy(true);
    setError(null);
    try {
      const content = {
        gateId,
        decision: value,
        inputAssessmentId: assessment.id,
        rationale: rationale.trim(),
        assumptions: lines(assumptions),
        conditions: lines(conditions),
      };
      const request = await requestGateDecisionSignature(token, id, content, newIdempotencyKey());
      const signature = await signTypedData(request.typedData);
      setDecision(
        await recordGateDecision(
          token,
          id,
          { ...content, signatureRequestId: request.signatureRequestId, signature },
          newIdempotencyKey(),
        ),
      );
      setSignedPayload(request.humanReadablePayload);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <p className="sub">
        No account is connected. <Link href="/">Connect an account →</Link>
      </p>
    );
  }

  const blocking = assessment
    ? assessment.requirementResults.filter(
        (result) => result.applicable && (result.status === "gap" || result.status === "not_evaluable"),
      )
    : [];
  const watching = assessment
    ? assessment.requirementResults.filter(
        (result) => result.applicable && result.status === "watch",
      )
    : [];
  const hasConditions = lines(conditions).length > 0;
  const goBlocked = !assessment || blocking.length > 0;
  // §11.3: watch → go needs a rationale and a condition. The server refuses it either way.
  const goNeedsCondition = !goBlocked && watching.length > 0 && !hasConditions;
  const canDecide = assessment !== null && rationale.trim().length > 0;

  const renderReadiness = () => {
    return (
      <div className="panel">
        <h2>1. Check readiness</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          A decision always takes an assessment as its input. There is no deciding without one.
        </p>
        <div className="row">
          <button onClick={() => void loadAssessment()} disabled={busy}>
            Load current readiness
          </button>
          {assessment ? (
            <ReadinessBadge status={assessment.status as ReadinessStatus} />
          ) : (
            <span className="meta">Not loaded yet</span>
          )}
        </div>

        {blocking.length > 0 ? (
          <div
            className="notice"
            style={{ color: "var(--destructive-text)", marginTop: 12 }}
            data-testid="blocking-requirements"
          >
            <div className="title">{blocking.length} requirements block go</div>
            <ul>
              {blocking.map((result) => (
                <li key={result.requirementId} data-testid={`blocking-${result.requirementId}`}>
                  <span className="mono">{result.requirementId}</span> — {result.status} (
                  {result.reasonCode})<div className="meta">Cause: {result.cause}</div>
                  {result.neededEvidence.length > 0 ? (
                    <div className="meta">Needed: {result.neededEvidence.join(", ")}</div>
                  ) : null}
                  {result.nextAction ? <div className="meta">Next: {result.nextAction}</div> : null}
                </li>
              ))}
            </ul>
            <div className="meta" style={{ marginTop: 6 }}>
              A gap means the basis is absent; not_evaluable means there is no rule to judge against.
              Both block go, but they call for different work.
            </div>
          </div>
        ) : null}

        {watching.length > 0 ? (
          <div className="notice" style={{ color: "var(--alert)", marginTop: 12 }}>
            <div className="title">{watching.length} requirements are on watch</div>
            Going ahead is possible, but it needs a rationale and at least one condition to monitor.
          </div>
        ) : null}
      </div>
    );
  };

  const renderDecisionForm = () => {
    return (
      <div className="panel">
        <h2>2. Record and sign the decision</h2>

        <div className="field">
          <label htmlFor="rationale">Rationale (required)</label>
          <input
            id="rationale"
            value={rationale}
            onChange={(event) => setRationale(event.target.value)}
            placeholder="Why this decision was made"
          />
        </div>

        <div className="field">
          <label htmlFor="assumptions">Assumptions (one per line)</label>
          <textarea
            id="assumptions"
            rows={3}
            value={assumptions}
            onChange={(event) => setAssumptions(event.target.value)}
            placeholder="What this decision takes as given"
          />
        </div>

        <div className="field">
          <label htmlFor="conditions">Conditions (one per line; required for go on watch)</label>
          <textarea
            id="conditions"
            rows={3}
            value={conditions}
            onChange={(event) => setConditions(event.target.value)}
            placeholder="What must keep holding after this decision"
          />
        </div>

        <div className="row">
          <button
            className="primary"
            disabled={busy || goBlocked || goNeedsCondition || !canDecide}
            onClick={() => void decide("go")}
            title={
              goBlocked
                ? "Required items are unmet, so go cannot be chosen"
                : goNeedsCondition
                  ? "A watch needs at least one condition before go"
                  : undefined
            }
          >
            {goBlocked ? "go (blocked)" : "go"}
          </button>
          <button disabled={busy || !canDecide} onClick={() => void decide("hold")}>
            hold
          </button>
          <button disabled={busy || !canDecide} onClick={() => void decide("rework")}>
            rework
          </button>
          <button disabled={busy || !canDecide} onClick={() => void decide("stop")}>
            stop
          </button>
        </div>

        <p className="meta" style={{ marginTop: 10 }}>
          {/* Blocking the recording of bad news lets state go stale silently. */}
          hold, rework, and stop can always be recorded, whatever the readiness says. The disabled
          button is guidance; the server decides again on its own. Choosing a decision opens your
          wallet to sign it — the server holds no key and signs for no one.
        </p>
      </div>
    );
  };

  const renderRecordedDecision = () => {
    return decision ? (
      <div className="panel" data-testid="recorded-decision">
        <h2>Recorded decision</h2>
        <dl className="dl">
          <dt>Decision</dt>
          <dd className="mono">{decision.decision}</dd>
          <dt>Rationale</dt>
          <dd>{decision.rationale}</dd>
          <dt>Assumptions</dt>
          <dd>{decision.assumptions.join("; ") || "—"}</dd>
          <dt>Conditions</dt>
          <dd>{decision.conditions.join("; ") || "—"}</dd>
          <dt>Signed by</dt>
          <dd>
            <Address value={decision.signerWalletAddress} label="signer address" />
          </dd>
          <dt>Signed at</dt>
          <dd className="mono">{decision.signedAt}</dd>
        </dl>
        {signedPayload ? (
          <pre
            style={{
              marginTop: 14,
              padding: 12,
              background: "var(--muted)",
              borderRadius: 6,
              whiteSpace: "pre-wrap",
              fontSize: 12,
            }}
          >
            {signedPayload}
          </pre>
        ) : null}
        <p className="meta" style={{ marginTop: 10 }}>
          A decision cannot be edited. To change it, record a new one.
        </p>
      </div>
    ) : null;
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Gate decision</h1>
          <p className="sub">
            Gate <span className="mono">{gateId}</span> · recorded and signed by the decision owner
          </p>
        </div>
        <Link href={`/w/projects/${id}/readiness`}>← Readiness</Link>
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      {renderReadiness()}

      {renderDecisionForm()}

      {renderRecordedDecision()}

      <div className="notice" style={{ color: "var(--alert)" }}>
        <div className="title">What this decision does not mean</div>
        Data readiness, MPC’s decision to support a project, and legal approval to issue are
        three different judgements. This record is one of them and stands in for none of the
        others.
      </div>
    </>
  );
}

/** Lines of a textarea as a list. Blank lines are not entries. */
function lines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

const DEMO_POLICY_SET_ID = "dddddddd-0000-0000-0000-000000000001";
