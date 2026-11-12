import { ApiError } from "./api";
import { getEvidenceLedger, type LedgerSummary } from "./evidence-ledger-api";

type Result = { snapshot: LedgerSummary };
type Task = {
  start: () => Promise<Result>;
  resolve: (result: Result) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
  cancel: () => void;
  started: boolean;
};
export class ProgressRateLimited extends Error {
  constructor() { super("Progress loading is paused"); }
}

/** A shared page-runtime budget survives row/filter remounts. No results or identities are cached. */
export function createProgressRequests() {
  const waiting: Task[] = [];
  let active = 0;
  let pausedUntil = 0;
  function discardWaiting(error: unknown) {
    for (const task of waiting.splice(0)) {
      task.signal.removeEventListener("abort", task.cancel);
      task.reject(error);
    }
  }
  function drain() {
    if (Date.now() < pausedUntil) return;
    while (active < 2 && waiting.length) {
      const task = waiting.shift()!;
      task.started = true;
      active++;
      // Cancellation discards the result but does not release capacity early: cancelling
      // a browser fetch would not establish that the server's DB work has stopped.
      void task.start().then(task.resolve, error => {
        if (error instanceof ApiError && error.status === 429) {
          pausedUntil = Date.now() + 60_000;
          const paused = new ProgressRateLimited();
          discardWaiting(paused);
          task.reject(paused);
        } else {
          task.reject(error);
        }
      }).finally(() => {
        task.signal.removeEventListener("abort", task.cancel);
        active--;
        drain();
      });
    }
  }
  return {
    load(token: string, projectId: string, signal: AbortSignal): Promise<Result> {
      if (signal.aborted) return Promise.reject(new DOMException("Cancelled", "AbortError"));
      if (Date.now() < pausedUntil) return Promise.reject(new ProgressRateLimited());
      return new Promise((resolve, reject) => {
        const task: Task = {
          start: () => getEvidenceLedger(token, projectId), resolve, reject, signal,
          started: false,
          cancel: () => {
            if (!task.started) {
              const index = waiting.indexOf(task);
              if (index >= 0) waiting.splice(index, 1);
              signal.removeEventListener("abort", task.cancel);
            }
            reject(new DOMException("Cancelled", "AbortError"));
          },
        };
        signal.addEventListener("abort", task.cancel, { once: true });
        waiting.push(task);
        drain();
      });
    },
  };
}

export const projectProgressRequests = createProgressRequests();
