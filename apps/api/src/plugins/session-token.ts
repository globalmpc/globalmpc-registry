import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type postgres from "postgres";
import { keccak256 } from "@mpc/canonical";

/**
 * 세션 토큰 — R1 Task 8.
 *
 * 개발용 wallet 헤더 인증을 대체한다. 그 경로는 서명 검증 없이 주소를 믿었으므로
 * 인증 우회였다.
 *
 * 설계 결정:
 *
 * - **opaque random 토큰**을 쓴다. JWT가 아니다 — key 분실·역할 변경·incident에서
 *   즉시 폐기할 수 있어야 한다(AC-27). JWT는 만료 전까지 무효화할 수 없다.
 * - DB에는 토큰의 **해시**만 저장한다. DB가 유출돼도 세션을 탈취할 수 없다.
 * - 조회는 SECURITY DEFINER 함수로 한다. 세션을 찾기 전에는 tenant를 모른다.
 */

const TOKEN_BYTES = 32;
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

export interface IssuedSession {
  /** 클라이언트에만 전달된다. 서버는 저장하지 않는다. */
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
 * Authorization 헤더에서 토큰을 꺼낸다.
 *
 * `Bearer 0x...`(개발용 wallet 주소) 형식은 더 이상 받지 않는다. 그 형식이
 * 들어오면 토큰으로 취급되고 조회에 실패해 401이 된다 — 조용히 통과하지 않는다.
 */
export function extractBearerToken(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/** 상수 시간 비교. 토큰 비교에 `===`를 쓰면 타이밍 정보가 샌다. */
export function tokensEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
