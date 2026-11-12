"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  getReadinessPolicyOptions,
  type ReadinessPolicyOption,
} from "@/lib/api";
import { ErrorNotice } from "./ErrorNotice";

export function useReadinessPolicies(
  token: string | null,
  projectId: string,
  enabled: boolean,
  gateId?: string,
) {
  const [items, setItems] = useState<ReadinessPolicyOption[]>([]);
  const [policySetId, select] = useState("");
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setItems([]);
    select("");
    setError(null);
    if (!token || !enabled) {
      setLoading(false);
      return;
    }
    setLoading(true);
    getReadinessPolicyOptions(token, projectId, gateId)
      .then((result) => {
        if (!live) return;
        setItems(result.items);
        select(result.items.length === 1 ? result.items[0]!.id : "");
      })
      .catch((caught) => {
        if (live) setError(caught);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [token, projectId, enabled, gateId, attempt]);
  return {
    items,
    policySetId,
    select,
    loading,
    error,
    retry: () => setAttempt((value) => value + 1),
  };
}

export function ReadinessPolicySelect({
  policies,
  disabled,
  mayManage,
}: {
  policies: ReturnType<typeof useReadinessPolicies>;
  disabled: boolean;
  mayManage: boolean;
}) {
  if (policies.loading)
    return <p role="status">Loading effective rule sets…</p>;
  if (policies.error)
    return (
      <>
        <ErrorNotice error={policies.error} />
        <button type="button" disabled={disabled} onClick={policies.retry}>
          Retry rule sets
        </button>
      </>
    );
  if (!policies.items.length)
    return (
      <div className="notice" role="status">
        <div className="title">No effective rule set is available</div>
        <p>
          An operator must propose a policy set and a different authorized
          reviewer must approve it. Evaluation is available once its effective
          date is reached.
        </p>
        {mayManage ? (
          <Link href="/w/registries">Open review registries →</Link>
        ) : (
          <p>Ask your workspace operator to configure a policy set.</p>
        )}
        <button type="button" disabled={disabled} onClick={policies.retry}>
          Refresh rule sets
        </button>
      </div>
    );
  return (
    <div className="field">
      <label htmlFor="policySet">Rule set</label>
      <select
        id="policySet"
        disabled={disabled}
        value={policies.policySetId}
        onChange={(event) => policies.select(event.target.value)}
      >
        <option value="">Select a rule set</option>
        {policies.items.map((item) => (
          <option key={item.id} value={item.id}>
            {item.ruleSetId} · v{item.version} · {item.gateId} ·{" "}
            {item.jurisdictionProfile}
          </option>
        ))}
      </select>
    </div>
  );
}
