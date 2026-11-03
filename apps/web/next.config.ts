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
const nextConfig: NextConfig = {
  transpilePackages: ["@mpc/ui", "@mpc/domain", "@mpc/canonical", "@mpc/api-contract", "@mpc/policy"],

  /**
   * Values that are **always defined at build time**. If undefined, Next does not replace
   * `process.env.NEXT_PUBLIC_*` with a literal and leaves a runtime shim, which can throw in the
   * browser. Empty means the streaming upload stays same-origin.
   */
  env: {
    NEXT_PUBLIC_API_DIRECT_ORIGIN: process.env["NEXT_PUBLIC_API_DIRECT_ORIGIN"] ?? "",
  },

  /**
   * Security headers.
   *
   * The session token is an HttpOnly cookie the page cannot read (WP6, `src/lib/bff.ts`), so an
   * injected script can act as the person while the page is open but cannot carry the token away.
   * CSP narrows what such a script can do.
   *
   * WP6 added no source: the authenticator QR code is drawn as inline SVG elements (no `data:` image,
   * no QR service), passkeys use `navigator.credentials` (governed by Permissions-Policy, whose
   * `publickey-credentials-*` default is this origin), and Google / Microsoft are reached by a
   * top-level navigation, which `connect-src` and `form-action` do not govern.
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
      {
        /**
         * The provider returns `code` and `state` in this page's query. The page strips them before
         * it calls anything, but the browser fetches the page's own scripts first; with no referrer
         * those requests do not repeat the code into this server's logs.
         */
        source: "/auth/oidc/:path*",
        headers: [
          { key: "referrer-policy", value: "no-referrer" },
          { key: "cache-control", value: "no-store" },
        ],
      },
    ];
  },

  // design-system outside the workspace is referenced via symlink, so raise the tracing root.
  outputFileTracingRoot: path.join(process.cwd(), "../.."),

  // Keep webpack's default of resolving through pnpm's symlinks. With `resolve.symlinks = false`
  // a package's imports fell through to pnpm's hidden hoist directory, which holds one version
  // per name: viem's @noble/curves then got @mpc/canonical's @noble/hashes 2 instead of its own 1.x.
  webpack(config) {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },

  // `src/proxy.ts` handles the same-origin API proxy. Putting it in rewrites() here
  // fixes the destination at build time and ignores the runtime API_ORIGIN.
};

export default nextConfig;
