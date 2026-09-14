"use client";

import { TxLink } from "@/components/TxLink";

import { useState } from "react";
import { hashProjection, verifyMerkleProof, type Hex } from "@mpc/canonical";
import {
  getInclusionProof,
  getPublicRegistryEntry,
  type InclusionProof,
  type PublicProjection,
} from "@/lib/api";
import { ErrorNotice } from "@/components/ErrorNotice";

/**
 * Independent Proof Verifier — spec 11 §11.3 / AC-23.
 *
 * A different screen from the one inside Explorer that only **displayed** proof results. When the server
 * sent `merkleVerified: true`, that screen copied it verbatim. That is quotation,
 * not verification.
 *
 * Here **the browser recomputes the Merkle path.** It does not use the verdict flag
 * the server sent — the point of a proof is not having to trust the server.
 *
 * **It also states what is not confirmed here.** Besides the public projection content hash,
 * the leaf binds `subjectId`, `policyVersion`, and `schemaVersion`, and
 * those three are not in the public projection (05 §5.7 allowlist). So public data alone
 * cannot rebuild the leaf hash from scratch. The screen states that limitation —
 * otherwise users believe they "verified everything themselves".
 */

type Outcome =
  | { readonly kind: "idle" }
  | { readonly kind: "not-anchored"; readonly detail: string }
  | {
      readonly kind: "checked";
      readonly proof: InclusionProof;
      readonly recomputed: boolean;
      readonly record: PublicProjection | null;
      readonly expectedLeafMatch: boolean | null;
    };

