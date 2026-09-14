"use client";

import { useEffect, useState } from "react";
import { TxLink } from "@/components/TxLink";
import {
  getInclusionProof,
  type InclusionProof,
  type PublicProjection,
} from "@/lib/api";
import { project, type RecordDepth, type RecordView } from "@mpc/ui";

/**
 * 게시된 공개 기록 하나 — spec 11 §11.3·§11.10 / AC-26.
 *
 * Explorer 검색 결과와 공유 가능한 프로젝트 URL(`/explorer/projects/[key]`)이
 * 같은 것을 보여야 한다. 두 화면이 각자 그리면 한쪽에서만 limitations가 빠지는
 * 일이 생기고, 그것은 눈으로 잡히지 않는다.
 *
 * 두 질문을 분리해 표시하는 것이 이 컴포넌트의 핵심이다(08 §8.11).
 *
 * 1. 이 공개 version이 해당 batch에 포함됐는가 — Merkle proof와 체인 확정
 * 2. 이 출처·검토자가 그 판단에 적합한 authority였는가 — 오프체인 Registry
 *
 * 1번의 성공은 2번을 보증하지 않는다.
 */
export function PublicRecord({ entry }: { readonly entry: PublicProjection }) {
  const [proof, setProof] = useState<InclusionProof | null>(null);
  const [depth, setDepth] = useState<RecordDepth>("basic");

  // proof는 아직 anchor되지 않았을 수 있다. 없는 것이 오류가 아니므로 조회
  // 실패를 화면 오류로 올리지 않고 "아직 없음"으로 말한다.
  useEffect(() => {
    let live = true;
    setProof(null);
    void getInclusionProof(entry.entryVersionId)
      .then((found) => {
        if (live) setProof(found);
      })
      .catch(() => {
        if (live) setProof(null);
      });
    return () => {
      live = false;
    };
  }, [entry.entryVersionId]);

  const view = toRecordView(entry, proof);
  // 깊이별 필드 선택은 @mpc/ui가 한다. 화면이 직접 고르면 어느 깊이에선가
  // limitations가 빠진다(AC-26).
  const shown = project(view, depth) as Record<string, unknown>;

  return (
      <>
        <div className="panel">
          <div className="page-head" style={{ marginBottom: 14 }}>
            <h2 style={{ margin: 0 }}>Published record</h2>
            {/*
              3깊이 레코드 뷰 — §11.10 / AC-26.

              깊이는 **더 보여줄 뿐 덜 보여주지 않는다.** status·as-of·version·
              limitations·authority scope는 어느 깊이에서도 그대로 있다. 그래야
              "간단히 보기"에서 읽은 상태와 "자세히 보기"에서 읽은 상태가
              갈리지 않는다.
            */}
            <div className="row" style={{ gap: 6 }} data-testid="depth-switch">
              {(["basic", "explanation", "expert"] as const).map((option) => (
                <button
                  key={option}
                  data-testid={`depth-${option}`}
                  className={depth === option ? "primary" : undefined}
                  aria-pressed={depth === option}
                  onClick={() => setDepth(option)}
                >
                  {DEPTH_LABEL[option]}
                </button>
              ))}
            </div>
          </div>

          {/* 어느 깊이에서도 접히지 않는 사실. */}
          <dl className="dl" data-testid="shared-facts">
            <dt>Status</dt>
            <dd className="mono" data-testid="shared-status">
              {view.shared.status}
            </dd>
            <dt>Version</dt>
            <dd className="mono" data-testid="shared-version">
              {view.shared.version}
            </dd>
            <dt>As of</dt>
            <dd className="mono" data-testid="shared-as-of">
              {view.shared.asOf}
            </dd>
            <dt>Legal effect</dt>
            <dd className="mono">{String(entry.legalEffect)}</dd>
            {entry.revokedAt ? (
              <>
                <dt>Revoked at</dt>
                <dd className="mono" style={{ color: "var(--destructive-text)" }}>
                  {entry.revokedAt}
                </dd>
              </>
            ) : null}
          </dl>

          <h2 style={{ marginTop: 18 }}>Authority scope</h2>
          <ul
            style={{ margin: 0, paddingLeft: 18, color: "var(--muted-foreground)" }}
            data-testid="shared-authority-scope"
          >
            {view.shared.authorityScope.length > 0 ? (
              view.shared.authorityScope.map((scope) => <li key={scope}>{scope}</li>)
            ) : (
              <li>The published record states no authority scope.</li>
            )}
          </ul>

          <h2 style={{ marginTop: 18 }}>Limits of this review</h2>
          <ul
            style={{ margin: 0, paddingLeft: 18, color: "var(--muted-foreground)" }}
            data-testid="shared-limitations"
          >
            {view.shared.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>

          {"proves" in shown ? (
            <div data-testid="explanation-layer">
              <div className="row" style={{ marginTop: 18, alignItems: "flex-start", gap: 24 }}>
                <div style={{ flex: 1, minWidth: 240 }}>
                  <h2 style={{ fontSize: 13 }}>What this authority establishes</h2>
                  <ul style={{ margin: 0, paddingLeft: 18, color: "var(--positive)" }}>
                    {view.explanation.proves.length > 0 ? (
                      view.explanation.proves.map((item) => <li key={item}>{item}</li>)
                    ) : (
                      <li>Nothing has been anchored for this version yet.</li>
                    )}
                  </ul>
                </div>
                <div style={{ flex: 1, minWidth: 240 }}>
                  <h2 style={{ fontSize: 13 }}>What it does not establish</h2>
                  <ul style={{ margin: 0, paddingLeft: 18, color: "var(--alert)" }}>
                    {view.explanation.doesNotProve.length > 0 ? (
                      view.explanation.doesNotProve.map((item) => <li key={item}>{item}</li>)
                    ) : (
                      <li>Factual accuracy, reviewer standing, and legal effect.</li>
                    )}
                  </ul>
                </div>
              </div>
              <p className="meta" style={{ marginTop: 12 }}>
                {view.explanation.freshnessExplanation}
              </p>
            </div>
          ) : null}

          {"rawHashReference" in shown ? (
            <div data-testid="expert-layer">
              <h2 style={{ marginTop: 18 }}>Receipt and integrity detail</h2>
              <dl className="dl">
                <dt>Record ID</dt>
                <dd className="mono" style={{ wordBreak: "break-all" }}>
                  {view.shared.recordId}
                </dd>
                <dt>Authority</dt>
                <dd className="mono">{view.expert.authorityId}</dd>
                <dt>Query or document</dt>
                <dd className="mono" style={{ wordBreak: "break-all" }}>
                  {view.expert.queryOrDocumentReference}
                </dd>
                <dt>Received at</dt>
                <dd className="mono">{view.expert.receivedAt}</dd>
                <dt>Leaf hash</dt>
                <dd className="mono" style={{ wordBreak: "break-all" }}>
                  {view.expert.rawHashReference}
                </dd>
                <dt>Source schema version</dt>
                <dd className="mono">{view.expert.sourceSchemaVersion}</dd>
                <dt>Adapter version</dt>
                <dd className="mono">{view.expert.adapterVersion}</dd>
                <dt>Policy version</dt>
                <dd className="mono">{view.expert.policyVersion ?? "—"}</dd>
                <dt>Merkle path</dt>
                <dd className="mono" style={{ wordBreak: "break-all" }}>
                  {view.expert.merklePath?.length
                    ? view.expert.merklePath.join(" · ")
                    : "Not anchored yet"}
                </dd>
                <dt>Transaction</dt>
                <dd>
                  <TxLink chainId={proof?.chainId ?? null} hash={view.expert.transactionHash ?? null} />
                </dd>
              </dl>
            </div>
          ) : null}
        </div>

        {entry.history.length > 0 ? (
          <div className="panel">
            <h2>Earlier versions</h2>
            {/* 정정·철회 이력을 감추지 않는다. 과거 상태를 최신처럼 보이게
                하지 않는 것과 같은 이유다(§11.6). */}
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Version</th>
                    <th>Status</th>
                    <th>ID</th>
                  </tr>
                </thead>
                <tbody>
                  {entry.history.map((version) => (
                    <tr key={version.entryVersionId}>
                      <td className="mono">v{version.version}</td>
                      <td className="mono">{version.status}</td>
                      <td className="mono meta">{version.entryVersionId}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        <div className="panel" data-testid="proof-panel">
          <h2>Integrity proof</h2>
          {proof ? (
            <>
              <dl className="dl">
                <dt>Merkle check</dt>
                <dd>
                  {proof.merkleVerified ? (
                    <span style={{ color: "var(--positive)" }}>Path matches</span>
                  ) : (
                    <span style={{ color: "var(--destructive-text)" }}>Does not match</span>
                  )}
                </dd>
                <dt>Chain confirmation state</dt>
                <dd className="mono">{proof.confirmationState}</dd>
                <dt>Inclusion confirmed</dt>
                <dd data-testid="proof-included">
                  {proof.included ? (
                    <span style={{ color: "var(--positive)" }}>Confirmed</span>
                  ) : (
                    // included는 confirmed일 때만 참이다. 그 전에는 아직
                    // 확정되지 않았다(06 §6.8 hidden success 금지).
                    <span style={{ color: "var(--alert)" }}>
                      Not confirmed yet — shown once the chain confirms
                    </span>
                  )}
                </dd>
                <dt>root</dt>
                <dd className="mono" style={{ wordBreak: "break-all" }}>
                  {proof.root}
                </dd>
                <dt>Transaction</dt>
                <dd>
                  <TxLink chainId={proof.chainId} hash={proof.transactionHash} />
                </dd>
              </dl>

              <div className="row" style={{ marginTop: 14, alignItems: "flex-start", gap: 24 }}>
                <div style={{ flex: 1, minWidth: 240 }}>
                  <h2 style={{ fontSize: 13 }}>What this proof confirms</h2>
                  <ul style={{ margin: 0, paddingLeft: 18, color: "var(--positive)" }}>
                    {proof.proves.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
                <div style={{ flex: 1, minWidth: 240 }} data-testid="proof-disclaimer">
                  <h2 style={{ fontSize: 13 }}>What it does not confirm</h2>
                  <ul style={{ margin: 0, paddingLeft: 18, color: "var(--alert)" }}>
                    {proof.doesNotProve.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </>
          ) : (
            <p className="sub" style={{ margin: 0 }}>
              Not anchored yet. An integrity proof exists only after a batch is built.
            </p>
          )}
        </div>

        <div className="notice" style={{ color: "var(--alert)" }}>
          <div className="title">Integrity and authority are different questions</div>
          The proof confirms that this record has not changed. It does not judge whether the
          source is factually accurate or whether the reviewer was qualified. Those are
          established on separate grounds.
        </div>
      </>
  );
}

const DEPTH_LABEL: Record<RecordDepth, string> = {
  basic: "Basic",
  explanation: "Explanation",
  expert: "Expert",
};

/** 공개 projection의 선택 필드. `.strict()` allowlist 안에서만 읽는다. */
function optionalString(entry: PublicProjection, key: string): string | null {
  const value = entry[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalStrings(entry: PublicProjection, key: string): readonly string[] {
  const value = entry[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * 공개 응답을 3깊이 뷰로 옮긴다.
 *
 * **없는 값을 만들어 채우지 않는다.** anchor 전이면 merkle path와 트랜잭션이
 * 없고, 화면은 그것을 "아직 없음"으로 말한다 — 빈 자리를 그럴듯한 값으로 메우면
 * Expert 깊이가 근거가 아니라 장식이 된다.
 */
function toRecordView(entry: PublicProjection, proof: InclusionProof | null): RecordView {
  const asOf = entry.publishedAt ?? optionalString(entry, "asOf") ?? "—";
  const staleStatus = optionalString(entry, "staleStatus");
  const sourceAge = optionalString(entry, "sourceAge");

  return {
    shared: {
  recordId: entry.entryVersionId,
  version: `v${entry.version}`,
  status: entry.status,
  asOf,
  limitations: entry.limitations,
  authorityScope: optionalStrings(entry, "authorityScope"),
    },
    explanation: {
  proves: proof ? proof.proves : [],
  doesNotProve: proof ? proof.doesNotProve : [],
  freshnessExplanation: staleStatus
    ? `Source freshness: ${staleStatus}${sourceAge ? ` · age ${sourceAge}` : ""}. As of ${asOf}.`
    : `As of ${asOf}. The published record states no freshness status.`,
    },
    expert: {
  authorityId: optionalString(entry, "authorityType") ?? "—",
  queryOrDocumentReference: proof ? `batch ${proof.batchId}` : "—",
  receivedAt: entry.publishedAt ?? "—",
  rawHashReference: proof?.leafHash ?? "—",
  // 공개 projection allowlist에 없는 값이다. 비슷한 필드를 대신 넣지 않는다.
  sourceSchemaVersion: "—",
  adapterVersion: "—",
  signature: null,
  attestationVersion: null,
  policyVersion: null,
  merklePath: proof ? proof.proof : null,
  transactionHash: proof?.transactionHash ?? null,
    },
  };
}
