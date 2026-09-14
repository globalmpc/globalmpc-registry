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
 * 독립 Proof Verifier — spec 11 §11.3 / AC-23.
 *
 * Explorer 안에서 증명 결과를 **보여주기만** 하던 것과 다른 화면이다. 서버가
 * `merkleVerified: true`를 보내면 그 화면은 그대로 옮겨 적었다. 그것은 검증이
 * 아니라 인용이다.
 *
 * 여기서는 **브라우저가 Merkle 경로를 다시 계산한다.** 서버가 보낸 판정 플래그를
 * 쓰지 않는다 — 서버를 믿지 않아도 되는 것이 증명의 목적이다.
 *
 * **여기서 확인되지 않는 것을 함께 적는다.** leaf는 공개 projection의
 * content hash 외에 `subjectId`·`policyVersion`·`schemaVersion`을 함께 묶는데
 * 그 셋은 공개 projection에 없다(05 §5.7 allowlist). 따라서 공개 데이터만으로
 * leaf 해시를 처음부터 다시 만들 수는 없다. 그 한계를 화면이 말한다 —
 * 말하지 않으면 사용자가 "전부 스스로 확인했다"고 믿는다.
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
      // 키로 들어오면 기록을 먼저 읽는다. 철회 여부는 증명이 아니라 기록이
      // 갖는 사실이고, 둘을 합쳐야 "포함됐으나 철회됐다"를 말할 수 있다.
      const record =
        mode === "key" ? await getPublicRegistryEntry(registryType, publicKey.trim()) : null;
      const target = record ? record.entryVersionId : versionId.trim();

      let proof: InclusionProof;
      try {
        proof = await getInclusionProof(target);
      } catch (caught) {
        // 아직 anchor되지 않은 것은 오류가 아니라 상태다. 둘을 같은 빨간
        // 상자로 그리면 "증명 실패"로 읽힌다.
        setOutcome({
          kind: "not-anchored",
          detail:
            caught instanceof Error
              ? caught.message
              : "No anchor batch contains this version yet.",
        });
        return;
      }

      // 서버의 `merkleVerified`를 쓰지 않는다. 같은 입력으로 여기서 다시 센다.
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
      // 정규화는 @mpc/canonical이 한다. 화면이 키를 정렬하면 서버와 다른
      // 바이트를 해싱하고, 그 불일치는 "위조"처럼 보인다.
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
          여기서 확인되는 것과 아닌 것을 붙여 둔다. content hash가 leaf 해시가
          아니라는 것을 말하지 않으면 "일치했다"가 포함 증명으로 읽힌다.
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
              철회는 증명의 실패가 아니다. 바이트는 그대로 포함돼 있고 그 기록이
              더 이상 유효하지 않을 뿐이다. 둘을 한 상자에 넣으면 구분이 사라진다.
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
