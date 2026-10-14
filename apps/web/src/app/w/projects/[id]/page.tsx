"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState, type FormEvent } from "react";
import { getOfferingGate, type OfferingGateStatus } from "@/lib/api";
import {
  createRegistrationRequest,
  getProjectOverview,
  updateProject,
  type ProjectOverview,
} from "@/lib/projects-api";
import { useSession } from "@/lib/session";
import { ErrorNotice } from "@/components/ErrorNotice";
import { BlackoutNotice } from "@/components/BlackoutNotice";
import { LifecycleBadge, ReadinessBadge } from "@/components/StatusBadge";
import { ConfirmationBadge } from "@/components/project/Confirmation";
import { FactMatrix } from "@/components/project/FactMatrix";
import { PartiesPanel } from "@/components/project/PartiesPanel";
import { StakeholderHistory } from "@/components/project/StakeholderHistory";
import { REQUIRED_BOUNDARY_COPY } from "@mpc/ui";

/**
 * Project Overview — spec 11 §11.3, §11.5.
 *
 * Identity and parties, the Confirmed/Pending Matrix, the lifecycle timeline, the three registry
 * states, readiness and the latest human decision **in separate cards**, open gaps with
 * limitations and data age, and a short activity summary.
 *
 * Readiness and decisions are never merged into one value: side by side as one badge, an `ok`
 * reads as approval and a `go` reads as a data result (11 §11.9).
 */

const REFERENCE_LABEL: Record<ProjectOverview["referenceStatus"], string> = {
  none: "None",
  official_reference: "Official Reference Project",
  synthetic_test_project: "Synthetic test project",
};

const REGISTRY_LABEL = { project: "Project Registry", verification: "Verification Registry", asset: "Asset Registry" };

