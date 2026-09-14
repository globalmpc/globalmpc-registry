/**
 * Metrics — spec 06 §6.9.
 *
 * Exposed in Prometheus text format. No library: only a few counters and histograms are
 * needed, and each added dependency is also supply-chain surface.
 *
 * **No unique values in labels.** A UUID in the path grows series without bound and kills
 * the collector. Paths are normalized to route templates
 * (`/api/v1/projects/:projectId`).
 *
 * **Tenant is not used as a label.** Metrics are usually scraped without auth, so the tenant
 * list would be exposed as is.
 */

/**
 * Values read from the DB at scrape time.
 *
 * Some things in-process counters cannot catch. When a worker is dead its counters
 * **report nothing**, and alert rules go quiet. Counting accumulated rows in the DB
 * makes the stalled state itself visible as a value.
 */
export interface Gauge {
  readonly metric: string;
  readonly label: string;
  readonly value: number;
}

export interface MetricsRegistry {
  observeRequest(method: string, route: string, statusCode: number, durationMs: number): void;
  /** Background job results. Holds only what the API observed, not the worker. */
  incrementCounter(name: string, labels?: Record<string, string>): void;
  /** Refreshed on every scrape. Current state, not cumulative. */
  setGauges(gauges: readonly Gauge[]): void;
  render(): string;
}

/** Response time buckets (ms). The final unbounded bucket is `+Inf`. */
const DURATION_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

function labelsToKey(labels: Record<string, string>): string {
  return Object.entries(labels)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, value]) => `${name}="${escapeLabel(value)}"`)
    .join(",");
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export function createMetricsRegistry(): MetricsRegistry {
  const counters = new Map<string, number>();
  const histogramSums = new Map<string, number>();
  const histogramCounts = new Map<string, number>();
  const histogramBuckets = new Map<string, number[]>();
  let gauges: readonly Gauge[] = [];

  return {
    observeRequest(method, route, statusCode, durationMs) {
      // statusCode is grouped by class rather than used as is. There is no reason to split 200 and
      // 201; it only adds series.
      const key = labelsToKey({
        method: method.toUpperCase(),
        route,
        status: `${Math.floor(statusCode / 100)}xx`,
      });

      counters.set(`http_requests_total{${key}}`, (counters.get(`http_requests_total{${key}}`) ?? 0) + 1);
      histogramSums.set(key, (histogramSums.get(key) ?? 0) + durationMs);
      histogramCounts.set(key, (histogramCounts.get(key) ?? 0) + 1);

      const buckets = histogramBuckets.get(key) ?? new Array<number>(DURATION_BUCKETS.length).fill(0);
      for (const [index, bound] of DURATION_BUCKETS.entries()) {
        if (durationMs <= bound) buckets[index] = (buckets[index] ?? 0) + 1;
      }
      histogramBuckets.set(key, buckets);
    },

    setGauges(next) {
      gauges = next;
    },

    incrementCounter(name, labels = {}) {
      const key = Object.keys(labels).length > 0 ? `${name}{${labelsToKey(labels)}}` : name;
      counters.set(key, (counters.get(key) ?? 0) + 1);
    },

    render() {
      const lines: string[] = [];

      lines.push("# HELP http_requests_total HTTP requests handled");
      lines.push("# TYPE http_requests_total counter");
      for (const [key, value] of counters) {
        if (key.startsWith("http_requests_total")) lines.push(`${key} ${value}`);
      }

      lines.push("# HELP http_request_duration_ms Response time distribution");
      lines.push("# TYPE http_request_duration_ms histogram");
      for (const [key, buckets] of histogramBuckets) {
        let cumulative = 0;
        for (const [index, bound] of DURATION_BUCKETS.entries()) {
          cumulative = buckets[index] ?? 0;
          lines.push(`http_request_duration_ms_bucket{${key},le="${bound}"} ${cumulative}`);
        }
        lines.push(
          `http_request_duration_ms_bucket{${key},le="+Inf"} ${histogramCounts.get(key) ?? 0}`,
        );
        lines.push(`http_request_duration_ms_sum{${key}} ${histogramSums.get(key) ?? 0}`);
        lines.push(`http_request_duration_ms_count{${key}} ${histogramCounts.get(key) ?? 0}`);
      }

      const others = [...counters].filter(([key]) => !key.startsWith("http_requests_total"));
      if (others.length > 0) {
        lines.push("# TYPE app_events_total counter");
        for (const [key, value] of others) lines.push(`${key} ${value}`);
      }

      // Gauges are grouped by name so HELP and TYPE are emitted once. Repeating them makes
      // Prometheus drop the whole scrape as a duplicate definition.
      for (const metric of [...new Set(gauges.map((gauge) => gauge.metric))]) {
        lines.push(`# TYPE mpc_${metric} gauge`);
        for (const gauge of gauges.filter((entry) => entry.metric === metric)) {
          lines.push(`mpc_${metric}{state="${escapeLabel(gauge.label)}"} ${gauge.value}`);
        }
      }

      return `${lines.join("\n")}\n`;
    },
  };
}
