import Link from "next/link";

/**
 * Asset Registry public screen — spec 11 §11.2, OD-07.
 *
 * **This screen explains a feature that does not exist.** The Asset Registry is inactive, and
 * that state was written nowhere — with no item in public navigation,
 * "not built yet" and "deliberately blocked" are indistinguishable.
 *
 * **No trading path (OD-07).** No `subscriptions`, `orders`, or `transfers`
 * route exists, and this screen has no CTA in that direction. It lists the remaining gates
 * but never says "opening soon" — whether it opens has not been decided.
 *
 * Server component. There is nothing to fetch on this screen.
 */

/** Remaining gates. Each item names its basis decision — a list without basis becomes a roadmap. */
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
