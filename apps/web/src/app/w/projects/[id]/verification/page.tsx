"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import {
  createAttestation,
  createSignatureRequest,
  createVerificationCase,
  disputeAttestation,
  getReviewAssignmentOptions,
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
  type ReviewAssignmentOptions,
  type SignedAttestation,
  type VerificationCase,
} from "@/lib/api";
import { useSession } from "@/lib/session";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Address } from "@/components/Address";

/**
 * Verification Workbench — spec 11 §11.3, 04 §4.4.
 *
 * Each of the four steps appears as a separate action.
 *
 * 1. **Assign** — pick evidence (claims) and create a case. The evidence snapshot is
 *    fixed at this point. A review without evidence cannot be created.
 * 2. **Draft** — write findings, citations, limitations. With empty `limitations`
 *    no draft is created at all (AC-01).
 * 3. **Signature request** — the server returns the EIP-712 structure and a human-readable summary.
 * 4. **Sign** — the browser signs. The server never signs on anyone's behalf and separately checks
 *    that the recovered address is the assigned reviewer.
 *
 * If evidence changes after a signature request, the request is void. The screen does not hide this.
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
  const [options, setOptions] = useState<ReviewAssignmentOptions | null>(null);
  const [reviewerId, setReviewerId] = useState("");
  const [credentialId, setCredentialId] = useState("");
  const [schemaId, setSchemaId] = useState("");
  // Only the assigner reads the options. The server decides; this only avoids a certain 403.
  const canAssign = session?.actions?.includes("claim.curate") ?? false;

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

  /**
   * Reviewer, credential, and schema come from this tenant's rows (Q-032). Fixed seed ids made
   * every assignment fail outside the demo tenant. The first reviewer who holds a valid
   * credential is preselected, with that credential and the first active schema.
   */
  useEffect(() => {
    if (!token || !canAssign) return;
    let cancelled = false;
    getReviewAssignmentOptions(token, id)
      .then((value) => {
        if (cancelled) return;
        const reviewer =
          value.reviewers.find((item) => item.credentials.length > 0) ?? value.reviewers[0];
        setOptions(value);
        setReviewerId(reviewer?.subjectId ?? "");
        setCredentialId(reviewer?.credentials[0]?.id ?? "");
        setSchemaId(value.schemas[0]?.id ?? "");
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught);
      });
    return () => {
      cancelled = true;
    };
  }, [token, id, canAssign]);

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
  const chosenReviewer = options?.reviewers.find((item) => item.subjectId === reviewerId);

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

        {canAssign ? (
          <div data-testid="assignment-options">
            {options && options.reviewers.length === 0 ? (
              <p className="meta" data-testid="no-reviewer">
                No reviewer can sign on this project yet. A reviewer needs a reviewer role that
                reaches this project, a wallet bound at high assurance, and a valid credential.
              </p>
            ) : null}
            {options && options.schemas.length === 0 ? (
              <p className="meta" data-testid="no-schema">
                No attestation schema is active in this workspace. An operator adds one with{" "}
                <span className="mono">bootstrap-registry schema</span>.
              </p>
            ) : null}

            <div className="field">
              <label htmlFor="assign-reviewer">Reviewer</label>
              <select
                id="assign-reviewer"
                value={reviewerId}
                disabled={!options || options.reviewers.length === 0}
                onChange={(event) => {
                  const next = options?.reviewers.find(
                    (item) => item.subjectId === event.target.value,
                  );
                  setReviewerId(event.target.value);
                  setCredentialId(next?.credentials[0]?.id ?? "");
                }}
              >
                {!options || options.reviewers.length === 0 ? (
                  <option value="">{options ? "None available" : "Loading…"}</option>
                ) : null}
                {options?.reviewers.map((reviewer) => (
                  <option key={reviewer.subjectId} value={reviewer.subjectId}>
                    {`${reviewer.displayName} · ${reviewer.roles.join(", ")}${
                      reviewer.credentials.length === 0 ? " · no valid credential" : ""
                    }`}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="assign-credential">Credential</label>
              <select
                id="assign-credential"
                value={credentialId}
                disabled={!chosenReviewer || chosenReviewer.credentials.length === 0}
                onChange={(event) => setCredentialId(event.target.value)}
              >
                {!chosenReviewer || chosenReviewer.credentials.length === 0 ? (
                  <option value="">No valid credential</option>
                ) : null}
                {chosenReviewer?.credentials.map((credential) => (
                  <option key={credential.id} value={credential.id}>
                    {`${credential.credentialType} · ${credential.issuerReference}${
                      credential.expiresAt ? ` · until ${credential.expiresAt.slice(0, 10)}` : ""
                    }`}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="assign-schema">Attestation schema</label>
              <select
                id="assign-schema"
                value={schemaId}
                disabled={!options || options.schemas.length === 0}
                onChange={(event) => setSchemaId(event.target.value)}
              >
                {!options || options.schemas.length === 0 ? (
                  <option value="">{options ? "None available" : "Loading…"}</option>
                ) : null}
                {options?.schemas.map((schema) => (
                  <option key={schema.id} value={schema.id}>
                    {`${schema.schemaKey} v${schema.schemaVersion} · ${schema.attestationType} · ${schema.jurisdictionProfile}`}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ) : null}

        <button
          disabled={
            busy ||
            selected.length === 0 ||
            !canAssign ||
            reviewerId === "" ||
            credentialId === "" ||
            schemaId === ""
          }
          onClick={() =>
            void run(async () => {
              const created = await createVerificationCase(
                token,
                {
                  projectId: id,
                  schemaId,
                  claimIds: selected,
                  reviewerSubjectId: reviewerId,
                  credentialId,
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
            {/* The assigner and the signer are different people, so the reviewer finds
                their assignment in this list. */}
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
            {/* If the only options were sign or nothing, there would be no place to record
                finding bad evidence. */}
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
                      // Re-read the list and refresh the selection from it. The transition response
                      // has no history, so filling the screen from it alone would hide
                      // the record just written.
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
              {/* Do not hide the path taken. A case reassigned after rejection and one that
                  went straight through look the same by current state alone. */}
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
          {/* A signature without limitations reads as a full guarantee. */}
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
            {/* The signed payload is typedData, but a human-readable form is shown with it.
                A signature without knowing what is signed is not consent (§11.4). */}
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
              {/* A credential expiring later does not change the facts at signing time (AC-17). */}
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
            {/* Deleting a signature is indistinguishable from hiding a bad review. */}
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
                {/* Resolved disputes are shown too. Hiding them erases the fact that
                    "an issue was raised once", which amounts to covering up a bad review. */}
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
                {/* A review confirmed wrong cannot be shown as valid. */}
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
