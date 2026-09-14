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
 * Authority Registry 운영 경로 — spec 02 §2.8, 05 §5.11, REQ-DAPP-043.
 *
 * 여기가 없으면 기관 등록이 DB 직접 INSERT다. 그러면 **누가 올렸고 누가
 * 승인했는지가 남지 않고**, 이력도 남지 않는다.
 *
 * 02 §2.8이 정한 분리를 이 파일이 강제한다:
 *
 * - 등록은 Trust Registry 운영자(`authority.register`)
 * - `accepted` 전환은 독립 reviewer(`authority.review`)
 * - **등록한 사람은 승인할 수 없다** — 권한이 둘 다 있어도 막힌다
 * - 연동을 켜는 것이 기관 승인이 되지 않는다 — DB 트리거가 본다
 */

const registerSchema = z.object({
  name: z.string().min(1),
  jurisdiction: z.string().length(3),
  proves: z.array(z.string().min(1)).min(1),
  // 한계 없는 authority는 존재하지 않는다(05 §5.11). DB CHECK도 같은 것을 본다.
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
  // 값이 아니라 참조만 받는다. 값이 API를 지나가면 요청 로그에 남는다.
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
   * 호출 대상. **형식만이 아니라 어디를 가리키는지도 본다** — 서버가 자격증명을
   * 붙여 부르는 주소이므로 내부망을 가리키면 그 경로가 통로가 된다.
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
          message: error instanceof Error ? error.message : "endpoint를 사용할 수 없다",
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
    // 값이 아니라 **설정 여부**만 알린다. 화면은 "자격증명 없음"을 알아야 하고
    // 값은 알 필요가 없다.
    hasSecret: row.secret_reference !== null,
    lastSuccessAt: row.last_success_at?.toISOString() ?? null,
    version: row.version,
  };
}

/** 이력 한 줄. 변경 뒤의 상태를 그대로 박제한다. */
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
 * 연동을 활성으로 두려면 기관이 승인돼 있어야 한다 — 02 §2.8.
 *
 * 연동이 붙었다는 사실과 그 기관을 신뢰하기로 했다는 판단은 다른 것이다.
 * 이 검사가 없으면 연동을 켜는 것만으로 승인 절차를 건너뛸 수 있다.
 */
function assertActivatable(connectionState: string, authorityState: string): void {
  if (connectionState !== "active" || authorityState === "accepted") return;

  throw unprocessable(
    "CONNECTION_REQUIRES_ACCEPTED_AUTHORITY",
    "승인되지 않은 기관의 연동은 활성이 될 수 없다",
    {
      authorityState,
      nextAction: "독립 검토자가 기관을 승인한 뒤 다시 시도한다",
    },
  );
}

export async function registerAuthorityAdminRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  // --- 등록 ----------------------------------------------------------------

  app.post("/api/v1/authorities", async (request, reply) => {
    const { session, tenantId, idempotencyKey } = requireMutationContext(request);

    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest("REQUEST_INVALID", "요청 형식이 올바르지 않다", {
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
         * 항상 `proposed`다.
         *
         * 요청이 상태를 정할 수 있으면 등록하는 사람이 승인까지 하게 된다 —
         * 02 §2.8이 금지하는 바로 그것이다.
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

  // --- 갱신 ----------------------------------------------------------------

  app.patch<{ Params: { authorityId: string } }>(
    "/api/v1/authorities/:authorityId",
    async (request) => {
      const { session, tenantId } = requireMutationContext(request);
      const expectedVersion = requireIfMatch(request);

      const parsed = updateSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "요청 형식이 올바르지 않다", {
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
        if (!current) throw notFound("기관을 찾을 수 없다");

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

  // --- 상태 전환 -------------------------------------------------------------

  app.post<{ Params: { authorityId: string } }>(
    "/api/v1/authorities/:authorityId/state",
    async (request) => {
      const { session, tenantId } = requireMutationContext(request);
      const expectedVersion = requireIfMatch(request);

      const parsed = stateSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "요청 형식이 올바르지 않다", {
          issues: parsed.error.issues,
        });
      }

      const effectiveRole = assertAuthorized(
        session,
        "authority.review",
        tenantResource(tenantId, {
          // 이 판단은 독립성이 요건이다. conflict가 미해소면 막힌다.
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
        if (!current) throw notFound("기관을 찾을 수 없다");

        assertVersionMatches(expectedVersion, current.version, "authority");

        /**
         * 등록한 사람은 승인할 수 없다 — 02 §2.8.
         *
         * 권한 검사만으로는 막지 못한다. 한 사람이 `authority.register`와
         * `authority.review`를 동시에 가질 수 있고, 그러면 혼자서 올리고 혼자서
         * 승인한다. 그 경우를 여기서 본다.
         *
         * `accepted`에만 적용한다. 정지·취소는 위험을 줄이는 방향이라
         * 등록자라도 즉시 할 수 있어야 한다 — 막으면 사고에 대응하지 못한다.
         */
        if (data.state === "accepted" && current.registered_by === session.subjectId) {
          throw forbidden("SEPARATION_OF_DUTIES", "등록한 사람은 같은 기관을 승인할 수 없다", {
            registeredBy: "self",
            requiredAction: "다른 검토자가 승인한다",
          });
        }

        if (current.state === data.state) {
          throw conflict("AUTHORITY_STATE_UNCHANGED", `이미 ${data.state} 상태다`);
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

        // 승인이 풀리면 연동이 내려간다(트리거). 응답이 그 사실을 알린다 —
        // 화면이 다시 조회하지 않으면 연동이 살아 있다고 믿는다.
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

  // --- 이력 ----------------------------------------------------------------

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

  // --- 연동 ----------------------------------------------------------------

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
        throw badRequest("REQUEST_INVALID", "요청 형식이 올바르지 않다", {
          issues: parsed.error.issues,
        });
      }
      const data = parsed.data;

      if (!data.connectionKey || !data.collectionMethod || !data.accessBasis) {
        throw badRequest(
          "REQUEST_INVALID",
          "연동을 만들려면 connectionKey·collectionMethod·accessBasis가 필요하다",
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
          if (!authority) throw notFound("기관을 찾을 수 없다");

          // DB 트리거가 같은 것을 막지만 거기서 걸리면 500이 나간다. 예상 가능한
          // 거절은 이유와 함께 422로 돌려준다.
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
            // endpoint는 남긴다. 자격증명은 참조조차 감사에 넣지 않는다.
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
        throw badRequest("REQUEST_INVALID", "요청 형식이 올바르지 않다", {
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
        if (!current) throw notFound("연동을 찾을 수 없다");

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
