import postgres from "postgres";
import {
  loadAnchorConfig,
  missingContractCode,
  rpcChainMismatch,
  unansweredFinalityTag,
} from "./anchor-config.js";
import { createHeartbeat } from "@mpc/db";
import {
  chainBacklog,
  extendReorgWatch,
  otherChainsInFlight,
  processChainMoves,
  registerAnchorContract,
  shouldBackOff,
  stepOnce,
} from "./anchor-submitter.js";
import {
  contractHasCode,
  createViemChainClient,
  rpcAnswersBlockTag,
  rpcChainId,
  signerAddress,
} from "./viem-chain-client.js";
import { createSafeClient } from "./safe-client.js";
import { createRedactor } from "./redact-urls.js";
import { eoaSubmissionAllowed } from "./anchor-state.js";

/**
 * Anchor submission loop.
 *
 * Advances one transaction at a time. Batching them lets one RPC failure roll back the progress
 * of the rest.
 *
 * This process works **across tenants**, so it connects as the `mpc_worker` role (0012).
 * Connecting as superuser grants more privilege than needed.
 */

function emit(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function loadConfig(): ReturnType<typeof loadAnchorConfig> {
  try {
    return loadAnchorConfig(process.env);
  } catch (error) {
    process.stderr.write(`${String(error instanceof Error ? error.message : error)}\n`);
    process.exit(1);
  }
}
const loaded = loadConfig();
// Logs and stored errors leave the host, and the RPC URL — or the Safe service URL — may carry the
// provider's API key. Every error this process prints or stores passes through this one redactor,
// carried on the configuration so the submitter uses the same one.
const redact = createRedactor([loaded.rpcUrl, loaded.safeServiceUrl]);
const config = { ...loaded, redact };

// Before opening anything, confirm the endpoint serves CHAIN_ID. An unreachable endpoint also stops
// here; the restart policy retries, which is clearer than a loop failing every step. viem quotes
// the URL in its errors, so it is masked like every other RPC error.
try {
  const mismatch = rpcChainMismatch(config.chainId, await rpcChainId(config.rpcUrl));
  if (mismatch) throw new Error(mismatch);
  // Then that the contract is there. A send to an address without code succeeds and stores
  // nothing, so a wrong address would otherwise surface only as batches never verifying.
  const missing = missingContractCode(
    config.chainId,
    await contractHasCode(config.rpcUrl, config.contractAddress as `0x${string}`),
  );
  if (missing) throw new Error(missing);
  // Then that it answers the finality tag. Without it nothing is ever confirmed. A failed read
  // refuses too, with its own message; the restart policy retries.
  if (config.finalityTag !== "none") {
    const unanswered = unansweredFinalityTag(
      config.chainId,
      config.finalityTag,
      await rpcAnswersBlockTag(config.rpcUrl, config.finalityTag).catch(() => "unreadable" as const),
    );
    if (unanswered) throw new Error(unanswered);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${redact(message)}\n`);
  process.exit(1);
}

// No prepared statements. The worker is long-lived; if a migration runs meanwhile, the cached
// plan's result shape drifts and the loop dies. Anchor submission is nowhere near thousands per
// second, so the outage risk outweighs the gain from prepared plans.
const sql = postgres(config.databaseUrl, { onnotice: () => {}, prepare: false });

// Register the configured contract for this chain before sending anything to it, so a later chain
// move asks it even after no row names it (0107). Without that record a move could anchor a batch
// a second time, so a failure stops here like the checks above; the restart policy retries.
try {
  await registerAnchorContract(sql, config.chainId, config.contractAddress);
} catch (error) {
  process.stderr.write(`anchor contract registration failed: ${redact(String(error))}\n`);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
}
const chain = createViemChainClient({
  rpcUrl: config.rpcUrl,
  chainId: config.chainId,
  contractAddress: config.contractAddress as `0x${string}`,
  signerPrivateKey: config.signerPrivateKey,
  logLookbackBlocks: config.logLookbackBlocks,
});

/**
 * Safe integration.
 *
 * With an address but no service URL, proposals are kept in the DB only — nobody can sign them,
 * so that configuration stands as a marker that "the proposal path is not ready".
 */
const safe =
  config.safeAddress && config.safeServiceUrl
    ? createSafeClient({
        serviceUrl: config.safeServiceUrl,
        chainId: config.chainId,
        proposerPrivateKey: config.signerPrivateKey,
      })
    : undefined;

let running = true;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    running = false;
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

emit({
  level: "info",
  msg: "anchor.worker.started",
  chainId: config.chainId,
  contractAddress: config.contractAddress,
  // The address is public. The private key is never printed anywhere.
  signer: signerAddress(config.signerPrivateKey),
  confirmationDepth: config.confirmationDepth,
  finalityTag: config.finalityTag,
  // Whether this chain allows direct EOA submission. Otherwise only Safe proposals are created.
  submissionMode: eoaSubmissionAllowed(config.chainId, config.eoaAllowedChainIds)
    ? "eoa"
    : config.safeAddress
      ? "safe_proposal"
      : "blocked",
  safeAddress: config.safeAddress,
  // Whether a Safe service is set, nothing of the URL itself: a hosted service can carry an API key
  // in its path, query or even its hostname, and these logs are shipped off the host.
  safeService: config.safeServiceUrl ? "configured" : null,
});

// Once a minute at most: passes come back to back when busy, and the count changes slowly.
const OTHER_CHAIN_WARNING_INTERVAL_MS = 60_000;
let lastOtherChainWarning = Number.NEGATIVE_INFINITY;

/**
 * After a `CHAIN_ID` change the old chain's unsettled rows and open sends have no watcher here. Say
 * so at startup and on every pass — busy or idle, since a busy worker may never be idle — so a chain
 * move is not finished while proofs on the old chain are still open or its sends' gas is still
 * unrecorded.
 */
async function warnOtherChainsInFlight(chainId: number, reorgWatchMs: number): Promise<void> {
  if (Date.now() - lastOtherChainWarning < OTHER_CHAIN_WARNING_INTERVAL_MS) return;
  lastOtherChainWarning = Date.now();
  try {
    const chains = await otherChainsInFlight(sql, chainId, reorgWatchMs);
    if (chains.length > 0) {
      emit({
        level: "warn",
        msg: "anchor.other_chain_in_flight",
        // Run a worker with that CHAIN_ID until both counts reach zero; this one never picks them.
        chains,
      });
    }
  } catch (error) {
    // Observability only: a failed count must not stop or slow the pass that asked for it. Its own
    // message, so an alert on failed passes does not fire for a pass that went on.
    emit({ level: "error", msg: "anchor.other_chain_check.failed", error: redact(String(error)) });
  }
}

const heartbeat = createHeartbeat(sql, "anchor", 15_000, process.env["WORKER_HEALTH_FILE"]);

const REORG_WATCH_EXTENSION_INTERVAL_MS = 60_000;
let lastReorgWatchExtension = Number.NEGATIVE_INFINITY;

/**
 * Brings this chain's watched rows up to this worker's `ANCHOR_REORG_WATCH_MS`: before the first
 * step, so a raise reaches rows confirmed before it, and then once a minute, since during a rolling
 * deploy a replica still on the shorter watch keeps confirming rows with its shorter deadline.
 *
 * Never in the way of the pass: a failure is logged under its own message and the pass goes on to
 * its step; the next run, a minute later, retries. Locked rows are skipped, not waited for
 * (`extendReorgWatch`).
 */
async function extendWatchedRows(): Promise<void> {
  if (Date.now() - lastReorgWatchExtension < REORG_WATCH_EXTENSION_INTERVAL_MS) return;
  lastReorgWatchExtension = Date.now();
  try {
    const extended = await extendReorgWatch(sql, config.chainId, config.reorgWatchMs);
    if (extended > 0) emit({ level: "info", msg: "anchor.reorg_watch.extended", transactions: extended });
  } catch (error) {
    emit({ level: "error", msg: "anchor.reorg_watch.extend_failed", error: redact(String(error)) });
  }
}

const CHAIN_MOVE_INTERVAL_MS = 60_000;
/** How long shutdown waits for a run of chain moves still going before closing the database. */
const CHAIN_MOVE_SHUTDOWN_WAIT_MS = 10_000;
let lastChainMoves = Number.NEGATIVE_INFINITY;
let chainMovesInFlight: Promise<void> | undefined;

/**
 * Carries out chain moves requested off this chain (`processChainMoves`): only this worker can ask
 * this chain whether it holds the batch. Started at most once a minute — a move waits for a
 * person's request anyway — and never in the way of the pass: it runs beside the loop, so a slow
 * node (up to ten requests, each several RPC reads) cannot hold back the step or the heartbeat past
 * the health check's window and get the task replaced. One run at a time: the next starts only
 * once this one has ended, however long it took. A failure is logged under its own message, and
 * each request left waiting is looked at again on the next run.
 *
 * Running beside the step changes nothing for a row: replicas already run both at once, and a
 * move is made only in a transaction that locks the row and checks it is exactly as it was read
 * (`updated_at` included), with no send or proposal of it appearing since.
 */
function carryOutChainMoves(): void {
  if (chainMovesInFlight) return;
  if (Date.now() - lastChainMoves < CHAIN_MOVE_INTERVAL_MS) return;
  lastChainMoves = Date.now();
  chainMovesInFlight = processChainMoves(sql, chain, config, emit)
    .then(
      () => undefined,
      (error: unknown) => {
        emit({ level: "error", msg: "anchor.chain_move.failed", error: redact(String(error)) });
      },
    )
    .finally(() => {
      chainMovesInFlight = undefined;
    });
}

/**
 * At shutdown, lets a run of chain moves still going finish before the database closes, for a
 * while. Cutting it off is safe — no row is locked while the chain is asked, and a decision is one
 * transaction — so a run held up by a slow node does not hold up the stop.
 */
async function settleChainMoves(): Promise<void> {
  if (!chainMovesInFlight) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    chainMovesInFlight,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CHAIN_MOVE_SHUTDOWN_WAIT_MS);
    }),
  ]);
  clearTimeout(timer);
}

await warnOtherChainsInFlight(config.chainId, config.reorgWatchMs);

while (running) {
  try {
    await extendWatchedRows();
    carryOutChainMoves();
    const result = await stepOnce(sql, chain, config, emit, safe);

    // Emit the signal even when the queue is empty — its purpose is to tell "nothing to submit"
    // apart from "worker is dead".
    await heartbeat({ handled: result.handled });
    await warnOtherChainsInFlight(config.chainId, config.reorgWatchMs);

    // Only a step that moved something runs the next one at once. A blocked step (cap reached,
    // send or proposal failed, transaction still pending) sleeps like an empty queue does —
    // otherwise it repeats the same RPC calls and UPDATEs until the condition clears.
    if (shouldBackOff(result)) {
      if (!result.handled) {
        const backlog = await chainBacklog(sql, config.chainId);
        if (backlog.needsAttention > 0) {
          // Do not stay silent on what needs a human. reverted, dropped, and
          // reconciliation-required do not resolve on their own.
          emit({ level: "warn", msg: "anchor.needs_attention", ...backlog });
        }
      }
      await sleep(config.pollIntervalMs);
    }
  } catch (error) {
    emit({ level: "error", msg: "anchor.loop.failed", error: redact(String(error)) });
    await sleep(config.pollIntervalMs);
  }
}

await settleChainMoves();
emit({ level: "info", msg: "anchor.worker.stopped" });
await sql.end();
