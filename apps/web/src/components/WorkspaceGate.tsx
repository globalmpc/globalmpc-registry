"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { COPY } from "@/lib/copy";
import { useSession } from "@/lib/session";
import { Address } from "@/components/Address";

/**
 * One screen first separates the three states before entering the workspace.
 *
 * 1. Reading the session — calls nothing.
 * 2. Not signed in — connect guidance.
 * 3. Signed in, but the wallet is not bound to an organization (tenant) — waiting-for-link guidance.
 *
 * Previously each screen called the API even in state 3, and every screen showed
 * `401 UNAUTHENTICATED`. "Authentication required" is wrong for someone who just signed, and re-signing gives the same.
 * State 3 is not an error but **a state with no seat yet**, so it is guidance, not an error box.
 *
 * No role or outside the project (403) is not blocked here. What is missing differs
 * per screen, and `ErrorNotice` shows the required role and the request path.
 */
/**
 * The screen blocked people land on — 11 §11.7.
 *
 * Even when not signed in or the wallet is unbound, it must be possible to read what is missing.
 * If the gate also covers this screen, someone following a rejection notice meets yet another notice.
 */
function isAccessRequestPath(pathname: string): boolean {
  return (
    pathname === "/w/access-requests" ||
    pathname === "/w/identity/upgrade" ||
    /^\/w\/projects\/[^/]+\/access-requests$/.test(pathname)
  );
}

export function WorkspaceGate({ children }: { readonly children: React.ReactNode }) {
  const { session, loading } = useSession();
  const pathname = usePathname();

  if (isAccessRequestPath(pathname)) return <>{children}</>;

  if (loading) {
    return <p className="sub">Loading your session…</p>;
  }

  if (!session?.authenticated) {
    return (
      <div className="panel" data-testid="workspace-signed-out">
        <h1>Connect your wallet to open the workspace</h1>
        <p className="sub">
          {COPY.session.required} Published records stay open without an account —{" "}
          <Link href="/explorer">browse the Explorer</Link>.
        </p>
        <Link href="/connect" className="btn-connect">
          {COPY.session.connect}
        </Link>
      </div>
    );
  }

  if (!session.tenantId) {
    return <EnrollmentPanel walletAddress={session.walletAddress ?? ""} />;
  }

  return <>{children}</>;
}

/** Wallet connected but not bound to an organization. */
export function EnrollmentPanel({ walletAddress }: { readonly walletAddress: string }) {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Your wallet is connected, but not linked to a workspace yet</h1>
          <p className="sub">
            Signing in proved that you control this wallet. Workspace data belongs to
            organizations, and a wallet sees it only after an operator links it to one. Signing in
            again will not change this.
          </p>
        </div>
      </div>

      <div className="panel" data-testid="enrollment-panel">
        <h2>What to do next</h2>
        <ol style={{ margin: 0, paddingLeft: 18 }}>
          <li>
            Send this wallet address to your organization&rsquo;s operator:{" "}
            <span data-testid="enrollment-wallet">
              <Address value={walletAddress} />
            </span>
          </li>
          <li>The operator links the wallet and grants a role. There is no self-service request yet.</li>
          <li>Reload this page after they confirm. The workspace menu appears with your role.</li>
        </ol>
        <p className="sub" style={{ marginBottom: 0 }}>
          Meanwhile, published records need no workspace access:{" "}
          <Link href="/explorer">Explorer</Link> · <Link href="/verify">Proof Verifier</Link>.
        </p>
      </div>
    </>
  );
}
