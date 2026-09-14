"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import {
  createAttestation,
  createSignatureRequest,
  createVerificationCase,
  disputeAttestation,
  listClaims,
  listDisputes,
  resolveDispute,
  listVerificationCases,
  newIdempotencyKey,
  submitSignature,
  transitionCase,
  type AttestationDraft,
  type Claim,
  type SignatureRequest,
  type AttestationDispute,
  type SignedAttestation,
  type VerificationCase,
} from "@/lib/api";
import { useSession } from "@/lib/session";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Address } from "@/components/Address";

/**
 * Verification Workbench — spec 11 §11.3, 04 §4.4.
 *
 * 4단계가 각각 별도 행동으로 보인다.
 *
 * 1. **배정** — 근거(claim)를 골라 case를 만든다. 이 시점의 evidence snapshot이
 *    고정된다. 근거 없는 검토는 만들 수 없다.
 * 2. **초안** — findings·citations·limitations를 적는다. `limitations`가 비면
 *    초안 자체가 만들어지지 않는다(AC-01).
 * 3. **서명 요청** — 서버가 EIP-712 구조와 사람이 읽을 수 있는 요약을 준다.
 * 4. **서명** — 브라우저가 서명한다. 서버는 대리 서명하지 않으며 복구된 주소가
 *    배정된 검토자인지 따로 대조한다.
 *
 * 서명 요청 이후 근거가 바뀌면 그 요청은 무효다. 화면이 이것을 숨기지 않는다.
 */
