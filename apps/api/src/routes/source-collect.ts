import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { z } from "zod";
import { withTenant } from "@mpc/db";
import { resolveSecret } from "@mpc/config";
import {
  adapterStateReason,
  checkAdapterAvailable,
  checkSecondReview,
  connectionStateToAdapterState,
  type AdapterDescriptor,
} from "@mpc/domain";
import { dnsResolver, type HostResolver } from "../services/source-endpoint.js";
import {
  buildReceiptBody,
  invokeHttpAdapter,
  type HttpAdapterConfig,
} from "../services/source-adapter.js";
import { pinnedFetch, type SourceFetch } from "../services/source-fetch.js";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../errors.js";
import {
  assertAuthorized,
  sessionFacts,
  tenantResource,
} from "../plugins/authorize.js";
import {
  completeIdempotency,
  hashRequest,
  releaseIdempotency,
  reserveIdempotency,
} from "../plugins/idempotency.js";
import { recordAudit } from "../audit.js";
import { enqueueEvent } from "../outbox.js";
import { requireMutationContext } from "./shared.js";

/**
 * 공식 출처 조회 — spec 05 §5.12, OD-42.
 *
 * `services/source-adapter.ts`가 응답을 12개 결과로 나누는 규칙을 갖고, 이
 * 라우트가 그것을 부르는 유일한 진입점이다.
 *
 * 여기서 지키는 것:
 *
 * - **호출 가능 여부를 먼저 판정한다.** `pending_access`인 연동을 부르면 401을
 *   받아 "인증 실패"로 남는데, 실제로는 협의가 안 된 것이다.
 * - **receipt는 출처에 실제로 요청이 나갔을 때만 만든다.** 로컬 설정 문제로
 *   요청조차 못 보낸 것을 receipt로 남기면 "출처를 조회했다"는 기록이 된다.
 * - **출처가 답한 것은 실패라도 남긴다.** 404(기록 없음)와 503(출처 장애)은
 *   둘 다 사실이고, 버리면 다음 사람이 같은 조회를 반복한다.
 * - **자격증명은 DB에 없다.** `secret_reference`가 가리키는 곳에서만 읽고,
 *   응답·감사·로그 어디에도 값이 나가지 않는다.
 */

/** 재시도가 그대로 돌려받는 응답. 예약과 마감이 같은 형태를 다룬다. */
interface CollectResponse {
  readonly receiptId: string;
  readonly connectionId: string;
  readonly authorityId: string;
  readonly result: string;
  readonly confirmed: boolean;
  readonly effectiveAt: string | null;
  readonly limitations: string[];
  readonly detail: string | null;
  readonly requestId: string;
  readonly asOf: string;
}

const secondReviewSchema = z.object({
  observation: z.string().min(1),
  confirmed: z.boolean(),
});

const collectSchema = z.object({
  projectId: z.string().uuid(),
  // 조회 조건. receipt에 그대로 남아 재현의 근거가 된다.
  queryBasis: z.record(z.string(), z.string()),
});

interface ConnectionRow {
  readonly id: string;
  readonly connection_key: string;
  readonly collection_method: string;
  readonly state: string;
  readonly endpoint: string | null;
  readonly timeout_ms: number;
  readonly effective_at_field: string | null;
  readonly schema_fingerprint: string[] | null;
  readonly response_record_absent_field: string | null;
  readonly response_record_absent_value: string | null;
  readonly response_business_error_field: string | null;
  readonly secret_reference: string | null;
  readonly authentication_method: string;
  readonly adapter_version: string;
  readonly source_schema_version: string;
  readonly terms_license: string;
  readonly commercial_reuse: string;
  readonly disclosure_permission: string;
  readonly authority_id: string;
  readonly authority_name: string;
  readonly jurisdiction: string;
  readonly proves: string[];
  readonly does_not_prove: string[];
}

/**
 * 인증 헤더를 만든다.
 *
 * 방식은 `authentication_method`가 정하고 값은 `secret_reference`가 가리키는
 * 곳에서 온다. **값이 DB에 있으면 DB 백업·복제본·덤프가 전부 자격증명 사본이
 * 된다.**
 */
