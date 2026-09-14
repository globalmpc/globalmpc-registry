import type { FastifyInstance } from "fastify";

/**
 * API 응답 보안 헤더 — 10 §10.6.
 *
 * 웹 쪽 CSP는 `apps/web/next.config.ts`가 갖는다. 그 정책은 화면을 그리는 문서를
 * 위한 것이고, 여기는 **JSON만 돌려주는 표면**이다. 그래서 정책이 "무엇을
 * 허용할까"가 아니라 `default-src 'none'`이다 — API 응답이 스크립트를 부르거나
 * frame에 들어가야 할 이유가 없다.
 *
 * 헤더가 막는 것은 서버 권한 검사를 **지나온 뒤** 브라우저 쪽에서 벌어지는 일이다.
 * 오류 본문에 반사된 값이 문서로 해석되는 것, content sniffing, frame 삽입은
 * 권한 코드로는 닿지 않는다.
 *
 * 배포에서 브라우저는 `web`의 `/api/*` 프록시를 지나 여기 닿지만, API가 다른
 * 경로로 직접 노출되는 순간(디버깅, 별도 도메인, 내부 도구) 프록시가 붙여 주던
 * 헤더는 사라진다. 그러므로 API가 자기 헤더를 직접 붙인다.
 */

export interface SecurityHeaderOptions {
  /** production에서만 HSTS를 보낸다. */
  readonly production: boolean;
}

/** 1년. preload 요건이며 그보다 짧으면 중간자 다운그레이드 창이 남는다. */
const HSTS_MAX_AGE_SECONDS = 31_536_000;

export function securityHeaders(
  options: SecurityHeaderOptions,
): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {
    "content-security-policy": [
      "default-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join("; "),
    "x-content-type-options": "nosniff",
    // CSP frame-ancestors를 못 읽는 브라우저를 위한 같은 뜻의 옛 헤더.
    "x-frame-options": "DENY",
    // API 응답에는 사용자가 따라갈 링크가 없다. 보낼 referrer도 없다.
    "referrer-policy": "no-referrer",
    "permissions-policy": "geolocation=(), camera=(), microphone=(), payment=()",
    "cross-origin-resource-policy": "same-origin",
    "cross-origin-opener-policy": "same-origin",
  };

  /**
   * HSTS는 production에서만 보낸다.
   *
   * 로컬은 http다. 거기서 HSTS를 받은 브라우저는 그 호스트를 https로 강제
   * 기억하고, 같은 호스트명을 쓰는 다른 로컬 프로젝트까지 접속이 막힌다.
   * 개발자가 브라우저 설정에서 직접 지워야 풀리므로 기본값으로 두지 않는다.
   */
  if (options.production) {
    headers["strict-transport-security"] =
      `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains`;
  }

  return headers;
}

export async function registerSecurityHeaders(
  app: FastifyInstance,
  options: SecurityHeaderOptions,
): Promise<void> {
  const headers = securityHeaders(options);

  /**
   * `onRequest`에 건다.
   *
   * 상한 초과(429)와 오류 응답도 같은 헤더를 받아야 한다. 정상 경로에만 붙이면,
   * 값이 반사돼 나갈 가능성이 가장 큰 응답에서 정확히 헤더가 빠진다.
   */
  app.addHook("onRequest", async (_request, reply) => {
    for (const [name, value] of Object.entries(headers)) {
      reply.header(name, value);
    }
  });
}
