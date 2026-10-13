"use client";

import { useEffect, useState } from "react";
import { getGovernanceCentralization, type GovernanceCentralization } from "@/lib/api";
import { ErrorNotice } from "@/components/ErrorNotice";

/**
 * Centralization disclosure — spec 09 §9.11, 11 §11.3, REQ-DAPP-023.
 *
 * "The UI discloses the current stage and the powers that are still centralized." Shown on
 * both the public page and the workspace: a holder deciding how to vote needs to know who can
 * act without a vote.
 *
 * **Current authority and target state are separate blocks.** The stage list is the
 * specification's plan; the role counts are what this service holds now. Mixing them would
 * read the plan as already done.
 */
export function GovernanceCentralizationPanel() {
  const [data, setData] = useState<GovernanceCentralization | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let live = true;
    getGovernanceCentralization()
      .then((value) => {
        if (live) setData(value);
      })
      .catch((caught: unknown) => {
        if (live) setError(caught);
      });
    return () => {
      live = false;
    };
  }, []);

  if (error) return <ErrorNotice error={error} />;
  if (!data) return null;

  return (
    <div className="panel" data-testid="governance-centralization">
      <h2>Who holds governance powers now</h2>
      <p className="sub" style={{ marginTop: 0 }}>
        Current stage: <span className="mono" data-testid="governance-stage">{data.currentStage}</span>.
        Still centralized:{" "}
        <span className="mono">
          {data.centralizedPowers.length === 0 ? "none" : data.centralizedPowers.join(", ")}
        </span>
        .
      </p>

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Role</th>
              <th>Power</th>
              <th>Active holders</th>
            </tr>
          </thead>
          <tbody>
            {data.governanceRoles.map((entry) => (
              <tr key={entry.role}>
                <td className="mono">{entry.role}</td>
                <td>{entry.power}</td>
                <td className="mono" data-testid={`holders-${entry.role}`}>
                  {entry.activeHolders}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 style={{ marginTop: 18 }}>Anchor contract</h2>
      {data.anchor.contracts.length === 0 ? (
        <p className="sub" style={{ margin: 0 }}>
          No anchor submission has been recorded by this service yet.
        </p>
      ) : (
        <ul>
          {data.anchor.contracts.map((contract) => (
            <li key={`${contract.chainId}-${contract.contractAddress}`} className="mono">
              Chain {contract.chainId} · {contract.contractAddress}
              {contract.safeAddresses.length > 0
                ? ` · Safe ${contract.safeAddresses.join(", ")}`
                : " · no Safe proposal recorded"}
            </li>
          ))}
        </ul>
      )}
      <p className="meta">{data.anchor.note}</p>

      <h2 style={{ marginTop: 18 }}>Planned stages</h2>
      <ol>
        {data.stages.map((stage) => (
          <li key={stage.stage}>
            <span className="mono">{stage.stage}</span>
            {stage.current ? " (current)" : ""} — {stage.description}
          </li>
        ))}
      </ol>
      <p className="meta">
        {data.transitionCriteria.note} Candidates:{" "}
        {data.transitionCriteria.candidates.join(", ")}.
      </p>

      <ul className="meta">
        {data.limitations.map((limitation) => (
          <li key={limitation}>{limitation}</li>
        ))}
      </ul>
    </div>
  );
}