function buildAuthHeaders(row: ConnectionRow): Readonly<Record<string, string>> {
  const method = row.authentication_method;
  if (method === "none") return {};

  if (!row.secret_reference) {
    throw unprocessable(
      "SOURCE_SECRET_UNAVAILABLE",
      `연동이 ${method} 인증을 쓰지만 secret reference가 없다`,
      { connectionKey: row.connection_key },
    );
  }

  let secret: string;
  try {
    secret = resolveSecret(row.connection_key, row.secret_reference);
  } catch (error) {
    // **원인 문자열을 그대로 내보내지 않는다.** 참조 해석 실패 메시지에는
    // 경로나 환경변수 이름이 들어갈 수 있다.
    throw unprocessable("SOURCE_SECRET_UNAVAILABLE", "연동 자격증명을 읽지 못했다", {
      connectionKey: row.connection_key,
      reason: error instanceof Error ? error.name : "UnknownError",
    });
  }

  if (method === "bearer") return { authorization: `Bearer ${secret}` };

  // `header:X-Api-Key` 형태. 기관마다 헤더 이름이 다르다.
  const named = /^header:(.+)$/.exec(method);
  if (named?.[1]) return { [named[1]]: secret };

  throw unprocessable("SOURCE_AUTH_METHOD_UNSUPPORTED", `알 수 없는 인증 방식이다: ${method}`);
}

