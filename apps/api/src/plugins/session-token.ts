import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type postgres from "postgres";
import { keccak256 } from "@mpc/canonical";

/**
 * Session token — R1 Task 8.
 *
 * Replaces dev wallet header authentication. That path trusted the address without signature
 * verification, so it was an auth bypass.
 *
 * Design decisions:
 *
 * - Uses an **opaque random token**, not JWT — it must be revocable at once on key loss, role
 *   change, or incident (AC-27). A JWT cannot be invalidated before it expires.
 * - The DB stores only the token's **hash**. A DB leak does not allow session theft.
 * - Lookup uses a SECURITY DEFINER function. The tenant is unknown before the session is found.
 */

const TOKEN_BYTES = 32;
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

export interface IssuedSession {
  /** Sent only to the client. The server does not store it. */
  readonly token: string;
  readonly sessionId: string;
  readonly expiresAt: string;
}

export function hashToken(token: string): string {
  return keccak256(new TextEncoder().encode(token));
}

export async function issueSessionToken(
  sql: postgres.Sql,
  walletAddress: string,
  chainId: number,
): Promise<IssuedSession> {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const sessionId = randomUUID();

  const [row] = await sql<{ create_session: Date }[]>`
    SELECT core.create_session(
      ${sessionId}, ${hashToken(token)}, ${walletAddress.toLowerCase()},
      ${chainId}, ${SESSION_TTL_SECONDS}
    ) AS create_session
  `;

  return {
    token,
    sessionId,
    expiresAt: row!.create_session.toISOString(),
  };
}

export async function resolveSessionToken(
  sql: postgres.Sql,
  token: string,
): Promise<{ walletAddress: `0x${string}`; chainId: number; sessionId: string } | null> {
  const [row] = await sql<
    { wallet_address: string; chain_id: number; session_id: string }[]
  >`SELECT * FROM core.resolve_session_token(${hashToken(token)})`;

  if (!row) return null;

  return {
    walletAddress: row.wallet_address as `0x${string}`,
    chainId: row.chain_id,
    sessionId: row.session_id,
  };
}

export async function revokeSessionToken(sql: postgres.Sql, token: string): Promise<boolean> {
  const rows = await sql`SELECT core.revoke_session(${hashToken(token)}) AS revoked`;
  return rows.length > 0 && rows[0]!["revoked"] === true;
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
