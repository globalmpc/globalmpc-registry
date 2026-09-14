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
 * Official source lookup — spec 05 §5.12, OD-42.
 *
 * `services/source-adapter.ts` owns the rules that split a response into 12 outcomes; this
 * route is the only entry point that calls it.
 *
 * What this route guarantees:
 *
 * - **Callability is decided first.** Calling a `pending_access` connection returns 401
 *   and is recorded as "authentication failed", when access was in fact never agreed.
 * - **A receipt is created only when a request actually reached the source.** A receipt for
 *   a request that local config kept from leaving would read as "the source was queried".
 * - **Whatever the source answered is kept, even failures.** 404 (no record) and 503 (source
 *   outage) are both facts; discarding them makes the next person repeat the same lookup.
 * - **Credentials are not in the DB.** They are read only from where `secret_reference` points,
 *   and the value never appears in responses, audit entries, or logs.
 */

/** The response a retry gets back verbatim. Reservation and completion handle the same shape. */
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
  // Query parameters. Stored verbatim in the receipt as the basis for reproduction.
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
 * Builds the authentication header.
 *
 * `authentication_method` sets the scheme; the value comes from where `secret_reference`
 * points. **If the value were in the DB, every DB backup, replica, and dump would be a copy
 * of the credential.**
 */
function buildAuthHeaders(row: ConnectionRow): Readonly<Record<string, string>> {
  const method = row.authentication_method;
  if (method === "none") return {};

  if (!row.secret_reference) {
    throw unprocessable(
      "SOURCE_SECRET_UNAVAILABLE",
      `Connection uses ${method} authentication but has no secret reference`,
      { connectionKey: row.connection_key },
    );
  }

  let secret: string;
  try {
    secret = resolveSecret(row.connection_key, row.secret_reference);
  } catch (error) {
    // **The cause string is not passed through.** A reference resolution failure message
    // can contain paths or environment variable names.
    throw unprocessable("SOURCE_SECRET_UNAVAILABLE", "Failed to read connection credentials", {
      connectionKey: row.connection_key,
      reason: error instanceof Error ? error.name : "UnknownError",
    });
  }

  if (method === "bearer") return { authorization: `Bearer ${secret}` };

  // `header:X-Api-Key` form. Header names differ by authority.
  const named = /^header:(.+)$/.exec(method);
  if (named?.[1]) return { [named[1]]: secret };

  throw unprocessable("SOURCE_AUTH_METHOD_UNSUPPORTED", `Unknown authentication method: ${method}`);
}

