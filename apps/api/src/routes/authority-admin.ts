import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { z } from "zod";
import { withTenant } from "@mpc/db";
import { assertEndpointShape } from "../services/source-endpoint.js";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../errors.js";
import {
  assertAuthorized,
  sessionFacts,
  tenantResource,
} from "../plugins/authorize.js";
import { hashRequest, withIdempotency } from "../plugins/idempotency.js";
import { recordAudit } from "../audit.js";
import { enqueueEvent } from "../outbox.js";
import { assertVersionMatches, requireIfMatch, requireMutationContext } from "./shared.js";
import { requireReadContext } from "./shared.js";

/**
 * Authority Registry operations — spec 02 §2.8, 05 §5.11, REQ-DAPP-043.
 *
 * Without this, registering an authority means a direct DB INSERT. Then **who submitted it and
 * who approved it is not recorded**, and no history is kept either.
 *
 * This file enforces the separation set by 02 §2.8:
 *
 * - Registration is by a Trust Registry operator (`authority.register`)
 * - The `accepted` transition is by an independent reviewer (`authority.review`)
 * - **The registrant cannot approve** — blocked even when holding both permissions
 * - Enabling a connection does not approve the authority — a DB trigger checks this
 */

const registerSchema = z.object({
  name: z.string().min(1),
  jurisdiction: z.string().length(3),
  proves: z.array(z.string().min(1)).min(1),
  // No authority exists without limitations (05 §5.11). A DB CHECK enforces the same.
  doesNotProve: z.array(z.string().min(1)).min(1),
  recognizedScope: z.array(z.string().min(1)).min(1),
  verificationMethod: z.string().min(1),
  publicDisclosureLevel: z.enum(["public", "restricted", "confidential", "pii", "whistleblower"]),
  validFrom: z.string(),
  validUntil: z.string().nullable().optional(),
  reason: z.string().min(1),
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  proves: z.array(z.string().min(1)).min(1).optional(),
  doesNotProve: z.array(z.string().min(1)).min(1).optional(),
  recognizedScope: z.array(z.string().min(1)).min(1).optional(),
  verificationMethod: z.string().min(1).optional(),
  validUntil: z.string().nullable().optional(),
  reason: z.string().min(1),
});

const stateSchema = z.object({
  state: z.enum(["under_review", "accepted", "suspended", "expired", "revoked", "superseded"]),
  reason: z.string().min(1),
});

const connectionSchema = z.object({
  connectionKey: z.string().min(1).optional(),
  collectionMethod: z
    .enum([
      "authenticated_api",
      "official_bulk_export",
      "verifiable_signed_document",
      "manual_official_registry_confirmation",
    ])
    .optional(),
  accessBasis: z.string().min(1).optional(),
  // Only a reference is accepted, not the value. A value passing through the API ends up in request logs.
  secretReference: z.string().min(1).nullable().optional(),
  state: z
    .enum([
      "planned",
      "feasibility_checked",
      "access_confirmed",
      "tested",
      "active",
      "degraded",
      "disabled",
    ])
    .optional(),
  /**
   * Call target. **Checks where it points, not just its format** — the server calls this
   * address with credentials attached, so if it points into the internal network it becomes a conduit.
   */
  endpoint: z
    .string()
    .url()
    .nullable()
    .optional()
    .superRefine((value, ctx) => {
      if (!value) return;
      try {
        assertEndpointShape(value);
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: error instanceof Error ? error.message : "Endpoint cannot be used",
        });
      }
    }),
  timeoutMs: z.number().int().min(1000).max(60_000).optional(),
  effectiveAtField: z.string().nullable().optional(),
  authenticationMethod: z.string().optional(),
  adapterVersion: z.string().optional(),
  sourceSchemaVersion: z.string().optional(),
  termsLicense: z.string().optional(),
  commercialReuse: z.enum(["confirmed", "unconfirmed", "prohibited"]).optional(),
  disclosurePermission: z
    .enum(["public", "restricted", "confidential", "pii", "whistleblower"])
    .optional(),
  reason: z.string().min(1),
});

