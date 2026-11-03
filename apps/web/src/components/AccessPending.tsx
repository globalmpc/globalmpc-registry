"use client";

import Link from "next/link";
import { assuranceNarrowedRoles, rolesAllInactive } from "@/lib/access";
import { COPY } from "@/lib/copy";
import { useSession } from "@/lib/session";

const C = COPY.accessPending;

/**
 * The state of a signed-in person the workspace has nothing for yet — plan §4 journey 1.
 *
 * Two cases, one screen: no role at all (an invitation was accepted, the grant has not landed),
 * or roles that are held but not in effect because the identity assurance is below them (after an
 * operator-verified wallet was replaced). Either way the next step is an administrator's, and the
 * screen says which one, instead of a project list that answers with a refusal naming 16 roles.
 *
 * The server still refuses every request this session cannot make; this only explains it.
 */
export function AccessPending() {
  const { session, signOut } = useSession();
  const inactive = rolesAllInactive(session) ? assuranceNarrowedRoles(session) : [];

  return (
    <div className="panel" data-testid="access-pending">
      {inactive.length > 0 ? (
        <>
          <h1>{C.inactiveHeading}</h1>
          <p className="sub">{C.inactiveLead}</p>
          <ul data-testid="access-pending-inactive-roles">
            {inactive.map((entry) => (
              <li key={entry.role} className="mono">
                {C.roleNeeds(entry.role, entry.requiredAssurance)}
              </li>
            ))}
          </ul>
          <p>{C.inactiveNext}</p>
        </>
      ) : (
        <>
          <h1>{C.heading}</h1>
          <p className="sub">{C.lead}</p>
        </>
      )}
      <p style={{ marginBottom: 6 }}>{C.next}</p>
      <ul>
        <li>
          <Link href="/w/access-requests" data-testid="access-pending-request">
            {C.requestAccess} →
          </Link>{" "}
          <span className="meta">— {C.requestAccessHint}</span>
        </li>
        <li>
          <Link href="/w/settings" data-testid="access-pending-settings">
            {C.settings} →
          </Link>{" "}
          <span className="meta">— {C.settingsHint}</span>
        </li>
        <li>
          <button type="button" data-testid="access-pending-sign-out" onClick={() => void signOut()}>
            {C.signOut}
          </button>
        </li>
      </ul>
      <p className="meta">
        {C.publicRecords} <Link href="/explorer">{C.explorer}</Link>
      </p>
    </div>
  );
}
