"use client";

import Link from "next/link";
import { use, useRef, useState } from "react";
import { createUpload, newIdempotencyKey, type ObjectUpload } from "@/lib/api";
import { useSession } from "@/lib/session";
import { UPLOAD_ACCEPT } from "@/lib/uploads";
import {
  saveDocumentProfileWithRecovery,
  validateDocumentClassification,
} from "@/lib/document-profile-recovery";
import { ErrorNotice } from "@/components/ErrorNotice";

export default function RegisterEvidencePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { token, session } = useSession();
  const [file, setFile] = useState<File | null>(null);
  const [step, setStep] = useState(1);
  const [type, setType] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [uploaded, setUploaded] = useState<ObjectUpload | null>(null);
  const [done, setDone] = useState(false);
  const [reused, setReused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const key = useRef(newIdempotencyKey());
  const inFlight = useRef(false);
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const base = `/w/projects/${encodeURIComponent(id)}`;
  async function submit() {
    if (!file || !token || inFlight.current) return;
    let classification;
    try {
      classification = validateDocumentClassification({
        documentType: type.trim() || null,
        validUntil: validUntil || null,
      });
    } catch (invalid) {
      setValidation(
        invalid instanceof Error
          ? invalid.message
          : "Check the classification fields.",
      );
      return;
    }
    setValidation(null);
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      let saved = uploaded;
      if (!saved) {
        const result = await createUpload(token, id, file, key.current);
        saved = result;
        setUploaded(result);
        // Only the creator may apply this new form's classification automatically.
        // Older cached responses lack this evidence, so preserve those records too.
        if (result.reused !== false) {
          setReused(true);
          setStep(3);
          setDone(true);
          return;
        }
      }
      await saveDocumentProfileWithRecovery(
        token,
        id,
        saved,
        classification,
        attempt,
        setUploaded,
      );
      setStep(3);
      setDone(true);
    } catch (caught) {
      setError(caught);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  function renderProgress() {
    return (
      <ol className="registration-steps" aria-label="Registration progress">
        <li aria-current={step === 1 ? "step" : undefined}>1 · Choose file</li>
        <li aria-current={step === 2 ? "step" : undefined}>
          2 · Classify and upload
        </li>
        <li aria-current={done ? "step" : undefined}>3 · Link evidence</li>
      </ol>
    );
  }

  function renderErrors() {
    return <>
      {validation ? (
        <p className="notice" role="alert">
          {validation}
        </p>
      ) : null}
      {error ? <ErrorNotice error={error} /> : null}

    </>;
  }

  return (
    <>
      <Link href={`${base}/requirements`} className="meta">
        ← Requirements
      </Link>
      <div className="page-head">
        <div>
          <h1>Register evidence</h1>
          <p className="sub">
            Store a file privately, describe it and connect it to your evidence
            workflow.
          </p>
        </div>
      </div>
      {renderProgress()}
      {renderErrors()}
      {!session?.actions?.includes("source.upload") ? (
        <p className="notice">
          Your current session cannot upload evidence.{" "}
          <Link href={`${base}/access-requests`}>Request access →</Link>
        </p>
      ) : done && uploaded ? (
        <section className="panel">
          <h2>{reused ? "File already stored" : "File uploaded"}</h2>
          <p>
            {reused
              ? "This file is already stored. Its existing classification has been preserved. Open the document to review its status or explicitly edit its classification."
              : `${file?.name} is stored privately. It must pass malware scanning before it can support a claim. Uploading does not approve the evidence.`}
          </p>
          <div className="workflow-links">
            <Link href={`${base}/documents/${uploaded.id}`}>
              {reused ? "View existing document →" : "View file status and versions →"}
            </Link>
            <Link href={`${base}/data-room#catalog-claim-title`}>
              Link scanned evidence to a catalog claim →
            </Link>
          </div>
        </section>
      ) : step === 1 ? (
        <section className="panel registration-form">
          <h2>Add the file</h2>
          <p className="sub">
            Original evidence is private. Only an independently approved summary
            can be published.
          </p>
          <div className="file-dropzone">
            <label htmlFor="register-file">Choose a file</label>
            <input
              id="register-file"
              type="file"
              accept={UPLOAD_ACCEPT}
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                key.current = newIdempotencyKey();
              }}
            />
          </div>
          {file ? (
            <p>
              {file.name} · {file.size.toLocaleString("en")} bytes
            </p>
          ) : (
            <p className="meta">
              PDF, office documents, text, data files and supported images. The
              server validates file size and type.
            </p>
          )}
          <button
            type="button"
            className="primary"
            disabled={!file}
            onClick={() => setStep(2)}
          >
            Continue
          </button>
        </section>
      ) : (
        <form
          className="panel registration-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <h2>What is it?</h2>
          <p>{file?.name}</p>
          <div className="field">
            <label htmlFor="register-type">Document type</label>
            <input
              id="register-type"
              value={type}
              disabled={busy}
              maxLength={80}
              onChange={(event) => {
                setType(event.target.value);
                setValidation(null);
              }}
              placeholder="For example, exploration report"
            />
          </div>
          <div className="field">
            <label htmlFor="register-validity">Valid until (optional)</label>
            <input
              id="register-validity"
              type="date"
              value={validUntil}
              disabled={busy}
              onChange={(event) => {
                setValidUntil(event.target.value);
                setValidation(null);
              }}
            />
          </div>
          {uploaded ? (
            <p>
              <Link href={`${base}/documents/${uploaded.id}`}>
                Open the stored document →
              </Link>
            </p>
          ) : null}
          {uploaded ? (
            <p role="status">
              The file was uploaded. Correct or retry its classification without
              uploading again.
            </p>
          ) : null}
          <div className="row">
            <button
              type="button"
              disabled={busy || uploaded !== null}
              onClick={() => setStep(1)}
            >
              Back
            </button>
            <button className="primary" type="submit" disabled={busy}>
              {busy
                ? "Saving evidence…"
                : uploaded
                  ? "Retry classification"
                  : "Upload privately"}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
