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
  readonly ANCHOR_GAS_LIMIT?: string;
}

export interface AnchorConfig extends SubmitterConfig {
  readonly databaseUrl: string;
  readonly rpcUrl: string;
  readonly signerPrivateKey: Hex;
  readonly pollIntervalMs: number;
}

/**
 * The local development chain (anvil/hardhat). The only chain where the worker may sign alone —
 * the API accepts 56 and this one (`apps/api/src/config.ts`).
 */
const LOCAL_CHAIN_ID = 31337;

function required(env: AnchorEnv, key: keyof AnchorEnv): string {
  const value = env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}

/** Resolves a secret reference to its value. Failure messages never include the value. */
function requiredSecret(env: AnchorEnv, key: keyof AnchorEnv): string {
  return resolveSecret(key, env[key], undefined, env as NodeJS.ProcessEnv);
}

/**
 * Reads an optional positive integer. Unset or empty falls back to the default.
 *
 * `Number("abc")` is NaN and NaN fails every comparison: an attempt count never reaches a NaN
 * cap, and elapsed time never reaches a NaN timeout. A typo would silently remove the limit, so
 * anything but plain digits above 0 refuses startup — the same form as the daily cap check.
 */
function positiveInteger(env: AnchorEnv, key: keyof AnchorEnv, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
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

  const dailySpendCapWei = loadDailySpendCap(env);

  // Solo EOA submission is for the local chain only. On any other chain the Safe multisig holds
  // the submitter role, and a setting must not be able to open a path around it — so listing a
  // non-local chain refuses startup instead of relying on the default.
  const eoaAllowedChainIds = (env.ANCHOR_EOA_CHAIN_IDS ?? String(LOCAL_CHAIN_ID))
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "")
    .map((value) => {
      if (!/^[0-9]+$/.test(value)) throw new Error("ANCHOR_EOA_CHAIN_IDS has an invalid chain id");
      const id = Number(value);
      if (id !== LOCAL_CHAIN_ID) {
        throw new Error(
          `ANCHOR_EOA_CHAIN_IDS may list only the local chain ${LOCAL_CHAIN_ID}; chain ${id} anchors through the Safe`,
        );
      }
      return id;
    });

  // Safe address that receives proposals on chains where EOA submission is blocked. Without it,
  // nothing happens on that chain, and the worker logs that fact.
  const safeAddress = env.ANCHOR_SAFE_ADDRESS?.toLowerCase() ?? null;
  if (safeAddress && !/^0x[0-9a-f]{40}$/.test(safeAddress)) {
    throw new Error("ANCHOR_SAFE_ADDRESS is not a valid address");
  }

  // Gas limit on every send. It is what makes a send's cost bounded before its receipt: the
  // daily cap reserves gas limit × fee for each one in flight. `submitRoot` measured at most
  // 145,926 gas plus 21,000 base (deploy/README.md); 200,000 leaves room for calldata.
  const gasLimit = BigInt(positiveInteger(env, "ANCHOR_GAS_LIMIT", 200_000));
  const feeCapWei = BigInt(Math.round(feeCapGwei * 1e9));
  // Every send is reserved at gas limit × fee cap until settled, and a broadcast that failed is
  // settled only once the next send reuses its nonce. A cap with room for a single send would
  // keep that next send out forever, so it must fit two.
  const minimumCapWei = 2n * gasLimit * feeCapWei;
  if (dailySpendCapWei < minimumCapWei) {
    throw new Error(
      `ANCHOR_DAILY_SPEND_CAP_WEI must be at least 2 × ANCHOR_GAS_LIMIT × ANCHOR_FEE_CAP_GWEI (${minimumCapWei} wei)`,
    );
  }

  return {
    databaseUrl: requiredSecret(env, "DATABASE_URL"),
    rpcUrl: required(env, "CHAIN_RPC_URL"),
    chainId,
    contractAddress,
    signerPrivateKey: signerPrivateKey.toLowerCase() as Hex,
    confirmationDepth,
    feeCapWei,
    dailySpendCapWei,
    maxAttempts: positiveInteger(env, "ANCHOR_MAX_ATTEMPTS", 3),
    dropTimeoutMs: positiveInteger(env, "ANCHOR_DROP_TIMEOUT_MS", 10 * 60 * 1000),
    pollIntervalMs: positiveInteger(env, "ANCHOR_POLL_MS", 2000),
    eoaAllowedChainIds,
    safeAddress,
    reorgWatchMs: positiveInteger(env, "ANCHOR_REORG_WATCH_MS", 30 * 60 * 1000),
    recheckIntervalMs: positiveInteger(env, "ANCHOR_RECHECK_MS", 15000),
    gasLimit,
  };
}

function loadDailySpendCap(env: AnchorEnv): bigint {
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
  return dailySpendCapWei;
}
