import path from "node:path";
import type { NextConfig } from "next";

/**
 * 워크스페이스 패키지는 빌드 없이 소스로 소비한다.
 *
 * 두 가지 설정이 필요하다.
 *
 * 1. `transpilePackages` — `@mpc/*`는 dist를 만들지 않고 TS 소스를 그대로
 *    노출한다. Next가 이들을 트랜스파일하도록 명시한다.
 * 2. `extensionAlias` — 패키지 내부가 `./foo.js`로 서로를 import한다(NodeNext
 *    규칙). 번들러가 그 `.js`를 `.ts`로 매핑해야 한다.
 *
 * 이 두 설정이 webpack 전용이므로 **dev·build 모두 `--webpack`으로 돈다.** Next 16의
 * 기본 번들러는 Turbopack이고, turbopack 설정 없이 webpack 설정만 있으면 기동
 * 자체를 거절한다. 플래그는 `package.json`의 `dev`·`build` 스크립트에 있고,
 * `playwright.config.ts`의 webServer도 같은 플래그를 쓴다 — 세 곳이 갈리면
 * 로컬에서만 되는 구간이 생긴다.
 */
/**
 * 데모 계정 키 — 빌드 시점 판정.
 *
 * production 빌드에 키가 들어가면 그 값을 아는 누구나 배포된 주소에서 그 역할로
 * 로그인한다. 지금까지 이것을 막는 것은 "배포 compose가 값을 주지 않는다"뿐이었고
 * 코드는 막지 않았다 — 설정 하나가 곧 인증 우회가 되는 상태다.
 *
 * 조용히 비우지 않고 빌드를 멈춘다. 비우면 로그인 화면에 계정이 없는 것만 보이고
 * 왜 없는지 알 수 없다.
 */
function demoAccountKeys(): string {
  const raw = process.env["NEXT_PUBLIC_DEMO_ACCOUNT_KEYS"] ?? "{}";
  if (process.env.NODE_ENV === "production" && raw.trim() !== "{}" && raw.trim() !== "") {
    throw new Error(
      "production 빌드에 NEXT_PUBLIC_DEMO_ACCOUNT_KEYS를 넣을 수 없다 — 키를 아는 누구나 그 역할로 로그인한다",
    );
  }
  return raw;
}

const nextConfig: NextConfig = {
  transpilePackages: ["@mpc/ui", "@mpc/domain", "@mpc/canonical"],

  /**
   * 데모 계정 키를 **빌드 시점에 항상 정의된 값**으로 만든다.
   *
   * 정의하지 않으면 Next는 `process.env.NEXT_PUBLIC_*`를 리터럴로 치환하지 않고
   * 런타임 shim으로 남긴다. 그러면 값이 없을 때 `undefined`가 아니라 shim 조회가
   * 되어 브라우저에서 예외가 날 수 있다. 기본값은 빈 객체다 — 데모 계정 없음.
   *
   * 키는 저장소에 없다(`lib/session`). E2E가 실행마다 만들어 넣는다.
   */
  env: {
    NEXT_PUBLIC_DEMO_ACCOUNT_KEYS: demoAccountKeys(),
  },

  /**
   * 보안 헤더.
   *
   * 세션 토큰이 `localStorage`에 있으므로 XSS 한 번이면 그대로 읽힌다. CSP가
   * 그 표면을 좁힌다.
   *
   * **`script-src`에 `'unsafe-inline'`이 남아 있다.** Next가 하이드레이션
   * 부트스트랩을 인라인 스크립트로 넣기 때문이고, nonce를 붙이려면 모든 응답을
   * 동적 렌더링으로 바꿔야 한다. 그래서 이 CSP는 스크립트 주입을 막지 못한다 —
   * 막는 것은 외부 오리진으로의 유출·프레이밍·플러그인 실행이다. 그 한계를
   * 적어 둔다.
   *
   * **개발 서버에서만 `'unsafe-eval'`을 연다.** webpack의 dev 번들은 모듈을
   * `eval`로 감싸므로, 이것이 막히면 하이드레이션이 통째로 죽는다 — 화면은
   * 렌더되는데 아무 버튼도 듣지 않는 상태가 되고 E2E가 전부 깨진다. 배포
   * 빌드에는 eval이 없으므로 prod 정책은 그대로 좁게 둔다.
   */
  async headers() {
    const scriptSrc =
      process.env.NODE_ENV === "development"
        ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
        : "script-src 'self' 'unsafe-inline'";

    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "content-security-policy",
            value: [
              "default-src 'self'",
              scriptSrc,
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data:",
              "font-src 'self' data:",
              // API는 same-origin 프록시를 지난다(`src/proxy.ts`). 지갑 확장은
              // 페이지가 아니라 브라우저가 부르므로 여기 열 필요가 없다.
              "connect-src 'self'",
              "object-src 'none'",
              "base-uri 'none'",
              "form-action 'self'",
              "frame-ancestors 'none'",
            ].join("; "),
          },
          { key: "x-content-type-options", value: "nosniff" },
          { key: "x-frame-options", value: "DENY" },
          { key: "referrer-policy", value: "strict-origin-when-cross-origin" },
          // 지갑 서명 외에 브라우저 장치 권한을 쓰지 않는다.
          { key: "permissions-policy", value: "camera=(), microphone=(), geolocation=()" },
          {
            key: "strict-transport-security",
            value: "max-age=31536000; includeSubDomains",
          },
        ],
      },
    ];
  },

  // 워크스페이스 밖의 design-system을 심볼릭 링크로 참조하므로 추적 루트를 올린다.
  outputFileTracingRoot: path.join(process.cwd(), "../.."),

  webpack(config) {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    config.resolve.symlinks = false;
    return config;
  },

  // API를 same-origin으로 프록시하는 것은 `src/proxy.ts`가 한다. 여기 rewrites()에
  // 두면 목적지가 빌드 시점에 고정되어 실행 시점의 API_ORIGIN이 무시된다.
};

export default nextConfig;
