import { PublicProjectDirectory } from "@/components/PublicProjectDirectory";
import { REQUIRED_BOUNDARY_COPY } from "@mpc/ui";

export default function PublicLandingPage() {
  return (
    <>
      <section className="public-directory-heading">
        <div>
          <h1>Verification Registry</h1>
          <p className="sub">
            Published project records, review scope and stated limitations.
          </p>
        </div>
      </section>

      <div className="directory-highlights" aria-label="Record contents">
        <span><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m2-13 2 2 3-3"/></svg>Review scope and limitations</span>
        <span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 3 13 13-5 5L3 8zM7 7l3 3m0-6 3 3m0 0 3 3m0 0 3 3"/></svg>Published status and version</span>
        <span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11a9 9 0 1 1 3 8M3 4v7h7m2-5v6l4 2"/></svg>Changes recorded over time</span>
      </div>
      <PublicProjectDirectory />
      <div className="public-directory-boundaries" data-testid="landing-boundaries">
        <p>{REQUIRED_BOUNDARY_COPY.verification} {REQUIRED_BOUNDARY_COPY.readiness}</p>
        <p className="meta">{REQUIRED_BOUNDARY_COPY.sourceStatus} {REQUIRED_BOUNDARY_COPY.proofResult}</p>
      </div>
      <details className="project-background">
        <summary>About these records</summary>
        <p>A published record states its review scope and limitations. Evidence readiness does not authorize a project to proceed. Integrity proofs show whether a record has changed, not whether its claims are true.</p>
        <p>Corrections and revocations remain visible alongside earlier versions. Open a project to inspect its published assessment, history and integrity proof.</p>
      </details>
    </>
  );
}
