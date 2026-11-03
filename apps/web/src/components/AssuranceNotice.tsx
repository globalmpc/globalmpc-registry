"use client";

import { assuranceNarrowedFor } from "@/lib/access";
import { COPY } from "@/lib/copy";
import { useSession } from "@/lib/session";

/**
 * Says up front that a role this screen needs is held but not in effect, because the identity
 * assurance is below its minimum — before the person fills a form and signs into a refusal.
 *
 * `actions` are the screen's write actions; only roles those actions allow are named. The server
 * still refuses the request; this is the explanation, not the control.
 */
export function AssuranceNotice({ actions }: { readonly actions: readonly string[] }) {
  const { session } = useSession();
  const inactive = assuranceNarrowedFor(session, actions);
  if (inactive.length === 0) return null;
  const required = inactive.some((entry) => entry.requiredAssurance === "high_assurance")
    ? "high_assurance"
    : "identity_bound";
  return (
    <div className="notice" style={{ color: "var(--alert)" }} role="status" data-testid="assurance-notice">
      <div className="title">{COPY.assurance.heading}</div>
      <div>{COPY.assurance.lead(required)}</div>
      <div style={{ marginTop: 6 }}>
        {COPY.assurance.roles}{" "}
        {inactive.map((entry, index) => (
          <span key={entry.role}>
            {index > 0 ? ", " : null}
            <span className="mono">{entry.role}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
