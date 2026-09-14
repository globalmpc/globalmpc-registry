"use client";

import Link from "next/link";
import { use, useState } from "react";
import { newIdempotencyKey, recomputeReadiness, type ReadinessAssessment } from "@/lib/api";
import { useSession } from "@/lib/session";
import { ErrorNotice } from "@/components/ErrorNotice";
import { ReadinessBadge } from "@/components/StatusBadge";
import type { ReadinessStatus } from "@mpc/domain";

/**
 * Readiness Matrix — spec 11 §11.3.
 *
 * 행=requirement, 열=근거/등급/상태/사유.
 *
 * **운영자 override control이 없다.** 이 화면에 값을 고치는 버튼이 없는 것이
 * 통제다(REQ-DAPP-017). 서버에도 그런 경로가 없고 DB 트리거도 막는다.
 *
 * Gate Decision은 여기 두지 않는다. 같은 화면에 있으면 준비도와 사람의 결정을
 * 혼동시킨다(§11.3) — 별도 라우트로 분리한다.
 */
export default function ReadinessPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { token } = useSession();

  const [assessment, setAssessment] = useState<ReadinessAssessment | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [policySetId, setPolicySetId] = useState(DEMO_POLICY_SET_ID);

  async function recompute() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      setAssessment(await recomputeReadiness(token, id, policySetId, newIdempotencyKey()));
    } catch (caught) {
      setError(caught);
      setAssessment(null);
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

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Data and evidence readiness</h1>
          <p className="sub">
            {/* §11.13: Compliance Policy Engine의 사용자 표시명이다.
                법률 컴플라이언스 승인으로 번역하지 않는다. */}
            A rule set computes whether the data requirements are met. Whether to move to the
            next stage is decided by a person.
          </p>
        </div>
        <Link href={`/w/projects/${id}`}>← Project</Link>
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      <div className="panel">
        <div className="field">
          <label htmlFor="policySet">Rule set ID</label>
          <input
            id="policySet"
            className="mono"
            value={policySetId}
            onChange={(event) => setPolicySetId(event.target.value)}
          />
        </div>
        <div className="row">
          <button className="primary" onClick={() => void recompute()} disabled={busy}>
            {busy ? "Evaluating…" : "Recompute"}
          </button>
          <span className="meta">
            An assessment never overwrites the previous one. Each run creates a new record.
          </span>
        </div>
      </div>

      {assessment ? (
        <>
          <div className="panel">
            <h2>
              Overall{" "}
              <ReadinessBadge status={assessment.status as ReadinessStatus} />
            </h2>

            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Requirement</th>
                    <th>Status</th>
                    <th>Applies</th>
                    <th>Reason</th>
                    <th>Missing</th>
                  </tr>
                </thead>
                <tbody>
                  {assessment.requirementResults.map((result) => (
                    <tr key={result.requirementId}>
                      <td className="mono">{result.requirementId}</td>
                      <td>
                        <ReadinessBadge status={result.status as ReadinessStatus} />
                      </td>
                      <td>
                        {result.applicable ? (
                          "Yes"
                        ) : (
                          // 적용 안 됨과 통과를 구분한다.
                          <span className="meta">Not applicable</span>
                        )}
                      </td>
                      <td className="mono meta">{result.reasonCode}</td>
                      <td className="meta">{result.missing.join(", ") || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel">
            <h2>Reproducibility</h2>
            <dl className="dl">
              <dt>Rule set version</dt>
              <dd className="mono">{assessment.ruleSetVersion}</dd>
              <dt>Result hash</dt>
              <dd className="mono">{assessment.canonicalResultHash}</dd>
              <dt>Evaluated as of</dt>
              <dd className="mono">{assessment.evaluatedAsOf}</dd>
              <dt>Produced by</dt>
              <dd>{assessment.authority}</dd>
              <dt>Legal effect</dt>
              <dd className="mono">{assessment.legalEffect}</dd>
            </dl>
            <p className="meta" style={{ marginTop: 10 }}>
              The same inputs under the same rule set version produce the same result hash, no
              matter when the assessment runs.
            </p>
          </div>

          <div className="notice" style={{ color: "var(--alert)" }}>
            <div className="title">This assessment is not a decision</div>
            {assessment.limitations.map((limitation) => (
              <div key={limitation}>{limitation}</div>
            ))}
            <div style={{ marginTop: 8 }}>
              <Link href={`/w/projects/${id}/gates/registry_publication`}>
                Record the human decision →
              </Link>
            </div>
          </div>

          <p className="meta">
            This screen has no control that edits a value. The server has no such path either,
            and the database refuses the change.
          </p>
        </>
      ) : null}
    </>
  );
}

/** seed가 만든 데모 규칙 세트. 실제로는 Jurisdiction Profile이 고른다. */
const DEMO_POLICY_SET_ID = "dddddddd-0000-0000-0000-000000000001";
