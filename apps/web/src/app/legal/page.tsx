import Link from "next/link";
import { REQUIRED_BOUNDARY_COPY } from "@mpc/ui";

/**
 * Terms, data handling, support — spec 12 §12.10 Legal track.
 *
 * **The formal terms and privacy policy are not written here.** Both are documents that only hold
 * after legal review (12 §12.10); posting unreviewed text under those titles makes readers
 * take it as a promise. Making a promise that cannot be kept is worse than having none.
 *
 * What is written here instead is **what the system actually does**. Every item below is enforced
 * by code or DB constraints and can be checked — so it can be stated as fact even before legal
 * review. The formal documents sit on top of it.
 *
 * Server component. Nothing to fetch.
 */

/** What the system enforces. Each item names where it can be checked. */
const ENFORCED = [
  {
    what: "Confidential, personal, and whistleblower-grade uploads are refused",
    how: "The upload route returns 422 for those sensitivity levels. There is no path that stores them, so there is nothing to disclose about how they are handled — they do not arrive.",
    basis: "OD-18 · unresolved",
  },
  {
    what: "Publishing is an allowlist, not a filter",
    how: "A field that is not on the public allowlist cannot enter a published record, whatever approval is given. Publication is irreversible, so the default is refusal.",
    basis: "05 §5.7 · AC-22",
  },
  {
    what: "Reviewers appear under a pseudonymous handle by default",
    how: "Natural-person names and registration numbers are not on the public allowlist. A published review names an organisation and a credential type, not a person.",
    basis: "05 §5.9 · AC-32",
  },
  {
    what: "Documents and personal data stay off-chain",
    how: "The chain holds a commitment to a published projection and its state history. No document, no personal data, and nothing confidential is written to it.",
    basis: "OD-41",
  },
  {
    what: "Records are corrected, not erased",
    how: "A published version stays readable after it is superseded or revoked, marked for what it is. An anchored commitment cannot be removed at all.",
    basis: "05 §5.7",
  },
] as const;

export default function LegalPage() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Terms, data handling, and support</h1>
          <p className="sub">
            What this service does with what you give it, stated as facts that can be checked
            against the running system.
          </p>
        </div>
        <Link href="/">← Public site</Link>
      </div>

      {/*
        What must be said first. If the text below is read as terms and real users are onboarded,
        from that point on it is as if this paragraph never existed.
      */}
      <div className="notice" style={{ color: "var(--alert)" }} data-testid="legal-status">
        <div className="title">There is no issued Terms of Service or Privacy Policy yet</div>
        Both require legal review before they mean anything, and that review has not happened. This
        page is not a substitute for either — it states what the system enforces today so that the
        formal documents can be written on top of facts rather than intentions.
        <div style={{ marginTop: 6 }}>
          Until they are issued, this service is not open to members of the public and must not be
          used to hold real personal data, real contracts, or anything a person would be harmed by
          losing.
        </div>
      </div>

      <div className="panel" data-testid="legal-enforced">
        <h2>What the system enforces today</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          Each row is a rule in code or a database constraint, not a statement of intent. If one
          stops being true, a test fails.
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Rule</th>
                <th>How it is enforced</th>
                <th>Basis</th>
              </tr>
            </thead>
            <tbody>
              {ENFORCED.map((row) => (
                <tr key={row.what}>
                  <td>{row.what}</td>
                  <td style={{ color: "var(--muted-foreground)" }}>{row.how}</td>
                  <td className="mono meta" style={{ whiteSpace: "nowrap" }}>
                    {row.basis}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2>What is not settled</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          Naming these is part of the answer. A policy that omits its open questions reads as
          complete when it is not.
        </p>
        <dl className="dl">
          <dt className="mono">Jurisdiction and storage</dt>
          <dd style={{ color: "var(--muted-foreground)" }}>
            Where records are stored and under whose law is provisionally resolved only (OD-17).
            Production deployment is blocked on it.
          </dd>
          <dt className="mono">Encryption key ownership</dt>
          <dd style={{ color: "var(--muted-foreground)" }}>
            Who holds the keys that would protect sensitive material, and whether a tenant can have
            its data made unreadable on request, is unresolved (OD-18). That is why sensitive
            uploads are refused rather than accepted and protected badly.
          </dd>
          <dt className="mono">Retention</dt>
          <dd style={{ color: "var(--muted-foreground)" }}>
            How long records are kept, and the recovery-point and recovery-time objectives behind
            that, have no agreed values (OD-32).
          </dd>
        </dl>
      </div>

      <div className="panel" data-testid="legal-support">
        <h2>Support and reporting</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          Three different things need three different paths. Sending all of them to one inbox means
          the urgent one waits behind the routine one.
        </p>
        <dl className="dl">
          <dt>A published record looks wrong</dt>
          <dd style={{ color: "var(--muted-foreground)" }}>
            Corrections and revocations are published rather than applied silently. Open the record
            in the <Link href="/explorer">Explorer</Link> and cite its version — the URL is stable
            across corrections — then raise it with the party named on the record.
          </dd>
          <dt>You cannot get in, or you lost a key</dt>
          <dd style={{ color: "var(--muted-foreground)" }}>
            A lost or compromised key is disabled and a new one bound by an administrator of your
            tenant. Past signatures are not removed by that — they stay, with the reason the key was
            disabled recorded alongside.
          </dd>
          <dt>A security problem</dt>
          <dd style={{ color: "var(--muted-foreground)" }}>
            Report it before disclosing it publicly. There is no bug bounty and no coordinated
            disclosure window agreed yet; that is itself an open item rather than a policy.
          </dd>
        </dl>
        <p className="meta" style={{ marginBottom: 0 }}>
          {/* Do not invent contact details. A nonexistent address makes reports vanish. */}
          Contact addresses are set per deployment and are not published in this repository. Ask the
          operator of the instance you are using.
        </p>
      </div>

      <div className="panel">
        <h2>Boundaries this service states everywhere</h2>
        <ul style={{ margin: 0, paddingLeft: 18, color: "var(--muted-foreground)" }}>
          {/* Boundary copy originates in `@mpc/ui`. It is not rewritten here. */}
          <li>{REQUIRED_BOUNDARY_COPY.verification.en}</li>
          <li>{REQUIRED_BOUNDARY_COPY.readiness.en}</li>
          <li>{REQUIRED_BOUNDARY_COPY.sourceStatus.en}</li>
          <li>{REQUIRED_BOUNDARY_COPY.proofResult.en}</li>
        </ul>
      </div>
    </>
  );
}
