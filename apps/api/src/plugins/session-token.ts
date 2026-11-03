import { randomBytes, timingSafeEqual } from "node:crypto";
import type postgres from "postgres";
import { firstFactor as firstFactorSchema } from "@mpc/api-contract";
import type {
  AssuranceLevel,
  FirstFactor,
  SecondFactor,
  ServiceScope,
} from "@mpc/api-contract";
import { keccak256 } from "@mpc/canonical";

/**
 * Session and service tokens.
 *
 * Design decisions:
 *
 * - **Opaque random tokens**, not JWT — they must be revocable at once on key loss, role change,
 *   or incident (AC-27). A JWT cannot be invalidated before it expires.
 * - The DB stores only the token's **hash**. A DB leak does not allow session theft.
 * - Lookup uses SECURITY DEFINER functions. The tenant is unknown before the token is found.
 * - A session belongs to a **subject** and records the factors it proved (0108). The wallet
 *   columns of the table held what a SIWE session signed with; SIWE sign-in is gone (0125) and
 *   nothing reads them.
 * - A service token carries a fixed prefix, so the request hook knows which table to ask without
 *   trying both. The prefix is not a secret and grants nothing; the hash lookup decides.
 */

const TOKEN_BYTES = 32;
/** Absolute session lifetime. The idle timeout (30 min) is enforced by `core.resolve_session`. */
export const SESSION_TTL_SECONDS = 8 * 60 * 60;
export const SESSION_IDLE_TIMEOUT_SECONDS = 30 * 60;

export const SERVICE_TOKEN_PREFIX = "mpcsvc_";

export interface IssuedSession {
  /** Sent only to the client. The server does not store it. */
  readonly token: string;
  readonly sessionId: string;
  readonly expiresAt: string;
}

/** A session row as `core.resolve_session` returns it. */
export interface ResolvedSessionRow {
  readonly sessionId: string;
  readonly subjectId: string;
  readonly tenantId: string;
  readonly firstFactor: FirstFactor;
  readonly secondFactor: SecondFactor | null;
  /** Restored by a recovery code: only re-enrolment, recovery codes and logout (WP3). */
  readonly recoveryLimited: boolean;
  /** The subject's current identity assurance. */
  readonly assuranceLevel: AssuranceLevel;
}

export interface ResolvedServiceToken {
  readonly tokenId: string;
  readonly subjectId: string;
  readonly tenantId: string;
  readonly scopes: readonly ServiceScope[];
  readonly assuranceLevel: AssuranceLevel;
}

export function hashToken(token: string): string {
  return keccak256(new TextEncoder().encode(token));
}

function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * A fresh session token, for the login flows that create the session row inside the database
 * function that verified the factor (emailed code, 0114). Only its hash is passed down.
 */
export function newSessionToken(): string {
  return newToken();
}

/*
 * There is no general "issue a session for this subject" here: every account session is created
 * by the database function that consumed its first factor — an emailed code
 * (`core.verify_sign_in_code`, `core.accept_invitation`, 0114) or a completed Google / Microsoft
 * login transaction (`core.complete_oidc_sign_in`, `core.complete_oidc_invitation`, 0121) — and
 * `core.create_subject_session` refuses every first factor (0121). A second factor is recorded
 * only by the MFA functions that consume its evidence (0116).
 */

export async function resolveSessionToken(
  sql: postgres.Sql,
  token: string,
): Promise<ResolvedSessionRow | null> {
  const [row] = await sql<
    {
      session_id: string;
      subject_id: string | null;
      tenant_id: string | null;
      first_factor: FirstFactor;
      second_factor: SecondFactor | null;
      recovery_limited: boolean;
      assurance_level: AssuranceLevel | null;
    }[]
  >`SELECT * FROM core.resolve_session(${hashToken(token)})`;

  if (!row) return null;
  // Fail closed on anything but an account session. 0125 revoked every SIWE session and refuses a
  // live one, so a `siwe_legacy` row, or one without a subject, cannot reach here; if one ever
  // did (a database restored from before 0125), it carries no session rather than an unbound one.
  if (!firstFactorSchema.safeParse(row.first_factor).success) return null;
  if (row.subject_id === null || row.tenant_id === null || row.assurance_level === null) return null;

  return {
    sessionId: row.session_id,
    subjectId: row.subject_id,
    tenantId: row.tenant_id,
    firstFactor: row.first_factor,
    secondFactor: row.second_factor,
    recoveryLimited: row.recovery_limited,
    assuranceLevel: row.assurance_level,
  };
}

export async function revokeSessionToken(sql: postgres.Sql, token: string): Promise<boolean> {
  const rows = await sql`SELECT core.revoke_session(${hashToken(token)}) AS revoked`;
  return rows.length > 0 && rows[0]!["revoked"] === true;
}

/**
 * Ends every live session of a subject — wallet disable now; recovery, email change and
 * authenticator removal later. `reason` is a short code stored with each revoked session.
 *
 * Call it inside `withTenant` of the subject's tenant: the database ends only sessions in the
 * current tenant, so outside it this ends none.
 */
export async function revokeSubjectSessions(
  sql: postgres.TransactionSql,
  subjectId: string,
  reason: string,
): Promise<number> {
  const [row] = await sql<{ revoked: number }[]>`
    SELECT core.revoke_subject_sessions(${subjectId}, ${reason}) AS revoked
  `;
  return row?.revoked ?? 0;
}

/** A new service token. Only the operator CLI issues one; the API only resolves them. */
export function generateServiceToken(): { token: string; hash: string } {
  const token = `${SERVICE_TOKEN_PREFIX}${newToken()}`;
  return { token, hash: hashToken(token) };
}

export function isServiceToken(token: string): boolean {
  return token.startsWith(SERVICE_TOKEN_PREFIX);
}

export async function resolveServiceToken(
  sql: postgres.Sql,
  token: string,
): Promise<ResolvedServiceToken | null> {
  const [row] = await sql<
    {
      token_id: string;
      subject_id: string;
      tenant_id: string;
      scopes: ServiceScope[];
      assurance_level: AssuranceLevel;
    }[]
  >`SELECT * FROM core.resolve_service_token(${hashToken(token)})`;

  if (!row) return null;
  return {
    tokenId: row.token_id,
    subjectId: row.subject_id,
    tenantId: row.tenant_id,
    scopes: row.scopes,
    assuranceLevel: row.assurance_level,
  };
}

/**
 * Extracts the token from the Authorization header.
 *
 * The `Bearer 0x...` (dev wallet address) form is no longer accepted. If it arrives it is
 * treated as a token, fails lookup, and yields 401 — it does not pass silently.
 */
export function extractBearerToken(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/** Constant-time comparison. Using `===` on tokens leaks timing information. */
export function tokensEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
