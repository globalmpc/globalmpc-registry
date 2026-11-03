/**
 * Chains a deployment may run on.
 *
 * The API, wallet bind, bootstrap, anchor worker, and web all decide against this one list. When
 * each kept its own copy, a chain added in one place logged in fine and then failed at the next
 * step (bind, anchor, explorer link) with no reason shown.
 *
 * Anchoring on a chain outside this list splits the Explorer's verification path, so anything
 * else refuses startup or the request.
 */

export const BSC_MAINNET_CHAIN_ID = 56;
export const OPBNB_TESTNET_CHAIN_ID = 5611;
export const LOCAL_CHAIN_ID = 31337;

export const SUPPORTED_CHAIN_IDS = [BSC_MAINNET_CHAIN_ID, OPBNB_TESTNET_CHAIN_ID, LOCAL_CHAIN_ID] as const;

export type SupportedChainId = (typeof SUPPORTED_CHAIN_IDS)[number];

/** Names used in error messages, so the operator sees which network a number means. */
export const CHAIN_LABELS: Readonly<Record<SupportedChainId, string>> = {
  [BSC_MAINNET_CHAIN_ID]: "BSC mainnet",
  [OPBNB_TESTNET_CHAIN_ID]: "opBNB testnet",
  [LOCAL_CHAIN_ID]: "local chain",
};

export function isSupportedChainId(value: unknown): value is SupportedChainId {
  return (SUPPORTED_CHAIN_IDS as readonly unknown[]).includes(value);
}

/**
 * The standing of a chain's anchors: `mainnet` anchors are the public record; `testnet` ones are
 * for trying the system out and prove nothing to the public.
 *
 * Stated per chain, not derived ("not 56, so a testnet"): a chain added to the list must be
 * classified on purpose, and the `Record` makes leaving it out a type error. A batch must never
 * move between environments — its record would then claim an anchor on a network of another
 * standing (the API's resubmit and the anchor worker's chain move both check this).
 *
 * The local chain counts with the test networks: neither has public standing, and a developer
 * moving a batch between them (local and opBNB testnet) claims nothing.
 */
export type ChainEnvironment = "mainnet" | "testnet";

export const CHAIN_ENVIRONMENTS: Readonly<Record<SupportedChainId, ChainEnvironment>> = {
  [BSC_MAINNET_CHAIN_ID]: "mainnet",
  [OPBNB_TESTNET_CHAIN_ID]: "testnet",
  [LOCAL_CHAIN_ID]: "testnet",
};

/** A supported chain's environment; null for any other chain, which has no standing to share. */
export function chainEnvironmentOf(chainId: number): ChainEnvironment | null {
  return isSupportedChainId(chainId) ? CHAIN_ENVIRONMENTS[chainId] : null;
}

/**
 * Whether a batch may move from one chain to the other: both supported, in one environment. A
 * chain outside the list is never the same environment as anything, itself included.
 */
export function sameChainEnvironment(a: number, b: number): boolean {
  const environment = chainEnvironmentOf(a);
  return environment !== null && environment === chainEnvironmentOf(b);
}

/**
 * A chain ID read from configuration, or null when it is not a supported chain.
 *
 * Plain decimal digits only: `Number()` would also read "0x15eb", " 56 " or "5.611e3" as a
 * chain, and every service reading `CHAIN_ID` must agree on what a value means.
 */
export function parseSupportedChainId(raw: string): SupportedChainId | null {
  const value = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
  return isSupportedChainId(value) ? value : null;
}

/**
 * Chains where the anchor worker **may** be configured to sign alone as an EOA.
 *
 * Only the local and test chains. On mainnet the Safe multisig holds the submitter role, and no
 * setting may open a path around it. Being in this set does not enable anything — the worker
 * still needs the chain listed explicitly in `ANCHOR_EOA_CHAIN_IDS`; the default lists only the
 * local chain.
 */
export const EOA_ANCHOR_ELIGIBLE_CHAIN_IDS = [OPBNB_TESTNET_CHAIN_ID, LOCAL_CHAIN_ID] as const;

export function isEoaAnchorEligibleChainId(value: number): boolean {
  return (EOA_ANCHOR_ELIGIBLE_CHAIN_IDS as readonly number[]).includes(value);
}

/** `56 (BSC mainnet), 5611 (opBNB testnet), …` — for messages that list the allowed chains. */
export function describeChains(ids: readonly SupportedChainId[]): string {
  return ids.map((id) => `${id} (${CHAIN_LABELS[id]})`).join(", ");
}
