"use client";

import { useCallback, useEffect, useState } from "react";
import {
  decideRegistryProposal,
  listRegistryProposals,
  newIdempotencyKey,
  proposeRegistryItem,
  type RegistryProposal,
  type RegistrySegment,
} from "@/lib/api";
import { useSession } from "@/lib/session";
import { ErrorNotice } from "@/components/ErrorNotice";

/**
 * Review registry proposals — spec 02 §2.8, W-066.
 *
 * Credentials, attestation schemas and compliance policy sets are proposed by an operator and
 * approved by a different person holding the review role. Approval is what creates the record.
 * Before this panel the only way in was a CLI where "approval" was a typed name.
 *
 * **Controls follow the session's actions, not role names copied here.** The server lists the
 * actions a session holds (`session.actions`) and still decides every request — hiding a button
 * is not a control (02 §2.1).
 *
 * **The proposer never sees decision buttons.** The server and the DB reject a decision by the
 * proposer; a button that is always rejected makes the screen look broken.
 */

const KINDS: readonly { readonly segment: RegistrySegment; readonly label: string }[] = [
  { segment: "policy-sets", label: "Policy sets" },
  { segment: "attestation-schemas", label: "Attestation schemas" },
  { segment: "credentials", label: "Credentials" },
];

/** Starting payload per registry. The rationale is a separate field. */
const TEMPLATES: Readonly<Record<RegistrySegment, unknown>> = {
  "policy-sets": {
    definition: {
      ruleSetId: "",
      version: "1.0.0",
      effectiveFrom: "2026-01-01T00:00:00Z",
      supersededBy: null,
      jurisdictionProfile: "MNG",
      gateId: "registry_publication",
      retroactive: false,
      requirements: [],
    },
  },
  "attestation-schemas": {
    schemaKey: "",
    schemaVersion: "1",
    attestationType: "professional_signoff",
    requiredEvidence: [],
    acceptedAuthorityTypes: [],
    mandatoryLimitations: [],
    jurisdictionProfile: "MNG",
    effectiveFrom: "2026-01-01T00:00:00Z",
  },
  credentials: {
    subjectId: "",
    issuerReference: "",
    credentialType: "competent_person",
    credentialScope: [],
    jurisdiction: ["MNG"],
    issuedAt: "2026-01-01T00:00:00Z",
    expiresAt: null,
  },
};

function template(segment: RegistrySegment): string {
  return JSON.stringify(TEMPLATES[segment], null, 2);
}

