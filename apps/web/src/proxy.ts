import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * `/api/*`를 API 서버로 same-origin 프록시한다.
 *
 * CORS를 여는 대신 프록시를 쓰는 이유: 브라우저 요청이 같은 출처가 되므로 세션
 * 쿠키로 전환할 때 SameSite 설정을 그대로 쓸 수 있다. CORS + 크로스 오리진 쿠키는
 * 설정 실수가 그대로 인증 우회가 된다.
 *
 * **`next.config.ts`의 `rewrites()`가 아니라 여기 있는 이유가 있다.** `rewrites()`는
 * 빌드 시점에 평가되어 목적지 문자열이 `routes-manifest.json`에 박힌다. 이미지를
 * 만들 때는 API 주소를 모르므로 기본값 `http://localhost:3001`이 박히고, 실행
 * 시점에 준 `API_ORIGIN`은 무시된다 — 컨테이너 안에서 localhost는 자기 자신이라
 * 모든 API 호출이 갈 곳을 잃는다. proxy는 요청마다 실행되므로 그 시점의
 * 환경변수를 읽는다.
 *
 * 기본값은 로컬 개발용이다. 배포에서는 반드시 주어진다.
 */
export function proxy(request: NextRequest): NextResponse {
  const origin = process.env.API_ORIGIN ?? "http://localhost:3001";
  const { pathname, search } = request.nextUrl;

  return NextResponse.rewrite(new URL(`${pathname}${search}`, origin));
}

export const config = {
  matcher: "/api/:path*",
};
