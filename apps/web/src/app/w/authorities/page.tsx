"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { getJurisdictionProfile, type JurisdictionProfile } from "@/lib/api";
import { useSession } from "@/lib/session";
import { ErrorNotice } from "@/components/ErrorNotice";

/**
 * Authority Registry — spec 05 §5.11, OD-42·OD-43.
 *
 * **Authorities without an integration stay in the list.** Removing them hides "why is this
 * authority missing"; marking them active promises an integration that does not exist. The R5 gate
 * criterion "zero overstated unverified integrations" is this screen's pass condition.
 *
 * Each authority's **what it does not confirm** sits beside what it confirms. Showing only
 * one side makes readers assume full confirmation.
 */
export default function AuthoritiesPage() {
  const { token, loading: sessionLoading } = useSession();
  const [jurisdiction, setJurisdiction] = useState("MNG");
  const [profile, setProfile] = useState<JurisdictionProfile | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    setBusy(true);
    try {
      setProfile(await getJurisdictionProfile(token, jurisdiction));
      setError(null);
    } catch (caught) {
      setError(caught);
      setProfile(null);
    } finally {
      setBusy(false);
    }
  }, [token, jurisdiction]);

  useEffect(() => {
    if (!sessionLoading) void load();
  }, [load, sessionLoading]);

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
          <h1>Authority Registry</h1>
          <p className="sub">
            Which authority confirms what — and what it does not confirm. Integration state is
            shown alongside.
          </p>
        </div>
        <Link href="/w/projects">← Projects</Link>
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      <div className="panel">
        <div className="row" style={{ alignItems: "flex-end" }}>
          <div className="field" style={{ marginBottom: 0, width: 160 }}>
            <label htmlFor="jurisdiction">Jurisdiction (ISO3)</label>
            <input
              id="jurisdiction"
              className="mono"
              value={jurisdiction}
              onChange={(event) => setJurisdiction(event.target.value.toUpperCase())}
            />
          </div>
          <button onClick={() => void load()} disabled={busy}>
            {busy ? "Searching…" : "Search"}
          </button>
        </div>
      </div>

      {profile ? (
        <>
          <div className="panel" data-testid="profile-summary">
            <h2>Integration state</h2>
            <dl className="dl">
              <dt>Callable</dt>
              <dd className="mono" style={{ color: "var(--positive)" }}>
                {profile.activeCount}
              </dd>
              <dt>Manual check</dt>
              <dd className="mono" style={{ color: "var(--alert)" }}>
                {profile.manualCount}
                {/* Manual is not an outage. A person performs the lookup. */}
                <div className="meta">Not an outage — a path where a person performs the lookup</div>
              </dd>
              <dt>Pending or blocked</dt>
              <dd className="mono" style={{ color: "var(--muted-foreground)" }}>
                {profile.pendingCount}
              </dd>
            </dl>
          </div>

          <div className="panel">
            <div className="table-scroll">
              <table data-testid="authority-table">
                <thead>
                  <tr>
                    <th>Authority</th>
                    <th>Confirms</th>
                    <th>Does not confirm</th>
                    <th>Integration</th>
                    <th>Next action</th>
                  </tr>
                </thead>
                <tbody>
                  {profile.authorities.map((authority) => (
                    <tr key={authority.id}>
                      <td>
                        {authority.name}
                        <div className="meta mono">{authority.verificationMethod}</div>
                      </td>
                      <td className="meta">{authority.proves.join(", ")}</td>
                      <td className="meta" style={{ color: "var(--alert)" }}>
                        {/* Showing one side only is misread as full confirmation (05 §5.11). */}
                        {authority.doesNotProve.join(", ")}
                      </td>
                      <td>
                        <span
                          className="mono"
                          data-testid={`adapter-state-${authority.id}`}
                          style={{ color: adapterColor(authority.adapterState) }}
                        >
                          {authority.adapterState}
                        </span>
                        {authority.adapterStateReason ? (
                          <div className="meta">{authority.adapterStateReason}</div>
                        ) : null}
                      </td>
                      <td className="meta">{authority.nextAction ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="notice" style={{ color: "var(--alert)" }} data-testid="profile-limits">
            <div className="title">What this list does not promise</div>
            {profile.limitations.map((limitation) => (
              <div key={limitation}>{limitation}</div>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}

function adapterColor(state: string): string {
  if (state === "active") return "var(--positive)";
  if (state === "manual") return "var(--alert)";
  if (state === "blocked") return "var(--destructive-text)";
  return "var(--muted-foreground)";
}
