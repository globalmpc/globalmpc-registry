"use client";

import Link from "next/link";
import { administratorDraftEligibility, PROJECT_PUBLICATION_DISCLAIMERS, PROJECT_PUBLICATION_LIMITATIONS } from "@mpc/api-contract";
import { use, useCallback, useEffect, useState } from "react";
import {
  ApiError,
  apiFetch,
  approveRegistryDraftDisclosure,
  createAnchorBatch,
  discardRegistryDraft,
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
import { persistEvidenceLedger } from "@/lib/evidence-ledger-api";
import { WorkspaceEvidenceLedger } from "@/components/EvidenceLedger";
import { DisclosurePreview } from "@/components/DisclosurePreview";
import { ErrorNotice } from "@/components/ErrorNotice";
import { BlackoutNotice } from "@/components/BlackoutNotice";

/**
 * Public publication and anchor — spec 02 §2.8, 05 §5.6·§5.7·§5.9, 07 §7.2, 08 §8.11.
 *
 * An administrator can draft, publish their eligible project draft, and create an anchor batch.
 *
 * 1. **Draft** (`administrator`) — only allowlisted fields go out. The server checks the
 *    projection against the project and records the evidence snapshot and source terms it
 *    derived itself. Nothing is public yet. The screen deliberately does not pre-filter —
 *    pre-filtering would obscure where the real control lives.
 * 2. **Publish** — makes the draft public. The server
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
  const [acknowledgedDraft, setAcknowledgedDraft] = useState<string | null>(null);
  const [prepareAdministratorPublication, setPrepareAdministratorPublication] = useState(true);

  const loadPublication = useCallback(async () => {
    if (!token) return;
    const results = await Promise.allSettled([
      getProject(token, id).then(setProject),
      listRegistryDrafts(token, id).then((response) => setDrafts(response.items)),
    ]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }, [token, id]);

  useEffect(() => {
    void loadPublication().catch(setError);
  }, [loadPublication]);

  const awaitingDisclosure = drafts.some((draft) => draft.state === "pending"
    && draft.proposedBySubjectId === session?.subjectId
    && draft.administratorPublicationPrepared && !draft.disclosureApproved);

  useDisclosureApprovalRefresh(token, id, !busy && awaitingDisclosure, setDrafts);

  async function run(step: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await step();
    } catch (caught) {
      setError(caught);
      if (caught instanceof ApiError && caught.status === 412) {
        await loadPublication().catch(setError);
      }
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

  const { canDraft, canReviewPublish, pending, lastPublished, pendingRevision, ownDraft,
    administratorEligibility, canPublish, canApproveDisclosure } = publicationControls(
    drafts, project, session,
  );
  const exportVersionId = published?.id ?? lastPublished?.entryVersionId;
  const acknowledged = pendingRevision !== null && acknowledgedDraft === pendingRevision;
  const previewProjection = pending?.projection ?? (project ? buildProjection(project, prepareAdministratorPublication) : null);

  const renderNotice = () => {
    return !canDraft && !canReviewPublish ? (
      <div className="notice" style={{ color: "var(--alert)" }}>
        <div className="title">This account cannot draft or publish</div>
        An administrator can publish their eligible project draft after independent disclosure approval. A reviewer can also publish a draft prepared by another person.
      </div>
    ) : null;
  };

  const renderPublicProjection = () => {
    return (
      <div className="panel">
        <h2>1. What will be public</h2>
        {previewProjection ? <DisclosurePreview projection={previewProjection} /> : null}
        {!pending && token ? <WorkspaceEvidenceLedger mayManagePolicies={session?.actions?.includes("registry.read") ?? false} token={token} projectId={id} /> : null}
        <p className="sub" style={{ marginTop: 0 }}>
          Only the fields below and the approved evidence assessment go out. Source documents,
          coordinates, person-level identifiers, and internal notes leave under no approval.
        </p>
        {previewProjection ? (
          <details className="disclosure-fields"><summary>Inspect exact disclosure fields</summary><div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(previewProjection).map(
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
          </div></details>
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
        {canDraft && !pending ? (
          <label>
            <input type="checkbox" checked={prepareAdministratorPublication} disabled={busy}
              onChange={(event) => setPrepareAdministratorPublication(event.target.checked)} />
            Prepare for administrator publication
          </label>
        ) : null}
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
                  prepareAdministratorPublication,
                  projection: { ...buildProjection(project, prepareAdministratorPublication), evidenceLedger: assessment.publicProjection },
                  policyVersion: "1.0.0",
                  schemaVersion: "1",
                },
                newIdempotencyKey(),
              );
              await loadPublication();
            })
          }
        >
          Create a draft
        </button>

        {pending && ownDraft && canDraft ? (
          <button
            disabled={busy}
            onClick={() => void run(async () => {
              const discarded = await discardRegistryDraft(token, pending, newIdempotencyKey());
              setDrafts((current) => current.map((draft) => draft.id === discarded.id ? discarded : draft));
              setAcknowledgedDraft(null);
              await loadPublication();
            })}
          >
            Discard draft
          </button>
        ) : null}

        {pending ? (
          <dl className="dl" data-testid="pending-draft" style={{ marginTop: 14 }}>
            <dt>State</dt>
            <dd className="mono">{canPublish ? "Ready to publish" : "Waiting for an eligible publisher"}</dd>
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
        {ownDraft && !canPublish ? (
          <p className="sub" style={{ marginTop: 0 }}>
            {administratorEligibility === "stale"
              ? "The project changed. Discard this draft and create a new one."
              : administratorEligibility === "eligible"
                ? "Waiting for an independent reviewer to approve this draft for public disclosure."
                : "This draft needs a different reviewer to publish it."}
          </p>
        ) : null}
        {canApproveDisclosure && pending ? (
          <button
            disabled={busy}
            onClick={() => void run(async () => {
              const approved = await approveRegistryDraftDisclosure(token, pending, newIdempotencyKey());
              setDrafts((current) => current.map((draft) => draft.id === approved.id ? approved : draft));
              await loadPublication();
            })}
          >
            Approve this draft for public disclosure
          </button>
        ) : null}
        <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 12 }}>
          <input
            type="checkbox"
            data-testid="irreversibility-ack"
            checked={acknowledged}
            disabled={!pending || busy}
            onChange={(event) => setAcknowledgedDraft(event.target.checked ? pendingRevision : null)}
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
          disabled={busy || !pending || !canPublish || !acknowledged}
          onClick={() =>
            void run(async () => {
              if (!pending) return;
              const result = await publishRegistryDraft(token, pending, newIdempotencyKey());
              setPublished(result);
              setDrafts((current) => current.filter((draft) => draft.id !== pending.id));
              await loadPublication();
            })
          }
        >
          Publish
        </button>

        {exportVersionId ? <button type="button" onClick={async()=>{
          try {
            const response=await apiFetch(`/api/v1/registry-entries/versions/${exportVersionId}/review-bundle`,{cache:"no-store"});
            if(!response.ok)throw new Error("Review proof is unavailable or access is denied");
            const data:unknown=await response.json();
            const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:"application/json"}));
            const link=document.createElement("a");link.href=url;link.download=`review-bundle-${exportVersionId}.json`;link.click();URL.revokeObjectURL(url);
          }catch(error){setError(error);}
        }}>Download signed review proof</button>:null}
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
          This batch includes only published versions of this project that are not already in a batch.
        </p>
        <button
          data-testid="anchor"
          disabled={busy || !canDraft || !(published || lastPublished)}
          onClick={() =>
            void run(async () => {
              setBatch(await createAnchorBatch(token, id, newIdempotencyKey()));
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
          <Link href={`/w/projects/${id}/cre`}>Continue to CRE →</Link>
          <p className="sub">
            Only fields on the allowlist are published. An independent reviewer must approve what will be public before an administrator publishes their own draft.
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
function publicationControls(
  drafts: readonly RegistryDraft[],
  project: ProjectSummary | null,
  session: ReturnType<typeof useSession>["session"],
) {
  const roles = session?.roleBindings?.map((binding) => binding.role) ?? [];
  const canDraft = roles.includes("administrator");
  const canReviewPublish = roles.includes("reviewer");
  const pending = drafts.find((draft) => draft.state === "pending") ?? null;
  const lastPublished = drafts.find((draft) => draft.state === "published") ?? null;
  const pendingRevision = pending ? `${pending.id}:${pending.version}` : null;
  const ownDraft = pending !== null && pending.proposedBySubjectId === session?.subjectId;
  const administratorEligibility = pending && project
    ? administratorDraftEligibility(pending, { version: project.version, publicationStatus: publicationStatus(project) })
    : "ineligible";
  const canPublish = ownDraft
    ? canDraft && administratorEligibility === "eligible" && pending.disclosureApproved
    : canReviewPublish;
  const canApproveDisclosure = canReviewPublish && !ownDraft && pending?.administratorPublicationPrepared
    && !pending.disclosureApproved && administratorEligibility === "eligible";

  return { canDraft, canReviewPublish, pending, lastPublished, pendingRevision, ownDraft,
    administratorEligibility, canPublish, canApproveDisclosure };
}

/** Refresh approvals recorded in another session while the administrator is waiting. */
function useDisclosureApprovalRefresh(
  token: string | null,
  id: string,
  enabled: boolean,
  onDrafts: (drafts: RegistryDraft[]) => void,
) {
  useEffect(() => {
    if (!token || !enabled) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const refreshDrafts = async () => {
      try {
        const response = await listRegistryDrafts(token, id);
        if (active) onDrafts(response.items);
      } catch {
        // An automatic read failure leaves the last known draft visible and retries.
      }
      if (active) timer = setTimeout(refreshDrafts, 5_000);
    };

    timer = setTimeout(refreshDrafts, 5_000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [token, id, enabled, onDrafts]);
}

function publicationStatus(project: ProjectSummary): string {
  return project.lifecycleState === "draft" ? "registered" : project.lifecycleState;
}

function buildProjection(project: ProjectSummary, prepareAdministratorPublication: boolean): Record<string, unknown> {
  return {
    stableId: project.id,
    projectKey: project.projectKey,
    projectName: project.name,
    hostCountry: project.hostCountryIso3,
    mineral: project.minerals,
    status: prepareAdministratorPublication ? publicationStatus(project) : project.lifecycleState,
    version: String(project.version),
    asOf: project.asOf,
    sourceAge: null,
    staleStatus: prepareAdministratorPublication ? "unknown" : "fresh",
    limitations: PROJECT_PUBLICATION_LIMITATIONS,
    legalEffect: "none",
    disclaimerCodes: PROJECT_PUBLICATION_DISCLAIMERS,
  };
}
