"use client";

import Link from "next/link";
import { use, useState } from "react";
import {
  newIdempotencyKey,
  recomputeReadiness,
  recordGateDecision,
  type GateDecision,
  type ReadinessAssessment,
} from "@/lib/api";
import { useSession } from "@/lib/session";
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
 * rejects (AC-02, AC-34). Disabling on screen is guidance, not a control.
 */
export default function GateDecisionPage({
  params,
}: {
  params: Promise<{ id: string; gateId: string }>;
}) {
  const { id, gateId } = use(params);
  const { token, session } = useSession();

  const [assessment, setAssessment] = useState<ReadinessAssessment | null>(null);
  const [decision, setDecision] = useState<GateDecision | null>(null);
  const [rationale, setRationale] = useState("");
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

  async function decide(value: "go" | "hold" | "rework" | "stop") {
    if (!token || !assessment) return;
    setBusy(true);
    setError(null);
    try {
      setDecision(
        await recordGateDecision(
          token,
          id,
          {
            gateId,
            decision: value,
            inputAssessmentId: assessment.id,
            rationale: rationale.trim(),
          },
          newIdempotencyKey(),
        ),
      );
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
  const goBlocked = !assessment || blocking.length > 0;
  const canDecide = assessment !== null && rationale.trim().length > 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Gate decision</h1>
          <p className="sub">
            Gate <span className="mono">{gateId}</span> · recorded by the decision owner
          </p>
        </div>
        <Link href={`/w/projects/${id}/readiness`}>← Readiness</Link>
      </div>

      {error ? <ErrorNotice error={error} /> : null}

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
          <div className="notice" style={{ color: "var(--destructive-text)", marginTop: 12 }}>
            <div className="title">{blocking.length} requirements block go</div>
            <ul>
              {blocking.map((result) => (
                <li key={result.requirementId}>
                  <span className="mono">{result.requirementId}</span> — {result.status} (
                  {result.reasonCode})
                  {result.missing.length > 0 ? (
                    <span className="meta"> · missing: {result.missing.join(", ")}</span>
                  ) : null}
                </li>
              ))}
            </ul>
            <div className="meta" style={{ marginTop: 6 }}>
              A gap means the basis is absent; not_evaluable means there is no rule to judge
              against. Both block go, but they call for different work.
            </div>
          </div>
        ) : null}
      </div>

      <div className="panel">
        <h2>2. Record the decision</h2>

        <div className="field">
          <label htmlFor="rationale">Rationale (required)</label>
          <input
            id="rationale"
            value={rationale}
            onChange={(event) => setRationale(event.target.value)}
            placeholder="Why this decision was made"
          />
        </div>

        <div className="row">
          <button
            className="primary"
            disabled={busy || goBlocked || !canDecide}
            onClick={() => void decide("go")}
            title={goBlocked ? "Required items are unmet, so go cannot be chosen" : undefined}
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
          hold, rework, and stop can always be recorded, whatever the readiness says. The
          disabled button is guidance; the server decides again on its own.
        </p>
      </div>

      {decision ? (
        <div className="panel">
          <h2>Recorded decision</h2>
          <dl className="dl">
            <dt>Decision</dt>
            <dd className="mono">{decision.decision}</dd>
            <dt>Rationale</dt>
            <dd>{decision.rationale}</dd>
            <dt>Decided by</dt>
            <dd className="mono">
              {session?.roleBindings?.map((binding) => binding.role).join(", ")}
            </dd>
            <dt>Signed at</dt>
            <dd className="mono">{decision.signedAt}</dd>
          </dl>
          <p className="meta" style={{ marginTop: 10 }}>
            A decision cannot be edited. To change it, record a new one.
          </p>
        </div>
      ) : null}

      <div className="notice" style={{ color: "var(--alert)" }}>
        <div className="title">What this decision does not mean</div>
        Data readiness, MPC’s decision to support a project, and legal approval to issue are
        three different judgements. This record is one of them and stands in for none of the
        others.
      </div>
    </>
  );
}

const DEMO_POLICY_SET_ID = "dddddddd-0000-0000-0000-000000000001";
