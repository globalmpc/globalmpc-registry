"use client";

import { useEffect, useState } from "react";
import { listActiveDisclosureRestrictions, type DisclosureRestriction } from "@/lib/api";

/**
 * Active material-information blackout — spec 11 §11.12, AC-30.
 *
 * Shown next to the affected actions with the reason, authority, scope, start, and expected next
 * update. It offers no way around the restriction: the server refuses the action regardless of
 * this notice, with the same restriction ID shown here. Hiding a button would not be a control.
 *
 * The expected next update is an expectation, not a release time — nothing lifts a blackout
 * until its authority records a release.
 */
export function BlackoutNotice({ token, projectId }: { token: string | null; projectId: string }) {
  const [items, setItems] = useState<DisclosureRestriction[]>([]);

  useEffect(() => {
    if (!token) return;
    let live = true;
    listActiveDisclosureRestrictions(token, projectId)
      .then((page) => {
        if (live) setItems(page.items);
      })
      // A read failure is not the absence of a blackout; the server still enforces it.
      .catch(() => {
        if (live) setItems([]);
      });
    return () => {
      live = false;
    };
  }, [token, projectId]);

  if (items.length === 0) return null;

  return (
    <div className="notice" style={{ color: "var(--alert)" }} role="status" data-testid="blackout-notice">
      <div className="title">Some actions on this project are restricted</div>
      {items.map((item) => (
        <dl className="dl" key={item.restrictionId} style={{ marginTop: 8 }}>
          <dt>Reason</dt>
          <dd>{item.reason ?? "—"}</dd>
          <dt>Authority</dt>
          <dd>{item.authority}</dd>
          <dt>Restricted actions</dt>
          <dd className="mono">{item.restrictedActionTypes.join(", ")}</dd>
          <dt>Since</dt>
          <dd className="mono">{item.effectiveAt?.slice(0, 16).replace("T", " ") ?? "—"}</dd>
          <dt>Next expected update</dt>
          <dd className="mono">
            {item.expectedNextUpdateAt?.slice(0, 16).replace("T", " ") ?? "Not stated"}
          </dd>
          <dt>Restriction ID</dt>
          <dd className="mono">{item.restrictionId}</dd>
        </dl>
      ))}
    </div>
  );
}
