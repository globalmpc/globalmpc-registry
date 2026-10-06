import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { withTenant } from "@mpc/db";
import {
  adapterStateReason,
  checkAdapterAvailable,
  checkOfferingGate,
  connectionStateToAdapterState,
  OFFERING_ABSENCE_COPY,
  OFFERING_NOT_MEANING,
} from "@mpc/domain";
import {
  assertAuthorized,
  projectResource,
  sessionFacts,
  tenantResource,
} from "../plugins/authorize.js";
import { requireReadContext } from "./shared.js";

/**
 * Authority Registry — spec 05 §5.11, OD-42·OD-43.
 *
 * What this route guarantees:
 *
 * - **`doesNotProve` is always returned alongside.** Showing only what is confirmed makes the
 *   reader take it as full confirmation. A DB CHECK blocks empty values, but dropping the field
 *   from the response causes the same misreading.
 * - **Unconnected authorities stay in the list.** Removing them hides why an authority is
 *   missing; marking them active promises an integration that does not exist (R5 gate: zero
 *   overstatement of unverified integrations).
 * - **The server decides callability and the next action.** If screens guess from the state
 *   string, each screen reads it differently.
 */

interface AuthorityRow {
  readonly id: string;
  readonly name: string;
  readonly jurisdiction: string;
  readonly proves: string[];
  readonly does_not_prove: string[];
  readonly recognized_scope: string[];
  readonly verification_method: string;
  readonly state: string;
  readonly valid_from: Date;
  readonly valid_until: Date | null;
  readonly connection_key: string | null;
  readonly connection_state: string | null;
}

function toView(row: AuthorityRow) {
  const adapterState = connectionStateToAdapterState(row.connection_state);
  const reason = adapterStateReason(adapterState, row.connection_state);

  // `none` has no adapter at all, so the domain check does not apply.
  const availability =
    adapterState === "none"
      ? { callable: false as const, reason: "NO_CONNECTION", nextAction: "Register a connection first" }
      : checkAdapterAvailable({
          connectionKey: row.connection_key ?? "",
          authorityName: row.name,
          jurisdiction: row.jurisdiction,
          state: adapterState,
          proves: row.proves,
          doesNotProve: row.does_not_prove,
          stateReason: reason,
        });

  return {
    id: row.id,
    name: row.name,
    jurisdiction: row.jurisdiction,
    proves: row.proves,
    // 05 §5.11: no authority exists without limitations.
    doesNotProve: row.does_not_prove,
    recognizedScope: row.recognized_scope,
    verificationMethod: row.verification_method,
    state: row.state,
    validFrom: row.valid_from.toISOString().slice(0, 10),
    validUntil: row.valid_until?.toISOString().slice(0, 10) ?? null,
    adapterState,
    adapterStateReason: reason || null,
    connectionKey: row.connection_key,
    callable: availability.callable,
    nextAction: availability.callable ? null : availability.nextAction,
  };
}

const PROFILE_LIMITATIONS = [
  "Connection state reflects access only; it does not mean the source vouches for the facts",
  "manual means a person performs the lookup; it is not an integration outage",
  "Sources in pending_access are not called — this list does not promise any available integration",
] as const;

export async function registerAuthorityRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  app.get("/api/v1/authorities", async (request) => {
    const { session, tenantId } = requireReadContext(request);
    const { requestId, asOf } = request.context;

    assertAuthorized(
      session,
      "authority.read",
      tenantResource(tenantId),
      sessionFacts(session),
    );

    const rows = await withTenant(sql, { tenantId }, (tx) =>
      tx<AuthorityRow[]>`
        SELECT a.id, a.name, a.jurisdiction, a.proves, a.does_not_prove,
               a.recognized_scope, a.verification_method, a.state,
               a.valid_from, a.valid_until,
               c.connection_key, c.state::text AS connection_state
        FROM core.authorities a
        LEFT JOIN core.source_connections c ON c.authority_id = a.id
        ORDER BY a.jurisdiction, a.name
      `,
    );

    return { items: rows.map(toView), requestId, asOf };
  });

  /**
   * Asset and offering activation conditions — OD-07.
   *
   * **This is not a trading route.** It answers "why is it not available yet". Whether the
   * conditions are met is read from `project_facts` — a separate approval table would make
   * filling that table look like activation itself.
   *
   * No project meets the conditions today. That is expected, and even once they are met the
   * code still has no trading path.
   */
  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/offering-gate",
    async (request) => {
      const { session, tenantId } = requireReadContext(request);
      const { requestId, asOf } = request.context;

      assertAuthorized(
        session,
        "project.read",
        projectResource(tenantId, request.params.projectId),
        sessionFacts(session),
      );

      const facts = await withTenant(sql, { tenantId }, (tx) =>
        tx<{ fact_key: string; status: string; evidence_ref: string | null }[]>`
          SELECT fact_key, status, evidence_ref
          FROM core.project_facts
          WHERE project_id = ${request.params.projectId}
        `,
      );

      const statuses = facts.map((fact) => ({
        key: fact.fact_key as never,
        // Only `confirmed` counts as met. `pending` is under confirmation, not confirmed.
        satisfied: fact.status === "confirmed",
        evidenceRef: fact.evidence_ref,
      }));

      const decision = checkOfferingGate(statuses);

      return {
        projectId: request.params.projectId,
        activatable: decision.activatable,
        missing: decision.activatable ? [] : decision.missing,
        unsupported: decision.activatable ? [] : decision.unsupported,
        // The response itself states that the feature does not exist. If a screen forgets, the
        // API still says it.
        absenceNotice: OFFERING_ABSENCE_COPY,
        notMeaning: OFFERING_NOT_MEANING,
        requestId,
        asOf,
      };
    },
  );

  /**
   * Integration status per jurisdiction — OD-43.
   *
   * Counts active, manual, and pending separately. A total alone lets "10 authorities
   * connected" hide that only 1 is actually callable.
   */
  app.get<{ Params: { jurisdiction: string } }>(
    "/api/v1/jurisdictions/:jurisdiction/profile",
    async (request) => {
      const { session, tenantId } = requireReadContext(request);
      const { requestId, asOf } = request.context;

      assertAuthorized(
        session,
        "authority.read",
        tenantResource(tenantId),
        sessionFacts(session),
      );

      const rows = await withTenant(sql, { tenantId }, (tx) =>
        tx<AuthorityRow[]>`
          SELECT a.id, a.name, a.jurisdiction, a.proves, a.does_not_prove,
                 a.recognized_scope, a.verification_method, a.state,
                 a.valid_from, a.valid_until,
                 c.connection_key, c.state::text AS connection_state
          FROM core.authorities a
          LEFT JOIN core.source_connections c ON c.authority_id = a.id
          WHERE a.jurisdiction = ${request.params.jurisdiction.toUpperCase()}
          ORDER BY a.name
        `,
      );

      const authorities = rows.map(toView);

      return {
        jurisdiction: request.params.jurisdiction.toUpperCase(),
        authorities,
        activeCount: authorities.filter((item) => item.adapterState === "active").length,
        manualCount: authorities.filter((item) => item.adapterState === "manual").length,
        pendingCount: authorities.filter((item) =>
          ["pending_access", "blocked", "none"].includes(item.adapterState),
        ).length,
        limitations: [...PROFILE_LIMITATIONS],
        requestId,
        asOf,
      };
    },
  );
}