interface AuthorityRow {
  readonly id: string;
  readonly name: string;
  readonly jurisdiction: string;
  readonly proves: string[];
  readonly does_not_prove: string[];
  readonly recognized_scope: string[];
  readonly verification_method: string;
  readonly public_disclosure_level: string;
  readonly valid_from: Date;
  readonly valid_until: Date | null;
  readonly state: string;
  readonly state_reason: string | null;
  readonly registered_by: string | null;
  readonly accepted_by: string | null;
  readonly version: number;
}

interface ConnectionRow {
  readonly id: string;
  readonly authority_id: string;
  readonly connection_key: string;
  readonly collection_method: string;
  readonly state: string;
  readonly endpoint: string | null;
  readonly secret_reference: string | null;
  readonly last_success_at: Date | null;
  readonly version: number;
}

function toAuthorityView(row: AuthorityRow) {
  return {
    id: row.id,
    name: row.name,
    jurisdiction: row.jurisdiction,
    proves: row.proves,
    doesNotProve: row.does_not_prove,
    recognizedScope: row.recognized_scope,
    verificationMethod: row.verification_method,
    publicDisclosureLevel: row.public_disclosure_level,
    validFrom: row.valid_from.toISOString().slice(0, 10),
    validUntil: row.valid_until?.toISOString().slice(0, 10) ?? null,
    state: row.state,
    stateReason: row.state_reason,
    version: row.version,
  };
}

function toConnectionView(row: ConnectionRow) {
  return {
    id: row.id,
    authorityId: row.authority_id,
    connectionKey: row.connection_key,
    collectionMethod: row.collection_method,
    state: row.state,
    endpoint: row.endpoint,
    // Reports only **whether it is set**, not the value. The UI needs to know "no credential"
    // but does not need the value.
    hasSecret: row.secret_reference !== null,
    lastSuccessAt: row.last_success_at?.toISOString() ?? null,
    version: row.version,
  };
}

/** One history row. Freezes the post-change state as is. */
async function recordVersion(
  tx: postgres.TransactionSql,
  tenantId: string,
  row: AuthorityRow,
  changeReason: string,
  changedBy: string | null,
): Promise<void> {
  await tx`
    INSERT INTO core.authority_versions (
      id, tenant_id, authority_id, version, name, jurisdiction, proves, does_not_prove,
      recognized_scope, verification_method, public_disclosure_level,
      valid_from, valid_until, state, state_reason, change_reason, changed_by
    ) VALUES (
      ${randomUUID()}, ${tenantId}, ${row.id}, ${row.version}, ${row.name},
      ${row.jurisdiction}, ${row.proves}, ${row.does_not_prove}, ${row.recognized_scope},
      ${row.verification_method}, ${row.public_disclosure_level},
      ${row.valid_from}, ${row.valid_until}, ${row.state}, ${row.state_reason},
      ${changeReason}, ${changedBy}
    )
  `;
}

/**
 * Keeping a connection active requires the authority to be approved — 02 §2.8.
 *
 * A connection being attached and the decision to trust that authority are different things.
 * Without this check, merely enabling a connection could skip the approval process.
 */
function assertActivatable(connectionState: string, authorityState: string): void {
  if (connectionState !== "active" || authorityState === "accepted") return;

  throw unprocessable(
    "CONNECTION_REQUIRES_ACCEPTED_AUTHORITY",
    "A connection to an unapproved authority cannot be active",
    {
      authorityState,
      nextAction: "Retry after an independent reviewer approves the authority",
    },
  );
}

