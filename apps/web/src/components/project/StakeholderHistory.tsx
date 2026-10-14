"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  createStakeholderEvent,
  listStakeholderEvents,
  type ConfirmationStatus,
  type EvidenceKind,
  type StakeholderEvent,
} from "@/lib/projects-api";
import { ErrorNotice } from "@/components/ErrorNotice";
import { ConfirmationBadge, EvidenceText } from "./Confirmation";

/**
 * Stakeholder and obligation event history — spec 12 §12.7.
 *
 * Restricted to the workspace. A corrected event stays listed and points to its correction:
 * a history that drops the old version cannot show what was believed at the time.
 */
export function StakeholderHistory({
  token,
  projectId,
  canRecord,
}: {
  readonly token: string;
  readonly projectId: string;
  readonly canRecord: boolean;
}) {
  const [events, setEvents] = useState<StakeholderEvent[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [category, setCategory] = useState<StakeholderEvent["category"]>("relationship");
  const [summary, setSummary] = useState("");
  const [occurredOn, setOccurredOn] = useState("");
  const [status, setStatus] = useState<ConfirmationStatus>("pending");
  const [kind, setKind] = useState<EvidenceKind>("source_receipt");
  const [evidenceId, setEvidenceId] = useState("");
  const [supersedesId, setSupersedesId] = useState("");

  const load = useCallback(() => {
    listStakeholderEvents(token, projectId)
      .then((page) => {
        setEvents(page.items);
      })
      .catch(setError);
  }, [token, projectId]);

  useEffect(load, [load]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await createStakeholderEvent(token, projectId, {
        category,
        summary,
        occurredOn,
        status,
        evidence: evidenceId.trim() ? { kind, id: evidenceId.trim() } : null,
        supersedesId: supersedesId || null,
      });
      setSummary("");
      setEvidenceId("");
      setSupersedesId("");
      setError(null);
      load();
    } catch (caught) {
      setError(caught);
    }
  }

  return (
    <div className="panel" data-testid="stakeholder-history">
      <h2>Stakeholder and obligation history</h2>
      <p className="sub" style={{ marginTop: 0 }}>
        Restricted to this workspace. Recording an event here does not publish it.
      </p>
      {error ? <ErrorNotice error={error} /> : null}
      {events === null ? (
        <p className="sub">Loading…</p>
      ) : events.length === 0 ? (
        <p className="sub" style={{ margin: 0 }}>
          No stakeholder or obligation event has been recorded.
        </p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Category</th>
                <th scope="col">Summary</th>
                <th scope="col">Status</th>
                <th scope="col">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {events.map((item) => (
                <tr key={item.id}>
                  <td className="mono">{item.occurredOn}</td>
                  <td>{item.category}</td>
                  <td>
                    {item.summary}
                    {item.supersededById ? (
                      <div className="meta">Corrected by a later entry</div>
                    ) : null}
                  </td>
                  <td>
                    <ConfirmationBadge status={item.status} />
                  </td>
                  <td>
                    <EvidenceText evidence={item.evidence} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canRecord ? (
        <details style={{ marginTop: 14 }}>
          <summary>Record an event</summary>
          <form onSubmit={submit} style={{ maxWidth: 560, marginTop: 12 }}>
            <div className="field">
              <label htmlFor="event-category">Category</label>
              <select
                id="event-category"
                value={category}
                onChange={(event) => setCategory(event.target.value as StakeholderEvent["category"])}
              >
                <option value="relationship">Relationship</option>
                <option value="consent">Consent</option>
                <option value="obligation">Obligation</option>
                <option value="dispute">Dispute</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="event-summary">Summary</label>
              <input
                id="event-summary"
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="event-date">Date of the event</label>
              <input
                id="event-date"
                type="date"
                value={occurredOn}
                onChange={(event) => setOccurredOn(event.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="event-status">Status</label>
              <select
                id="event-status"
                value={status}
                onChange={(event) => setStatus(event.target.value as ConfirmationStatus)}
              >
                <option value="pending">Pending</option>
                <option value="confirmed">Confirmed (requires evidence)</option>
                <option value="rejected">Rejected</option>
                <option value="not_applicable">Not applicable</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="event-evidence-kind">Evidence kind</label>
              <select
                id="event-evidence-kind"
                value={kind}
                onChange={(event) => setKind(event.target.value as EvidenceKind)}
              >
                <option value="source_receipt">Source receipt</option>
                <option value="upload">Uploaded document</option>
                <option value="attestation">Attestation</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="event-evidence">Evidence id</label>
              <input
                id="event-evidence"
                className="mono"
                value={evidenceId}
                onChange={(event) => setEvidenceId(event.target.value)}
                required={status === "confirmed"}
              />
            </div>
            <div className="field">
              <label htmlFor="event-supersedes">Corrects entry (optional)</label>
              <select
                id="event-supersedes"
                value={supersedesId}
                onChange={(event) => setSupersedesId(event.target.value)}
              >
                <option value="">None</option>
                {(events ?? [])
                  .filter((item) => item.supersededById === null)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {`${item.occurredOn} · ${item.summary}`}
                    </option>
                  ))}
              </select>
            </div>
            <button type="submit">Record event</button>
          </form>
        </details>
      ) : null}
    </div>
  );
}
