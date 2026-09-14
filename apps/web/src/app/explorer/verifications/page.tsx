"use client";

import { PublicRegistryBrowser } from "@/components/PublicRegistryBrowser";

/**
 * Verification Registry 공개 목록 — spec 11 §11.2·§11.3.
 *
 * 검토 결과를 공개하는 목적은 "검토됐음"을 보이는 것이 아니라 **누가 어떤
 * authority 아래 어떤 범위로 무엇을 보았고 무엇을 보지 않았는지**를 보이는
 * 것이다(OD-40). 그래서 목록에 검토자 조직·credential 종류·결정 종류를 함께
 * 낸다 — 이름만 있는 목록은 "검토 완료"라는 인상만 남긴다.
 *
 * 검토자는 기본이 pseudonymous handle이다(AC-32). 자연인 이름은 공개 allowlist에
 * 없으므로 서버가 애초에 반환하지 않는다.
 */
export default function PublicVerificationsPage() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Verification Records</h1>
          <p className="sub">
            Published reviews with the scope and the limits each reviewer stated. A record here
            reports what was examined. It is not an assurance of outcome, and it does not transfer
            the reviewer&rsquo;s standing to anything outside the stated scope.
          </p>
        </div>
      </div>

      <div className="notice" style={{ color: "var(--alert)" }}>
        <div className="title">Reading a verification record</div>
        Open a record to see the scope, the limitations, and the authority behind it. Those three
        travel with the record at every level of detail — a shorter view drops explanation, never
        limits.
      </div>

      <PublicRegistryBrowser
        registryType="verification"
        hrefFor={(item) =>
          `/explorer?registryType=verification&publicKey=${encodeURIComponent(item.publicKey)}`
        }
        // 서버 검색(0034)이 보는 것은 key와 프로젝트 필드뿐이다. 검토 조직·결정으로
        // 찾는다고 적으면 빈 결과가 "그런 기록이 없다"로 읽힌다.
        searchPlaceholder="Verification key"
        emptyMessage="No verification record has been published yet. This is not a permission problem."
        columns={[
          { field: "reviewerOrganization", label: "Reviewer" },
          { field: "reviewerCredentialType", label: "Credential" },
          { field: "decisionType", label: "Decision" },
          { field: "verificationScope", label: "Scope" },
        ]}
      />
    </>
  );
}
