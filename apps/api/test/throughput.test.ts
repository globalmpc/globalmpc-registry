import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * 처리량 측정 — spec 06 §6.9, OD-32.
 *
 * **목표를 코드에 박지 않는다.** SLA·RPO·RTO 수치가 OD-32로 미정이고, 임의의
 * 숫자를 넣으면 그것이 결정이 되어 버린다. 대신 측정하고 출력한다.
 *
 * 환경변수로 임계값을 주면 그때 실패로 바꾼다:
 *
 *   PERF_MAX_P95_MS=250 pnpm vitest run --project @mpc/api test/throughput.test.ts
 *
 * 이 파일이 CI에서 하는 일은 **회귀를 눈에 보이게 하는 것**이다. 절대 수치는
 * 기계마다 다르므로 통과 기준으로 쓰지 않는다.
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

/** 측정 결과를 사람이 읽을 수 있게 남긴다. 숫자만 보면 회귀를 못 알아본다. */
function report(measurement: Measurement): void {
  process.stdout.write(
    `  ${measurement.label}: n=${measurement.count} p50=${measurement.p50}ms ` +
      `p95=${measurement.p95}ms max=${measurement.max}ms errors=${measurement.errors}\n`,
  );
}

/**
 * 임계값.
 *
 * 없으면 측정만 한다. OD-32가 정해지면 CI 환경변수로 넣는다 — 코드를 고치지
 * 않아도 되게.
 */
function parseThreshold(raw: string | undefined): number | null {
  // 배포 플랫폼은 설정되지 않은 변수를 빈 문자열로 넣는다. 그것은 "없음"이다.
  if (raw === undefined || raw.trim() === "") return null;

  const value = Number(raw);
  /**
   * 숫자가 아니면 **던진다.** `Number("abc")`는 NaN이고 `p95 > NaN`은 항상
   * 거짓이라, 오타 하나가 게이트를 조용히 꺼 버린다. 값을 넣은 사람은 게이트가
   * 켜졌다고 믿는다 — 그 상태가 게이트가 없는 것보다 나쁘다.
   */
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`PERF_MAX_P95_MS는 양수여야 한다: ${JSON.stringify(raw)}`);
  }
  return value;
}

const MAX_P95_MS = parseThreshold(process.env["PERF_MAX_P95_MS"]);

describeDb("처리량 측정", () => {
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

  /** 동시 요청을 보내고 각각의 소요를 잰다. */
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

    // 5xx는 오류로 센다. 성공으로 세면 장애가 빠른 응답으로 보인다.
    errors += results.filter((status) => status >= 500).length;

    const measurement = summarize(label, durations, errors);
    report(measurement);
    return measurement;
  }

  it("프로젝트 목록 읽기", async () => {
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

  it("공개 조회 (무인증)", async () => {
    // Explorer는 로그인 없이 열린다. 부하가 가장 예측하기 어려운 경로다.
    const measurement = await measure("GET /public/registries", 50, () =>
      app.inject({ method: "GET", url: "/api/v1/public/registries/project/NOPE" }),
    );

    expect(measurement.errors).toBe(0);
    if (MAX_P95_MS !== null) expect(measurement.p95).toBeLessThanOrEqual(MAX_P95_MS);
  });

  it("mutation — 프로젝트 등록", async () => {
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
          name: "측정용",
          hostCountryIso3: "MNG",
          minerals: ["copper"],
          ownerOrganizationId: fx.orgA,
        },
      });
    });

    expect(measurement.errors).toBe(0);
    if (MAX_P95_MS !== null) expect(measurement.p95).toBeLessThanOrEqual(MAX_P95_MS);
  });

  it("인증 — SIWE nonce 발급", async () => {
    // 로그인 경로가 막히면 다른 모든 것이 막힌다.
    const measurement = await measure("POST /auth/siwe/nonce", 30, () =>
      app.inject({
        method: "POST",
        url: "/api/v1/auth/siwe/nonce",
        payload: { walletAddress: fx.operatorA.address, chainId: 97 },
      }),
    );

    expect(measurement.errors).toBe(0);
  });

  it("메트릭이 측정 트래픽을 반영한다", async () => {
    // 위 케이스들이 남긴 관측이 실제로 수집됐는지 본다. 수집되지 않으면
    // 운영에서 부하를 볼 방법이 없다.
    const output = (await app.inject({ method: "GET", url: "/metrics" })).body;

    expect(output).toContain('route="/api/v1/projects"');
    expect(output).toContain("http_request_duration_ms_count");
  });

  it("임계값이 없으면 측정만 한다", () => {
    // OD-32가 정해지기 전까지 임의의 숫자를 통과 기준으로 쓰지 않는다.
    if (MAX_P95_MS === null) {
      process.stdout.write(
        "  임계값 미설정 — PERF_MAX_P95_MS로 지정하면 회귀가 실패로 바뀐다 (OD-32)\n",
      );
    }
    expect(true).toBe(true);
  });
});
