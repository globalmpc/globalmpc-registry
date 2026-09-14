/**
 * 메트릭 — spec 06 §6.9.
 *
 * Prometheus 텍스트 형식으로 노출한다. 라이브러리를 쓰지 않는 이유: 필요한 것이
 * counter·histogram 몇 개뿐이고, 의존성 하나가 늘면 그것도 supply-chain 표면이다.
 *
 * **레이블에 고유값을 넣지 않는다.** 경로에 UUID가 들어가면 시계열이 무한히
 * 늘어나 수집기가 죽는다. 경로는 route 템플릿(`/api/v1/projects/:projectId`)으로
 * 정규화한다.
 *
 * **tenant를 레이블로 쓰지 않는다.** 메트릭은 보통 인증 없이 수집되므로 tenant
 * 목록이 그대로 노출된다.
 */

/**
 * 스크레이프 시점에 DB에서 읽는 값.
 *
 * 프로세스가 세는 counter로는 잡히지 않는 것이 있다. worker가 죽어 있으면 그
 * worker의 counter는 **아무것도 보고하지 않고**, 알림 규칙은 조용해진다. 쌓인
 * 행을 DB에서 세면 멈춘 상태 자체가 값으로 보인다.
 */
export interface Gauge {
  readonly metric: string;
  readonly label: string;
  readonly value: number;
}

export interface MetricsRegistry {
  observeRequest(method: string, route: string, statusCode: number, durationMs: number): void;
  /** 백그라운드 작업 결과. worker가 아니라 API가 관측한 것만 담는다. */
  incrementCounter(name: string, labels?: Record<string, string>): void;
  /** 스크레이프마다 갱신한다. 누적이 아니라 현재 상태다. */
  setGauges(gauges: readonly Gauge[]): void;
  render(): string;
}

/** 응답 시간 버킷(ms). 상한 없는 마지막 버킷은 `+Inf`다. */
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
      // statusCode를 그대로 쓰지 않고 계열로 묶는다. 200과 201을 나눌 이유가 없고
      // 시계열만 늘어난다.
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

      lines.push("# HELP http_requests_total 처리한 HTTP 요청 수");
      lines.push("# TYPE http_requests_total counter");
      for (const [key, value] of counters) {
        if (key.startsWith("http_requests_total")) lines.push(`${key} ${value}`);
      }

      lines.push("# HELP http_request_duration_ms 응답 시간 분포");
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

      // gauge는 이름별로 묶어 HELP·TYPE을 한 번만 낸다. 반복하면 Prometheus가
      // 중복 정의로 스크레이프 전체를 버린다.
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