export default function VerificationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { token, session, signTypedData } = useSession();

  const [claims, setClaims] = useState<Claim[]>([]);
  const [cases, setCases] = useState<VerificationCase[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [verificationCase, setVerificationCase] = useState<VerificationCase | null>(null);
  const [attestation, setAttestation] = useState<AttestationDraft | null>(null);
  const [signatureRequest, setSignatureRequest] = useState<SignatureRequest | null>(null);
  const [signed, setSigned] = useState<SignedAttestation | null>(null);
  const [transitionReason, setTransitionReason] = useState("");
  const [disputes, setDisputes] = useState<AttestationDispute[]>([]);
  const [resolution, setResolution] = useState("");
  const [limitations, setLimitations] = useState(
    "This review is limited to the documents submitted and does not include site due diligence",
  );
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<VerificationCase[]> => {
    if (!token) return [];
    try {
      const [claimData, caseData] = await Promise.all([
        listClaims(token, id),
        listVerificationCases(token, id),
      ]);
      setClaims(claimData.items);
      setCases(caseData.items);
      return caseData.items;
    } catch (caught) {
      setError(caught);
      return [];
    }
  }, [token, id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(step: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await step();
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

  const roles = session?.roleBindings?.map((binding) => binding.role) ?? [];
  const isReviewer = roles.some((role) => role.startsWith("reviewer_"));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Verification Workbench</h1>
          <p className="sub">
            A qualified person reads the evidence and signs. A signature only stands if it
            carries its scope and its limitations.
          </p>
        </div>
        <Link href={`/w/projects/${id}`}>← Project</Link>
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      {!isReviewer ? (
        <div className="notice" style={{ color: "var(--alert)" }}>
          <div className="title">This account cannot sign</div>
          Signing an attestation requires one of <span className="mono">reviewer_cp_qp</span>·
          <span className="mono">reviewer_lab</span>·<span className="mono">reviewer_legal</span>·
          <span className="mono">reviewer_assurance</span>. Assignments are created by a
          <span className="mono"> data_steward</span>.
        </div>
      ) : null}

      <div className="panel">
        <h2>1. Select evidence and assign</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          The claims you select become the review scope. Their state at this moment is fixed as
          a snapshot.
        </p>

        {claims.length === 0 ? (
          <p className="sub" style={{ margin: 0 }}>
            No claims yet. Record them in the{" "}
            <Link href={`/w/projects/${id}/data-room`}>Data Room</Link> first.
          </p>
        ) : (
          <ul style={{ listStyle: "none", margin: "0 0 14px", padding: 0 }}>
            {claims.map((claim) => (
              <li key={claim.id} style={{ padding: "4px 0" }}>
                <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    type="checkbox"
                    checked={selected.includes(claim.id)}
                    onChange={(event) =>
                      setSelected((previous) =>
                        event.target.checked
                          ? [...previous, claim.id]
                          : previous.filter((value) => value !== claim.id),
                      )
                    }
                  />
                  <span className="mono">{claim.claimType}</span>
                  <span>{claim.valueText}</span>
                  <span className="meta">{claim.grade}</span>
                </label>
              </li>
            ))}
          </ul>
        )}

        <button
          disabled={busy || selected.length === 0}
          onClick={() =>
            void run(async () => {
              const created = await createVerificationCase(
                token,
                {
                  projectId: id,
                  schemaId: DEMO_SCHEMA_ID,
                  claimIds: selected,
                  reviewerSubjectId: DEMO_REVIEWER_SUBJECT_ID,
                  credentialId: DEMO_CREDENTIAL_ID,
                  conflictStatus: "none",
                },
                newIdempotencyKey(),
              );
              setVerificationCase(created);
              await load();
            })
          }
        >
          Assign the review
        </button>

        {cases.length > 0 ? (
          <div className="table-scroll" style={{ marginTop: 18 }}>
            {/* 배정한 사람과 서명하는 사람이 다르므로, 검토자는 이 목록에서
                자기 배정을 찾는다. */}
            <table data-testid="case-list">
              <thead>
                <tr>
                  <th>State</th>
                  <th>Claims</th>
                  <th>Assigned at</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {cases.map((item) => (
                  <tr key={item.id}>
                    <td className="mono">{item.state}</td>
                    <td className="mono">{item.claimIds.length}</td>
                    <td className="mono meta">{item.assignedAt?.slice(0, 19) ?? "—"}</td>
                    <td>
                      <button
                        data-testid={`select-case-${item.id}`}
                        onClick={() => setVerificationCase(item)}
                        disabled={verificationCase?.id === item.id}
                      >
                        {verificationCase?.id === item.id ? "Selected" : "Open this case"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {verificationCase ? (
          <dl className="dl" data-testid="selected-case" style={{ marginTop: 14 }}>
            <dt>Case state</dt>
            <dd className="mono">{verificationCase.state}</dd>
            <dt>Evidence snapshot</dt>
            <dd className="mono" style={{ wordBreak: "break-all" }}>
              {verificationCase.evidenceSnapshotHash}
            </dd>
          </dl>
        ) : null}
      </div>

      {verificationCase ? (
        <div className="panel">
          <h2>1-1. Record a state change</h2>
          <p className="sub" style={{ marginTop: 0 }}>
            {/* 서명하거나 아무 일도 없거나 둘뿐이면 잘못된 근거를 발견해도 남길
                자리가 없다. */}
            When the evidence falls short, request more. No state changes without a reason.
          </p>

          <div className="field">
            <label htmlFor="transitionReason">Reason (required)</label>
            <input
              id="transitionReason"
              value={transitionReason}
              onChange={(event) => setTransitionReason(event.target.value)}
              placeholder="What needs to be supplied"
            />
          </div>

          <div className="row">
            {(["in_review", "changes_requested", "declined", "cancelled"] as const).map(
              (state) => (
                <button
                  key={state}
                  data-testid={`transition-${state}`}
                  disabled={busy || transitionReason.trim().length === 0}
                  onClick={() =>
                    void run(async () => {
                      await transitionCase(
                        token,
                        verificationCase.id,
                        verificationCase.version ?? 1,
                        { toState: state, reason: transitionReason.trim() },
                        newIdempotencyKey(),
                      );
                      // 목록을 다시 읽어 그 결과로 선택을 갱신한다. 전이 응답에는
                      // 이력이 없으므로 응답만으로 화면을 채우면 방금 남긴 기록이
                      // 보이지 않는다.
                      const refreshed = await load();
                      const updated = refreshed.find((item) => item.id === verificationCase.id);
                      if (updated) setVerificationCase(updated);
                    })
                  }
                >
                  {state}
                </button>
              ),
            )}
          </div>

          {verificationCase.transitions && verificationCase.transitions.length > 0 ? (
            <div className="table-scroll" style={{ marginTop: 14 }}>
              {/* 지나온 경로를 감추지 않는다. 반려 후 재배정된 case와 처음부터
                  진행된 case는 현재 상태만으로 같아 보인다. */}
              <table data-testid="transition-history">
                <thead>
                  <tr>
                    <th>Transition</th>
                    <th>Reason</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {verificationCase.transitions.map((entry) => (
                    <tr key={`${entry.occurredAt}-${entry.toState}`}>
                      <td className="mono">
                        {entry.fromState} → {entry.toState}
                      </td>
                      <td className="meta">{entry.reason}</td>
                      <td className="mono meta">{entry.occurredAt.slice(0, 19)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="panel">
        <h2>2. Draft the review opinion</h2>
        <div className="field">
          <label htmlFor="limitations">What this review did not check (required)</label>
          <input
            id="limitations"
            value={limitations}
            onChange={(event) => setLimitations(event.target.value)}
          />
        </div>
        <p className="meta" style={{ marginTop: 0, marginBottom: 12 }}>
          {/* 한계 없는 서명은 읽는 쪽에서 전체 보증으로 읽힌다. */}
          Leave it empty and no draft is created. The server and the database each refuse it.
        </p>
        <button
          disabled={busy || !verificationCase || limitations.trim().length === 0}
          onClick={() =>
            void run(async () => {
              if (!verificationCase) return;
              setAttestation(
                await createAttestation(
                  token,
                  verificationCase.id,
                  {
                    assignmentId: verificationCase.assignmentId,
                    attestationType: "professional_signoff",
                    claimScope: verificationCase.claimIds,
                    findings: [
                      { finding: "The mining right number matches the registry lookup result" },
                    ],
                    citations: [{ source: "MN mineral registry", ref: "MV-012345" }],
                    limitations: limitations.trim(),
                  },
                  newIdempotencyKey(),
                ),
              );
            })
          }
        >
          Create the draft
        </button>

        {attestation ? (
          <dl className="dl" style={{ marginTop: 14 }}>
            <dt>State</dt>
            <dd className="mono">{attestation.state}</dd>
            <dt>Payload hash</dt>
            <dd className="mono" style={{ wordBreak: "break-all" }}>
              {attestation.payloadHash}
            </dd>
          </dl>
        ) : null}
      </div>

      <div className="panel">
        <h2>3. What you are signing</h2>
        <button
          disabled={busy || !attestation}
          onClick={() =>
            void run(async () => {
              if (!attestation) return;
              setSignatureRequest(
                await createSignatureRequest(token, attestation.id, newIdempotencyKey()),
              );
            })
          }
        >
          Create a signature request
        </button>

        {signatureRequest ? (
          <>
            {/* 서명 대상은 typedData지만 사람이 읽을 수 있는 형태를 함께 보여준다.
                무엇에 서명하는지 모르는 서명은 동의가 아니다(§11.4). */}
            <pre
              data-testid="signing-payload"
              style={{
                marginTop: 14,
                padding: 12,
                background: "var(--muted)",
                borderRadius: 6,
                whiteSpace: "pre-wrap",
                fontSize: 12,
              }}
            >
              {signatureRequest.humanReadablePayload}
            </pre>
            <p className="meta">
              Valid until <span className="mono">{signatureRequest.expiresAt}</span> · this
              request can be used once.
            </p>
          </>
        ) : null}
      </div>

      <div className="panel">
        <h2>4. Sign</h2>
        <button
          className="primary"
          data-testid="sign-attestation"
          disabled={busy || !signatureRequest || !attestation}
          onClick={() =>
            void run(async () => {
              if (!signatureRequest || !attestation) return;
              const signature = await signTypedData(signatureRequest.typedData);
              setSigned(
                await submitSignature(
                  token,
                  attestation.id,
                  { signatureRequestId: signatureRequest.signatureRequestId, signature },
                  newIdempotencyKey(),
                ),
              );
            })
          }
        >
          Sign with the wallet
        </button>

        {signed ? (
          <dl className="dl" data-testid="signed-result" style={{ marginTop: 14 }}>
            <dt>State</dt>
            <dd className="mono">{signed.state}</dd>
            <dt>Signer</dt>
            <dd>
              <Address value={signed.signerWalletAddress} label="signer address" />
            </dd>
            <dt>Current applicability of the credential</dt>
            <dd className="mono">{signed.ongoingApplicability}</dd>
            <dt>Validity of past signatures</dt>
            <dd>
              {/* 자격이 나중에 만료돼도 서명 당시의 사실은 바뀌지 않는다(AC-17). */}
              {signed.pastSignatureRemainsValid
                ? "Stands as it was at the time of signing"
                : "Void"}
            </dd>
          </dl>
        ) : null}
      </div>

      {signed ? (
        <div className="panel">
          <h2>5. Dispute</h2>
          <p className="sub" style={{ marginTop: 0 }}>
            {/* 서명을 삭제하면 잘못된 검토를 감추는 것과 구분되지 않는다. */}
            The signature is not deleted. The judgement made at signing time stands, and the
            dispute is added as a new fact. A dispute is not a finding that the review was wrong;
            it marks that it needs another look.
          </p>
          <button
            data-testid="dispute-attestation"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                if (!attestation) return;
                const result = await disputeAttestation(
                  token,
                  attestation.id,
                  {
                    reasonCode: "EVIDENCE_QUESTIONED",
                    detail: "The as-of date of the registry lookup used as evidence is unclear",
                  },
                  newIdempotencyKey(),
                );
                setSigned({ ...signed, state: result.state });
                setDisputes((await listDisputes(token, attestation.id)).items);
              })
            }
          >
            Raise a dispute
          </button>

          {disputes.length > 0 ? (
            <>
              <div className="field" style={{ marginTop: 14 }}>
                <label htmlFor="resolution">Basis for resolution (required)</label>
                <input
                  id="resolution"
                  value={resolution}
                  onChange={(event) => setResolution(event.target.value)}
                  placeholder="What was checked"
                />
              </div>

              <div className="table-scroll">
                {/* 해소된 이의도 함께 보여준다. 감추면 "한 번 문제가 제기됐다"는
                    사실이 사라지고, 그것은 잘못된 검토를 덮는 것과 같아진다. */}
                <table data-testid="dispute-table">
                  <thead>
                    <tr>
                      <th>Reason code</th>
                      <th>Detail</th>
                      <th>State</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {disputes.map((item) => (
                      <tr key={item.id}>
                        <td className="mono">{item.reasonCode}</td>
                        <td className="meta">{item.detail}</td>
                        <td className="mono meta">
                          {item.resolvedAt ? (item.outcome ?? "resolved") : "unresolved"}
                        </td>
                        <td>
                          {item.resolvedAt ? (
                            <span className="meta">{item.resolution}</span>
                          ) : (
                            <div className="row" style={{ gap: 6 }}>
                              {(["dismissed", "upheld"] as const).map((outcome) => (
                                <button
                                  key={outcome}
                                  data-testid={`resolve-${outcome}-${item.id}`}
                                  disabled={busy || resolution.trim().length === 0}
                                  onClick={() =>
                                    void run(async () => {
                                      const result = await resolveDispute(
                                        token,
                                        item.id,
                                        { outcome, resolution: resolution.trim() },
                                        newIdempotencyKey(),
                                      );
                                      if (attestation) {
                                        setDisputes(
                                          (await listDisputes(token, attestation.id)).items,
                                        );
                                      }
                                      if (signed) {
                                        setSigned({ ...signed, state: result.attestationState });
                                      }
                                    })
                                  }
                                >
                                  {outcome === "dismissed" ? "Dismiss" : "Uphold"}
                                </button>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <p className="meta" style={{ marginTop: 10 }}>
                {/* 틀렸다고 확인된 검토를 유효로 표시할 수 없다. */}
                Upholding a dispute does not return the review to valid. Correcting it is a
                separate decision — supersede it with a new signature, or revoke it.
              </p>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="notice" style={{ color: "var(--alert)" }}>
        <div className="title">What a signature does not mean</div>
        A signature records that this reviewer examined this scope under these limitations. It
        is not a judgement on commercial viability, completeness of rights, or investment
        suitability.
      </div>
    </>
  );
}

/** seed가 만든 데모 검토자·자격·스키마. R5에서 실제 배정 흐름으로 대체한다. */
const DEMO_REVIEWER_SUBJECT_ID = "aaaaaaaa-0000-0000-0000-000000000006";
const DEMO_CREDENTIAL_ID = "eeeeeeee-0000-0000-0000-000000000001";
const DEMO_SCHEMA_ID = "eeeeeeee-0000-0000-0000-000000000002";
