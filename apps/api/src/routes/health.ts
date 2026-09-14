import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import type { MetricsRegistry } from "../metrics.js";

/**
 * 운영 endpoint — 06 §6.9.
 *
 * `/health/*`와 `/metrics`는 API 계약(`ROUTES`)의 대상이 아니다. 오케스트레이터와
 * 수집기가 부르는 것이며 버전이 붙는 공개 API가 아니다.
 *
 * **메트릭에 인증을 걸지 않는다.** 대신 tenant·경로 파라미터 같은 식별 정보를
 * 담지 않는다 — 인증을 거는 것보다 담지 않는 편이 확실하다. 네트워크 수준에서
 * 내부에만 노출하는 것은 배포의 몫이다.
 */
export async function registerHealthRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
  metrics?: MetricsRegistry,
): Promise<void> {
  app.get("/health/live", async () => ({ status: "live" }));

  if (metrics) {
    app.get("/metrics", async (_request, reply) => {
      /**
       * 스크레이프마다 DB 게이지를 갱신한다.
       *
       * 프로세스가 세는 counter로는 **멈춘 worker**가 잡히지 않는다. 죽은
       * worker는 아무것도 보고하지 않고 알림 규칙은 조용해진다. 쌓인 행을 여기서
       * 세면 멈춘 상태 자체가 값으로 보인다.
       *
       * 집계 조회가 실패해도 스크레이프 전체를 실패시키지 않는다. 실패하면
       * `mpc_gauge_scrape_failed_total`이 오르고, 그것 자체가 알림 대상이다 —
       * 502를 돌려주면 수집기 로그에만 남고 지표에는 흔적이 없다.
       */
      try {
        const rows = await sql<{ metric: string; label: string; value: string }[]>`
          SELECT * FROM core.operational_gauges()
        `;
        metrics.setGauges(
          rows.map((row) => ({
            metric: row.metric,
            label: row.label,
            value: Number(row.value),
          })),
        );
      } catch {
        metrics.incrementCounter("mpc_gauge_scrape_failed_total");
      }

      reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
      return metrics.render();
    });
  }

  app.get("/health/ready", async (request, reply) => {
    try {
      await sql`SELECT 1`;
      return { status: "ready" };
    } catch {
      // 장애를 성공으로 표시하지 않는다(06 §6.8 hidden success 금지).
      return reply.status(503).send({
        code: "DATABASE_UNAVAILABLE",
        message: "데이터베이스에 연결할 수 없다",
        retryable: true,
        correlationId: request.context.correlationId,
      });
    }
  });
}
