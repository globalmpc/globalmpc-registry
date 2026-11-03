"use client";

import Link from "next/link";
import type { MouseEvent } from "react";
import { isAccountSession, needsSecondFactor, useSession } from "@/lib/session";
import { AUTH_COPY, COPY, PUBLIC_NAV } from "@/lib/copy";
import { visibleNav } from "@/lib/nav";
import { assuranceNarrowedRoles, effectiveRoles } from "@/lib/access";
import { StepUpCancelled, useOptionalStepUp } from "@/components/auth/StepUp";

/** Close the expanded public menu when a link is clicked. If it stays open across page changes, it covers the body. */
function closeMenu(event: MouseEvent<HTMLAnchorElement>): void {
  const menu = event.currentTarget.closest("details");
  if (menu) menu.open = false;
}

/** How the session signed in, for the header. */
const FIRST_FACTOR_LABEL: Readonly<Record<string, string>> = {
  email_code: "email",
  google: "Google",
  microsoft: "Microsoft",
};

export function TopBar() {
  const { session, signOut } = useSession();
  const stepUp = useOptionalStepUp();
  const authenticated = session?.authenticated === true;
  const pendingFactor = needsSecondFactor(session);
  const workspace = authenticated && session && !pendingFactor ? visibleNav(session) : [];
  // Roles the person holds that this session's level does not make effective (a TOTP session
  // holding a reviewer role): offer the passkey instead of hiding them.
  const narrowed = (session?.narrowedRoles ?? []).filter((entry) => entry.requiredAal !== null);
  // Roles held at this level but below their identity-assurance minimum (a reviewer whose
  // operator-verified wallet was replaced). Shown apart and marked inactive, with what to do —
  // listing them with the roles in effect claims an authority the server refuses.
  const inactive = assuranceNarrowedRoles(session);
  const roles = effectiveRoles(session);

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
          {authenticated && !pendingFactor ? (
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
              <span data-testid="sign-in-method">{FIRST_FACTOR_LABEL[session.firstFactor ?? ""] ?? "—"}</span>{" "}
              · {session.aal ?? "—"} ·{" "}
              <span data-testid="effective-roles">
                {roles.join(", ") || (inactive.length > 0 ? "" : COPY.session.noRoles)}
              </span>
              {inactive.length > 0 ? (
                <>
                  {roles.length > 0 ? " · " : null}
                  <span
                    data-testid="inactive-roles"
                    title={COPY.session.inactiveReason}
                    style={{ textDecoration: "line-through" }}
                  >
                    {inactive.map((entry) => entry.role).join(", ")}
                  </span>{" "}
                  <span data-testid="inactive-roles-reason">
                    ({COPY.session.inactiveRoles}: {COPY.session.inactiveReason})
                  </span>
                </>
              ) : null}{" "}
              · {session.assuranceLevel}
            </span>
            {narrowed.length > 0 && stepUp && !pendingFactor ? (
              <button
                type="button"
                data-testid="step-up-narrowed"
                title={AUTH_COPY.stepUp.narrowed}
                onClick={() =>
                  void stepUp
                    .prompt(narrowed.some((entry) => entry.requiredAal === "aal3") ? "aal3" : "aal2")
                    .catch((caught: unknown) => {
                      if (!(caught instanceof StepUpCancelled)) throw caught;
                    })
                }
              >
                {AUTH_COPY.stepUp.button(narrowed.map((entry) => entry.role).join(", "))}
              </button>
            ) : null}
            {isAccountSession(session) && !pendingFactor ? (
              <Link href="/w/settings">{COPY.session.settings}</Link>
            ) : null}
            <button onClick={() => void signOut()}>{COPY.session.disconnect}</button>
          </>
        ) : (
          <>
            <span className="meta">{COPY.session.none}</span>
            <Link href="/connect" className="btn-connect sm">
              {COPY.session.signIn}
            </Link>
          </>
        )}
      </div>
    </header>
  );
}