export default function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { token, session, loading: sessionLoading } = useSession();
  const [overview, setOverview] = useState<ProjectOverview | null>(null);
  const [offering, setOffering] = useState<OfferingGateStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const actions = session?.actions ?? [];

  const load = useCallback(() => {
    if (!token) return;
    getProjectOverview(token, id)
      .then((data) => {
        setOverview(data);
        setError(null);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }, [token, id]);

  useEffect(() => {
    if (sessionLoading || !token) return;
    setLoading(true);
    load();
    // The screen must explain why assets and offerings are absent. An empty slot
    // reads as "something should be here".
    getOfferingGate(token, id).then(setOffering).catch(() => setOffering(null));
  }, [token, id, sessionLoading, load]);

  if (!sessionLoading && !token) {
    return (
      <p className="sub">
        No account is connected. <Link href="/">Connect an account →</Link>
      </p>
    );
  }

  const project = overview;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{project?.projectKey ?? "Project"}</h1>
          <p className="sub">{project?.name ?? ""}</p>
        </div>
        <Link href="/w/projects">← All projects</Link>
      </div>

      {error ? <ErrorNotice error={error} /> : null}
      <BlackoutNotice token={token} projectId={id} />

      {loading ? <p className="sub">Loading…</p> : null}

      {project && token ? (
        <>
          <div className="panel">
            <h2>Identity</h2>
            <dl className="dl">
              <dt>Project ID</dt>
              <dd className="mono">{project.projectId}</dd>

              <dt>Host country</dt>
              <dd className="mono">{project.hostCountryIso3}</dd>

              <dt>Minerals</dt>
              <dd>{project.minerals.join(", ") || "—"}</dd>

              <dt>Lifecycle state</dt>
              <dd>
                <LifecycleBadge state={project.lifecycleState} />
              </dd>

              <dt>Owner</dt>
              <dd>{project.ownerOrganizationName}</dd>

              <dt>Reference standing</dt>
              <dd data-testid="reference-standing">
                {REFERENCE_LABEL[project.referenceStatus]}
                {project.referenceStatus !== "none" ? (
                  // A Reference badge must not make other fields look automatically
                  // confirmed (§11.5, invariant 10).
                  <div className="meta">
                    This label does not confirm rights, consent, issuer, or SPV status, and it is
                    not government cooperation or an offering.
                  </div>
                ) : null}
              </dd>

              <dt>Project relationship</dt>
              <dd>
                <ConfirmationBadge status={project.relationshipStatus} />
              </dd>

              <dt>Data readiness</dt>
              <dd>
                {project.readiness.length > 0 ? (
                  <span className="meta">See the readiness card below</span>
                ) : (
                  <>
                    <span className="meta">Not assessed</span>
                    <div className="meta">No assessment has run yet. This is not a pass.</div>
                  </>
                )}
              </dd>

              <dt>Version</dt>
              <dd className="mono">v{project.version}</dd>

              <dt>As of</dt>
              <dd className="mono">{project.asOf}</dd>
            </dl>
            {actions.includes("project.update") ? (
              <EditIdentity token={token} project={project} onSaved={load} />
            ) : null}
          </div>

          <PartiesPanel
            token={token}
            projectId={id}
            parties={project.parties}
            canSubmit={actions.includes("project.party.submit")}
            canConfirm={actions.includes("project.fact.record")}
            onChanged={load}
          />

          <FactMatrix
            token={token}
            projectId={id}
            facts={project.facts}
            canRecord={actions.includes("project.fact.record")}
            onChanged={load}
          />

          <div className="panel" data-testid="lifecycle-timeline">
            <h2>Lifecycle timeline</h2>
            {project.lifecycle.length === 0 ? (
              <p className="sub" style={{ margin: 0 }}>
                No transition has been recorded since registration.
              </p>
            ) : (
              <ol>
                {project.lifecycle.map((step) => (
                  <li key={`${step.occurredAt}-${step.toState}`}>
                    <span className="mono">{step.fromState}</span> →{" "}
                    <span className="mono">{step.toState}</span> · {step.reason} ·{" "}
                    <span className="mono meta">{step.occurredAt}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div className="panel" data-testid="registry-states">
            <h2>Registries</h2>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Registry</th>
                    <th scope="col">Status</th>
                    <th scope="col">Latest version</th>
                    <th scope="col">Anchored</th>
                  </tr>
                </thead>
                <tbody>
                  {project.registries.map((registry) => (
                    <tr key={registry.registryType}>
                      <th scope="row">{REGISTRY_LABEL[registry.registryType]}</th>
                      <td className="mono">
                        {registry.status === "none" ? "No record" : registry.status}
                      </td>
                      <td className="mono">
                        {registry.latestVersion === null ? "—" : `v${registry.latestVersion}`}
                      </td>
                      <td>{registry.anchored ? "Yes" : "No"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="meta" style={{ marginBottom: 0 }}>
              A registry record states that a record exists. It is not legal effect or issuance.
            </p>
          </div>

          <div className="row" style={{ alignItems: "stretch", flexWrap: "wrap" }}>
            <div className="panel" style={{ flex: "1 1 320px" }} data-testid="readiness-card">
              <h2>Readiness</h2>
              {project.readiness.length === 0 ? (
                <p className="sub" style={{ margin: 0 }}>No gate has an assessment on record.</p>
              ) : (
                <ul>
                  {project.readiness.map((row) => (
                    <li key={row.gateId}>
                      <span className="mono">{row.gateId}</span>{" "}
                      <ReadinessBadge status={row.status} />{" "}
                      <span className="meta mono">{row.generatedAt}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="meta">{REQUIRED_BOUNDARY_COPY.readiness}</p>
            </div>
            <div className="panel" style={{ flex: "1 1 320px" }} data-testid="decision-card">
              <h2>Latest human decision</h2>
              {project.decisions.length === 0 ? (
                <p className="sub" style={{ margin: 0 }}>No gate decision has been recorded.</p>
              ) : (
                <ul>
                  {project.decisions.map((row) => (
                    <li key={row.gateId}>
                      <span className="mono">{row.gateId}</span> · {row.decision} ·{" "}
                      {row.decisionAuthority} · <span className="meta mono">{row.signedAt}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="panel" data-testid="gaps-and-limitations">
            <h2>Open gaps, limitations and data age</h2>
            {project.readiness.flatMap((row) => row.openGaps).length > 0 ? (
              <ul>
                {project.readiness.flatMap((row) =>
                  row.openGaps.map((gap) => (
                    <li key={`${row.gateId}-${gap.requirementId}`}>
                      <span className="mono">{row.gateId}</span> ·{" "}
                      <span className="mono">{gap.requirementId}</span> · {gap.status} ·{" "}
                      <span className="meta">{gap.reasonCode}</span>
                    </li>
                  )),
                )}
              </ul>
            ) : null}
            <ul>
              {project.limitations.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
            <dl className="dl">
              <dt>Sources recorded</dt>
              <dd className="mono">{project.dataAge.sourceCount}</dd>
              <dt>Newest source as of</dt>
              <dd className="mono">{project.dataAge.newestSourceAsOf ?? "—"}</dd>
              <dt>Oldest source as of</dt>
              <dd className="mono">{project.dataAge.oldestSourceAsOf ?? "—"}</dd>
              <dt>Open stale signals</dt>
              <dd className="mono">{project.dataAge.openStaleSignals}</dd>
            </dl>
          </div>

          <RegistrationRequests
            token={token}
            projectId={id}
            overview={project}
            canRequest={actions.includes("project.registration.request")}
            onChanged={load}
          />

          <StakeholderHistory
            token={token}
            projectId={id}
            canRecord={actions.includes("project.stakeholder.record")}
          />

          <div className="panel">
            <h2>Actions</h2>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <Link href={`/w/projects/${id}/data-room`}>
                <button>Data Room</button>
              </Link>
              <Link href={`/w/projects/${id}/documents`}>
                <button>Document status</button>
              </Link>
              <Link href={`/w/projects/${id}/impacts`}>
                <button>Documents to recheck</button>
              </Link>
              <Link href={`/w/projects/${id}/verification`}>
                <button>Verification</button>
              </Link>
              <Link href={`/w/projects/${id}/readiness`}>
                <button>Readiness</button>
              </Link>
              {/* Gate Decision is a separate screen from readiness (§11.3). On the same screen,
                  readiness reads as approval. */}
              <Link href={`/w/projects/${id}/gates/registry_publication`}>
                <button>Gate decision</button>
              </Link>
              <Link href={`/w/projects/${id}/publication`}>
                <button>Publish</button>
              </Link>
            </div>
            <ul style={{ margin: "14px 0 0", paddingLeft: 18, color: "var(--muted-foreground)" }}>
              <li>{REQUIRED_BOUNDARY_COPY.readiness}</li>
              <li>{REQUIRED_BOUNDARY_COPY.verification}</li>
            </ul>
          </div>

          {offering ? <OfferingPanel offering={offering} /> : null}

          <div className="panel" data-testid="project-activity">
            <h2>Recent activity</h2>
            {project.activity.length === 0 ? (
              <p className="sub" style={{ margin: 0 }}>No recorded activity.</p>
            ) : (
              <ul>
                {project.activity.map((row, index) => (
                  <li key={`${row.occurredAt}-${index}`}>
                    <span className="mono">{row.command}</span>
                    {row.effectiveRole ? <span className="meta"> · {row.effectiveRole}</span> : null}{" "}
                    <span className="meta mono">{row.occurredAt}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="meta" style={{ marginBottom: 0 }}>
              Command and role only. The full record is on the audit screen.
            </p>
          </div>

          <p className="meta">
            Request ID <span className="mono">{project.requestId}</span>
          </p>
        </>
      ) : null}
    </>
  );
}

/** Name and minerals only — the owner and the reference label are not edited here (07 §7.2). */
function EditIdentity({
  token,
  project,
  onSaved,
}: {
  readonly token: string;
  readonly project: ProjectOverview;
  readonly onSaved: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [minerals, setMinerals] = useState(project.minerals.join(", "));
  const [reason, setReason] = useState("");
  const [error, setError] = useState<unknown>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await updateProject(token, project.projectId, project.version, {
        name,
        minerals: minerals.split(",").map((item) => item.trim()).filter(Boolean),
        reason,
      });
      setReason("");
      setError(null);
      onSaved();
    } catch (caught) {
      setError(caught);
    }
  }

  return (
    <details style={{ marginTop: 14 }}>
      <summary>Edit name or minerals</summary>
      {error ? <ErrorNotice error={error} /> : null}
      <form onSubmit={submit} style={{ maxWidth: 560, marginTop: 12 }}>
        <div className="field">
          <label htmlFor="edit-name">Project name</label>
          <input id="edit-name" value={name} onChange={(event) => setName(event.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="edit-minerals">Mineral list (comma separated)</label>
          <input id="edit-minerals" value={minerals} onChange={(event) => setMinerals(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="edit-reason">Reason for the change</label>
          <input id="edit-reason" value={reason} onChange={(event) => setReason(event.target.value)} required />
        </div>
        <button type="submit">Save</button>
      </form>
    </details>
  );
}

function RegistrationRequests({
  token,
  projectId,
  overview,
  canRequest,
  onChanged,
}: {
  readonly token: string;
  readonly projectId: string;
  readonly overview: ProjectOverview;
  readonly canRequest: boolean;
  readonly onChanged: () => void;
}) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<unknown>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await createRegistrationRequest(token, projectId, note);
      setNote("");
      setError(null);
      onChanged();
    } catch (caught) {
      setError(caught);
    }
  }

  return (
    <div className="panel" data-testid="registration-requests">
      <h2>Registration requests</h2>
      <p className="sub" style={{ marginTop: 0 }}>
        A request asks for the Project Registry workflow to start. It does not publish anything.
      </p>
      {error ? <ErrorNotice error={error} /> : null}
      {overview.registrationRequests.length === 0 ? (
        <p className="sub" style={{ margin: 0 }}>No registration request has been made.</p>
      ) : (
        <ul>
          {overview.registrationRequests.map((request) => (
            <li key={request.id}>
              {request.note} · <span className="mono meta">{request.requestedAt}</span> ·{" "}
              {request.answeredByPublication
                ? "A Project Registry version was published after this request"
                : "No publication since this request"}
            </li>
          ))}
        </ul>
      )}
      {canRequest ? (
        <form onSubmit={submit} style={{ maxWidth: 560, marginTop: 12 }}>
          <div className="field">
            <label htmlFor="registration-note">Request note</label>
            <input
              id="registration-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              required
            />
          </div>
          <button type="submit">Request registration</button>
        </form>
      ) : null}
    </div>
  );
}

function OfferingPanel({ offering }: { readonly offering: OfferingGateStatus }) {
  return (
    <div className="panel" data-testid="offering-gate">
      <h2>Assets and offering</h2>
      {/* No disabled buttons — they read as "coming soon". Unapproved regulated
          features create a mis-enable risk even behind a flag (OD-07). */}
      <p className="sub" style={{ marginTop: 0 }}>
        {offering.absenceNotice}
      </p>

      {offering.missing.length > 0 ? (
        <div className="table-scroll">
          <table data-testid="offering-preconditions">
            <thead>
              <tr>
                <th>Remaining condition</th>
                <th>Why it is needed</th>
                <th>Owner</th>
              </tr>
            </thead>
            <tbody>
              {offering.missing.map((item) => (
                <tr key={item.key}>
                  <td>{item.label}</td>
                  <td className="meta">{item.why}</td>
                  <td className="mono meta">{item.owner}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {offering.unsupported.length > 0 ? (
        <div className="notice" style={{ color: "var(--destructive-text)", marginTop: 12 }}>
          <div className="title">Marked as met without a basis</div>
          {/* Worse than missing — it makes people believe it was confirmed. */}
          {offering.unsupported.join(", ")}
        </div>
      ) : null}

      <p className="meta" style={{ marginTop: 10 }}>
        {offering.notMeaning}
      </p>
    </div>
  );
}
