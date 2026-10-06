"use client";

import Link from "next/link";
import type { MouseEvent } from "react";
import { useSession } from "@/lib/session";
import { COPY, PUBLIC_NAV } from "@/lib/copy";
import { visibleNav } from "@/lib/nav";
import { Address } from "@/components/Address";

/** Close the expanded public menu when a link is clicked. If it stays open across page changes, it covers the body. */
function closeMenu(event: MouseEvent<HTMLAnchorElement>): void {
  const menu = event.currentTarget.closest("details");
  if (menu) menu.open = false;
}

export function TopBar() {
  const { session, signOut } = useSession();
  const authenticated = session?.authenticated === true;
  const workspace = authenticated && session ? visibleNav(session) : [];

  return (
    <header className="topbar">
      <div className="row topbar-start" style={{ gap: 20 }}>
        {/* Do not typeset the wordmark in the body font (@mpc/design logo.md). The mark
            uses the source asset as-is; only the product name is added as text. The 28px height is above the
            mark minimum of 24px, and the clear space 0.5× (=14px) is given as gap. */}
        <Link href="/" className="brand" style={{ color: "var(--foreground)" }}>
          <img src="/brand/mpc-mark-on-dark.svg" alt="MPC" width={22} height={28} />
          <span>{COPY.productName}</span>
        </Link>
        {/* Links come from the single registry, not a local array (@mpc/design "chrome"). */}
        <nav className="row" style={{ gap: 14 }}>
          {authenticated ? (
            <>
              {workspace.map((entry) => (
                <Link key={entry.href} href={entry.href}>
                  {entry.label}
                </Link>
              ))}
              {/* With no roles at all, only "nowhere to go" remains. Give a next action. */}
              {session?.roleBindings?.length ? null : (
                <Link href="/w/access-requests">{COPY.session.requestAccess}</Link>
              )}
              {/* Public screens do not disappear after sign-in. They stay as one group,
                  not mixed with the workspace menu — the two answer different questions (copy.ts). */}
              <details className="nav-public">
                <summary>{COPY.session.publicMenu}</summary>
                <div className="nav-public-menu">
                  {PUBLIC_NAV.map((entry) => (
                    <Link key={entry.href} href={entry.href} onClick={closeMenu}>
                      {entry.label}
                    </Link>
                  ))}
                </div>
              </details>
            </>
          ) : (
            PUBLIC_NAV.map((entry) => (
              <Link key={entry.href} href={entry.href}>
                {entry.label}
              </Link>
            ))
          )}
        </nav>
      </div>

      <div className="row topbar-end">
        {authenticated && session ? (
          <>
            <span className="meta">
              {session.walletAddress ? <Address value={session.walletAddress} /> : null} ·{" "}
              {session.roleBindings?.map((binding) => binding.role).join(", ") ||
                COPY.session.noRoles}{" "}
              · {session.assuranceLevel}
            </span>
            <button onClick={() => void signOut()}>{COPY.session.disconnect}</button>
          </>
        ) : (
          <>
            <span className="meta">{COPY.session.none}</span>
            <Link href="/connect" className="btn-connect sm">
              Connect account →
            </Link>
          </>
        )}
      </div>
    </header>
  );
}
