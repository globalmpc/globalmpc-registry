import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import type { MetricsRegistry } from "../metrics.js";

/**
 * Operational endpoints — 06 §6.9.
 *
 * `/health/*` and `/metrics` are not part of the API contract (`ROUTES`). Orchestrators and
 * collectors call them; they are not a versioned public API.
 *
 * **Metrics are not authenticated.** Instead they carry no identifying data such as tenant or
 * path parameters — leaving it out is more reliable than gating it. Restricting exposure to the
 * internal network is the deployment's job.
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
       * Refreshes DB gauges on every scrape.
       *
       * In-process counters do not catch a **stalled worker**. A dead worker reports nothing
       * and alert rules go quiet. Counting the backlog here makes the stall itself visible as
       * a value.
       *
       * A failed aggregate query does not fail the whole scrape. On failure
       * `mpc_gauge_scrape_failed_total` increments, and that itself is alertable — returning
       * 502 would leave a trace only in collector logs, none in the metrics.
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
      // A failure is not reported as success (06 §6.8: no hidden success).
      return reply.status(503).send({
        code: "DATABASE_UNAVAILABLE",
        message: "Cannot connect to the database",
        retryable: true,
        correlationId: request.context.correlationId,
      });
    }
  });
}