export async function registerSourceCollectRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
  /**
   * 기본값이 전역 `fetch`이면 안 된다 — 2026-09-10 실사 A2.
   *
   * 전역 `fetch`는 이름을 스스로 다시 푼다. 그러면 `assertEndpointReachable`이
   * 검사한 주소와 실제로 연결하는 주소가 다를 수 있다.
   */
  fetchImpl: SourceFetch = pinnedFetch,
  resolveHost: HostResolver = dnsResolver,
): Promise<void> {
  app.post<{ Params: { connectionId: string } }>(
    "/api/v1/source-connections/:connectionId/collect",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);

      const parsed = collectSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "요청 형식이 올바르지 않다", {
          issues: parsed.error.issues,
        });
      }

      const effectiveRole = assertAuthorized(
        session,
        "source.collect",
        tenantResource(tenantId),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request.body);

      const [connection] = await withTenant(
        sql,
        { tenantId },
        (tx) =>
          tx<ConnectionRow[]>`
          SELECT c.id, c.connection_key, c.collection_method::text AS collection_method,
                 c.state::text AS state, c.endpoint, c.timeout_ms, c.effective_at_field,
                 c.schema_fingerprint, c.response_record_absent_field,
                 c.response_record_absent_value, c.response_business_error_field,
                 c.secret_reference, c.authentication_method, c.adapter_version,
                 c.source_schema_version, c.terms_license, c.commercial_reuse,
                 c.disclosure_permission::text AS disclosure_permission,
                 a.id AS authority_id, a.name AS authority_name, a.jurisdiction,
                 a.proves, a.does_not_prove
          FROM core.source_connections c
          JOIN core.authorities a ON a.id = c.authority_id
          WHERE c.id = ${request.params.connectionId}
        `,
      );

      if (!connection) throw notFound("연동을 찾을 수 없다");

      const adapterState = connectionStateToAdapterState(connection.state);
      const reason = adapterStateReason(adapterState, connection.state);

      if (adapterState === "none") {
        throw unprocessable("SOURCE_NOT_CALLABLE", reason, {
          nextAction: "연동을 먼저 등록한다",
        });
      }

      const descriptor: AdapterDescriptor = {
        connectionKey: connection.connection_key,
        authorityName: connection.authority_name,
        jurisdiction: connection.jurisdiction,
        state: adapterState,
        proves: connection.proves,
        // 05 §5.11: 한계 없는 authority는 존재하지 않는다.
        doesNotProve: connection.does_not_prove,
        stateReason: reason,
      };

      /**
       * 호출 가능 여부를 먼저 본다.
       *
       * adapter도 같은 판정을 하지만 그쪽은 실패 결과를 돌려주고, 그 결과로
       * receipt를 만들면 "조회했는데 권한이 없었다"가 된다. 실제로는 요청을
       * 보내지 않았다. **receipt는 출처에 요청이 나갔다는 뜻으로만 쓴다.**
       */
      const availability = checkAdapterAvailable(descriptor);
      if (!availability.callable) {
        throw unprocessable("SOURCE_NOT_CALLABLE", reason, {
          adapterState,
          nextAction: availability.nextAction,
        });
      }

      if (!connection.endpoint) {
        // DB CHECK가 active + authenticated_api 조합을 막지만, 다른 수집 방식이
        // active로 올라온 경우가 여기로 온다.
        throw unprocessable(
          "SOURCE_ENDPOINT_MISSING",
          "이 연동에는 호출 대상이 없다. 자동 조회 대상이 아니다",
          { collectionMethod: connection.collection_method },
        );
      }

      const config: HttpAdapterConfig = {
        endpoint: connection.endpoint,
        headers: buildAuthHeaders(connection),
        timeoutMs: connection.timeout_ms,
        effectiveAtField: connection.effective_at_field,
        /**
         * 이 출처의 정상 응답이 어떻게 생겼는가 — 2026-09-10 실사 A7.
         *
         * `schema_fingerprint`를 bulk export와 **같이 쓴다.** 별도 컬럼을 두면
         * 같은 질문에 두 개의 답이 생기고, 둘이 갈리면 어느 쪽이 진짜인지
         * 알 수 없다. 비어 있으면 확정하지 않는다.
         */
        responseProfile: {
          requiredFields: connection.schema_fingerprint ?? [],
          recordAbsentField: connection.response_record_absent_field,
          recordAbsentValue: connection.response_record_absent_value,
          businessErrorField: connection.response_business_error_field,
        },
      };

      /**
       * 외부를 부르기 **전에** key를 잡는다.
       *
       * 순서를 뒤집으면 재시도가 그대로 출처로 나간다 — 우리 쪽 receipt는
       * 하나로 유지되지만 등록부는 요청을 두 번 받는다. rate limit과 이용 조건은
       * 우리 재시도 횟수를 모른다.
       */
      const reservation = await withTenant(sql, { tenantId }, (tx) =>
        reserveIdempotency<CollectResponse>(tx, tenantId, idempotencyKey, requestHash),
      );
      if (reservation.replay) return reservation.replay;

      let invocation;
      try {
        // **트랜잭션 밖에서 부른다.** 외부 요청이 걸린 동안 DB 연결과 잠금을 쥐고
        // 있으면 출처 한 곳이 느려질 때 수집 전체가 멈춘다.
        invocation = await invokeHttpAdapter(
          { descriptor, config, queryBasis: parsed.data.queryBasis },
          fetchImpl,
          resolveHost,
        );
      } catch (error) {
        // 예약을 풀지 않으면 이 key는 영원히 `IN_FLIGHT`가 되고 클라이언트는
        // 다시 시도할 방법이 없다.
        await releaseIdempotency(sql, tenantId, idempotencyKey);
        throw error;
      }

      const body = buildReceiptBody(descriptor, invocation, {
        connectionId: connection.id,
        authorityId: connection.authority_id,
        collectionMethod: connection.collection_method,
        authenticationMethod: connection.authentication_method,
        // 자격증명이 붙기 전의 주소만 남긴다. query string은 queryBasis에 있다.
        endpointOrDocumentRef: connection.endpoint,
        sourceSchemaVersion: connection.source_schema_version,
        adapterVersion: connection.adapter_version,
        termsLicense: connection.terms_license,
        commercialReuse: connection.commercial_reuse,
        disclosurePermission: connection.disclosure_permission,
      });

      const result = body["result"] as string;
      const confirmed = result === "confirmed_from_source";

      /**
       * 누가 이 결과를 만들었는가 — 2026-09-10 실사 A1.
       *
       * 이 표시가 있어야 DB가 "사람이 적어 넣은 API 확정"과 "서버가 불러서 받은
       * 확정"을 구분할 수 있다(제약 api_confirmation_requires_server_collection).
       */
      const collectorEvidence = {
        collector: "server_adapter",
        adapterVersion: connection.adapter_version,
        endpoint: connection.endpoint,
      };

      try {
        return await withTenant(sql, { tenantId }, async (tx) => {
          const id = randomUUID();

          await tx`
            INSERT INTO core.source_receipts (
              id, tenant_id, project_id, connection_id, authority_id, collection_method,
              result, query_basis, endpoint_or_document_ref, authentication_method,
              raw_hash, source_schema_version, adapter_version,
              terms_license, commercial_reuse, disclosure_permission,
              received_at, as_of, effective_at, freshness_status, correlation_id, limitations,
              channel_evidence
            ) VALUES (
              ${id}, ${tenantId}, ${parsed.data.projectId}, ${connection.id},
              ${connection.authority_id}, ${connection.collection_method}, ${result},
              ${tx.json(body["queryBasis"] as Record<string, string>)},
              ${connection.endpoint}, ${connection.authentication_method},
              ${body["rawHash"] as string}, ${connection.source_schema_version},
              ${connection.adapter_version}, ${connection.terms_license},
              ${connection.commercial_reuse}, ${connection.disclosure_permission},
              now(), ${body["asOf"] as string}, ${body["effectiveAt"] as string | null},
              ${body["freshnessStatus"] as string}, ${correlationId},
              ${body["limitations"] as string[]},
              ${tx.json(collectorEvidence as never)}
            )
          `;

          // 성공했을 때만 갱신한다. 이 값이 "마지막으로 실제 답을 받은 때"다.
          if (confirmed) {
            await tx`
              UPDATE core.source_connections
              SET last_success_at = now()
              WHERE id = ${connection.id}
            `;
          }

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            projectId: parsed.data.projectId,
            session,
            command: "source.collected",
            resourceType: "source_receipt",
            resourceId: id,
            correlationId,
            requestIp: request.ip,
            // 결과와 연동 키만 남긴다. queryBasis에는 식별자가 들어갈 수 있다.
            detail: { result, connectionKey: connection.connection_key },
          });

          await enqueueEvent(tx, {
            tenantId,
            eventType: "source_receipt.received",
            aggregateId: id,
            aggregateVersion: 1,
            projectId: parsed.data.projectId,
            correlationId,
            payload: { result, authorityId: connection.authority_id },
          });

          const response: CollectResponse = {
            receiptId: id,
            connectionId: connection.id,
            authorityId: connection.authority_id,
            result,
            confirmed,
            effectiveAt: (body["effectiveAt"] as string | null) ?? null,
            limitations: body["limitations"] as string[],
            detail: invocation.kind === "failed" ? invocation.detail : null,
            requestId,
            asOf,
          };

          // 같은 트랜잭션에서 마감한다. receipt는 남고 응답은 저장되지 않는
          // 상태가 생기면 재시도가 출처를 다시 부른다.
          await completeIdempotency(tx, tenantId, idempotencyKey, response);

          return response;
        });
      } catch (error) {
        await releaseIdempotency(sql, tenantId, idempotencyKey);
        throw error;
      }
    },
  );
}

