"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import {
  createAnchorBatch,
  getProject,
  newIdempotencyKey,
  publishRegistryEntry,
  type AnchorBatch,
  type ProjectSummary,
  type PublishedVersion,
} from "@/lib/api";
import { useSession } from "@/lib/session";
import { ErrorNotice } from "@/components/ErrorNotice";

/**
 * Public publication and anchor — spec 05 §5.6·§5.7, 08 §8.11.
 *
 * Publication has two steps.
 *
 * 1. **Publish projection** — only allowlisted fields go out. If any field is outside it,
 *    the server rejects (AC-22). The screen deliberately does not pre-filter —
 *    pre-filtering would obscure where the real control lives.
 * 2. **anchor batch** — bundles published versions into a Merkle tree. At this point
 *    nothing is on chain yet. `confirmationState` says exactly that.
 *
 * Publication is irreversible. Withdrawal is a new state, not a deletion.
 */
export default function PublicationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { token, session } = useSession();

  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [published, setPublished] = useState<PublishedVersion | null>(null);
  const [batch, setBatch] = useState<AnchorBatch | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    if (!token) return;
    getProject(token, id).then(setProject).catch(setError);
  }, [token, id]);

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
  const canPublish = roles.includes("mpc_operator");

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Publish</h1>
          <p className="sub">
            Only fields on the allowlist are published. What is published cannot be taken back.
          </p>
        </div>
        <Link href={`/w/projects/${id}`}>← Project</Link>
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      {!canPublish ? (
        <div className="notice" style={{ color: "var(--alert)" }}>
          <div className="title">This account cannot publish</div>
          Publishing requires <span className="mono">mpc_operator</span>.
        </div>
      ) : null}

      <div className="panel">
        <h2>1. What will be public</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          Only the fields below go out. Source documents, coordinates, person-level identifiers,
          and internal notes leave under no approval.
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
                {Object.entries(buildProjection(project)).map(([field, value]) => (
                  <tr key={field}>
                    <td className="mono">{field}</td>
                    <td className="meta">
                      {Array.isArray(value) ? value.join("; ") : String(value ?? "—")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="sub">Loading…</p>
        )}
      </div>

      <div className="panel">
        <h2>2. Publish</h2>
        <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 12 }}>
          <input
            type="checkbox"
            data-testid="irreversibility-ack"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          {/* Saying it is irreversible after publishing is too late. */}
          <span>
            I understand that publication cannot be undone. Revoking does not recall what has
            already been read, and the revocation itself stays on the public record.
          </span>
        </label>

        <button
          className="primary"
          data-testid="publish"
          disabled={busy || !project || !acknowledged}
          onClick={() =>
            void run(async () => {
              if (!project) return;
              setPublished(
                await publishRegistryEntry(
                  token,
                  {
                    registryType: "project",
                    subjectId: project.id,
                    publicKey: project.projectKey,
                    projection: buildProjection(project),
                    sourceSnapshotHash: `0x${"cd".repeat(32)}`,
                    policyVersion: "1.0.0",
                    schemaVersion: "1",
                    containsPersonLevelIdentifier: false,
                  },
                  newIdempotencyKey(),
                ),
              );
            })
          }
        >
          Publish
        </button>

        {published ? (
          <dl className="dl" data-testid="published-result" style={{ marginTop: 14 }}>
            <dt>Public key</dt>
            <dd className="mono">{published.publicKey}</dd>
            <dt>Version</dt>
            <dd className="mono">v{published.version}</dd>
            <dt>Content hash</dt>
            <dd className="mono" style={{ wordBreak: "break-all" }}>
              {published.contentHash}
            </dd>
          </dl>
        ) : null}
      </div>

      <div className="panel">
        <h2>3. anchor</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          Published versions are bound into a Merkle tree. Nothing is submitted to the chain at
          this step.
        </p>
        <button
          data-testid="anchor"
          disabled={busy || !published}
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
                Not submitted yet. Until it confirms, the inclusion proof reports
                included=false.
              </div>
            </dd>
          </dl>
        ) : null}

        {published ? (
          <p className="meta" style={{ marginTop: 14 }}>
            <Link href={`/explorer?registryType=project&publicKey=${published.publicKey}`}>
              Check it in the Public Explorer →
            </Link>
          </p>
        ) : null}
      </div>
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
