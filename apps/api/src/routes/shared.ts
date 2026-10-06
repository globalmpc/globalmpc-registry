import type { FastifyRequest } from "fastify";
import {
  badRequest,
  forbidden,
  preconditionFailed,
  preconditionRequired,
  unauthorized,
} from "../errors.js";
import type { Session } from "../plugins/session.js";

/**
 * Common preconditions for mutation routes.
 *
 * Session, tenant, and Idempotency-Key are checked in one place. Repeated per route, missing
 * it in any one route makes that route alone silently lose idempotency.
 */
/** A tenant-bound session. Routes receiving this type do not re-check whether tenantId is null. */
export type EnrolledSession = Session & { readonly tenantId: string };

export interface MutationContext {
  readonly session: EnrolledSession;
  readonly tenantId: string;
  readonly idempotencyKey: string;
}

/**
 * Common preconditions for read routes.
 *
 * Unlike mutations, no Idempotency-Key is required. Session and tenant checks live in one
 * place so routes do not handle them differently.
 */
export interface ReadContext {
  readonly session: EnrolledSession;
  readonly tenantId: string;
}

/** Where someone goes whose wallet is connected but not bound to a workspace. */
const ENROLLMENT_PATH = "/w/access-requests";

/**
 * A signed-in session bound to a workspace (tenant).
 *
 * **The two are not both answered with 401.** Any wallet can sign in with SIWE
 * (`1d56c35`), but if that wallet is not bound to an organization there is no tenant. This
 * used to be `401 UNAUTHENTICATED` too, and someone who had just signed saw "authentication
 * required" and hit the same screen after signing again. 401 means "we do not know who you
 * are"; 403 means "we know who you are, but there is no place for you yet".
 */
export function requireEnrolledSession(request: FastifyRequest): ReadContext {
  const session = request.session;
  if (!session) {
    throw unauthorized("UNAUTHENTICATED", "Authentication required");
  }
  if (session.tenantId === null) {
    throw forbidden("WALLET_NOT_ENROLLED", "This wallet is not yet connected to a workspace", {
      reason: "WALLET_NOT_ENROLLED",
      accessRequestPath: ENROLLMENT_PATH,
    });
  }
  const tenantId = session.tenantId;
  return { session: { ...session, tenantId }, tenantId };
}

export function requireReadContext(request: FastifyRequest): ReadContext {
  return requireEnrolledSession(request);
}

export function requireMutationContext(request: FastifyRequest): MutationContext {
  const { session, tenantId } = requireEnrolledSession(request);

  const key = request.headers["idempotency-key"];
  if (typeof key !== "string" || key.length < 16) {
    throw badRequest(
      "IDEMPOTENCY_KEY_REQUIRED",
      "Mutations require an Idempotency-Key of at least 16 characters",
    );
  }

  return { session, tenantId, idempotencyKey: key };
}

/**
 * If-Match parsing — 07 §7.1.
 *
 * **Changing a versioned resource requires stating which version the change is based on.**
 * Without it, the last write wins — when two people handle the same claim at once, one
 * person's decision disappears without a trace.
 *
 * The ETag is the resource's `version` integer as is. A content hash cannot distinguish
 * different versions with the same content, and clients already receive version in the
 * response body, so there is no reason for a new concept.
 *
 * `*` is not accepted. "Overwrite whatever exists" has no meaning in this domain.
 */
export function requireIfMatch(request: FastifyRequest): number {
  const header = request.headers["if-match"];

  if (typeof header !== "string" || header.trim().length === 0) {
    throw preconditionRequired(
      "IF_MATCH_REQUIRED",
      "Changing a versioned resource requires If-Match",
      { hint: 'Pass the current version as is. Example: If-Match: "3"' },
    );
  }

  // Accepts `W/"3"`, `"3"`, and `3`. The weak/strong distinction has no meaning for an
  // integer version.
  const match = /^(?:W\/)?"?(\d+)"?$/.exec(header.trim());
  if (!match) {
    throw badRequest("IF_MATCH_INVALID", "If-Match must be the resource's integer version", {
      received: header,
    });
  }

  return Number(match[1]);
}

/**
 * Compares the expected version with the current version.
 *
 * A mismatch is not an error but the fact that **someone else changed it first**. The
 * response carries the current version so the client can reread.
 */
export function assertVersionMatches(
  expected: number,
  current: number,
  resourceType: string,
): void {
  if (expected === current) return;

  throw preconditionFailed(
    "RESOURCE_VERSION_MISMATCH",
    "This resource changed after it was read. Reread and decide again.",
    { resourceType, expectedVersion: String(expected), currentVersion: String(current) },
  );
}

/** ETag header value. Must equal the response's version. */
export function etagOf(version: number): string {
  return `"${version}"`;
}
