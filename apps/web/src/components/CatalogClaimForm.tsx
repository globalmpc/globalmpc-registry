"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { createClaim, newIdempotencyKey, type ObjectUpload } from "@/lib/api";
import { listClaimCatalog, type CatalogEntry } from "@/lib/evidence-ledger-api";
import { ErrorNotice } from "./ErrorNotice";

export function CatalogClaimForm({
  token,
  projectId,
  uploads,
  onSaved,
}: {
  readonly token: string;
  readonly projectId: string;
  readonly uploads: ObjectUpload[];
  readonly onSaved: () => Promise<void>;
}) {
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [entryId, setEntryId] = useState("");
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [documentId, setDocumentId] = useState("");
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [reference, setReference] = useState("");
  const [tier, setTier] = useState("");
  const [asOf, setAsOf] = useState("");
  const [dateError, setDateError] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const submissionKey = useRef(newIdempotencyKey());
  const inFlight = useRef(false);
  useEffect(() => {
    submissionKey.current = newIdempotencyKey();
  }, [entryId, values, documentId, reference, tier, asOf]);
  const entry = entries.find((item) => item.id === entryId);
  const eligibleUploads = uploads.filter(
    (upload) =>
      upload.revokedAt === null &&
      (upload.state === "scanned_clean" || upload.state === "promoted"),
  );
  useEffect(() => {
    let live = true;
    setLoaded(false);
    setEntries([]);
    setEntryId("");
    void listClaimCatalog(token)
      .then((result) => {
        if (live) {
          setEntries(result.items);
          setCursor(result.nextCursor);
          setLoaded(true);
          setError(null);
        }
      })
      .catch((caught: unknown) => {
        if (live) {
          setError(caught);
          setLoaded(true);
        }
      });
    return () => {
      live = false;
    };
  }, [token, projectId]);
  async function more() {
    if (!cursor) return;
    setBusy(true);
    try {
      const page = await listClaimCatalog(token, cursor);
      setEntries((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
      setError(null);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!entry || inFlight.current || reference.trim() === "") return;
    if (documentId && !eligibleUploads.some((upload) => upload.id === documentId)) {
      setDocumentError(
        "The selected document is no longer available. Choose another supporting document or no document.",
      );
      return;
    }
    setDocumentError(null);
    const today = new Date().toISOString().slice(0, 10);
    const parsedDate = new Date(`${asOf}T00:00:00Z`);
    if (
      asOf &&
      (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(asOf) ||
        asOf.startsWith("0000-") ||
        !Number.isFinite(parsedDate.getTime()) ||
        parsedDate.toISOString().slice(0, 10) !== asOf ||
        asOf > today)
    ) {
      setDateError("Choose a real claim date on or before today (UTC).");
      return;
    }
    setDateError(null);
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const structuredValues = Object.fromEntries(
        entry.definition.fields.flatMap((field) => {
          const value = values[field.key];
          return value === undefined || value === ""
            ? []
            : [[field.key, value]];
        }),
      );
      await createClaim(
        token,
        projectId,
        {
          claimType: entry.claimType,
          catalogEntryId: entry.id,
          structuredValues,
          valueText:
            entry.definition.fields
              .filter((field) => Object.hasOwn(structuredValues, field.key))
              .map(
                (field) =>
                  `${field.label}: ${String(structuredValues[field.key])}`,
              )
              .join("; ") || entry.displayName,
          sourceCoordinate: { document: reference.trim() },
          documentUploadIds: documentId ? [documentId] : [],
          evidenceTier: tier || null,
          asOf: asOf || null,
        },
        submissionKey.current,
      );
      setValues({});
      setDocumentId("");
      setReference("");
      setAsOf("");
      await onSaved();
    } catch (caught) {
      setError(caught);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="catalog-claim-title">
      <h3 id="catalog-claim-title">Record a catalog claim</h3>
      <p className="meta">
        Select an approved definition. Its version is pinned when saved;
        recording values does not verify them.
      </p>
      {error ? <ErrorNotice error={error} /> : null}
      {!loaded ? (
        <p role="status">Loading approved definitions…</p>
      ) : entries.length === 0 ? (
        <p>
          No approved, effective definitions available. Existing claims remain
          accessible below.
        </p>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          <div className="field">
            <label htmlFor="claim-catalog">Claim definition</label>
            <select
              id="claim-catalog"
              value={entryId}
              disabled={busy}
              required
              onChange={(event) => {
                setEntryId(event.target.value);
                setValues({});
              }}
            >
              <option value="">Select a definition</option>
              {entries.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.displayName} · v{item.catalogVersion}
                </option>
              ))}
            </select>
          </div>
          {cursor ? (
            <button type="button" disabled={busy} onClick={() => void more()}>
              Load more definitions
            </button>
          ) : null}
          {entry ? (
            <fieldset disabled={busy}>
              <legend>
                {entry.displayName} · catalog v{entry.catalogVersion}
              </legend>
              {entry.description ? <p>{entry.description}</p> : null}
              {entry.definition.fields.map((field) => (
                <div className="field" key={field.key}>
                  <label htmlFor={`claim-field-${field.key}`}>
                    {field.label}
                    {field.required ? " (required)" : " (optional)"}
                  </label>
                  {field.type === "boolean" ? (
                    <select
                      id={`claim-field-${field.key}`}
                      required={field.required}
                      value={
                        values[field.key] === undefined
                          ? ""
                          : String(values[field.key])
                      }
                      onChange={(event) =>
                        setValues((current) => ({
                          ...current,
                          [field.key]:
                            event.target.value === ""
                              ? ""
                              : event.target.value === "true",
                        }))
                      }
                    >
                      <option value="">Select a value</option>
                      <option value="true">Yes</option>
                      <option value="false">No</option>
                    </select>
                  ) : (
                    <input
                      id={`claim-field-${field.key}`}
                      required={field.required}
                      maxLength={4000}
                      type={field.type === "date" ? "date" : "text"}
                      inputMode={
                        field.type === "number" ? "decimal" : undefined
                      }
                      pattern={
                        field.type === "number"
                          ? /-?(0|[1-9][0-9]{0,77})(\.[0-9]{1,38})?/.source
                          : undefined
                      }
                      value={String(values[field.key] ?? "")}
                      onChange={(event) =>
                        setValues((current) => ({
                          ...current,
                          [field.key]: event.target.value,
                        }))
                      }
                    />
                  )}
                </div>
              ))}
              <div className="field">
                <label htmlFor="claim-as-of">Claim as-of date (optional)</label>
                <input
                  id="claim-as-of"
                  type="date"
                  min="0001-01-01"
                  max={new Date().toISOString().slice(0, 10)}
                  value={asOf}
                  aria-describedby="claim-as-of-help claim-as-of-error"
                  aria-invalid={dateError ? true : undefined}
                  onChange={(event) => {
                    setAsOf(event.target.value);
                    setDateError(null);
                  }}
                />
                <p id="claim-as-of-help" className="meta">
                  Date the claim describes, in UTC. Leave blank if unknown;
                  undated claims cannot satisfy freshness requirements.
                </p>
                <p id="claim-as-of-error" role={dateError ? "alert" : undefined}>
                  {dateError}
                </p>
              </div>
              <div className="field">
                <label htmlFor="claim-evidence-tier">Claim evidence tier</label>
                <select
                  id="claim-evidence-tier"
                  value={tier}
                  onChange={(event) => setTier(event.target.value)}
                >
                  <option value="">Not classified</option>
                  {["P1", "P2", "P3", "P4", "P5"].map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
                <p className="meta">
                  P1 is official registry or regulatory disclosure; P5 is an
                  unverified secondary citation. A tier does not imply
                  verification.
                </p>
              </div>
              <div className="field">
                <label htmlFor="claim-evidence-upload">
                  Claim supporting document
                </label>
                <select
                  id="claim-evidence-upload"
                  value={documentId}
                  onChange={(event) => {
                    setDocumentId(event.target.value);
                    setDocumentError(null);
                  }}
                >
                  <option value="">No document linked</option>
                  {documentId && !eligibleUploads.some((upload) => upload.id === documentId) ? (
                    <option value={documentId} disabled>Selected document unavailable</option>
                  ) : null}
                  {eligibleUploads.map((upload) => (
                      <option key={upload.id} value={upload.id}>
                        {upload.originalFilename ?? upload.id}
                      </option>
                    ))}
                </select>
                {documentError ? <p role="alert">{documentError}</p> : null}
              </div>
              <div className="field">
                <label htmlFor="claim-evidence-reference">
                  Claim source reference
                </label>
                <input
                  id="claim-evidence-reference"
                  required
                  maxLength={1000}
                  value={reference}
                  onChange={(event) => setReference(event.target.value)}
                  placeholder="Document and page or official source location"
                />
              </div>
              <button className="primary" type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save catalog claim"}
              </button>
            </fieldset>
          ) : null}
        </form>
      )}
    </section>
  );
}
