import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Throughput measurement — spec 06 §6.9, OD-32.
 *
 * **Targets are not hardcoded.** SLA/RPO/RTO figures are undecided under OD-32, and an
 * arbitrary number would become the decision. Measures and prints instead.
 *
 * Setting a threshold via environment variable turns it into a failure:
 *
 *   PERF_MAX_P95_MS=250 pnpm vitest run --project @mpc/api test/throughput.test.ts
 *
 * In CI this file's job is **to make regressions visible**. Absolute figures vary by
 * machine, so they are not used as pass criteria.
 */

interface Measurement {
  readonly label: string;
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly errors: number;
}

function summarize(label: string, durations: number[], errors: number): Measurement {
  const sorted = [...durations].sort((a, b) => a - b);
  const at = (ratio: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;

  return {
    label,
    count: durations.length,
    p50: Math.round(at(0.5) * 100) / 100,
    p95: Math.round(at(0.95) * 100) / 100,
    max: Math.round((sorted[sorted.length - 1] ?? 0) * 100) / 100,
    errors,
  };
}

/** Leaves results in human-readable form. Bare numbers hide regressions. */
function report(measurement: Measurement): void {
  process.stdout.write(
    `  ${measurement.label}: n=${measurement.count} p50=${measurement.p50}ms ` +
      `p95=${measurement.p95}ms max=${measurement.max}ms errors=${measurement.errors}\n`,
  );
}

/**
 * Threshold.
 *
 * Without one, only measures. Once OD-32 is decided, set it as a CI environment variable —
 * no code change needed.
 */
function parseThreshold(raw: string | undefined): number | null {
  // Deploy platforms inject unset variables as empty strings. That means "none".
  if (raw === undefined || raw.trim() === "") return null;

  const value = Number(raw);
  /**
   * **Throws** on a non-number. `Number("abc")` is NaN and `p95 > NaN` is always
   * false, so one typo silently disables the gate. Whoever set the value believes the gate
   * is on — a state worse than having no gate.
   */
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`PERF_MAX_P95_MS must be a positive number: ${JSON.stringify(raw)}`);
  }
  return value;
}

const MAX_P95_MS = parseThreshold(process.env["PERF_MAX_P95_MS"]);

describeDb("throughput measurement", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    token = await signIn(app, fx.operatorA);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  /** Sends concurrent requests and times each one. */
  async function measure(
    label: string,
    concurrency: number,
    makeRequest: () => Promise<{ statusCode: number }>,
  ): Promise<Measurement> {
    const durations: number[] = [];
    let errors = 0;

    const results = await Promise.all(
      Array.from({ length: concurrency }, async () => {
        const started = performance.now();
        try {
          const response = await makeRequest();
          durations.push(performance.now() - started);
          return response.statusCode;
        } catch {
          errors += 1;
          return 0;
        }
      }),
    );

    // Counts 5xx as errors. Counting them as successes makes outages look like fast responses.
    errors += results.filter((status) => status >= 500).length;

    const measurement = summarize(label, durations, errors);
    report(measurement);
    return measurement;
  }

  it("project list read", async () => {
    const measurement = await measure("GET /projects", 50, () =>
      app.inject({
        method: "GET",
        url: "/api/v1/projects",
        headers: { authorization: `Bearer ${token}` },
      }),
    );

    expect(measurement.errors).toBe(0);
    if (MAX_P95_MS !== null) expect(measurement.p95).toBeLessThanOrEqual(MAX_P95_MS);
  });

  it("public lookup (unauthenticated)", async () => {
    // Explorer opens without login. Its load is the hardest to predict.
    const measurement = await measure("GET /public/registries", 50, () =>
      app.inject({ method: "GET", url: "/api/v1/public/registries/project/NOPE" }),
    );

    expect(measurement.errors).toBe(0);
    if (MAX_P95_MS !== null) expect(measurement.p95).toBeLessThanOrEqual(MAX_P95_MS);
  });

  it("mutation — project registration", async () => {
    let counter = 0;
    const stamp = Date.now();

    const measurement = await measure("POST /projects", 20, () => {
      counter += 1;
      return app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey() },
        payload: {
          projectKey: `PERF-${stamp}-${counter}`,
          name: "for measurement",
          hostCountryIso3: "MNG",
          minerals: ["copper"],
          ownerOrganizationId: fx.orgA,
        },
      });
    });

    expect(measurement.errors).toBe(0);
    if (MAX_P95_MS !== null) expect(measurement.p95).toBeLessThanOrEqual(MAX_P95_MS);
  });

  it("auth — SIWE nonce issuance", async () => {
    // If the login path is blocked, everything else is blocked.
    const measurement = await measure("POST /auth/siwe/nonce", 30, () =>
      app.inject({
        method: "POST",
        url: "/api/v1/auth/siwe/nonce",
        payload: { walletAddress: fx.operatorA.address, chainId: 97 },
      }),
    );

    expect(measurement.errors).toBe(0);
  });

  it("reflects measurement traffic in metrics", async () => {
    // Checks that observations left by the cases above were actually collected. Otherwise
    // there is no way to see load in operations.
    const output = (await app.inject({ method: "GET", url: "/metrics" })).body;

    expect(output).toContain('route="/api/v1/projects"');
    expect(output).toContain("http_request_duration_ms_count");
  });

  it("only measures when no threshold is set", () => {
    // Until OD-32 is decided, no arbitrary number serves as a pass criterion.
    if (MAX_P95_MS === null) {
      process.stdout.write(
        "  no threshold set — set PERF_MAX_P95_MS to turn regressions into failures (OD-32)\n",
      );
    }
    expect(true).toBe(true);
  });
});
