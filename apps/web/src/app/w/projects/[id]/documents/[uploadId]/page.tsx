"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createDocumentLink,
  createUpload,
  getDocumentGraph,
  getDocumentImpactPreview,
  newIdempotencyKey,
  removeDocumentLink,
  updateDocumentProfile,
  type DocumentGraph,
  type DocumentImpactPreview,
  type DocumentLink,
  type DocumentLinkKind,
  type ObjectUpload,
} from "@/lib/api";
import { useSession } from "@/lib/session";
import { ErrorNotice } from "@/components/ErrorNotice";
import { DocumentTree } from "@/components/DocumentTree";
import {
  KIND_EXPLANATION,
  KIND_LABEL,
  ORIGIN_LABEL,
  UNUSABLE_STATES,
  documentLabel,
  validityText,
} from "@/lib/documents";
import { PHOTO_ACCEPT, UPLOAD_ACCEPT } from "@/lib/uploads";

/**
 * One document and the documents it rests on.
 *
 * The list of document types is not settled, so relations cannot be inferred — the person
 * who knows the documents declares them here. The screen answers three questions: what does
 * this rest on, what rests on it, and what would need a second look if it changed.
 *
 * **Nothing here changes another document.** A new version flags what rests on this one; the
 * people who own those documents decide what to do.
 */
