import Link from "next/link";
import { REQUIRED_BOUNDARY_COPY } from "@mpc/ui";
import { PUBLIC_NAV } from "@/lib/copy";

/**
 * Public entry point — spec 11 §11.2.
 *
 * This spot used to hold the account connect screen. So the first thing someone unfamiliar with
 * the product met was "Connect your wallet", with nothing saying what it connects to. Sign-in is
 * one branch of the public surface, not its entrance — connect moved to `/connect`.
 *
 * **Keep description from becoming a claim.** This screen states what it confirms
 * and what it does not confirm with equal weight. Boundary copy originates in `@mpc/ui`
 * and is not rewritten here — if each screen words it differently, enforcing it means nothing.
 *
 * Server component. There is no reason to make an anonymous first visit wait for a client bundle
 * and a session lookup.
 */

/** The questions this product keeps apart — §11.1. None of the three vouches for another. */
const SEPARATIONS = [
  {
    left: "Integrity proof",
    right: "Factual truth",
    body: "An anchored proof confirms that a published record has not changed since it was anchored. It does not judge whether what the record says is true.",
  },
  {
    left: "Data readiness",
    right: "Human decision",
    body: "The readiness assessment reports whether the required evidence is present and current. Going ahead remains a decision a person records and signs for.",
  },
  {
    left: "Professional verification",
    right: "Guarantee",
    body: "A reviewer states a scope and its limits. A completed review is a record of what was examined, not an assurance of outcome.",
  },
  {
    left: "On-chain record",
    right: "Off-chain execution",
    body: "BNB Chain holds commitments to published projections and their state history. Documents, personal data, and anything confidential stay in controlled off-chain storage (OD-41).",
  },
] as const;

/** What can be viewed. The order belongs to `PUBLIC_NAV` — written in two places, it diverges. */
const NAV_BLURB: Record<string, string> = {
  "/explorer": "Browse published registry records and look one up by key.",
  "/explorer/verifications": "Verification Registry entries — who reviewed what, under which authority.",
  "/asset-registry": "Why the Asset Registry is inactive and which gates remain.",
  "/verify": "Check a proof yourself from a file or a leaf hash.",
  "/governance": "Protocol proposals and how each vote resolved.",
  "/disclosures": "Corrections, revocations, suspensions, pauses, and disputes over time.",
};

export default function PublicLandingPage() {
  return (
    <>
      <section className="hero">
        <div>
          <h1>Mining Compliance Evidence &amp; Registry Infrastructure</h1>
          <p className="sub">
            A public record of who reviewed which evidence, under whose authority, with what scope
            and what limits — and a way to check that the record has not changed since it was
            published.
          </p>
        </div>
        <Link href="/connect" className="btn-connect">
          Connect account →
        </Link>
      </section>

      {/*
        Put the boundary where it never collapses. Moved to the footer, it goes unread, and an unread
        warning is not a warning (§11.6).
      */}
      <div className="notice" style={{ color: "var(--alert)" }} data-testid="landing-boundaries">
        <div className="title">What this service does not do</div>
        <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
          <li>{REQUIRED_BOUNDARY_COPY.verification.en}</li>
          <li>{REQUIRED_BOUNDARY_COPY.readiness.en}</li>
          <li>{REQUIRED_BOUNDARY_COPY.sourceStatus.en}</li>
          <li>{REQUIRED_BOUNDARY_COPY.proofResult.en}</li>
        </ul>
      </div>

      <div className="panel" data-testid="landing-separations">
        <h2>Four things this service keeps apart</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          Most of the confusion in this domain comes from collapsing one of these pairs. Each row
          names both sides and says which one a record actually establishes.
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Establishes</th>
                <th>Does not establish</th>
                <th>Why they differ</th>
              </tr>
            </thead>
            <tbody>
              {SEPARATIONS.map((row) => (
                <tr key={row.left}>
                  <td style={{ color: "var(--positive)", whiteSpace: "nowrap" }}>{row.left}</td>
                  <td style={{ color: "var(--alert)", whiteSpace: "nowrap" }}>{row.right}</td>
                  <td style={{ color: "var(--muted-foreground)" }}>{row.body}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel" data-testid="landing-public-surface">
        <h2>Open without an account</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          Everything below is readable without signing in. Signing in adds the workspace where
          evidence is submitted and reviewed; it does not unlock a different set of published facts.
        </p>
        <dl className="dl">
          {PUBLIC_NAV.map((entry) => (
            <div key={entry.href} style={{ display: "contents" }}>
              <dt>
                <Link href={entry.href}>{entry.label}</Link>
              </dt>
              <dd style={{ color: "var(--muted-foreground)" }}>{NAV_BLURB[entry.href]}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="panel">
        <h2>What a published record contains</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          A record names its status, the version you are reading, the date the underlying source was
          current, the scope of the authority behind it, and the limits of that review. Those five
          stay visible at every level of detail — a shorter view shows less explanation, never fewer
          limits.
        </p>
        <p className="meta" style={{ marginBottom: 0 }}>
          Corrections and revocations are published alongside the record rather than replacing it.
          An earlier version stays reachable, marked for what it is.
        </p>
      </div>
    </>
  );
}
