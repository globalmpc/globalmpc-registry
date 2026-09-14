import type { Hex } from "viem";
import { resolveSecret } from "@mpc/config";
import type { SubmitterConfig } from "./anchor-submitter.js";

/**
 * Anchor worker configuration.
 *
 * Everything is validated at startup. Deferring a gap to runtime means learning that submission
 * fails only after batches have piled up.
 *
 * **Secrets have no defaults.** If a default key exists, someone will run production on it.
 *
 * The signing key and DB URL may be given as references instead of values (`file:`, `env:`). The
 * goal is to keep the private key out of the process environment in deployment — a single
 * `docker inspect` would expose the whole anchor signer wallet.
 */

export interface AnchorEnv {
  readonly DATABASE_URL?: string;
  readonly CHAIN_RPC_URL?: string;
  readonly CHAIN_ID?: string;
  readonly ANCHOR_CONTRACT_ADDRESS?: string;
  readonly ANCHOR_SIGNER_PRIVATE_KEY?: string;
  readonly ANCHOR_CONFIRMATIONS?: string;
  readonly ANCHOR_FEE_CAP_GWEI?: string;
  readonly ANCHOR_DAILY_SPEND_CAP_WEI?: string;
  readonly ANCHOR_MAX_ATTEMPTS?: string;
  readonly ANCHOR_DROP_TIMEOUT_MS?: string;
  readonly ANCHOR_POLL_MS?: string;
  readonly ANCHOR_EOA_CHAIN_IDS?: string;
  readonly ANCHOR_SAFE_ADDRESS?: string;
  readonly ANCHOR_REORG_WATCH_MS?: string;
  readonly SAFE_SERVICE_URL?: string;
  readonly ANCHOR_RECHECK_MS?: string;
}

export interface AnchorConfig extends SubmitterConfig {
  readonly databaseUrl: string;
  readonly rpcUrl: string;
  readonly signerPrivateKey: Hex;
  readonly pollIntervalMs: number;
}

function required(env: AnchorEnv, key: keyof AnchorEnv): string {
  const value = env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}

/** Resolves a secret reference to its value. Failure messages never include the value. */
function requiredSecret(env: AnchorEnv, key: keyof AnchorEnv): string {
  return resolveSecret(key, env[key], undefined, env as NodeJS.ProcessEnv);
}

export function loadAnchorConfig(env: AnchorEnv): AnchorConfig {
  const contractAddress = required(env, "ANCHOR_CONTRACT_ADDRESS").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(contractAddress)) {
    throw new Error("ANCHOR_CONTRACT_ADDRESS is not a valid address");
  }

  const signerPrivateKey = requiredSecret(env, "ANCHOR_SIGNER_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(signerPrivateKey)) {
    // Checks format only. The value itself never goes into the error message.
    throw new Error("ANCHOR_SIGNER_PRIVATE_KEY has an invalid format");
  }

  const chainId = Number(required(env, "CHAIN_ID"));
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error("CHAIN_ID is invalid");

  const confirmationDepth = Number(env.ANCHOR_CONFIRMATIONS ?? "12");
  if (!Number.isInteger(confirmationDepth) || confirmationDepth < 1) {
    // A depth of 0 would mean "confirmed once in a block", which breaks 06 §6.8.
    throw new Error("ANCHOR_CONFIRMATIONS must be at least 1");
  }

  const feeCapGwei = Number(env.ANCHOR_FEE_CAP_GWEI ?? "100");
  if (!(feeCapGwei > 0)) throw new Error("ANCHOR_FEE_CAP_GWEI must be greater than 0");

  // O1 — total gas that may be burned per day. **No default.**
  //
  // A per-tx cap and a retry cap already exist. Even with both honored, a steady stream of
  // batches drains the wallet. The loss cap is fixed only as a daily total, and the operator sets
  // it (expected burn × 1.5). With a default, it ships without anyone deciding — the same reason
  // an empty `OBJECT_REGION` is rejected.
  const dailySpendCapRaw = required(env, "ANCHOR_DAILY_SPEND_CAP_WEI");
  if (!/^[0-9]+$/.test(dailySpendCapRaw)) {
    // wei is an integer. `0.05` or `1e17` means the unit was mistaken, and silently rounding
    // would make the cap trip somewhere other than intended.
    throw new Error("ANCHOR_DAILY_SPEND_CAP_WEI must be an integer in wei");
  }
  const dailySpendCapWei = BigInt(dailySpendCapRaw);
  if (dailySpendCapWei <= 0n) {
    // 0 does not mean "no cap"; it means "submit nothing".
    throw new Error("ANCHOR_DAILY_SPEND_CAP_WEI must be greater than 0");
  }

  // Defaults are local (31337) and BNB testnet (97) only. Solo EOA submission on mainnet must be
  // opened explicitly, and by contract design that is the Safe multisig's role.
  const eoaAllowedChainIds = (env.ANCHOR_EOA_CHAIN_IDS ?? "31337,97")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);

  // Safe address that receives proposals on chains where EOA submission is blocked. Without it,
  // nothing happens on that chain, and the worker logs that fact.
  const safeAddress = env.ANCHOR_SAFE_ADDRESS?.toLowerCase() ?? null;
  if (safeAddress && !/^0x[0-9a-f]{40}$/.test(safeAddress)) {
    throw new Error("ANCHOR_SAFE_ADDRESS is not a valid address");
  }

  return {
    databaseUrl: requiredSecret(env, "DATABASE_URL"),
    rpcUrl: required(env, "CHAIN_RPC_URL"),
    chainId,
    contractAddress,
    signerPrivateKey: signerPrivateKey.toLowerCase() as Hex,
    confirmationDepth,
    feeCapWei: BigInt(Math.round(feeCapGwei * 1e9)),
    dailySpendCapWei,
    maxAttempts: Number(env.ANCHOR_MAX_ATTEMPTS ?? "3"),
    dropTimeoutMs: Number(env.ANCHOR_DROP_TIMEOUT_MS ?? String(10 * 60 * 1000)),
    pollIntervalMs: Number(env.ANCHOR_POLL_MS ?? "2000"),
    eoaAllowedChainIds,
    safeAddress,
    reorgWatchMs: Number(env.ANCHOR_REORG_WATCH_MS ?? String(30 * 60 * 1000)),
    recheckIntervalMs: Number(env.ANCHOR_RECHECK_MS ?? "15000"),
  };
}
