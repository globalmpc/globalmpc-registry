"use client";

import { useState, type FormEvent } from "react";
import {
  createProjectParty,
  recordPartyConfirmation,
  type ProjectParty,
} from "@/lib/projects-api";
import { ErrorNotice } from "@/components/ErrorNotice";
import { ConfirmationBadge, ConfirmationForm, EvidenceText } from "./Confirmation";

/**
 * Project parties — spec 04 §4.2, 05 §5.6.
 *
 * A submitted party starts pending. Naming yourself as a party is a self-statement (05 §5.11);
 * confirming it takes a steward and evidence, so the two actions are separate controls.
 */

const ROLE_LABELS: Record<ProjectParty["partyRole"], string> = {
  sponsor_operator: "Sponsor / operator",
  host_country_spv: "Host-country SPV or rights holder",
  issuer: "Project-specific issuer",
};

export function PartiesPanel({
  token,
  projectId,
  parties,
  canSubmit,
  canConfirm,
  onChanged,
}: {
  readonly token: string;
  readonly projectId: string;
  readonly parties: readonly ProjectParty[];
  readonly canSubmit: boolean;
  readonly canConfirm: boolean;
  readonly onChanged: () => void;
}) {
  const [role, setRole] = useState<ProjectParty["partyRole"]>("sponsor_operator");
  const [legalName, setLegalName] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [confirming, setConfirming] = useState<string>("");
  const [error, setError] = useState<unknown>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await createProjectParty(token, projectId, {
        partyRole: role,
        legalName,
        jurisdiction: jurisdiction.trim() ? jurisdiction.trim().toUpperCase() : null,
      });
      setLegalName("");
      setError(null);
      onChanged();
    } catch (caught) {
      setError(caught);
    }
  }

  const target = parties.find((party) => party.id === confirming);

  return (
    <div className="panel" data-testid="project-parties">
      <h2>Parties</h2>
      {error ? <ErrorNotice error={error} /> : null}
      {parties.length === 0 ? (
        <p className="sub" style={{ margin: 0 }}>
          No party has been submitted. The sponsor, host-country SPV and issuer are unknown to this
          record, not absent from the project.
        </p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Role</th>
                <th scope="col">Legal name</th>
                <th scope="col">Jurisdiction</th>
                <th scope="col">Status</th>
                <th scope="col">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {parties.map((party) => (
                <tr key={party.id}>
                  <td>{ROLE_LABELS[party.partyRole]}</td>
                  <td>{party.legalName}</td>
                  <td className="mono">{party.jurisdiction ?? "—"}</td>
                  <td>
                    <ConfirmationBadge status={party.status} />
                  </td>
                  <td>
                    <EvidenceText evidence={party.evidence} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canSubmit ? (
        <details style={{ marginTop: 14 }}>
          <summary>Submit a party</summary>
          <form onSubmit={submit} style={{ maxWidth: 560, marginTop: 12 }}>
            <div className="field">
              <label htmlFor="party-role">Party role</label>
              <select
                id="party-role"
                value={role}
                onChange={(event) => setRole(event.target.value as ProjectParty["partyRole"])}
              >
                {Object.entries(ROLE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="party-name">Legal name</label>
              <input
                id="party-name"
                value={legalName}
                onChange={(event) => setLegalName(event.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="party-jurisdiction">Jurisdiction (ISO3, optional)</label>
              <input
                id="party-jurisdiction"
                className="mono"
                value={jurisdiction}
                maxLength={3}
                onChange={(event) => setJurisdiction(event.target.value)}
              />
            </div>
            <button type="submit">Submit party</button>
          </form>
        </details>
      ) : null}

      {canConfirm && parties.length > 0 ? (
        <details style={{ marginTop: 14 }}>
          <summary>Record a party&apos;s confirmation</summary>
          <div className="field" style={{ maxWidth: 560, marginTop: 12 }}>
            <label htmlFor="party-target">Party</label>
            <select
              id="party-target"
              value={confirming}
              onChange={(event) => setConfirming(event.target.value)}
            >
              <option value="">Choose a party</option>
              {parties.map((party) => (
                <option key={party.id} value={party.id}>
                  {`${ROLE_LABELS[party.partyRole]} · ${party.legalName}`}
                </option>
              ))}
            </select>
          </div>
          {target ? (
            <ConfirmationForm
              idPrefix="party"
              submitLabel="Record party status"
              onSubmit={async (input) => {
                try {
                  await recordPartyConfirmation(token, projectId, target.id, target.version, input);
                  setError(null);
                  onChanged();
                } catch (caught) {
                  setError(caught);
                }
              }}
            />
          ) : null}
        </details>
      ) : null}
    </div>
  );
}
