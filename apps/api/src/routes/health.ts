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
  metrics: MetricsRegistry | undefined,
  // No default: an ops endpoint left open because a caller forgot the guard is not a safe default.
  allowPeer: (peer: string | undefined) => boolean,
): Promise<void> {
  /**
   * Peers outside `OPS_ENDPOINT_CIDRS` get the same answer as an unknown path.
   *
   * Nothing here needs auth on the container network, but once the API host is reachable
   * from the internet, readiness and the operational gauges must not be. A 403 would confirm
   * the path exists; the not-found envelope says nothing.
   */
  app.addHook("onRequest", async (request, reply) => {
    const url = request.routeOptions.url;
    if (url !== "/health/live" && url !== "/health/ready" && url !== "/metrics") return;
    // A request that came through a proxy carries a forwarding header; its socket peer is the
    // proxy, often on a private range. The collector scrapes the API directly and sends none.
    const proxied =
      request.headers["x-forwarded-for"] !== undefined ||
      request.headers["forwarded"] !== undefined ||
      request.headers["x-real-ip"] !== undefined;
    if (!proxied && allowPeer(request.socket.remoteAddress)) return;
    return reply.status(404).send({
      code: "NOT_FOUND",
      message: "The requested route does not exist",
      retryable: false,
      correlationId: request.context?.correlationId ?? "unknown",
    });
  });

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
        // A worker the API refuses (its service token revoked, or rotated without a deploy)
        // stays alive and keeps a fresh heartbeat, so the liveness alerts stay quiet while
        // nothing is scanned. Its heartbeat says so (`status: "unauthorized"`); 1 while it does,
        // 0 otherwise, and no series for a worker that never reported.
        const refused = await sql<{ label: string; value: number }[]>`
          SELECT worker_kind AS label,
                 CASE WHEN detail->>'status' = 'unauthorized' THEN 1 ELSE 0 END AS value
          FROM core.worker_heartbeats WHERE worker_kind = 'scan'
        `;
        metrics.setGauges([
          ...rows.map((row) => ({
            metric: row.metric,
            label: row.label,
            value: Number(row.value),
          })),
          ...refused.map((row) => ({
            metric: "worker_unauthorized",
            label: row.label,
            value: Number(row.value),
          })),
        ]);
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
