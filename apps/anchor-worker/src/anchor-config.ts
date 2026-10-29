import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { assertNotDevKey, resolveSecret } from "@mpc/config";
import {
  describeChains,
  EOA_ANCHOR_ELIGIBLE_CHAIN_IDS,
  isEoaAnchorEligibleChainId,
  isSupportedChainId,
  LOCAL_CHAIN_ID,
  SUPPORTED_CHAIN_IDS,
} from "@mpc/domain";
import type { SubmitterConfig } from "./anchor-submitter.js";
import {
  defaultFinalityTag,
  defaultLogLookbackBlocks,
  FINALITY_TAGS,
  isFinalityTag,
  type FinalityTag,
} from "./chain-profile.js";

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
  readonly ANCHOR_FINALITY_TAG?: string;
  readonly ANCHOR_LOG_LOOKBACK_BLOCKS?: string;
  readonly ANCHOR_CHAIN_SEARCH_RETRY_MS?: string;
  readonly ANCHOR_CHAIN_SEARCH_GIVE_UP_MS?: string;
}

export interface AnchorConfig extends SubmitterConfig {
  readonly databaseUrl: string;
  readonly rpcUrl: string;
  readonly signerPrivateKey: Hex;
  readonly pollIntervalMs: number;
  /** Blocks searched back for a `RootSubmitted` log. */
  readonly logLookbackBlocks: number;
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

  // The same chains the API accepts. A worker anchoring on any other chain writes roots the API
  // and Explorer never look for, so it refuses startup instead of running unnoticed. Plain digits
  // only, like ANCHOR_EOA_CHAIN_IDS: `Number()` would also read "0x38" or " 56 " as a chain.
  const chainIdRaw = required(env, "CHAIN_ID");
  const chainId = /^[0-9]+$/.test(chainIdRaw) ? Number(chainIdRaw) : Number.NaN;
  if (!isSupportedChainId(chainId)) {
    throw new Error(`CHAIN_ID must be one of ${describeChains(SUPPORTED_CHAIN_IDS)}`);
  }

  // A public anvil key on a shared chain lets anyone who knows the mnemonic anchor as this worker.
  let signer: string;
  try {
    signer = privateKeyToAccount(signerPrivateKey as Hex).address;
  } catch {
    // Out of the curve's range. The library's error is not passed on — it may quote the input.
    throw new Error("ANCHOR_SIGNER_PRIVATE_KEY is not a valid secp256k1 key");
  }
  assertNotDevKey("ANCHOR_SIGNER_PRIVATE_KEY", signer, chainId);

  const confirmationDepth = Number(env.ANCHOR_CONFIRMATIONS ?? "12");
  if (!Number.isInteger(confirmationDepth) || confirmationDepth < 1) {
    // A depth of 0 would mean "confirmed once in a block", which breaks 06 §6.8.
    throw new Error("ANCHOR_CONFIRMATIONS must be at least 1");
  }

  const finalityTag = loadFinalityTag(env, chainId);

  const feeCapGwei = Number(env.ANCHOR_FEE_CAP_GWEI ?? "100");
  if (!(feeCapGwei > 0)) throw new Error("ANCHOR_FEE_CAP_GWEI must be greater than 0");

  const dailySpendCapWei = loadDailySpendCap(env);

