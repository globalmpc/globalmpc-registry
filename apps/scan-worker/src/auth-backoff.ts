/**
 * Back-off for a rejected service token.
 *
 * A 401 is the worker's credential, not a file: until the token is registered (or a revoked one
 * is replaced) every lease ends the same way. Without a pause the loop leases, scans and reports
 * again at once — hundreds of cycles a second against the scanner, the bucket and the API, while
 * the heartbeat looks healthy. So the loop stops leasing for a while, doubling the pause from
 * 5 seconds up to 5 minutes, and resumes the normal poll on the first report that is accepted.
 *
 * The pause is jittered to 50–100% of the step, so workers that lost their token together do not
 * come back in lockstep.
 */
export interface UnauthorizedBackoff {
  /** Records a 401 and returns how long to wait before the next lease. */
  next(): number;
  /** A report was accepted: the token works again. */
  reset(): void;
  /** Consecutive 401s since the last accepted report. */
  readonly failures: number;
}

export const UNAUTHORIZED_BACKOFF_BASE_MS = 5_000;
export const UNAUTHORIZED_BACKOFF_MAX_MS = 5 * 60_000;

export function createUnauthorizedBackoff(options: {
  readonly baseMs?: number;
  readonly maxMs?: number;
  readonly random?: () => number;
} = {}): UnauthorizedBackoff {
  const baseMs = options.baseMs ?? UNAUTHORIZED_BACKOFF_BASE_MS;
  const maxMs = options.maxMs ?? UNAUTHORIZED_BACKOFF_MAX_MS;
  const random = options.random ?? Math.random;
  let failures = 0;
  return {
    next() {
      failures += 1;
      // 2^(n-1) overflows nothing that matters: the cap applies long before.
      const step = Math.min(maxMs, baseMs * 2 ** Math.min(failures - 1, 30));
      return Math.round(step * (0.5 + random() * 0.5));
    },
    reset() {
      failures = 0;
    },
    get failures() {
      return failures;
    },
  };
}