export async function registerAuthorityAdminRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  // --- Registration ----------------------------------------------------------------

  app.post("/api/v1/authorities", async (request, reply) => {
    const { session, tenantId, idempotencyKey } = requireMutationContext(request);

    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest("REQUEST_INVALID", "Request format is invalid", {
        issues: parsed.error.issues,
      });
    }

    const effectiveRole = assertAuthorized(
      session,
      "authority.register",
      tenantResource(tenantId),
      sessionFacts(session),
    );

    const { requestId, asOf, correlationId } = request.context;
    const requestHash = hashRequest(request.body);
    const data = parsed.data;

    const result = await withTenant(sql, { tenantId }, (tx) =>
      withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
        const id = randomUUID();

        /**
         * Always `proposed`.
         *
         * If the request could set the state, the registrant would also approve —
         * exactly what 02 §2.8 forbids.
         */
        const [row] = await tx<AuthorityRow[]>`
          INSERT INTO core.authorities (
            id, tenant_id, name, jurisdiction, proves, does_not_prove,
            recognized_scope, verification_method, public_disclosure_level,
            valid_from, valid_until, state, registered_by
          ) VALUES (
            ${id}, ${tenantId}, ${data.name}, ${data.jurisdiction.toUpperCase()},
            ${data.proves}, ${data.doesNotProve}, ${data.recognizedScope},
            ${data.verificationMethod}, ${data.publicDisclosureLevel},
            ${data.validFrom}, ${data.validUntil ?? null}, 'proposed', ${session.subjectId}
          )
          RETURNING *
        `;

        await recordVersion(tx, tenantId, row!, data.reason, session.subjectId);

        await recordAudit(tx, {
          effectiveRole,
          tenantId,
          session,
          command: "authority.registered",
          resourceType: "authority",
          resourceId: id,
          correlationId,
          requestIp: request.ip,
          reason: data.reason,
          afterVersion: row!.version,
          detail: { jurisdiction: row!.jurisdiction, state: "proposed" },
        });

        await enqueueEvent(tx, {
          tenantId,
          eventType: "authority.registered",
          aggregateId: id,
          aggregateVersion: 1,
          correlationId,
          payload: { jurisdiction: row!.jurisdiction, state: "proposed" },
        });

        return toAuthorityView(row!);
      }),
    );

    return reply.code(201).send({ ...result, requestId, asOf });
  });

  // --- Update ----------------------------------------------------------------

  app.patch<{ Params: { authorityId: string } }>(
    "/api/v1/authorities/:authorityId",
    async (request) => {
      const { session, tenantId } = requireMutationContext(request);
      const expectedVersion = requireIfMatch(request);

      const parsed = updateSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "Request format is invalid", {
          issues: parsed.error.issues,
        });
      }

      const effectiveRole = assertAuthorized(
        session,
        "authority.register",
        tenantResource(tenantId),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      const data = parsed.data;

      return withTenant(sql, { tenantId }, async (tx) => {
        const [current] = await tx<AuthorityRow[]>`
          SELECT * FROM core.authorities
          WHERE id = ${request.params.authorityId}
          FOR UPDATE
        `;
        if (!current) throw notFound("Authority not found");

        assertVersionMatches(expectedVersion, current.version, "authority");

        const [row] = await tx<AuthorityRow[]>`
          UPDATE core.authorities SET
            name = ${data.name ?? current.name},
            proves = ${data.proves ?? current.proves},
            does_not_prove = ${data.doesNotProve ?? current.does_not_prove},
            recognized_scope = ${data.recognizedScope ?? current.recognized_scope},
            verification_method = ${data.verificationMethod ?? current.verification_method},
            valid_until = ${data.validUntil === undefined ? current.valid_until : data.validUntil},
            version = version + 1
          WHERE id = ${current.id}
          RETURNING *
        `;

        await recordVersion(tx, tenantId, row!, data.reason, session.subjectId);

        await recordAudit(tx, {
          effectiveRole,
          tenantId,
          session,
          command: "authority.updated",
          resourceType: "authority",
          resourceId: current.id,
          correlationId,
          requestIp: request.ip,
          reason: data.reason,
          beforeVersion: current.version,
          afterVersion: row!.version,
          detail: { state: row!.state },
        });

        return { ...toAuthorityView(row!), requestId, asOf };
      });
    },
  );

  // --- State transition -------------------------------------------------------------

  app.post<{ Params: { authorityId: string } }>(
    "/api/v1/authorities/:authorityId/state",
    async (request) => {
      const { session, tenantId } = requireMutationContext(request);
      const expectedVersion = requireIfMatch(request);

      const parsed = stateSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "Request format is invalid", {
          issues: parsed.error.issues,
        });
      }

      const effectiveRole = assertAuthorized(
        session,
        "authority.review",
        tenantResource(tenantId, {
          // This decision requires independence. It is blocked while a conflict is unresolved.
          separationSensitive: true,
        }),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      const data = parsed.data;

      return withTenant(sql, { tenantId }, async (tx) => {
        const [current] = await tx<AuthorityRow[]>`
          SELECT * FROM core.authorities
          WHERE id = ${request.params.authorityId}
          FOR UPDATE
        `;
        if (!current) throw notFound("Authority not found");

        assertVersionMatches(expectedVersion, current.version, "authority");

        /**
         * The registrant cannot approve — 02 §2.8.
         *
         * Permission checks alone cannot prevent this. One person can hold both `authority.register`
         * and `authority.review`, and then submits and approves alone. That case is checked
         * here.
         *
         * Applies only to `accepted`. Suspension and cancellation reduce risk, so even the
         * registrant must be able to do them immediately — blocking them would prevent incident response.
         */
        if (data.state === "accepted" && current.registered_by === session.subjectId) {
          throw forbidden("SEPARATION_OF_DUTIES", "The registrant cannot approve the same authority", {
            registeredBy: "self",
            requiredAction: "Another reviewer approves",
          });
        }

        if (current.state === data.state) {
          throw conflict("AUTHORITY_STATE_UNCHANGED", `Already in state ${data.state}`);
        }

        const accepting = data.state === "accepted";

        const [row] = await tx<AuthorityRow[]>`
          UPDATE core.authorities SET
            state = ${data.state},
            state_reason = ${data.reason},
            accepted_by = ${accepting ? session.subjectId : current.accepted_by},
            accepted_at = ${accepting ? new Date() : null},
            version = version + 1
          WHERE id = ${current.id}
          RETURNING *
        `;

        await recordVersion(tx, tenantId, row!, data.reason, session.subjectId);

        await recordAudit(tx, {
          effectiveRole,
          tenantId,
          session,
          command: "authority.state_changed",
          resourceType: "authority",
          resourceId: current.id,
          correlationId,
          requestIp: request.ip,
          reason: data.reason,
          beforeVersion: current.version,
          afterVersion: row!.version,
          detail: { fromState: current.state, toState: data.state },
        });

        await enqueueEvent(tx, {
          tenantId,
          eventType: "authority.state_changed",
          aggregateId: current.id,
          aggregateVersion: row!.version,
          correlationId,
          payload: { fromState: current.state, toState: data.state },
        });

        // Losing approval takes the connection down (trigger). The response says so —
        // unless the UI refetches, it believes the connection is still live.
        const demoted = !accepting && current.state === "accepted";

        return {
          ...toAuthorityView(row!),
          connectionsDegraded: demoted,
          requestId,
          asOf,
        };
      });
    },
  );

  // --- History ----------------------------------------------------------------

  app.get<{ Params: { authorityId: string } }>(
    "/api/v1/authorities/:authorityId/versions",
    async (request) => {
      const { session, tenantId } = requireReadContext(request);
      const { requestId, asOf } = request.context;

      assertAuthorized(
        session,
        "authority.read",
        tenantResource(tenantId),
        sessionFacts(session),
      );

      const rows = await withTenant(
        sql,
        { tenantId },
        (tx) =>
          tx<
            {
              version: number;
              name: string;
              proves: string[];
              does_not_prove: string[];
              recognized_scope: string[];
              verification_method: string;
              state: string;
              state_reason: string | null;
              change_reason: string;
              recorded_at: Date;
            }[]
          >`
          SELECT version, name, proves, does_not_prove, recognized_scope,
                 verification_method, state, state_reason, change_reason, recorded_at
          FROM core.authority_versions
          WHERE authority_id = ${request.params.authorityId}
          ORDER BY version DESC
        `,
      );

      return {
        items: rows.map((row) => ({
          version: row.version,
          name: row.name,
          proves: row.proves,
          doesNotProve: row.does_not_prove,
          recognizedScope: row.recognized_scope,
          verificationMethod: row.verification_method,
          state: row.state,
          stateReason: row.state_reason,
          changeReason: row.change_reason,
          recordedAt: row.recorded_at.toISOString(),
        })),
        requestId,
        asOf,
      };
    },
  );

  // --- Connections ----------------------------------------------------------------

  app.get<{ Params: { authorityId: string } }>(
    "/api/v1/authorities/:authorityId/connections",
    async (request) => {
      const { session, tenantId } = requireReadContext(request);
      const { requestId, asOf } = request.context;

      assertAuthorized(
        session,
        "authority.read",
        tenantResource(tenantId),
        sessionFacts(session),
      );

      const rows = await withTenant(
        sql,
        { tenantId },
        (tx) =>
          tx<ConnectionRow[]>`
          SELECT id, authority_id, connection_key, collection_method::text AS collection_method,
                 state::text AS state, endpoint, secret_reference, last_success_at, version
          FROM core.source_connections
          WHERE authority_id = ${request.params.authorityId}
          ORDER BY connection_key
        `,
      );

      return { items: rows.map(toConnectionView), requestId, asOf };
    },
  );

  app.post<{ Params: { authorityId: string } }>(
    "/api/v1/authorities/:authorityId/connections",
    async (request, reply) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);

      const parsed = connectionSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "Request format is invalid", {
          issues: parsed.error.issues,
        });
      }
      const data = parsed.data;

      if (!data.connectionKey || !data.collectionMethod || !data.accessBasis) {
        throw badRequest(
          "REQUEST_INVALID",
          "Creating a connection requires connectionKey, collectionMethod, and accessBasis",
        );
      }

      const effectiveRole = assertAuthorized(
        session,
        "connection.configure",
        tenantResource(tenantId),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request.body);

      const result = await withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          const [authority] = await tx<{ id: string; state: string }[]>`
            SELECT id, state::text AS state FROM core.authorities
            WHERE id = ${request.params.authorityId}
          `;
          if (!authority) throw notFound("Authority not found");

          // The DB trigger blocks the same thing, but failing there returns 500. A foreseeable
          // rejection is returned as 422 with its reason.
          assertActivatable(data.state ?? "planned", authority.state);

          const id = randomUUID();

          const [row] = await tx<ConnectionRow[]>`
            INSERT INTO core.source_connections (
              id, tenant_id, authority_id, connection_key, collection_method,
              access_basis, secret_reference, state, endpoint, timeout_ms,
              effective_at_field, authentication_method, adapter_version,
              source_schema_version, terms_license, commercial_reuse, disclosure_permission
            ) VALUES (
              ${id}, ${tenantId}, ${authority.id}, ${data.connectionKey!},
              ${data.collectionMethod!}, ${data.accessBasis!}, ${data.secretReference ?? null},
              ${data.state ?? "planned"}, ${data.endpoint ?? null},
              ${data.timeoutMs ?? 10_000}, ${data.effectiveAtField ?? null},
              ${data.authenticationMethod ?? "none"}, ${data.adapterVersion ?? "v0"},
              ${data.sourceSchemaVersion ?? "unknown"}, ${data.termsLicense ?? "unconfirmed"},
              ${data.commercialReuse ?? "unconfirmed"}, ${data.disclosurePermission ?? "restricted"}
            )
            RETURNING id, authority_id, connection_key,
                      collection_method::text AS collection_method, state::text AS state,
                      endpoint, secret_reference, last_success_at, version
          `;

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            session,
            command: "source_connection.configured",
            resourceType: "source_connection",
            resourceId: id,
            correlationId,
            requestIp: request.ip,
            reason: data.reason,
            afterVersion: row!.version,
            // The endpoint is kept. Credentials are not put in the audit, not even as a reference.
            detail: { connectionKey: row!.connection_key, state: row!.state },
          });

          return toConnectionView(row!);
        }),
      );

      return reply.code(201).send({ ...result, requestId, asOf });
    },
  );

  app.patch<{ Params: { connectionId: string } }>(
    "/api/v1/source-connections/:connectionId",
    async (request) => {
      const { session, tenantId } = requireMutationContext(request);
      const expectedVersion = requireIfMatch(request);

      const parsed = connectionSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "Request format is invalid", {
          issues: parsed.error.issues,
        });
      }

      const effectiveRole = assertAuthorized(
        session,
        "connection.configure",
        tenantResource(tenantId),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      const data = parsed.data;

      return withTenant(sql, { tenantId }, async (tx) => {
        const [current] = await tx<
          (ConnectionRow & {
            timeout_ms: number;
            effective_at_field: string | null;
            authentication_method: string;
            adapter_version: string;
            source_schema_version: string;
            terms_license: string;
            commercial_reuse: string;
            disclosure_permission: string;
            access_basis: string;
          })[]
        >`
          SELECT c.*, c.collection_method::text AS collection_method,
                 c.state::text AS state,
                 c.disclosure_permission::text AS disclosure_permission
          FROM core.source_connections c
          WHERE c.id = ${request.params.connectionId}
          FOR UPDATE
        `;
        if (!current) throw notFound("Connection not found");

        assertVersionMatches(expectedVersion, current.version, "source_connection");

        if (data.state === "active" && current.state !== "active") {
          const [authority] = await tx<{ state: string }[]>`
            SELECT state::text AS state FROM core.authorities WHERE id = ${current.authority_id}
          `;
          assertActivatable(data.state, authority?.state ?? "unknown");
        }

        const [row] = await tx<ConnectionRow[]>`
          UPDATE core.source_connections SET
            connection_key = ${data.connectionKey ?? current.connection_key},
            access_basis = ${data.accessBasis ?? current.access_basis},
            secret_reference = ${
              data.secretReference === undefined ? current.secret_reference : data.secretReference
            },
            state = ${data.state ?? current.state},
            endpoint = ${data.endpoint === undefined ? current.endpoint : data.endpoint},
            timeout_ms = ${data.timeoutMs ?? current.timeout_ms},
            effective_at_field = ${
              data.effectiveAtField === undefined
                ? current.effective_at_field
                : data.effectiveAtField
            },
            authentication_method = ${data.authenticationMethod ?? current.authentication_method},
            adapter_version = ${data.adapterVersion ?? current.adapter_version},
            source_schema_version = ${data.sourceSchemaVersion ?? current.source_schema_version},
            terms_license = ${data.termsLicense ?? current.terms_license},
            commercial_reuse = ${data.commercialReuse ?? current.commercial_reuse},
            disclosure_permission = ${data.disclosurePermission ?? current.disclosure_permission},
            version = version + 1
          WHERE id = ${current.id}
          RETURNING id, authority_id, connection_key,
                    collection_method::text AS collection_method, state::text AS state,
                    endpoint, secret_reference, last_success_at, version
        `;

        await recordAudit(tx, {
          effectiveRole,
          tenantId,
          session,
          command: "source_connection.configured",
          resourceType: "source_connection",
          resourceId: current.id,
          correlationId,
          requestIp: request.ip,
          reason: data.reason,
          beforeVersion: current.version,
          afterVersion: row!.version,
          detail: { fromState: current.state, toState: row!.state },
        });

        return { ...toConnectionView(row!), requestId, asOf };
      });
    },
  );
}