  // Solo EOA submission is for the local chain and, by explicit opt-in, the opBNB testnet. On
  // mainnet the Safe multisig holds the submitter role, and a setting must not be able to open a
  // path around it — so listing any other chain refuses startup instead of relying on the
  // default. The default stays the local chain alone: a testnet signer is a funded key, and
  // enabling it is the operator's decision.
  const eoaAllowedChainIds = (env.ANCHOR_EOA_CHAIN_IDS ?? String(LOCAL_CHAIN_ID))
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "")
    .map((value) => {
      if (!/^[0-9]+$/.test(value)) throw new Error("ANCHOR_EOA_CHAIN_IDS has an invalid chain id");
      const id = Number(value);
      if (!isEoaAnchorEligibleChainId(id)) {
        throw new Error(
          `ANCHOR_EOA_CHAIN_IDS may list only ${EOA_ANCHOR_ELIGIBLE_CHAIN_IDS.join(", ")}; chain ${id} anchors through the Safe`,
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
  // 145,926 gas plus 21,000 base (docs/operations/deployment.md); 200,000 leaves room for calldata.
  const gasLimit = BigInt(positiveInteger(env, "ANCHOR_GAS_LIMIT", 200_000));
  const feeCapWei = BigInt(Math.round(feeCapGwei * 1e9));
  // Every send is reserved at gas limit × fee cap until settled, and a broadcast that failed is
  // settled only once the next send reuses its nonce. A cap with room for a single send would
  // keep that next send out forever, so it must fit two.
  // On OP-stack this is only the startup floor: the live L1 quote must also fit twice before
  // an EOA send is admitted (`checkSubmitAllowed`). No signed ceiling exists for that L1 fee.
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
    finalityTag,
    logLookbackBlocks: positiveInteger(env, "ANCHOR_LOG_LOOKBACK_BLOCKS", defaultLogLookbackBlocks(chainId)),
    eoaAllowedChainIds,
    safeAddress,
    reorgWatchMs: positiveInteger(env, "ANCHOR_REORG_WATCH_MS", 30 * 60 * 1000),
    recheckIntervalMs: positiveInteger(env, "ANCHOR_RECHECK_MS", 15000),
    // A minute apart for an hour: long enough for a rate limit or a lagging node to clear,
    // short enough that a provider that can never answer reaches a person the same hour.
    chainSearchRetryMs: positiveInteger(env, "ANCHOR_CHAIN_SEARCH_RETRY_MS", 60 * 1000),
    chainSearchGiveUpMs: positiveInteger(env, "ANCHOR_CHAIN_SEARCH_GIVE_UP_MS", 60 * 60 * 1000),
    gasLimit,
  };
}

/**
 * `ANCHOR_FINALITY_TAG` — the block tag a receipt must also be at or below before `confirmed`.
 *
 * Unset or empty takes the chain's default: `safe` on shared chains, `none` on the local chain.
 * Anything else but the three names refuses startup: a typo read as `none` would quietly confirm
 * on depth alone, which on opBNB is 3 s.
 */
function loadFinalityTag(env: AnchorEnv, chainId: number): FinalityTag {
  const raw = env.ANCHOR_FINALITY_TAG;
  if (raw === undefined || raw === "") return defaultFinalityTag(chainId);
  if (!isFinalityTag(raw)) {
    throw new Error(`ANCHOR_FINALITY_TAG must be one of ${FINALITY_TAGS.join(", ")}`);
  }
  return raw;
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

/**
 * Refusal message when the RPC endpoint serves another chain than `CHAIN_ID`, or null.
 *
 * The worker signs with `CHAIN_ID` and records rows under it. Pointed at another chain's node it
 * would anchor where nobody verifies, or fail every send with no stated cause. The message carries
 * no URL: hosted endpoints put their API key in it.
 */
export function rpcChainMismatch(expected: number, reported: number): string | null {
  return reported === expected
    ? null
    : `CHAIN_RPC_URL serves chain ${reported}, but CHAIN_ID is ${expected}; refusing to start`;
}

/**
 * Refusal message when `ANCHOR_CONTRACT_ADDRESS` holds no code on the chain, or null. Like the
 * chain check, it names no URL.
 */
export function missingContractCode(chainId: number, hasCode: boolean): string | null {
  return hasCode
    ? null
    : `ANCHOR_CONTRACT_ADDRESS has no contract code on chain ${chainId}; refusing to start`;
}

/**
 * Refusal message when the endpoint does not answer the `ANCHOR_FINALITY_TAG` block tag, or null.
 * Without it no receipt reaches `confirmed`; refusing at startup says so once, instead of every
 * row waiting with `finality_read_failed`. `unreadable`: the read itself failed, which may be
 * passing, so the message does not claim the node lacks the tag. Like the chain check, it names
 * no URL.
 */
export function unansweredFinalityTag(
  chainId: number,
  tag: string,
  answer: boolean | "unreadable",
): string | null {
  if (answer === true) return null;
  return answer === "unreadable"
    ? `CHAIN_RPC_URL could not be asked for the "${tag}" block tag (ANCHOR_FINALITY_TAG) on chain ${chainId}; refusing to start`
    : `CHAIN_RPC_URL does not answer the "${tag}" block tag (ANCHOR_FINALITY_TAG) on chain ${chainId}; refusing to start`;
}