/**
 * 수동 확인의 두 번째 검토 — AC-29.
 *
 * 수동 경로에는 API 응답도 서명도 없다. 한 사람의 진술이 유일한 근거이므로
 * 그것만으로 확정되면 **가장 약한 채널이 가장 쉬운 채널이 된다.**
 *
 * 처음 확인한 사람은 할 수 없다. DB CHECK도 같은 것을 막지만 거기서 걸리면
 * 500이 나가고, 보내는 쪽은 왜 막혔는지 알 수 없다.
 */
export async function registerSecondReviewRoute(
  app: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  app.post<{ Params: { receiptId: string } }>(
    "/api/v1/source-receipts/:receiptId/second-review",
    async (request) => {
      const { session, tenantId } = requireMutationContext(request);

      const parsed = secondReviewSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "요청 형식이 올바르지 않다", {
          issues: parsed.error.issues,
        });
      }

      const effectiveRole = assertAuthorized(
        session,
        "source.collect",
        tenantResource(tenantId, {
          // 다른 눈이 요건이다. conflict가 미해소면 두 번째 검토가 아니다.
          separationSensitive: true,
        }),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;

      return withTenant(sql, { tenantId }, async (tx) => {
        const [receipt] = await tx<
          {
            id: string;
            project_id: string | null;
            connection_id: string;
            authority_id: string;
            collection_method: string;
            result: string;
            query_basis: Record<string, string>;
            endpoint_or_document_ref: string;
            authentication_method: string;
            raw_hash: string;
            source_schema_version: string;
            adapter_version: string;
            terms_license: string;
            commercial_reuse: string;
            disclosure_permission: string;
            as_of: Date;
            effective_at: Date | null;
            freshness_status: string;
            limitations: string[];
            first_confirmed_by: string | null;
            second_confirmed_by: string | null;
            channel_evidence: Record<string, unknown>;
          }[]
        >`
          SELECT r.*, r.collection_method::text AS collection_method, r.result::text AS result,
                 r.disclosure_permission::text AS disclosure_permission
          FROM core.source_receipts r WHERE r.id = ${request.params.receiptId}
        `;
        if (!receipt) throw notFound("receipt를 찾을 수 없다");

        if (receipt.collection_method !== "manual_official_registry_confirmation") {
          throw unprocessable(
            "SECOND_REVIEW_NOT_APPLICABLE",
            "두 번째 검토는 수동 확인 경로에만 있다",
            { collectionMethod: receipt.collection_method },
          );
        }

        if (receipt.second_confirmed_by) {
          throw conflict("SECOND_REVIEW_ALREADY_DONE", "이미 두 번째 검토를 마쳤다");
        }

        // 이 receipt를 이미 다른 사람이 이어받았는가. append-only라 원본은
        // 그대로 남으므로 중복 이어받기를 여기서 막는다.
        const [existing] = await tx<{ id: string }[]>`
          SELECT id FROM core.source_receipts
          WHERE supersedes_receipt_id = ${receipt.id}
        `;
        if (existing) {
          throw conflict("SECOND_REVIEW_ALREADY_DONE", "이미 두 번째 검토를 마쳤다");
        }

        const check = checkSecondReview({
          firstConfirmedBy: receipt.first_confirmed_by,
          secondConfirmedBy: session.subjectId,
        });
        if (!check.ok) {
          throw forbidden("SECOND_REVIEW_SAME_PERSON", check.reason, {
            nextAction: check.nextAction,
          });
        }

        /**
         * 확인하지 못했다면 확정으로 만들지 않는다.
         *
         * 두 번째 사람이 다른 것을 봤다는 사실 자체가 기록이다. `conflicting`은
         * "둘이 다르다"를 말하며, 어느 쪽이 맞는지는 사람이 판단한다.
         */
        const nextResult = parsed.data.confirmed ? "confirmed_from_source" : "conflicting";

        /**
         * **새 receipt를 만든다.** 원본을 고치지 않는다.
         *
         * `source_receipts`는 append-only다. 두 번째 검토가 원본을 덮어쓰면
         * "한 사람만 봤을 때 무엇이라고 했는가"가 사라진다 — 나중에 두 진술이
         * 갈렸을 때 그 기록이 판단의 근거다.
         */
        const id = randomUUID();
        await tx`
          INSERT INTO core.source_receipts (
            id, tenant_id, project_id, connection_id, authority_id, collection_method,
            result, query_basis, endpoint_or_document_ref, authentication_method,
            raw_hash, source_schema_version, adapter_version,
            terms_license, commercial_reuse, disclosure_permission,
            received_at, as_of, effective_at, freshness_status, correlation_id, limitations,
            channel_evidence, first_confirmed_by, second_confirmed_by, second_confirmed_at,
            supersedes_receipt_id
          ) VALUES (
            ${id}, ${tenantId}, ${receipt.project_id}, ${receipt.connection_id},
            ${receipt.authority_id}, ${receipt.collection_method}, ${nextResult},
            ${tx.json(receipt.query_basis as never)}, ${receipt.endpoint_or_document_ref},
            ${receipt.authentication_method}, ${receipt.raw_hash},
            ${receipt.source_schema_version}, ${receipt.adapter_version},
            ${receipt.terms_license}, ${receipt.commercial_reuse},
            ${receipt.disclosure_permission}, now(), ${receipt.as_of}, ${receipt.effective_at},
            ${receipt.freshness_status}, ${correlationId}, ${receipt.limitations},
            ${tx.json({
              ...receipt.channel_evidence,
              secondReviewObservation: parsed.data.observation,
              secondReviewConfirmed: parsed.data.confirmed,
            } as never)},
            ${receipt.first_confirmed_by}, ${session.subjectId}, now(), ${receipt.id}
          )
        `;

        await recordAudit(tx, {
          effectiveRole,
          tenantId,
          session,
          command: "source_receipt.second_reviewed",
          resourceType: "source_receipt",
          resourceId: id,
          correlationId,
          requestIp: request.ip,
          reason: parsed.data.observation,
          detail: {
            supersedes: receipt.id,
            fromResult: receipt.result,
            toResult: nextResult,
          },
        });

        await enqueueEvent(tx, {
          tenantId,
          eventType: "source_receipt.received",
          aggregateId: id,
          aggregateVersion: 1,
          correlationId,
          payload: { result: nextResult, authorityId: receipt.authority_id },
        });

        return {
          receiptId: id,
          supersedesReceiptId: receipt.id,
          result: nextResult,
          confirmed: nextResult === "confirmed_from_source",
          requestId,
          asOf,
        };
      });
    },
  );
}
