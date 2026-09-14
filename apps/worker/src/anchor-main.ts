import postgres from "postgres";
import { loadAnchorConfig } from "./anchor-config.js";
import { createHeartbeat } from "./heartbeat.js";
import { chainBacklog, stepOnce } from "./anchor-submitter.js";
import { createViemChainClient, signerAddress } from "./viem-chain-client.js";
import { createSafeClient } from "./safe-client.js";

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

let config;
try {
  config = loadAnchorConfig(process.env);
} catch (error) {
  process.stderr.write(`${String(error instanceof Error ? error.message : error)}\n`);
  process.exit(1);
}

// No prepared statements. The worker is long-lived; if a migration runs meanwhile, the cached
// plan's result shape drifts and the loop dies. Anchor submission is nowhere near thousands per
// second, so the outage risk outweighs the gain from prepared plans.
const sql = postgres(config.databaseUrl, { onnotice: () => {}, prepare: false });
const chain = createViemChainClient({
  rpcUrl: config.rpcUrl,
  chainId: config.chainId,
  contractAddress: config.contractAddress as `0x${string}`,
  signerPrivateKey: config.signerPrivateKey,
});

/**
 * Safe integration.
 *
 * With an address but no service URL, proposals are kept in the DB only — nobody can sign them,
 * so that configuration stands as a marker that "the proposal path is not ready".
 */
const safe =
  config.safeAddress && process.env["SAFE_SERVICE_URL"]
    ? createSafeClient({
        serviceUrl: process.env["SAFE_SERVICE_URL"],
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
  // Whether this chain allows direct EOA submission. Otherwise only Safe proposals are created.
  submissionMode: config.eoaAllowedChainIds.includes(config.chainId)
    ? "eoa"
    : config.safeAddress
      ? "safe_proposal"
      : "blocked",
  safeAddress: config.safeAddress,
  safeService: process.env["SAFE_SERVICE_URL"] ?? null,
});

const heartbeat = createHeartbeat(sql, "anchor");

while (running) {
  try {
    const result = await stepOnce(sql, chain, config, emit, safe);

    // Emit the signal even when the queue is empty — its purpose is to tell "nothing to submit"
    // apart from "worker is dead".
    await heartbeat({ handled: result.handled });

    if (!result.handled) {
      const backlog = await chainBacklog(sql, config.chainId);
      if (backlog.needsAttention > 0) {
        // Do not stay silent on what needs a human. reverted, dropped, and
        // reconciliation-required do not resolve on their own.
        emit({ level: "warn", msg: "anchor.needs_attention", ...backlog });
      }
      await sleep(config.pollIntervalMs);
    }
  } catch (error) {
    emit({ level: "error", msg: "anchor.loop.failed", error: String(error) });
    await sleep(config.pollIntervalMs);
  }
}

emit({ level: "info", msg: "anchor.worker.stopped" });
await sql.end();
