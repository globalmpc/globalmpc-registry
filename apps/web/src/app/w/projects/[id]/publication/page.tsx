"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import {
  createAnchorBatch,
  draftRegistryEntry,
  getProject,
  listRegistryDrafts,
  newIdempotencyKey,
  publishRegistryDraft,
  type AnchorBatch,
  type ProjectSummary,
  type PublishedVersion,
  type RegistryDraft,
} from "@/lib/api";
import { useSession } from "@/lib/session";
import { persistEvidenceLedger, type LedgerSummary } from "@/lib/evidence-ledger-api";
import { EvidenceLedger, WorkspaceEvidenceLedger } from "@/components/EvidenceLedger";
import { ErrorNotice } from "@/components/ErrorNotice";
import { BlackoutNotice } from "@/components/BlackoutNotice";

/**
 * Public publication and anchor — spec 02 §2.8, 05 §5.6·§5.7·§5.9, 07 §7.2, 08 §8.11.
 *
 * Three steps, and the first two are done by **different people**.
 *
 * 1. **Draft** (`mpc_operator`) — only allowlisted fields go out. The server checks the
 *    projection against the project and records the evidence snapshot and source terms it
 *    derived itself. Nothing is public yet. The screen deliberately does not pre-filter —
 *    pre-filtering would obscure where the real control lives.
 * 2. **Publish** (`disclosure_approver`, not the drafter) — makes the draft public. The server
 *    re-checks it against the record as it is now.
 * 3. **anchor batch** — bundles published versions into a Merkle tree. At this point
 *    nothing is on chain yet. `confirmationState` says exactly that.
 *
 * Publication is irreversible. Withdrawal is a new state, not a deletion.
 */
