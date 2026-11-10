import Link from "next/link";

export default function HelpPage() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Help and support</h1>
          <p className="sub">Find the next step for your project work.</p>
        </div>
      </div>
      <div className="help-grid">
        <section className="panel">
          <h2>Getting started</h2>
          <p>
            Select a project, open Requirements and inspect the missing evidence
            or items needing another review.
          </p>
          <Link href="/w/projects">Choose a project →</Link>
        </section>
        <section className="panel">
          <h2>Evidence and reviews</h2>
          <p>
            Open Documents &amp; evidence to upload supporting files and record
            values. A successful upload is separate from a signed professional
            review.
          </p>
          <Link href="/w/work">See your assigned work →</Link>
        </section>
        <section className="panel">
          <h2>Impact and decisions</h2>
          <p>
            Changed or expired evidence can require another review. Check the
            affected records before making a new decision. Readiness is an input
            to that decision, not permission to proceed.
          </p>
          <Link href="/w/notifications">Check notifications →</Link>
        </section>
        <section className="panel">
          <h2>Account and access</h2>
          <p>
            Manage sign-in methods, second factors and signing wallets in
            Account settings. Project permissions require an administrator and
            an independent approval.
          </p>
          <Link href="/w/settings">Account settings →</Link>
          <p>
            <Link href="/w/access-requests">Request access →</Link>
          </p>
        </section>
      </div>
      <section className="panel">
        <h2>Report a problem</h2>
        <p>
          Keep the page address and the trace ID shown with an error. Do not
          include private files, recovery codes or signing keys in a support
          request.
        </p>
        <Link href="/legal">Support and data handling →</Link>
      </section>
    </>
  );
}
