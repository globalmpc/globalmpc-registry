"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import {
  getOfferingGate,
  getProject,
  type OfferingGateStatus,
  type ProjectSummary,
} from "@/lib/api";
import { useSession } from "@/lib/session";
import { ErrorNotice } from "@/components/ErrorNotice";
import { LifecycleBadge, ReadinessBadge } from "@/components/StatusBadge";
import { REQUIRED_BOUNDARY_COPY } from "@mpc/ui";
import type { ReadinessStatus } from "@mpc/domain";

export default function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { token, loading: sessionLoading } = useSession();
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [offering, setOffering] = useState<OfferingGateStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (sessionLoading || !token) return;
    setLoading(true);
    getProject(token, id)
      .then((data) => {
        setProject(data);
        setError(null);
      })
      .catch(setError)
      .finally(() => setLoading(false));

    // The screen must explain why assets and offerings are absent. An empty slot
    // reads as "something should be here".
    getOfferingGate(token, id).then(setOffering).catch(() => setOffering(null));
  }, [token, id, sessionLoading]);

  if (!sessionLoading && !token) {
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
          <h1>{project?.projectKey ?? "Project"}</h1>
          <p className="sub">{project?.name ?? ""}</p>
        </div>
        <Link href="/w/projects">← All projects</Link>
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      {loading ? <p className="sub">Loading…</p> : null}

      {project ? (
        <>
          <div className="panel">
            <h2>Basics</h2>
            <dl className="dl">
              <dt>Project ID</dt>
              <dd className="mono">{project.id}</dd>

              <dt>Host country</dt>
              <dd className="mono">{project.hostCountryIso3}</dd>

              <dt>Minerals</dt>
              <dd>{project.minerals.join(", ") || "—"}</dd>

              <dt>Lifecycle state</dt>
              <dd>
                <LifecycleBadge state={project.lifecycleState} />
              </dd>

              <dt>Reference standing</dt>
              <dd>
                {project.referenceStatus === "official_reference" ? (
                  <>
                    official_reference
                    {/* A Reference badge must not make other fields look automatically
                        confirmed (§11.5, invariant 10). */}
                    <div className="meta">
                      This standing does not confirm rights, consent, issuer, or SPV status.
                    </div>
                  </>
                ) : (
                  <span className="meta">none</span>
                )}
              </dd>

              <dt>Data readiness</dt>
              <dd>
                {project.readinessSummary ? (
                  <ReadinessBadge status={project.readinessSummary as ReadinessStatus} />
                ) : (
                  <>
                    <span className="meta">Not assessed</span>
                    <div className="meta">
                      No assessment has run yet. This is not a pass.
                    </div>
                  </>
                )}
              </dd>

              <dt>Version</dt>
              <dd className="mono">v{project.version}</dd>

              <dt>Last changed</dt>
              <dd className="mono">{project.updatedAt}</dd>

              <dt>As of</dt>
              <dd className="mono">{project.asOf}</dd>
            </dl>
          </div>

          <div className="panel">
            <h2>Actions</h2>
            <div className="row">
              <Link href={`/w/projects/${project.id}/data-room`}>
                <button>Data Room</button>
              </Link>
              <Link href={`/w/projects/${project.id}/verification`}>
                <button>Verification</button>
              </Link>
              <Link href={`/w/projects/${project.id}/readiness`}>
                <button>Readiness</button>
              </Link>
              {/* Gate Decision is a separate screen from readiness (§11.3). On the same screen,
                  readiness reads as approval. */}
              <Link href={`/w/projects/${project.id}/gates/registry_publication`}>
                <button>Gate decision</button>
              </Link>
              <Link href={`/w/projects/${project.id}/publication`}>
                <button>Publish</button>
              </Link>
            </div>
            <ul style={{ margin: "14px 0 0", paddingLeft: 18, color: "var(--muted-foreground)" }}>
              <li>{REQUIRED_BOUNDARY_COPY.readiness}</li>
              <li>{REQUIRED_BOUNDARY_COPY.verification}</li>
            </ul>
          </div>

          {offering ? (
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
          ) : null}

          <p className="meta">
            Request ID <span className="mono">{project.requestId}</span>
          </p>
        </>
      ) : null}
    </>
  );
}