export default function DocumentPage({
  params,
}: {
  params: Promise<{ id: string; uploadId: string }>;
}) {
  const { id, uploadId } = use(params);
  const { token, loading: sessionLoading } = useSession();

  const [graph, setGraph] = useState<DocumentGraph | null>(null);
  const [preview, setPreview] = useState<DocumentImpactPreview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const [typeDraft, setTypeDraft] = useState("");
  const [validDraft, setValidDraft] = useState("");

  const [linkTarget, setLinkTarget] = useState("");
  const [direction, setDirection] = useState<"rests_on" | "rested_on_by">("rests_on");
  const [kind, setKind] = useState<DocumentLinkKind>("depends_on");
  const [linkNote, setLinkNote] = useState("");

  const [removeFor, setRemoveFor] = useState<DocumentLink | null>(null);
  const [removeReason, setRemoveReason] = useState("");

  const [versionFile, setVersionFile] = useState<File | null>(null);
  // Both pickers feed the one pending version. A file input keeps its own selection, so picking
  // on one clears the other — otherwise the page shows two files while only the last is uploaded.
  const versionFileInput = useRef<HTMLInputElement>(null);
  const versionPhotoInput = useRef<HTMLInputElement>(null);
  const [versionValid, setVersionValid] = useState("");
  const [created, setCreated] = useState<ObjectUpload | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const [graphData, previewData] = await Promise.all([
        getDocumentGraph(token, id),
        getDocumentImpactPreview(token, uploadId),
      ]);
      setGraph(graphData);
      setPreview(previewData);
      const self = graphData.nodes.find((node) => node.uploadId === uploadId);
      setTypeDraft(self?.documentType ?? "");
      setValidDraft(self?.validUntil ?? "");
      setError(null);
    } catch (caught) {
      setError(caught);
    }
  }, [token, id, uploadId]);

  useEffect(() => {
    if (!sessionLoading) void load();
  }, [load, sessionLoading]);

  async function step(action: (activeToken: string) => Promise<unknown>) {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await action(token);
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  const nodes = useMemo(
    () => new Map((graph?.nodes ?? []).map((node) => [node.uploadId, node])),
    [graph],
  );
  const self = nodes.get(uploadId);
  const restsOn = (graph?.links ?? []).filter((link) => link.downstreamUploadId === uploadId);
  const restedOnBy = (graph?.links ?? []).filter((link) => link.upstreamUploadId === uploadId);
  const knownTypes = [
    ...new Set(
      (graph?.nodes ?? [])
        .map((node) => node.documentType)
        .filter((value): value is string => value !== null),
    ),
  ].sort();
  // Only documents someone relies on now. A replaced version or a failed file would be refused.
  const candidates = (graph?.nodes ?? []).filter(
    (node) =>
      node.uploadId !== uploadId &&
      node.supersededByUploadId === null &&
      !UNUSABLE_STATES.has(node.state),
  );

  if (!sessionLoading && !token) {
    return (
      <p className="sub">
        No account is connected. <Link href="/">Connect an account →</Link>
      </p>
    );
  }

  const nextType = typeDraft.trim() === "" ? null : typeDraft.trim();
  const nextValid = validDraft === "" ? null : validDraft;
  const profileChanges: { documentType?: string | null; validUntil?: string | null } = {};
  if (self && nextType !== self.documentType) profileChanges.documentType = nextType;
  if (self && nextValid !== self.validUntil) profileChanges.validUntil = nextValid;
  const profileChanged = Object.keys(profileChanges).length > 0;

  const replaced = self?.supersededByUploadId ?? null;
  const usable = self ? !UNUSABLE_STATES.has(self.state) : false;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 data-testid="document-title">{documentLabel(self, uploadId)}</h1>
          <p className="sub">
            What this document rests on, what rests on it, and what would need a second look if it
            changed. Links are declared by people; nothing is inferred.
          </p>
        </div>
        <Link href={`/w/projects/${id}/data-room`}>← Data Room</Link>
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      {graph && !self ? (
        <p className="sub">This document is not in this project, or it is not visible to you.</p>
      ) : null}

      {replaced ? (
        <div className="notice" data-testid="document-replaced">
          <div className="title">A newer version replaced this document</div>
          Its links moved to the new version. This page is kept so the history stays readable.{" "}
          <Link href={`/w/projects/${id}/documents/${replaced}`}>Open the current version →</Link>
        </div>
      ) : null}

      {self?.supersedesUploadId ? (
        <p className="meta">
          This is a new version of{" "}
          <Link href={`/w/projects/${id}/documents/${self.supersedesUploadId}`}>
            {documentLabel(nodes.get(self.supersedesUploadId), self.supersedesUploadId)}
          </Link>
          {self.state === "promoted"
            ? "."
            : ". It takes effect once it passes the scan and is promoted."}
        </p>
      ) : null}

      {self ? (
        <div className="panel">
          <h2>Profile</h2>
          <dl className="kv" style={{ marginTop: 0 }}>
            <dt>State</dt>
            <dd className="mono">{self.state}</dd>
            <dt>Valid until</dt>
            <dd className="mono" data-testid="document-validity">
              {validityText(self.validUntil, self.daysUntilExpiry)}
            </dd>
            <dt>Open impacts</dt>
            <dd className="mono">{self.openImpactCount}</dd>
          </dl>

          <form
            className="row"
            style={{ alignItems: "flex-end", marginTop: 12 }}
            onSubmit={(event) => {
              event.preventDefault();
              void step((activeToken) =>
                updateDocumentProfile(
                  activeToken,
                  uploadId,
                  self.version,
                  profileChanges,
                  newIdempotencyKey(),
                ),
              );
            }}
          >
            <div className="field" style={{ marginBottom: 0, flex: 1, minWidth: 220 }}>
              <label htmlFor="document-type">Document type</label>
              <input
                id="document-type"
                list="document-types"
                maxLength={80}
                value={typeDraft}
                disabled={!usable}
                placeholder="e.g. Exploration license"
                onChange={(event) => setTypeDraft(event.target.value)}
              />
              {/* Suggest the words already in use, so one kind of document does not end up
                  under three spellings — type rules match on the text. */}
              <datalist id="document-types">
                {knownTypes.map((value) => (
                  <option key={value} value={value} />
                ))}
              </datalist>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="document-valid-until">Valid until</label>
              <input
                id="document-valid-until"
                type="date"
                value={validDraft}
                disabled={!usable}
                onChange={(event) => setValidDraft(event.target.value)}
              />
            </div>
            <button className="primary" type="submit" disabled={busy || !usable || !profileChanged}>
              Save profile
            </button>
          </form>
          <p className="meta" style={{ marginTop: 10 }}>
            The type is free text. Setting a type can add links from type rules an operator has
            declared. A validity date in the past flags this document and whatever rests on it at
            once.
          </p>
        </div>
      ) : null}

      <div className="panel">
        <h2>Rests on</h2>
        <LinkTable
          testId="rests-on-list"
          links={restsOn}
          otherEnd={(link) => link.upstreamUploadId}
          projectId={id}
          nodes={nodes}
          busy={busy}
          onRemove={setRemoveFor}
          empty="This document rests on no other document."
        />
      </div>

      <div className="panel">
        <h2>Rested on by</h2>
        <LinkTable
          testId="rested-on-by-list"
          links={restedOnBy}
          otherEnd={(link) => link.downstreamUploadId}
          projectId={id}
          nodes={nodes}
          busy={busy}
          onRemove={setRemoveFor}
          empty="No document rests on this one."
        />
      </div>

      {removeFor ? (
        <div className="panel">
          <h2>Remove a link</h2>
          <p className="sub" style={{ marginTop: 0 }}>
            The link stops carrying the next change. Impacts it already raised stay open — they
            were right when raised. The link is kept on record with your reason.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void step(async (activeToken) => {
                await removeDocumentLink(
                  activeToken,
                  removeFor.id,
                  removeReason.trim(),
                  newIdempotencyKey(),
                );
                setRemoveFor(null);
                setRemoveReason("");
              });
            }}
          >
            <div className="field">
              <label htmlFor="remove-reason">Why</label>
              <input
                id="remove-reason"
                value={removeReason}
                maxLength={500}
                onChange={(event) => setRemoveReason(event.target.value)}
              />
            </div>
            <button className="primary" type="submit" disabled={busy || removeReason.trim() === ""}>
              Remove link
            </button>{" "}
            <button type="button" onClick={() => setRemoveFor(null)}>
              Cancel
            </button>
          </form>
        </div>
      ) : null}

      {self && usable && !replaced ? (
        <div className="panel">
          <h2>Add a link</h2>
          {candidates.length === 0 ? (
            <p className="sub" style={{ margin: 0 }}>
              No other current document in this project to link to.
            </p>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const upstreamUploadId = direction === "rests_on" ? linkTarget : uploadId;
                const downstreamUploadId = direction === "rests_on" ? uploadId : linkTarget;
                void step(async (activeToken) => {
                  await createDocumentLink(
                    activeToken,
                    id,
                    {
                      upstreamUploadId,
                      downstreamUploadId,
                      kind,
                      note: linkNote.trim() === "" ? null : linkNote.trim(),
                    },
                    newIdempotencyKey(),
                  );
                  setLinkTarget("");
                  setLinkNote("");
                });
              }}
            >
              <div className="field">
                <label htmlFor="link-target">Other document</label>
                <select
                  id="link-target"
                  data-testid="link-target"
                  value={linkTarget}
                  onChange={(event) => setLinkTarget(event.target.value)}
                >
                  <option value="">Choose a document…</option>
                  {candidates.map((node) => (
                    <option key={node.uploadId} value={node.uploadId}>
                      {documentLabel(node, node.uploadId)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="link-direction">Direction</label>
                <select
                  id="link-direction"
                  value={direction}
                  onChange={(event) =>
                    setDirection(event.target.value as "rests_on" | "rested_on_by")
                  }
                >
                  <option value="rests_on">This document rests on the other one</option>
                  <option value="rested_on_by">The other document rests on this one</option>
                </select>
              </div>
              <fieldset className="field" style={{ border: 0, padding: 0 }}>
                <legend>Kind</legend>
                {(["depends_on", "references"] as const).map((option) => (
                  <label key={option} style={{ display: "block", margin: "4px 0" }}>
                    <input
                      type="radio"
                      name="link-kind"
                      value={option}
                      checked={kind === option}
                      onChange={() => setKind(option)}
                    />{" "}
                    {KIND_EXPLANATION[option]}
                  </label>
                ))}
              </fieldset>
              <div className="field">
                <label htmlFor="link-note">Note (optional)</label>
                <input
                  id="link-note"
                  value={linkNote}
                  maxLength={500}
                  onChange={(event) => setLinkNote(event.target.value)}
                />
              </div>
              <button className="primary" type="submit" disabled={busy || linkTarget === ""}>
                Add link
              </button>
            </form>
          )}
        </div>
      ) : null}

      <div className="panel">
        <h2>If this document changes</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          These documents would need a second look. A link that cites stops the change there; a
          link that rests on carries it further. This is a preview — nothing is recorded.
        </p>
        {preview && preview.items.length > 0 ? (
          <DocumentTree
            testId="impact-preview"
            rootId={uploadId}
            items={preview.items}
            renderItem={(item) => (
              <>
                <Link href={`/w/projects/${id}/documents/${item.uploadId}`}>
                  {documentLabel(nodes.get(item.uploadId), item.uploadId)}
                </Link>{" "}
                <span className="meta">— {KIND_LABEL[item.viaKind]} the document above</span>
              </>
            )}
          />
        ) : (
          <p className="sub" style={{ margin: 0 }} data-testid="impact-preview-empty">
            Nothing rests on this document, so a change here flags no other document.
          </p>
        )}
      </div>

      {self && usable && !replaced ? (
        <div className="panel">
          <h2>Upload a new version</h2>
          <p className="sub" style={{ marginTop: 0 }}>
            The new version goes through quarantine and the scan like any upload. It takes effect
            only once it is promoted in the Data Room — then this document&rsquo;s links move to it
            and the documents resting on this one are flagged for a second look.
          </p>
          <form
            className="row"
            style={{ alignItems: "flex-end" }}
            onSubmit={(event) => {
              event.preventDefault();
              if (!versionFile) return;
              const file = versionFile;
              void step(async (activeToken) => {
                const uploaded = await createUpload(activeToken, id, file, newIdempotencyKey());
                /**
                 * The server stores identical content once and hands back the existing upload.
                 * Marking that one as the new version would quietly turn an unrelated document
                 * into this document's successor, so stop here. A fresh upload is always in
                 * quarantine and not yet in this project's list.
                 */
                if (uploaded.state !== "quarantined" || nodes.has(uploaded.id)) {
                  throw new Error(
                    `This file is already in the Data Room as upload ${uploaded.id}. ` +
                      "Upload the revised file, or open that document and mark it as the new version there.",
                  );
                }
                const marked = await updateDocumentProfile(
                  activeToken,
                  uploaded.id,
                  uploaded.version,
                  {
                    supersedesUploadId: uploadId,
                    ...(self.documentType ? { documentType: self.documentType } : {}),
                    ...(versionValid ? { validUntil: versionValid } : {}),
                  },
                  newIdempotencyKey(),
                );
                setCreated(marked);
                setVersionFile(null);
                if (versionFileInput.current) versionFileInput.current.value = "";
                if (versionPhotoInput.current) versionPhotoInput.current.value = "";
                setVersionValid("");
              });
            }}
          >
            <div className="field" style={{ marginBottom: 0, flex: 1, minWidth: 220 }}>
              <label htmlFor="new-version-file">File</label>
              <input
                id="new-version-file"
                type="file"
                accept={UPLOAD_ACCEPT}
                data-testid="new-version-input"
                ref={versionFileInput}
                disabled={busy}
                onChange={(event) => {
                  if (versionPhotoInput.current) versionPhotoInput.current.value = "";
                  setVersionFile(event.target.files?.[0] ?? null);
                }}
              />
            </div>
            {/* A renewed permit is often photographed on site. The camera stays on its own input
                so the general picker still lets people attach a saved file. */}
            <div className="field" style={{ marginBottom: 0, flex: 1, minWidth: 220 }}>
              <label htmlFor="new-version-photo">Or take a photo</label>
              <input
                id="new-version-photo"
                type="file"
                accept={PHOTO_ACCEPT}
                capture="environment"
                data-testid="new-version-photo-input"
                ref={versionPhotoInput}
                disabled={busy}
                onChange={(event) => {
                  if (versionFileInput.current) versionFileInput.current.value = "";
                  setVersionFile(event.target.files?.[0] ?? null);
                }}
              />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="new-version-valid-until">New version valid until (optional)</label>
              <input
                id="new-version-valid-until"
                type="date"
                value={versionValid}
                onChange={(event) => setVersionValid(event.target.value)}
              />
            </div>
            <button className="primary" type="submit" disabled={busy || versionFile === null}>
              Upload new version
            </button>
          </form>
        </div>
      ) : null}

      {created ? (
        <div className="notice" data-testid="new-version-created">
          <div className="title">New version uploaded — waiting for the scan</div>
          Upload <span className="mono" data-testid="new-version-id">{created.id}</span> is in
          quarantine. It takes effect after the scan passes and it is promoted in the{" "}
          <Link href={`/w/projects/${id}/data-room`}>Data Room</Link>.
        </div>
      ) : null}
    </>
  );
}

