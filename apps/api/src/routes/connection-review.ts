import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { withTenant } from "@mpc/db";
import { createConnectionSecurityReviewRequest } from "@mpc/api-contract";
import { badRequest, notFound, unprocessable } from "../errors.js";
import { assertAuthorized, sessionFacts, tenantResource } from "../plugins/authorize.js";
import { hashRequest, withIdempotency } from "../plugins/idempotency.js";
import { recordAudit } from "../audit.js";
import { assertVersionMatches, requireIfMatch, requireMutationContext } from "./shared.js";

/**
 * Source connection security review — spec 02 §2.8.
 *
 * Configuring a connection and clearing it for use are different acts by different people. A
 * `security_operator` reviews **one version** of a connection; activation then requires an
 * approved review of exactly that version, by someone other than whoever activates it.
 *
 * The DB trigger `source_connections_require_security_review` refuses activation without an
 * approved review of the version, so a route that forgets to call `assertActivationReviewed`
 * still cannot activate. This file adds the second-person check the trigger cannot see (the DB
 * does not know who is calling) and turns foreseeable refusals into 422s with a reason.
 */

/**
 * Fields whose change moves a connection somewhere the review did not look — where it connects,
 * with what credential, and on what data rights (terms, reuse, disclosure).
 */
const REVIEWED_FIELDS = [
  "endpoint",
  "secretReference",
  "authenticationMethod",
  "accessBasis",
  "termsLicense",
  "commercialReuse",
  "disclosurePermission",
] as const;

interface ReviewedConnection {
  readonly id: string;
  readonly version: number;
  readonly state: string;
  readonly endpoint: string | null;
  readonly secret_reference: string | null;
  readonly authentication_method: string;
  readonly access_basis: string;
  readonly terms_license: string;
  readonly commercial_reuse: string;
  readonly disclosure_permission: string;
}

type ReviewedChange = Partial<Record<(typeof REVIEWED_FIELDS)[number], unknown>> & {
  readonly state?: string | undefined;
};

function changesReviewedFields(current: ReviewedConnection, change: ReviewedChange): boolean {
  const before: Record<(typeof REVIEWED_FIELDS)[number], unknown> = {
    endpoint: current.endpoint,
    secretReference: current.secret_reference,
    authenticationMethod: current.authentication_method,
    accessBasis: current.access_basis,
    termsLicense: current.terms_license,
    commercialReuse: current.commercial_reuse,
    disclosurePermission: current.disclosure_permission,
  };
  return REVIEWED_FIELDS.some(
    (field) => change[field] !== undefined && change[field] !== before[field],
  );
}

/** Creating a connection in the `active` state skips review, so creation never activates. */
export function assertNotCreatedActive(state: string | undefined): void {
  if (state === "active") {
    throw unprocessable(
      "CONNECTION_SECURITY_REVIEW_REQUIRED",
      "A connection is created inactive; it is activated after a security review",
      { hint: "Create it as planned, have a security operator review it, then activate" },
    );
  }
}

/**
 * Checks an update against the review rules. Call inside the update transaction, after the
 * connection row is locked.
 */
export async function assertActivationReviewed(
  tx: postgres.TransactionSql,
  current: ReviewedConnection,
  change: ReviewedChange,
  activatingSubjectId: string | null,
): Promise<void> {
  const nextState = change.state ?? current.state;

  if (current.state === "active" && nextState === "active" && changesReviewedFields(current, change)) {
    throw unprocessable(
      "CONNECTION_REVIEW_INVALIDATED",
      "An active connection cannot be re-pointed without a new security review",
      { hint: "Move it out of active, change it, have it reviewed, then activate" },
    );
  }

  if (nextState !== "active" || current.state === "active") return;

  if (changesReviewedFields(current, change)) {
    throw unprocessable(
      "CONNECTION_REVIEW_INVALIDATED",
      "Activation cannot change the reviewed configuration in the same step",
      { hint: "Save the change first, have that version reviewed, then activate" },
    );
  }

  const [latest] = await tx<{ decision: string; reviewed_by_subject_id: string }[]>`
    SELECT decision, reviewed_by_subject_id FROM core.connection_security_reviews
    WHERE connection_id = ${current.id} AND connection_version = ${current.version}
    ORDER BY reviewed_at DESC, id DESC
    LIMIT 1
  `;

  if (latest?.decision !== "approved") {
    throw unprocessable(
      "CONNECTION_SECURITY_REVIEW_REQUIRED",
      "This connection version has no approved security review",
      { connectionVersion: String(current.version) },
    );
  }
  if (latest.reviewed_by_subject_id === activatingSubjectId) {
    throw unprocessable(
      "CONNECTION_REVIEW_SAME_PERSON",
      "The reviewer cannot also activate the connection",
      { hint: "Another connection admin activates it" },
    );
  }
}

export async function registerConnectionReviewRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  app.post<{ Params: { connectionId: string } }>(
    "/api/v1/source-connections/:connectionId/security-reviews",
    async (request, reply) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      // The version reviewed is the version the reviewer read. Reviewing "whatever is there now"
      // would approve a configuration changed after the reviewer looked.
      const expected = requireIfMatch(request);
      const effectiveRole = assertAuthorized(
        session,
        "connection.security_review",
        tenantResource(tenantId),
        sessionFacts(session),
      );

      const parsed = createConnectionSecurityReviewRequest.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "Request format is invalid", {
          issues: parsed.error.issues,
        });
      }

      const { requestId, asOf, correlationId } = request.context;
      const result = await withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
          const [connection] = await tx<{ id: string; version: number; state: string }[]>`
            SELECT id, version, state::text AS state FROM core.source_connections
            WHERE id = ${request.params.connectionId}
            FOR SHARE
          `;
          if (!connection) throw notFound("Connection not found");
          assertVersionMatches(expected, connection.version, "source_connection");

          const id = randomUUID();
          const [row] = await tx<{ reviewed_at: Date }[]>`
            INSERT INTO core.connection_security_reviews (
              id, tenant_id, connection_id, connection_version, decision, reason,
              reviewed_by_subject_id
            ) VALUES (
              ${id}, ${tenantId}, ${connection.id}, ${connection.version}, ${parsed.data.decision},
              ${parsed.data.reason}, ${session.subjectId}
            )
            RETURNING reviewed_at
          `;

          await recordAudit(tx, {
            tenantId,
            session,
            effectiveRole,
            command: `source_connection.security_review_${parsed.data.decision}`,
            resourceType: "source_connection",
            resourceId: connection.id,
            beforeVersion: connection.version,
            afterVersion: connection.version,
            reason: parsed.data.reason,
            correlationId,
            requestIp: request.clientIp,
            detail: { reviewId: id, connectionState: connection.state },
          });

          return {
            id,
            connectionId: connection.id,
            connectionVersion: connection.version,
            decision: parsed.data.decision,
            reason: parsed.data.reason,
            reviewedBySubjectId: session.subjectId,
            reviewedAt: row!.reviewed_at.toISOString(),
          };
        }),
      );
      return reply.code(201).send({ ...result, requestId, asOf });
    },
  );
}