/** A parse failure is shown like any other error, with what went wrong. */
function parsePayload(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (caught) {
    throw new Error(
      `Payload is not valid JSON — ${caught instanceof Error ? caught.message : String(caught)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Payload must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export function ReviewRegistryPanel() {
  const { token, session, loading: sessionLoading } = useSession();
  const actions = session?.actions ?? [];
  const canRead = actions.includes("review_registry.read");
  const canPropose = actions.includes("review_registry.propose");
  const canDecide = actions.includes("review_registry.approve");

  const [segment, setSegment] = useState<RegistrySegment>("policy-sets");
  const [items, setItems] = useState<RegistryProposal[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [payload, setPayload] = useState(() => template("policy-sets"));
  const [rationale, setRationale] = useState("");
  const [decisionReason, setDecisionReason] = useState("");

  const reload = useCallback(async () => {
    if (!token || !canRead) return;
    try {
      const page = await listRegistryProposals(token, segment);
      setItems(page.items);
    } catch (caught) {
      setError(caught);
    }
  }, [token, canRead, segment]);

  useEffect(() => {
    if (sessionLoading) return;
    void reload();
  }, [reload, sessionLoading]);

  async function run(action: () => Promise<unknown>) {
    try {
      await action();
      setError(null);
      await reload();
    } catch (caught) {
      setError(caught);
    }
  }

  function selectSegment(next: RegistrySegment) {
    setSegment(next);
    setPayload(template(next));
    setItems([]);
    setError(null);
  }

  // Without read access there is nothing to show; a 403 notice here would only be noise on a
  // page the person can otherwise use.
  if (!canRead || !token) return null;

  function decide(proposal: RegistryProposal, decision: "approve" | "reject") {
    void run(async () => {
      await decideRegistryProposal(
        token!,
        newIdempotencyKey(),
        segment,
        proposal.id,
        proposal.version,
        { decision, reason: decisionReason.trim() },
      );
      setDecisionReason("");
    });
  }

  function decisionCell(proposal: RegistryProposal) {
    if (proposal.state !== "pending") {
      return (
        <span className="mono">
          {proposal.state}
          {proposal.decisionReason ? <div className="meta">{proposal.decisionReason}</div> : null}
        </span>
      );
    }
    if (proposal.proposedBySubjectId === session?.subjectId) {
      return <span className="meta">You proposed this — someone else decides.</span>;
    }
    if (!canDecide) {
      return <span className="meta">Waiting for a holder of the review role.</span>;
    }
    const blank = decisionReason.trim() === "";
    return (
      <>
        <button className="primary" disabled={blank} onClick={() => decide(proposal, "approve")}>
          Approve
        </button>{" "}
        <button disabled={blank} onClick={() => decide(proposal, "reject")}>
          Reject
        </button>
      </>
    );
  }

  const hasPending = items.some((proposal) => proposal.state === "pending");

  return (
    <div className="panel" data-testid="review-registry">
      <h2>Review registry proposals</h2>
      <p className="sub" style={{ marginTop: 0 }}>
        Credentials, attestation schemas and compliance policy sets. An operator proposes; a
        different person with the review role decides, and only approval creates the record. A new
        version is a new proposal — an approved version is never edited.
      </p>

      <div className="row" style={{ gap: 6 }} data-testid="review-registry-kind">
        {KINDS.map((kind) => (
          <button
            key={kind.segment}
            className={segment === kind.segment ? "primary" : undefined}
            aria-pressed={segment === kind.segment}
            onClick={() => selectSegment(kind.segment)}
          >
            {kind.label}
          </button>
        ))}
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      {items.length === 0 ? (
        <p className="sub">No proposals for this registry yet. This is not a permission problem.</p>
      ) : (
        <>
          {canDecide && hasPending ? (
            <div className="field">
              <label htmlFor="registry-decision-reason">Decision reason</label>
              <input
                id="registry-decision-reason"
                value={decisionReason}
                onChange={(event) => setDecisionReason(event.target.value)}
              />
            </div>
          ) : null}
          <div className="table-scroll">
            <table data-testid="review-registry-proposals">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Version</th>
                  <th>Effective from</th>
                  <th>Rationale</th>
                  <th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {items.map((proposal) => (
                  <tr key={proposal.id}>
                    <td className="mono">{proposal.itemKey}</td>
                    <td className="mono">v{proposal.itemVersion}</td>
                    <td className="mono meta">{proposal.effectiveFrom}</td>
                    <td style={{ color: "var(--muted-foreground)" }}>{proposal.rationale}</td>
                    <td>{decisionCell(proposal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {canPropose ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const body = parsePayload(payload);
              await proposeRegistryItem(token, newIdempotencyKey(), segment, {
                ...body,
                rationale,
              });
              setRationale("");
            });
          }}
        >
          <h3>Propose a version</h3>
          <p className="sub" style={{ marginTop: 0 }}>
            Proposing creates nothing. The server validates the payload with the same rules the
            bootstrap CLI uses and says what is wrong.
          </p>
          <div className="field">
            <label htmlFor="registry-payload">Payload (JSON)</label>
            <textarea
              id="registry-payload"
              className="mono"
              rows={12}
              style={{ width: "100%" }}
              value={payload}
              onChange={(event) => setPayload(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="registry-rationale">Rationale</label>
            <input
              id="registry-rationale"
              value={rationale}
              onChange={(event) => setRationale(event.target.value)}
            />
          </div>
          <button className="primary" type="submit" disabled={rationale.trim() === ""}>
            Propose
          </button>
        </form>
      ) : null}
    </div>
  );
}