export async function registerSourceCollectRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
  /**
   * The default must not be global `fetch` — 2026-09-10 audit A2.
   *
   * Global `fetch` re-resolves the hostname itself, so the address `assertEndpointReachable`
   * checked can differ from the address actually connected to.
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
        throw badRequest("REQUEST_INVALID", "Request format is invalid", {
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

      if (!connection) throw notFound("Connection not found");

      const adapterState = connectionStateToAdapterState(connection.state);
      const reason = adapterStateReason(adapterState, connection.state);

      if (adapterState === "none") {
        throw unprocessable("SOURCE_NOT_CALLABLE", reason, {
          nextAction: "Register the connection first",
        });
      }

      const descriptor: AdapterDescriptor = {
        connectionKey: connection.connection_key,
        authorityName: connection.authority_name,
        jurisdiction: connection.jurisdiction,
        state: adapterState,
        proves: connection.proves,
        // 05 §5.11: no authority exists without limitations.
        doesNotProve: connection.does_not_prove,
        stateReason: reason,
      };

      /**
       * Checks callability first.
       *
       * The adapter makes the same decision but returns a failure outcome; creating a receipt from
       * it would record "queried, but not authorized". In fact no request was
       * sent. **A receipt means only that a request reached the source.**
       */
      const availability = checkAdapterAvailable(descriptor);
      if (!availability.callable) {
        throw unprocessable("SOURCE_NOT_CALLABLE", reason, {
          adapterState,
          nextAction: availability.nextAction,
        });
      }

      if (!connection.endpoint) {
        // The DB CHECK blocks active + authenticated_api, but a connection with another collection
        // method that was made active lands here.
        throw unprocessable(
          "SOURCE_ENDPOINT_MISSING",
          "This connection has no endpoint. It is not eligible for automated lookup.",
          { collectionMethod: connection.collection_method },
        );
      }

      const config: HttpAdapterConfig = {
        endpoint: connection.endpoint,
        headers: buildAuthHeaders(connection),
        timeoutMs: connection.timeout_ms,
        effectiveAtField: connection.effective_at_field,
        /**
         * What a normal response from this source looks like — 2026-09-10 audit A7.
         *
         * `schema_fingerprint` is **shared** with bulk export. A separate column would give
         * two answers to the same question, and if they diverged there would be no way to tell
         * which is right. If empty, the result is not confirmed.
         */
        responseProfile: {
          requiredFields: connection.schema_fingerprint ?? [],
          recordAbsentField: connection.response_record_absent_field,
          recordAbsentValue: connection.response_record_absent_value,
          businessErrorField: connection.response_business_error_field,
        },
      };

      /**
       * Reserves the key **before** calling out.
       *
       * In the reverse order, a retry goes straight to the source — our side keeps one receipt,
       * but the registry receives the request twice. Rate limits and terms of use do not
       * know our retry count.
       */
      const reservation = await withTenant(sql, { tenantId }, (tx) =>
        reserveIdempotency<CollectResponse>(tx, tenantId, idempotencyKey, requestHash),
      );
      if (reservation.replay) return reservation.replay;

      let invocation;
      try {
        // **Called outside the transaction.** Holding a DB connection and locks during an external
        // request means one slow source stalls all collection.
        invocation = await invokeHttpAdapter(
          { descriptor, config, queryBasis: parsed.data.queryBasis },
          fetchImpl,
          resolveHost,
        );
      } catch (error) {
        // If the reservation is not released, this key stays `IN_FLIGHT` forever and the client
        // has no way to retry.
        await releaseIdempotency(sql, tenantId, idempotencyKey);
        throw error;
      }

      const body = buildReceiptBody(descriptor, invocation, {
        connectionId: connection.id,
        authorityId: connection.authority_id,
        collectionMethod: connection.collection_method,
        authenticationMethod: connection.authentication_method,
        // Records only the URL before credentials are attached. The query string is in queryBasis.
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
       * Who produced this result — 2026-09-10 audit A1.
       *
       * This marker lets the DB tell "an API confirmation a person typed in" from "a confirmation
       * the server fetched" (constraint api_confirmation_requires_server_collection).
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

          // Updated only on success. This value is "the last time a real answer was received".
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
            // Records only the outcome and connection key. queryBasis can contain identifiers.
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

          // Completes in the same transaction. A state where the receipt exists but the response is
          // not stored would make a retry call the source again.
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
 * Second review of a manual check — AC-29.
 *
 * The manual path has no API response and no signature. One person's statement is the only
 * evidence, so if that alone confirmed it, **the weakest channel would become the easiest.**
 *
 * The first checker cannot do it. The DB CHECK blocks the same thing, but tripping it
 * returns a 500 and the caller cannot tell why it was blocked.
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
        throw badRequest("REQUEST_INVALID", "Request format is invalid", {
          issues: parsed.error.issues,
        });
      }

      const effectiveRole = assertAuthorized(
        session,
        "source.collect",
        tenantResource(tenantId, {
          // A different reviewer is required. An unresolved conflict is not a second review.
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
        if (!receipt) throw notFound("Receipt not found");

        if (receipt.collection_method !== "manual_official_registry_confirmation") {
          throw unprocessable(
            "SECOND_REVIEW_NOT_APPLICABLE",
            "Second review exists only on the manual check path",
            { collectionMethod: receipt.collection_method },
          );
        }

        if (receipt.second_confirmed_by) {
          throw conflict("SECOND_REVIEW_ALREADY_DONE", "Second review is already done");
        }

        // Has someone already followed up on this receipt? The table is append-only, so the original
        // stays as is; duplicate follow-ups are blocked here.
        const [existing] = await tx<{ id: string }[]>`
          SELECT id FROM core.source_receipts
          WHERE supersedes_receipt_id = ${receipt.id}
        `;
        if (existing) {
          throw conflict("SECOND_REVIEW_ALREADY_DONE", "Second review is already done");
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
         * If it could not be verified, it is not made confirmed.
         *
         * That the second person saw something different is itself the record. `conflicting`
         * says "the two differ"; a person decides which is right.
         */
        const nextResult = parsed.data.confirmed ? "confirmed_from_source" : "conflicting";

        /**
         * **Creates a new receipt.** The original is not modified.
         *
         * `source_receipts` is append-only. If the second review overwrote the original, "what it
         * said when only one person had looked" would be lost — when the two statements later
         * diverge, that record is the evidence for the decision.
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