export default function ProofVerifierPage() {
  const [mode, setMode] = useState<"key" | "versionId">("key");
  const [registryType, setRegistryType] = useState("project");
  const [publicKey, setPublicKey] = useState("");
  const [versionId, setVersionId] = useState("");
  const [expectedLeaf, setExpectedLeaf] = useState("");
  const [fileHash, setFileHash] = useState<{ name: string; hash: string } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function check() {
    setBusy(true);
    setError(null);
    setOutcome({ kind: "idle" });
    try {
      // When entered by key, read the record first. Revocation is a fact held by the record, not the
      // proof, and both are needed to say "included but revoked".
      const record =
        mode === "key" ? await getPublicRegistryEntry(registryType, publicKey.trim()) : null;
      const target = record ? record.entryVersionId : versionId.trim();

      let proof: InclusionProof;
      try {
        proof = await getInclusionProof(target);
      } catch (caught) {
        // Not yet anchored is a state, not an error. Drawing both in the same red
        // box reads as "proof failed".
        setOutcome({
          kind: "not-anchored",
          detail:
            caught instanceof Error
              ? caught.message
              : "No anchor batch contains this version yet.",
        });
        return;
      }

      // Do not use the server `merkleVerified`. Recompute here from the same input.
      const recomputed = verifyMerkleProof(
        proof.leafHash as Hex,
        proof.proof as Hex[],
        proof.root as Hex,
      );

      const expected = expectedLeaf.trim().toLowerCase();
      setOutcome({
        kind: "checked",
        proof,
        recomputed,
        record,
        expectedLeafMatch: expected ? expected === proof.leafHash.toLowerCase() : null,
      });
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function readFile(file: File) {
    setFileError(null);
    setFileHash(null);
    try {
      const parsed: unknown = JSON.parse(await file.text());
      // @mpc/canonical does the normalization. If the screen sorts keys, it hashes bytes
      // different from the server, and that mismatch looks like "forgery".
      setFileHash({ name: file.name, hash: hashProjection(parsed as never) });
    } catch {
      setFileError("This file is not JSON we can canonicalise. Upload the published record JSON.");
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Proof Verifier</h1>
          <p className="sub">
            Check an integrity proof yourself. The Merkle path is recomputed in your browser from
            the values the server returned — the server&rsquo;s own verdict is not used.
          </p>
        </div>
      </div>

      <div className="panel">
        <div className="row" style={{ gap: 6, marginBottom: 14 }} data-testid="verify-mode">
          {(["key", "versionId"] as const).map((option) => (
            <button
              key={option}
              className={mode === option ? "primary" : undefined}
              aria-pressed={mode === option}
              onClick={() => setMode(option)}
            >
              {option === "key" ? "By registry key" : "By version id"}
            </button>
          ))}
        </div>

        <form
          className="row"
          style={{ alignItems: "flex-end" }}
          onSubmit={(event) => {
            event.preventDefault();
            void check();
          }}
        >
          {mode === "key" ? (
            <>
              <div className="field" style={{ marginBottom: 0, width: 160 }}>
                <label htmlFor="verify-registry">Registry</label>
                <select
                  id="verify-registry"
                  value={registryType}
                  onChange={(event) => setRegistryType(event.target.value)}
                >
                  <option value="project">project</option>
                  <option value="verification">verification</option>
                  <option value="asset">asset</option>
                </select>
              </div>
              <div className="field" style={{ marginBottom: 0, flex: 1, minWidth: 220 }}>
                <label htmlFor="verify-key">Public key</label>
                <input
                  id="verify-key"
                  className="mono"
                  value={publicKey}
                  onChange={(event) => setPublicKey(event.target.value)}
                />
              </div>
            </>
          ) : (
            <div className="field" style={{ marginBottom: 0, flex: 1, minWidth: 260 }}>
              <label htmlFor="verify-version">Entry version id</label>
              <input
                id="verify-version"
                className="mono"
                value={versionId}
                onChange={(event) => setVersionId(event.target.value)}
              />
            </div>
          )}
          <button
            className="primary"
            type="submit"
            disabled={busy || (mode === "key" ? !publicKey : !versionId)}
          >
            {busy ? "Checking…" : "Check proof"}
          </button>
        </form>

        <div className="field" style={{ marginTop: 14, marginBottom: 0 }}>
          <label htmlFor="verify-leaf">Expected leaf hash (optional)</label>
          <input
            id="verify-leaf"
            className="mono"
            value={expectedLeaf}
            placeholder="0x…"
            onChange={(event) => setExpectedLeaf(event.target.value)}
          />
          <p className="meta" style={{ margin: "4px 0 0" }}>
            If you kept a leaf hash from an earlier receipt, paste it and we will compare rather than
            asking you to read two hex strings side by side.
          </p>
        </div>
      </div>

      <div className="panel">
        <h2>Hash a saved record file</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          Upload a published record JSON to see its content hash. Nothing is uploaded — the file is
          read and hashed in this browser.
        </p>
        <input
          type="file"
          accept="application/json,.json"
          aria-label="Published record JSON"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void readFile(file);
          }}
        />
        {fileError ? (
          <p className="meta" style={{ color: "var(--destructive-text)" }} role="alert">
            {fileError}
          </p>
        ) : null}
        {fileHash ? (
          <dl className="dl" data-testid="file-hash">
            <dt>File</dt>
            <dd className="mono">{fileHash.name}</dd>
            <dt>Content hash</dt>
            <dd className="mono" style={{ wordBreak: "break-all" }}>
              {fileHash.hash}
            </dd>
          </dl>
        ) : null}
        {/*
          Keep what is and is not confirmed here side by side. Unless it says the content hash is not
          the leaf hash, "matched" reads as proof of inclusion.
        */}
        <p className="meta" style={{ marginBottom: 0 }}>
          A content hash is one input to the anchored leaf, not the leaf itself. The remaining
          inputs — subject id, policy version, and schema version — are not part of the public
          projection, so a matching content hash confirms the record bytes you hold, and inclusion is
          established by the Merkle check above.
        </p>
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      {outcome.kind === "not-anchored" ? (
        <div className="notice" style={{ color: "var(--alert)" }} data-testid="verify-not-anchored">
          <div className="title">No proof exists yet</div>
          An integrity proof exists only after a batch is built and submitted. This is not a failed
          check — there is nothing to check against.
          <div className="meta" style={{ marginTop: 6 }}>{outcome.detail}</div>
        </div>
      ) : null}

      {outcome.kind === "checked" ? (
        <>
          {outcome.record?.revokedAt ? (
            /*
              Revocation is not a proof failure. The bytes are still included; the record
              is simply no longer valid. Putting both in one box erases the distinction.
            */
            <div
              className="notice"
              style={{ color: "var(--destructive-text)" }}
              data-testid="verify-revoked"
            >
              <div className="title">This record has been revoked</div>
              The proof below still holds — the bytes were anchored and have not changed. What
              changed is the record&rsquo;s standing: it was withdrawn on{" "}
              <span className="mono">{outcome.record.revokedAt}</span>. Do not cite it as current.
            </div>
          ) : null}

          <div className="panel" data-testid="verify-result">
            <h2>Result</h2>
            <dl className="dl">
              <dt>Merkle path (recomputed here)</dt>
              <dd data-testid="verify-merkle">
                {outcome.recomputed ? (
                  <span style={{ color: "var(--positive)" }}>Matches the anchored root</span>
                ) : (
                  <span style={{ color: "var(--destructive-text)" }}>
                    Does not match — the leaf is not in this root
                  </span>
                )}
              </dd>
              <dt>Chain confirmation</dt>
              <dd className="mono">{outcome.proof.confirmationState}</dd>
              <dt>Inclusion confirmed</dt>
              <dd data-testid="verify-included">
                {outcome.proof.included ? (
                  <span style={{ color: "var(--positive)" }}>Confirmed</span>
                ) : (
                  <span style={{ color: "var(--alert)" }}>
                    Not confirmed yet — shown once the chain confirms
                  </span>
                )}
              </dd>
              {outcome.expectedLeafMatch !== null ? (
                <>
                  <dt>Your expected leaf hash</dt>
                  <dd data-testid="verify-expected">
                    {outcome.expectedLeafMatch ? (
                      <span style={{ color: "var(--positive)" }}>Same as the anchored leaf</span>
                    ) : (
                      <span style={{ color: "var(--destructive-text)" }}>
                        Different from the anchored leaf
                      </span>
                    )}
                  </dd>
                </>
              ) : null}
              <dt>Leaf hash</dt>
              <dd className="mono" style={{ wordBreak: "break-all" }}>
                {outcome.proof.leafHash}
              </dd>
              <dt>Root</dt>
              <dd className="mono" style={{ wordBreak: "break-all" }}>
                {outcome.proof.root}
              </dd>
              <dt>Transaction</dt>
              <dd>
                <TxLink chainId={outcome.proof.chainId} hash={outcome.proof.transactionHash} />
              </dd>
            </dl>

            <div className="row" style={{ marginTop: 14, alignItems: "flex-start", gap: 24 }}>
              <div style={{ flex: 1, minWidth: 240 }}>
                <h2 style={{ fontSize: 13 }}>What this confirms</h2>
                <ul style={{ margin: 0, paddingLeft: 18, color: "var(--positive)" }}>
                  {outcome.proof.proves.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
              <div style={{ flex: 1, minWidth: 240 }} data-testid="verify-disclaimer">
                <h2 style={{ fontSize: 13 }}>What it does not confirm</h2>
                <ul style={{ margin: 0, paddingLeft: 18, color: "var(--alert)" }}>
                  {outcome.proof.doesNotProve.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}
