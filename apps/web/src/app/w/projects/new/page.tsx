"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  createProject,
  listOrganizations,
  newIdempotencyKey,
  type OrganizationOption,
} from "@/lib/api";
import { useSession } from "@/lib/session";
import { ErrorNotice } from "@/components/ErrorNotice";

/**
 * Project registration.
 *
 * The owner organization comes from `GET /api/v1/organizations`, which applies the same rule
 * as project creation: a party role sees its own organization, a tenant operations role sees
 * every organization in the tenant. One option is preselected; with several, the choice is left
 * to the person — registering under the wrong organization makes another company a party.
 */
export default function NewProjectPage() {
  const { token } = useSession();
  const router = useRouter();

  const [projectKey, setProjectKey] = useState("");
  const [name, setName] = useState("");
  const [hostCountry, setHostCountry] = useState("MNG");
  const [minerals, setMinerals] = useState("copper");
  const [organizations, setOrganizations] = useState<OrganizationOption[] | null>(null);
  const [ownerOrganizationId, setOwnerOrganizationId] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);
  // Keep one key per form instance. If the user clicks submit twice,
  // the same key is sent and the server blocks the duplicate (07 §7.1).
  const [idempotencyKey] = useState(() => newIdempotencyKey());

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    listOrganizations(token)
      .then((page) => {
        if (cancelled) return;
        setOrganizations(page.items);
        setOwnerOrganizationId(page.items.length === 1 ? page.items[0]!.id : "");
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        // A 403 here carries the required roles — shown before the form is filled in.
        setOrganizations([]);
        setError(caught);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (!token) {
    return <p className="sub">No account is connected.</p>;
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!token || ownerOrganizationId === "") return;

    setSubmitting(true);
    setError(null);
    try {
      const created = await createProject(
        token,
        {
          projectKey: projectKey.trim(),
          name: name.trim(),
          hostCountryIso3: hostCountry.trim().toUpperCase(),
          minerals: minerals
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
          ownerOrganizationId,
        },
        idempotencyKey,
      );
      router.push(`/w/projects/${created.id}`);
    } catch (caught) {
      setError(caught);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>New project</h1>
          <p className="sub">
            Registration starts in <span className="mono">draft</span>. Items such as rights,
            issuer, and SPV stay <span className="mono">pending</span> until their evidence is
            confirmed.
          </p>
        </div>
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      <form className="panel" onSubmit={submit} style={{ maxWidth: 560 }}>
        <div className="field">
          <label htmlFor="projectKey">Project key</label>
          <input
            id="projectKey"
            className="mono"
            value={projectKey}
            onChange={(event) => setProjectKey(event.target.value)}
            placeholder="SYNTH-PROJECT-003"
            required
            maxLength={64}
          />
        </div>

        <div className="field">
          <label htmlFor="name">Name</label>
          <input
            id="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Project name"
            required
          />
        </div>

        <div className="field">
          <label htmlFor="hostCountry">Host country (ISO3)</label>
          <input
            id="hostCountry"
            className="mono"
            value={hostCountry}
            onChange={(event) => setHostCountry(event.target.value)}
            maxLength={3}
            minLength={3}
            required
          />
        </div>

        <div className="field">
          <label htmlFor="minerals">Minerals (comma separated)</label>
          <input
            id="minerals"
            value={minerals}
            onChange={(event) => setMinerals(event.target.value)}
            placeholder="copper, gold"
          />
        </div>

        <div className="field">
          <label htmlFor="ownerOrganization">Owning organization</label>
          <select
            id="ownerOrganization"
            value={ownerOrganizationId}
            onChange={(event) => setOwnerOrganizationId(event.target.value)}
            disabled={organizations === null || organizations.length === 0}
            required
          >
            {organizations === null ? <option value="">Loading…</option> : null}
            {organizations !== null && organizations.length !== 1 ? (
              <option value="">
                {organizations.length === 0 ? "No organization available" : "Choose an organization"}
              </option>
            ) : null}
            {(organizations ?? []).map((organization) => (
              <option key={organization.id} value={organization.id}>
                {`${organization.legalName} · ${organization.jurisdiction}`}
              </option>
            ))}
          </select>
          <div className="meta mono" data-testid="owner-organization-id">
            {ownerOrganizationId || "—"}
          </div>
        </div>

        <div className="row">
          <button
            type="submit"
            className="primary"
            disabled={submitting || ownerOrganizationId === ""}
          >
            {submitting ? "Registering…" : "Register"}
          </button>
          <span className="meta">
            Idempotency-Key <span className="mono">{idempotencyKey.slice(0, 12)}…</span>
          </span>
        </div>
      </form>

      <p className="meta">
        On success the audit event and the outbox event are written in the same transaction. On
        failure neither remains.
      </p>
    </>
  );
}