export default function PublicationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { token, session } = useSession();

  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [drafts, setDrafts] = useState<RegistryDraft[]>([]);
  const [published, setPublished] = useState<PublishedVersion | null>(null);
  const [batch, setBatch] = useState<AnchorBatch | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  const loadDrafts = useCallback(async () => {
    if (!token) return;
    setDrafts((await listRegistryDrafts(token, id)).items);
  }, [token, id]);

  useEffect(() => {
    if (!token) return;
    getProject(token, id).then(setProject).catch(setError);
    loadDrafts().catch(setError);
  }, [token, id, loadDrafts]);

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
  const canDraft = roles.includes("mpc_operator");
  const canPublish = roles.includes("disclosure_approver");
  const pending = drafts.find((draft) => draft.state === "pending") ?? null;
  const lastPublished = drafts.find((draft) => draft.state === "published") ?? null;
  const ownDraft = pending !== null && pending.proposedBySubjectId === session?.subjectId;

  const renderNotice = () => {
    return !canDraft && !canPublish ? (
      <div className="notice" style={{ color: "var(--alert)" }}>
        <div className="title">This account cannot draft or publish</div>
        Drafting requires <span className="mono">mpc_operator</span>. Publishing requires{" "}
        <span className="mono">disclosure_approver</span>, held by someone other than the drafter.
      </div>
    ) : null;
  };

  const renderPublicProjection = () => {
    return (
      <div className="panel">
        <h2>1. What will be public</h2>
        {pending?.projection.evidenceLedger ? (
          <EvidenceLedger
            summary={pending.projection.evidenceLedger as LedgerSummary}
            title="Evidence assessment in this draft"
          />
        ) : token ? <WorkspaceEvidenceLedger token={token} projectId={id} /> : null}
        <p className="sub" style={{ marginTop: 0 }}>
          Only the fields below and the approved evidence assessment go out. Source documents,
          coordinates, person-level identifiers, and internal notes leave under no approval.
        </p>
        {project ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(pending?.projection ?? buildProjection(project)).map(
                  ([field, value]) => (
                    <tr key={field}>
                      <td className="mono">{field}</td>
                      <td className="meta">
                        {typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? "—")}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="sub">Loading…</p>
        )}
      </div>
    );
  };

  const renderDraft = () => {
    return (
      <div className="panel">
        <h2>2. Draft</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          The server checks these fields against the project and records the evidence snapshot and
          source terms itself. A draft is not public.
        </p>
        <button
          className="primary"
          data-testid="draft"
          disabled={busy || !project || !canDraft || pending !== null}
          onClick={() =>
            void run(async () => {
              if (!project) return;
              const assessment = await persistEvidenceLedger(token, id, newIdempotencyKey());
              await draftRegistryEntry(
                token,
                {
                  registryType: "project",
                  subjectId: project.id,
                  publicKey: project.projectKey,
                  projection: { ...buildProjection(project), evidenceLedger: assessment.publicProjection },
                  policyVersion: "1.0.0",
                  schemaVersion: "1",
                },
                newIdempotencyKey(),
              );
              await loadDrafts();
            })
          }
        >
          Create a draft
        </button>

        {pending ? (
          <dl className="dl" data-testid="pending-draft" style={{ marginTop: 14 }}>
            <dt>State</dt>
            <dd className="mono">waiting for a Disclosure Approver</dd>
            <dt>Evidence snapshot</dt>
            <dd className="mono" style={{ wordBreak: "break-all" }}>
              {pending.sourceSnapshotHash}
            </dd>
            <dt>Source terms (commercial reuse)</dt>
            <dd className="mono">{pending.commercialReuse}</dd>
          </dl>
        ) : null}
      </div>
    );
  };

  const renderPublication = () => {
    return (
      <div className="panel">
        <h2>3. Publish</h2>
        {/* Next to the action it may block (11 §11.12). The server enforces it either way. */}
        <BlackoutNotice token={token} projectId={id} />
        {ownDraft ? (
          <p className="sub" style={{ marginTop: 0 }}>
            You drafted this. Another Disclosure Approver publishes it.
          </p>
        ) : null}
        <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 12 }}>
          <input
            type="checkbox"
            data-testid="irreversibility-ack"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          {/* Saying it is irreversible after publishing is too late. */}
          <span>
            I understand that publication cannot be undone. Revoking does not recall what has already
            been read, and the revocation itself stays on the public record.
          </span>
        </label>

        <button
          className="primary"
          data-testid="publish"
          disabled={busy || !pending || !canPublish || ownDraft || !acknowledged}
          onClick={() =>
            void run(async () => {
              if (!pending) return;
              setPublished(await publishRegistryDraft(token, pending, newIdempotencyKey()));
              await loadDrafts();
            })
          }
        >
          Publish
        </button>

        {published || lastPublished ? (
          <dl className="dl" data-testid="published-result" style={{ marginTop: 14 }}>
            <dt>Public key</dt>
            <dd className="mono">{published?.publicKey ?? lastPublished?.publicKey}</dd>
            {published ? (
              <>
                <dt>Version</dt>
                <dd className="mono">v{published.version}</dd>
                <dt>Content hash</dt>
                <dd className="mono" style={{ wordBreak: "break-all" }}>
                  {published.contentHash}
                </dd>
              </>
            ) : (
              <>
                <dt>Published at</dt>
                <dd className="mono">{lastPublished?.decidedAt}</dd>
              </>
            )}
          </dl>
        ) : null}
      </div>
    );
  };

  const renderAnchor = () => {
    return (
      <div className="panel">
        <h2>4. anchor</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          Published versions are bound into a Merkle tree. Nothing is submitted to the chain at this
          step.
        </p>
        <button
          data-testid="anchor"
          disabled={busy || !canDraft || !(published || lastPublished)}
          onClick={() =>
            void run(async () => {
              setBatch(await createAnchorBatch(token, newIdempotencyKey()));
            })
          }
        >
          Create a batch
        </button>

        {batch ? (
          <dl className="dl" data-testid="anchor-result" style={{ marginTop: 14 }}>
            <dt>batch</dt>
            <dd className="mono" style={{ wordBreak: "break-all" }}>
              {batch.batchId}
            </dd>
            <dt>root</dt>
            <dd className="mono" style={{ wordBreak: "break-all" }}>
              {batch.root}
            </dd>
            <dt>Records included</dt>
            <dd className="mono">{batch.recordCount}</dd>
            <dt>Chain state</dt>
            <dd className="mono">
              {batch.confirmationState}
              {/* created is pre-submission. Do not let it look "done". */}
              <div className="meta">
                Not submitted yet. Until it confirms, the inclusion proof reports included=false.
              </div>
            </dd>
          </dl>
        ) : null}

        {published || lastPublished ? (
          <p className="meta" style={{ marginTop: 14 }}>
            <Link
              href={`/explorer?registryType=project&publicKey=${published?.publicKey ?? lastPublished?.publicKey}`}
            >
              Check it in the Public Explorer →
            </Link>
          </p>
        ) : null}
      </div>
    );
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Publish</h1>
          <p className="sub">
            Only fields on the allowlist are published. One person drafts, another publishes.
            What is published cannot be taken back.
          </p>
        </div>
        <Link href={`/w/projects/${id}`}>← Project</Link>
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      {renderNotice()}

      {renderPublicProjection()}

      {renderDraft()}

      {renderPublication()}

      {renderAnchor()}
    </>
  );
}

/**
 * Public projection.
 *
 * Leaves out fields outside the allowlist. Filtering here is a convenience; the real control is
 * the server's `checkPublishable` and `.strict()` schema — bypassing the screen is still blocked.
 */
function buildProjection(project: ProjectSummary): Record<string, unknown> {
  return {
    stableId: project.id,
    projectKey: project.projectKey,
    projectName: project.name,
    hostCountry: project.hostCountryIso3,
    mineral: project.minerals,
    status: project.lifecycleState,
    version: String(project.version),
    asOf: project.asOf,
    sourceAge: null,
    staleStatus: "fresh",
    limitations: [
      "This record is the result of checking submitted material; it is not a judgement on commercial viability or completeness of rights",
      "It does not include site due diligence",
    ],
    legalEffect: "none",
    disclaimerCodes: ["DISC-VERIFICATION-SCOPE", "DISC-NO-GUARANTEE"],
  };
}
