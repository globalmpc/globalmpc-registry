"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { accessPending, rolesAllInactive } from "@/lib/access";
import { COPY } from "@/lib/copy";
import { useSession } from "@/lib/session";
import { AccessPending } from "@/components/AccessPending";

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

  if (!session.workspaceAvailable) {
    return (
      <div className="panel" data-testid="workspace-unavailable">
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
