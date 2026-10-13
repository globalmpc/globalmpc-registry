import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import {
  CURRENT_GOVERNANCE_STAGE,
  GOVERNANCE_STAGES,
  STAGE_TRANSITION_CRITERIA_CANDIDATES,
} from "@mpc/domain";

/**
 * Centralization disclosure — spec 09 §9.11, 11 §11.3, REQ-DAPP-023.
 *
 * "The UI discloses the current stage and the powers that are still centralized" (09 §9.11).
 * Two halves, kept apart so neither is mistaken for the other:
 *
 * - **Current authority** — read from what this service holds: who holds governance and
 *   operations roles (counted, not named) and which anchor contracts and Safes its own chain
 *   records name.
 * - **Target state** — the stage list of 09 §9.11 as written. No dates and no criteria values:
 *   the spec gives neither (the values belong to OD-10 to OD-12, still open).
 *
 * Public, because the people affected by who holds these powers are mostly not signed in.
 */

/** What each counted role can do — 02 §2.2, responsibility column. */
const ROLE_POWERS: Readonly<Record<string, string>> = {
  mpc_operator: "Operates tenants, workflows and the registry service; administers proposals",
  security_operator: "Executes pause, incident response and key rotation",
  protocol_proposer: "Creates allowed protocol proposals",
  protocol_voter: "Votes on protocol proposals by MPC snapshot",
  project_proposer: "Creates a project's contractual proposals",
  project_voter: "Votes on its project's proposals by that project's AT snapshot",
  execution_recorder: "Records off-chain execution status and evidence",
  treasury_signer: "Co-signs approved treasury transactions",
};

const ANCHOR_NOTE =
  "The anchor contract assigns its admin, submitter and pauser roles on chain. This service " +
  "lists the contracts it submitted to and the Safes it sent proposals to; it does not read the " +
  "current on-chain role holders. Check the contract's role events for those.";

const LIMITATIONS = [
  "Holder counts come from this service's active role bindings across all tenants; they are not on-chain facts",
  "The criteria for moving between stages have no decided values, so no transition date or threshold is shown",
  "This page describes who holds a power, not whether any use of it was proper",
] as const;

export async function registerGovernanceCentralizationRoute(
  app: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  app.get("/api/v1/public/governance/centralization", async (request, reply) => {
    const holders = await sql<{ role: string; active_holders: string }[]>`
      SELECT * FROM core.public_governance_role_holders()
    `;
    const contracts = await sql<
      { chain_id: number; contract_address: string; safe_addresses: string[] }[]
    >`
      SELECT * FROM core.public_anchor_authority()
    `;

    const currentIndex = GOVERNANCE_STAGES.findIndex(
      (stage) => stage.stage === CURRENT_GOVERNANCE_STAGE,
    );

    reply.header("cache-control", "public, max-age=30");

    return {
      currentStage: CURRENT_GOVERNANCE_STAGE,
      stages: GOVERNANCE_STAGES.map((stage, index) => ({
        stage: stage.stage,
        description: stage.description,
        delegates: [...stage.delegates],
        current: index === currentIndex,
      })),
      transitionCriteria: {
        candidates: [...STAGE_TRANSITION_CRITERIA_CANDIDATES],
        decided: false as const,
        note: "Candidate criteria from the governance specification. Their values are not decided.",
      },
      // Everything a later stage would delegate is, by definition, not delegated yet.
      centralizedPowers: GOVERNANCE_STAGES.slice(currentIndex + 1).flatMap((stage) => [
        ...stage.delegates,
      ]),
      governanceRoles: holders.map((row) => ({
        role: row.role,
        power: ROLE_POWERS[row.role] ?? row.role,
        activeHolders: Number(row.active_holders),
      })),
      anchor: {
        contracts: contracts.map((row) => ({
          chainId: row.chain_id,
          contractAddress: row.contract_address,
          safeAddresses: row.safe_addresses,
        })),
        note: ANCHOR_NOTE,
      },
      limitations: [...LIMITATIONS],
      requestId: request.context.requestId,
      asOf: request.context.asOf,
    };
  });
}
