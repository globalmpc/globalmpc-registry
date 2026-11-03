"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { accessPending, rolesAllInactive } from "@/lib/access";
import { COPY } from "@/lib/copy";
import { needsSecondFactor, useSession } from "@/lib/session";
import { AccessPending } from "@/components/AccessPending";

/**
 * One screen first separates the states before entering the workspace.
 *
 * 1. Reading the session — calls nothing.
 * 2. Not signed in — sign-in guidance.
 * 3. Signed in with the first factor only, or restored by a recovery code — the second-factor
 *    screen (`/auth/mfa`). The server refuses such a session everything else (priority rule 2), so
 *    drawing the workspace would only fill it with refusals.
 *
 * Every session belongs to an account, and an account always has a tenant: the wallet sign-in
 * whose unbound wallet once reached the workspace without one was removed in WP7. A session
 * without a tenant is still not drawn into the workspace, where every screen would only fail.
 *
 * 4. Signed in with no usable role — no role at all ("access pending", plan §4 journey 1), or
 *    only roles whose identity-assurance minimum is not met — the access-pending explanation on
 *    every screen that needs a role. Account settings and the person's own activity stay open.
 *
 * A missing role for one screen, or a project outside the session's reach (403), is not blocked
 * here. What is missing differs per screen, and `ErrorNotice` shows the required role and the
 * request path.
 */
/**
 * The screen blocked people land on — 11 §11.7.
 *
 * Even when not signed in, it must be possible to read what is missing.
 * If the gate also covers this screen, someone following a rejection notice meets yet another notice.
 */
function isAccessRequestPath(pathname: string): boolean {
  return (
    pathname === "/w/access-requests" ||
    pathname === "/w/identity/upgrade" ||
    /^\/w\/projects\/[^/]+\/access-requests$/.test(pathname)
  );
}

/** Screens a person without a usable role can still use: their own account and activity. */
function isRoleFreePath(pathname: string): boolean {
  return (
    pathname === "/w/access-pending" ||
    pathname === "/w/activity" ||
    pathname === "/w/settings" ||
    pathname.startsWith("/w/settings/")
  );
}

export function WorkspaceGate({ children }: { readonly children: React.ReactNode }) {
  const { session, loading } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const pendingFactor = !loading && needsSecondFactor(session);

  useEffect(() => {
    if (pendingFactor) router.replace(`/auth/mfa?next=${encodeURIComponent(pathname)}`);
  }, [pendingFactor, pathname, router]);

  if (isAccessRequestPath(pathname)) return <>{children}</>;

  if (loading) {
    return <p className="sub">Loading your session…</p>;
  }

  if (!session?.authenticated) {
    return (
      <div className="panel" data-testid="workspace-signed-out">
        <h1>Sign in to open the workspace</h1>
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

  if (pendingFactor) {
    return (
      <p className="sub" data-testid="workspace-second-factor">
        <Link href="/auth/mfa">Finish signing in with your second factor →</Link>
      </p>
    );
  }

  if (!session.tenantId) {
    return (
      <div className="panel" data-testid="workspace-no-tenant">
        <h1>This sign-in has no workspace</h1>
        <p className="sub">
          Sign out and sign in again. Published records need no workspace access:{" "}
          <Link href="/explorer">Explorer</Link> · <Link href="/verify">Proof Verifier</Link>.
        </p>
      </div>
    );
  }

  if ((accessPending(session) || rolesAllInactive(session)) && !isRoleFreePath(pathname)) {
    return <AccessPending />;
  }

  return <>{children}</>;
}
