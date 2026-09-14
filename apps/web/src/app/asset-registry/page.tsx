import Link from "next/link";

/**
 * Asset Registry 공개 화면 — spec 11 §11.2, OD-07.
 *
 * **이 화면의 일은 없는 기능을 설명하는 것이다.** Asset Registry는 비활성이고
 * 그 상태가 어디에도 적혀 있지 않았다 — 공개 navigation에 항목이 없으면
 * "아직 안 만들었다"와 "일부러 막아 두었다"가 구분되지 않는다.
 *
 * **거래 경로를 만들지 않는다(OD-07).** `subscriptions`·`orders`·`transfers`
 * route가 존재하지 않으며 이 화면도 그 방향의 CTA를 두지 않는다. 남은 gate를
 * 나열하되 "곧 열린다"고 말하지 않는다 — 열릴지 여부가 결정된 바 없다.
 *
 * 서버 컴포넌트다. 이 화면에는 조회할 것이 없다.
 */

/** 남은 gate. 각 항목은 근거 결정을 함께 적는다 — 근거 없는 목록은 로드맵이 된다. */
const GATES = [
  {
    gate: "Legal issuance decision",
    basis: "D-50 · R-03",
    body: "Whether an instrument may be offered at all is a legal decision taken outside this system. Data readiness does not stand in for it, and this service does not adjudicate it.",
  },
  {
    gate: "Jurisdiction and data custody (OD-17)",
    basis: "OD-17 · resolved_provisional",
    body: "Where records are stored and under whose law is provisionally resolved only. Production deployment is blocked on it, and an asset record would be the most sensitive thing stored.",
  },
  {
    gate: "Encryption key ownership (OD-18)",
    basis: "OD-18 · resolved_provisional",
    body: "Confidential, personal, and whistleblower material is refused at upload today. The secured path that would hold contract-grade evidence does not exist yet.",
  },
  {
    gate: "Regulated service providers",
    basis: "OD-38",
    body: "Custody, transfer agent, placement, and venue functions are performed by separately licensed entities under project-specific contracts. None is bound for any project in this registry.",
  },
  {
    gate: "Governance token and snapshots",
    basis: "OD-24",
    body: "No governance token is deployed and no archive node is available for snapshots, so weight-bearing decisions fall back to manual recording.",
  },
] as const;

export default function AssetRegistryPage() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Asset Registry</h1>
          <p className="sub">
            The Asset Registry is inactive. This page exists so that the reason is readable rather
            than inferred from an absence.
          </p>
        </div>
      </div>

      <div className="notice" style={{ color: "var(--alert)" }} data-testid="asset-registry-status">
        <div className="title">Inactive by decision, not by omission</div>
        No asset record has been published, and no path in this service creates, offers, transfers,
        or settles one. There are no subscription, order, or transfer endpoints to reach — they are
        not disabled behind a permission, they do not exist (OD-07).
      </div>

      <div className="panel">
        <h2>What has to be settled first</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          Each row names a gate and the decision it belongs to. None of these is scheduled here; a
          gate listed below is open, and listing it is not a statement that it will close.
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Gate</th>
                <th>Basis</th>
                <th>Why it blocks</th>
              </tr>
            </thead>
            <tbody>
              {GATES.map((row) => (
                <tr key={row.gate}>
                  <td style={{ whiteSpace: "nowrap" }}>{row.gate}</td>
                  <td className="mono meta" style={{ whiteSpace: "nowrap" }}>
                    {row.basis}
                  </td>
                  <td style={{ color: "var(--muted-foreground)" }}>{row.body}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2>What is available now</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          The evidence and review layers run today. They are what an asset record would eventually
          rest on, and they are readable without an account.
        </p>
        <ul style={{ margin: 0, paddingLeft: 18, color: "var(--muted-foreground)" }}>
          <li>
            <Link href="/explorer/projects">Project Registry</Link> — projects with a published
            record
          </li>
          <li>
            <Link href="/explorer/verifications">Verification Records</Link> — reviews with their
            stated scope and limits
          </li>
          <li>
            <Link href="/verify">Proof Verifier</Link> — check a published record&rsquo;s integrity
            yourself
          </li>
        </ul>
      </div>
    </>
  );
}
