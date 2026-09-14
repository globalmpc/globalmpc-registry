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
 * mutation 라우트의 공통 전제.
 *
 * 세션·tenant·Idempotency-Key를 한 곳에서 확인한다. 라우트마다 반복하면
 * 어느 하나에서 빠뜨렸을 때 그 라우트만 조용히 멱등성을 잃는다.
 */
/** tenant에 묶인 세션. 이 타입을 받은 라우트는 tenantId가 null인지 다시 묻지 않는다. */
export type EnrolledSession = Session & { readonly tenantId: string };

export interface MutationContext {
  readonly session: EnrolledSession;
  readonly tenantId: string;
  readonly idempotencyKey: string;
}

/**
 * 읽기 라우트의 공통 전제.
 *
 * mutation과 달리 Idempotency-Key를 요구하지 않는다. 세션·tenant 확인만 한 곳에
 * 모아 라우트마다 다르게 처리하는 것을 막는다.
 */
export interface ReadContext {
  readonly session: EnrolledSession;
  readonly tenantId: string;
}

/** 지갑은 연결됐지만 워크스페이스에 묶이지 않은 사람이 갈 곳. */
const ENROLLMENT_PATH = "/w/access-requests";

/**
 * 로그인했고 워크스페이스(tenant)에 묶인 세션.
 *
 * **둘을 같은 401로 내지 않는다.** 어느 지갑이든 SIWE로 로그인할 수 있지만
 * (`1d56c35`), 그 지갑이 조직에 묶이지 않았으면 tenant가 없다. 예전에는 이것도
 * `401 UNAUTHENTICATED`였고, 방금 서명한 사람이 "인증이 필요하다"를 보고 다시
 * 서명해도 같은 화면을 만났다. 401은 "누구인지 모른다", 403은 "누구인지는 알지만
 * 아직 들어올 자리가 없다"다.
 */
export function requireEnrolledSession(request: FastifyRequest): ReadContext {
  const session = request.session;
  if (!session) {
    throw unauthorized("UNAUTHENTICATED", "인증이 필요하다");
  }
  if (session.tenantId === null) {
    throw forbidden("WALLET_NOT_ENROLLED", "이 지갑은 아직 워크스페이스에 연결되지 않았다", {
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
      "mutation에는 16자 이상의 Idempotency-Key가 필요하다",
    );
  }

  return { session, tenantId, idempotencyKey: key };
}

/**
 * If-Match 파싱 — 07 §7.1.
 *
 * **버전이 있는 resource를 바꾸려면 어떤 버전을 보고 바꾸는지 밝혀야 한다.**
 * 없으면 마지막 쓰기가 이깁니다 — 두 사람이 같은 claim을 동시에 다루면 한쪽의
 * 판단이 흔적 없이 사라진다.
 *
 * ETag는 resource의 `version` 정수를 그대로 쓴다. 내용 해시를 쓰면 같은 내용의
 * 다른 버전을 구분하지 못하고, 클라이언트가 이미 응답 본문에서 version을 받고
 * 있으므로 새 개념을 만들 이유가 없다.
 *
 * `*`는 받지 않는다. "무엇이든 있으면 덮어쓴다"는 이 도메인에서 의미가 없다.
 */
export function requireIfMatch(request: FastifyRequest): number {
  const header = request.headers["if-match"];

  if (typeof header !== "string" || header.trim().length === 0) {
    throw preconditionRequired(
      "IF_MATCH_REQUIRED",
      "버전이 있는 resource를 바꾸려면 If-Match가 필요하다",
      { hint: '현재 version을 그대로 넣는다. 예: If-Match: "3"' },
    );
  }

  // `W/"3"`, `"3"`, `3` 을 모두 받는다. weak/strong 구분은 정수 version에서
  // 의미가 없다.
  const match = /^(?:W\/)?"?(\d+)"?$/.exec(header.trim());
  if (!match) {
    throw badRequest("IF_MATCH_INVALID", "If-Match는 resource의 version 정수여야 한다", {
      received: header,
    });
  }

  return Number(match[1]);
}

/**
 * 기대한 version과 현재 version을 대조한다.
 *
 * 불일치는 오류가 아니라 **다른 사람이 먼저 바꿨다**는 사실이다. 응답에 현재
 * version을 담아 클라이언트가 다시 읽을 수 있게 한다.
 */
export function assertVersionMatches(
  expected: number,
  current: number,
  resourceType: string,
): void {
  if (expected === current) return;

  throw preconditionFailed(
    "RESOURCE_VERSION_MISMATCH",
    "이 resource는 조회 이후에 바뀌었다. 다시 읽고 판단한다",
    { resourceType, expectedVersion: String(expected), currentVersion: String(current) },
  );
}

/** ETag 헤더 값. 응답의 version과 같은 값이어야 한다. */
export function etagOf(version: number): string {
  return `"${version}"`;
}
