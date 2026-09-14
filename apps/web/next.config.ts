import path from "node:path";
import type { NextConfig } from "next";

/**
 * Workspace packages are consumed as source, without a build.
 *
 * Two settings are required.
 *
 * 1. `transpilePackages` — `@mpc/*` exposes TS source directly without producing dist.
 *    Tell Next explicitly to transpile them.
 * 2. `extensionAlias` — package internals import each other as `./foo.js` (NodeNext
 *    convention). The bundler must map that `.js` to `.ts`.
 *
 * Both settings are webpack-only, so **dev and build both run with `--webpack`.** Next 16's
 * default bundler is Turbopack, and with webpack config but no turbopack config it refuses to
 * start at all. The flag lives in the `dev` and `build` scripts of `package.json`, and
 * the webServer in `playwright.config.ts` uses the same flag — if the three diverge,
 * some paths work only locally.
 */
/**
 * Demo account keys — build-time check.
 *
 * If keys end up in a production build, anyone who knows them can log in with that role at the
 * deployed address. Until now the only safeguard was "the deployment compose does not provide the value";
 * the code did not block it — a single setting was an authentication bypass.
 *
 * Stop the build instead of silently emptying the value. Emptying it would only show a login screen with
 * no accounts and no explanation why.
 */
function demoAccountKeys(): string {
  const raw = process.env["NEXT_PUBLIC_DEMO_ACCOUNT_KEYS"] ?? "{}";
  if (process.env.NODE_ENV === "production" && raw.trim() !== "{}" && raw.trim() !== "") {
    throw new Error(
      "NEXT_PUBLIC_DEMO_ACCOUNT_KEYS cannot be set in a production build — anyone who knows the keys can log in with those roles",
    );
  }
  return raw;
}

const nextConfig: NextConfig = {
  transpilePackages: ["@mpc/ui", "@mpc/domain", "@mpc/canonical"],

  /**
   * Make the demo account keys **a value that is always defined at build time**.
   *
   * If undefined, Next does not replace `process.env.NEXT_PUBLIC_*` with a literal and
   * leaves a runtime shim. Then a missing value becomes a shim lookup instead of `undefined`
   * and can throw in the browser. The default is an empty object — no demo accounts.
   *
   * Keys are not in the repository (`lib/session`). E2E generates and injects them on every run.
   */
  env: {
    NEXT_PUBLIC_DEMO_ACCOUNT_KEYS: demoAccountKeys(),
  },

  /**
   * Security headers.
   *
   * The session token is in `localStorage`, so a single XSS can read it. CSP
   * narrows that surface.
   *
   * **`script-src` still contains `'unsafe-inline'`.** Next injects its hydration
   * bootstrap as an inline script, and adding a nonce would require switching every response
   * to dynamic rendering. So this CSP does not stop script injection —
   * it stops exfiltration to external origins, framing, and plugin execution. That limitation
   * is recorded here.
   *
   * **`'unsafe-eval'` is allowed only on the dev server.** webpack's dev bundle wraps modules
   * in `eval`, so blocking it kills hydration entirely — the screen
   * renders but no button responds, and every E2E test fails. Production
   * builds contain no eval, so the prod policy stays narrow.
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
              // The API goes through the same-origin proxy (`src/proxy.ts`). Wallet extensions
              // are called by the browser, not the page, so they need no entry here.
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
          // No browser device permissions are used besides wallet signing.
          { key: "permissions-policy", value: "camera=(), microphone=(), geolocation=()" },
          {
            key: "strict-transport-security",
            value: "max-age=31536000; includeSubDomains",
          },
        ],
      },
    ];
  },

  // design-system outside the workspace is referenced via symlink, so raise the tracing root.
  outputFileTracingRoot: path.join(process.cwd(), "../.."),

  webpack(config) {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    config.resolve.symlinks = false;
    return config;
  },

  // `src/proxy.ts` handles the same-origin API proxy. Putting it in rewrites() here
  // fixes the destination at build time and ignores the runtime API_ORIGIN.
};

export default nextConfig;
