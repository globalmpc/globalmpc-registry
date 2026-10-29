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