function LinkTable({
  testId,
  links,
  otherEnd,
  projectId,
  nodes,
  busy,
  onRemove,
  empty,
}: {
  testId: string;
  links: DocumentLink[];
  otherEnd: (link: DocumentLink) => string;
  projectId: string;
  nodes: Map<string, import("@/lib/api").DocumentNode>;
  busy: boolean;
  onRemove: (link: DocumentLink) => void;
  empty: string;
}) {
  if (links.length === 0) {
    return (
      <p className="sub" style={{ margin: 0 }} data-testid={testId}>
        {empty}
      </p>
    );
  }

  return (
    <div className="table-scroll">
      <table data-testid={testId}>
        <thead>
          <tr>
            <th>Document</th>
            <th>Kind</th>
            <th>Made by</th>
            <th>Note</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {links.map((link) => {
            const other = otherEnd(link);
            return (
              <tr key={link.id}>
                <td>
                  <Link href={`/w/projects/${projectId}/documents/${other}`}>
                    {documentLabel(nodes.get(other), other)}
                  </Link>
                </td>
                <td className="mono meta">{KIND_LABEL[link.kind]}</td>
                <td className="meta">{ORIGIN_LABEL[link.origin]}</td>
                <td className="meta">{link.note ?? "—"}</td>
                <td>
                  <button disabled={busy} onClick={() => onRemove(link)}>
                    Remove
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
