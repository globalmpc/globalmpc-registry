/**
 * Browser wallet (EIP-1193) integration.
 *
 * Demo accounts sign directly in the browser with known private keys. Real users
 * never give us their keys — the wallet extension signs and we receive only the result.
 *
 * **Both paths use the same SIWE and EIP-712 flow.** Only the signer differs; what the server
 * sees is identical. So the server has no code distinguishing "demo or real wallet" —
 * such a distinction could let the demo path become looser than the real-wallet path.
 */

/** Defines only the parts of an EIP-1193 provider that we use. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

/**
 * One installed wallet — EIP-6963.
 *
 * `window.ethereum` has a single slot, so with two or more extensions installed **whichever claims it
 * first wins.** Even when the user tries to log in with MetaMask, another wallet responds, and when that
 * wallet rejects, the cause never appears on screen. EIP-6963 has each wallet announce itself
 * so the user can choose.
 */
export interface DiscoveredWallet {
  /** The wallet's reverse-DNS identifier. Two wallets can share a name, so choose by this. */
  readonly id: string;
  readonly name: string;
  /** data URI. May be absent. */
  readonly icon: string | null;
  readonly provider: Eip1193Provider;
}

interface Eip6963ProviderDetail {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: Eip1193Provider;
}

/** The wallet the user chose. Falls back to `window.ethereum` before a choice is made. */
let selectedProvider: Eip1193Provider | null = null;

/**
 * Subscribe to announcements.
 *
 * Wallets announce themselves after receiving a request. Without subscribe → request ordering,
 * announcements already sent are missed. Announcements can arrive more than once, so dedupe by id.
 */
export function subscribeWallets(onChange: (wallets: DiscoveredWallet[]) => void): () => void {
  if (typeof window === "undefined") return () => undefined;

  const found = new Map<string, DiscoveredWallet>();

  const handler = (event: Event) => {
    const detail = (event as CustomEvent<Eip6963ProviderDetail>).detail;
    if (!detail?.info?.rdns || !detail.provider) return;
    found.set(detail.info.rdns, {
      id: detail.info.rdns,
      name: detail.info.name,
      icon: detail.info.icon || null,
      provider: detail.provider,
    });
    onChange([...found.values()]);
  };

  window.addEventListener("eip6963:announceProvider", handler);
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  return () => window.removeEventListener("eip6963:announceProvider", handler);
}

export function selectWallet(wallet: DiscoveredWallet | null): void {
  selectedProvider = wallet?.provider ?? null;
}

export function getInjectedProvider(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  return selectedProvider ?? window.ethereum ?? null;
}

export function hasInjectedWallet(): boolean {
  return getInjectedProvider() !== null;
}

export class WalletError extends Error {
  constructor(
    message: string,
    /** Whether the user rejected it directly. A choice, not an error. */
    readonly rejectedByUser: boolean,
    /**
     * The original code from the wallet. Losing it when wrapping leaves "no code" in the connection log,
     * and which wallet stopped on what cannot be reproduced (surfaced in E2E on 2026-09-11).
     */
    readonly code?: number,
  ) {
    super(message);
    this.name = "WalletError";
  }
}

/** EIP-1193 user rejection code. Showing it as an error makes a choice look like a failure. */
const USER_REJECTED = 4001;

/** JSON-RPC internal error. MetaMask mobile wraps the real code inside it. */
const INTERNAL_ERROR = -32603;

/**
 * Extract the code from a wallet error.
 *
 * **Each wallet puts the code in a different place.** Desktop MetaMask puts 4902 (unknown chain)
 * in the top-level `code`, but MetaMask mobile sets the top level to `-32603` and puts the real
 * code in `data.originalError.code` (metamask-mobile #3312). Reading only the top level leaves
 * mobile users stuck at "switch failed" with no offer to add the chain.
 */
export function rpcErrorCode(caught: unknown): number | undefined {
  const error = caught as { code?: unknown; data?: { originalError?: { code?: unknown } } } | null;
  const top = typeof error?.code === "number" ? error.code : undefined;
  const nested =
    typeof error?.data?.originalError?.code === "number" ? error.data.originalError.code : undefined;
  if (top !== undefined && top !== INTERNAL_ERROR) return top;
  return nested ?? top;
}

function toWalletError(caught: unknown, fallback: string): WalletError {
  const code = rpcErrorCode(caught);
  if (code === USER_REJECTED) {
    return new WalletError("The wallet rejected the request", true, code);
  }
  const message = caught instanceof Error ? caught.message : String(caught);
  return new WalletError(`${fallback}: ${message}`, false, code);
}

/**
 * Request account connection.
 *
 * A wallet reveals the address only after the user approves. There is no way to get the address
 * without approval, and there should not be.
 */
export async function connectWallet(): Promise<string> {
  const provider = getInjectedProvider();
  if (!provider) throw new WalletError("No browser wallet is available", false);

  try {
    const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
    const address = accounts[0];
    if (!address) throw new WalletError("The wallet returned no account", false);
    return address.toLowerCase();
  } catch (caught) {
    if (caught instanceof WalletError) throw caught;
    throw toWalletError(caught, "Could not connect the wallet");
  }
}

/**
 * Check the chain.
 *
 * The server accepts signatures only for specific chainIds. Signing with a wallet on another chain
 * fails verification, and that failure looks like "wrong signature", making the cause hard to find.
 * Check up front and say what differs.
 */
export async function currentChainId(): Promise<number> {
  const provider = getInjectedProvider();
  if (!provider) throw new WalletError("No browser wallet is available", false);

  const hex = (await provider.request({ method: "eth_chainId" })) as string;
  return Number.parseInt(hex, 16);
}

/**
 * Values used to offer adding the chain when the wallet does not know it.
 *
 * The server accepts only chains 56 and 97 (`apps/api/src/config.ts`). Listing any other chain here
 * would move the wallet to a chain that cannot be used.
 */
const CHAIN_PARAMS: Readonly<
  Record<
    number,
    {
      chainName: string;
      nativeCurrency: { name: string; symbol: string; decimals: number };
      rpcUrls: string[];
      blockExplorerUrls: string[];
    }
  >
> = {
  56: {
    chainName: "BNB Smart Chain",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: ["https://bsc-rpc.publicnode.com"],
    blockExplorerUrls: ["https://bscscan.com"],
  },
  97: {
    chainName: "BNB Smart Chain Testnet",
    nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
    rpcUrls: ["https://bsc-testnet-rpc.publicnode.com"],
    blockExplorerUrls: ["https://testnet.bscscan.com"],
  },
};

/**
 * Block explorer URL for a transaction hash.
 *
 * Visitors must be able to check a public record's tx hash on BscScan themselves. If the chain is
 * outside those the server accepts (56, 97) or the value is not hash-shaped, no link is made — plain
 * text is better than sending them to a page that does not exist.
 */
export function blockExplorerTxUrl(chainId: number, hash: string): string | null {
  const base = CHAIN_PARAMS[chainId]?.blockExplorerUrls[0];
  return base && /^0x[0-9a-fA-F]{64}$/.test(hash) ? `${base}/tx/${hash}` : null;
}

/**
 * Switch chains — add the chain if missing.
 *
 * **Tries adding without waiting for 4902.** Wallets respond differently when they
 * do not know the chain: desktop MetaMask returns 4902; MetaMask
 * mobile returns 4902 wrapped in `-32603`, or no code at all (#3312, #12502). Trying to match codes
 * just stalls on yet another wallet. Stop only when the user rejects; otherwise offer to add
 * the chain — if it already exists, the wallet only switches.
 *
 * Some wallets do not switch after adding, so check once more.
 */
export async function switchChain(chainId: number): Promise<void> {
  const provider = getInjectedProvider();
  if (!provider) throw new WalletError("No browser wallet is available", false);

  const hex = `0x${chainId.toString(16)}`;
  const switchTo = () =>
    provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });

  try {
    await switchTo();
    return;
  } catch (caught) {
    const params = CHAIN_PARAMS[chainId];
    // A rejection is a choice. Following it with an add prompt would ignore the rejection.
    if (rpcErrorCode(caught) === USER_REJECTED || !params) {
      throw toWalletError(caught, "Could not switch chain");
    }

    try {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: hex, ...params }],
      });
    } catch (addFailed) {
      throw toWalletError(addFailed, `Could not add ${params.chainName} to the wallet`);
    }
  }

  if ((await currentChainId()) !== chainId) {
    try {
      await switchTo();
    } catch (again) {
      throw toWalletError(again, "Could not switch chain");
    }
  }
}

/**
 * Align the wallet to that chain. Does nothing if it already matches.
 *
 * Returns the result — the connection log (`session.tsx`) records whether a switch happened.
 */
export async function ensureChain(
  chainId: number,
): Promise<{ readonly before: number; readonly switched: boolean }> {
  const before = await currentChainId();
  if (before === chainId) return { before, switched: false };
  await switchChain(chainId);
  return { before, switched: true };
}

/**
 * Flags the responding wallet reports about itself.
 *
 * **For logging only — not for decisions.** A flag is only what a wallet calls itself
 * (many wallets set `isMetaMask`); branching on it produces per-wallet code.
 * Recorded because reproducing a problem requires knowing what responded.
 */
export function walletFlags(provider: Eip1193Provider | null): string[] {
  if (!provider) return [];
  const flags = provider as unknown as Record<string, unknown>;
  return [
    "isMetaMask",
    "isBraveWallet",
    "isTrust",
    "isTrustWallet",
    "isCoinbaseWallet",
    "isRabby",
    "isOkxWallet",
  ].filter((name) => flags[name] === true);
}

/**
 * Listen for account and chain changes in the wallet.
 *
 * The session is bound to the old address on the server, so it is not a permission problem. The problem is that
 * the account the user sees in the wallet differs from the one on screen — when a signature is requested,
 * it is signed with the wrong account or rejected for no visible reason.
 */
export function subscribeProviderEvents(handlers: {
  onAccounts(accounts: string[]): void;
  onChain(chainId: number): void;
}): () => void {
  const provider = getInjectedProvider();
  if (!provider?.on || !provider.removeListener) return () => undefined;

  const onAccounts = (...args: unknown[]) =>
    handlers.onAccounts(((args[0] as string[] | undefined) ?? []).map((a) => a.toLowerCase()));
  const onChain = (...args: unknown[]) =>
    handlers.onChain(Number.parseInt(String(args[0]), 16));

  provider.on("accountsChanged", onAccounts);
  provider.on("chainChanged", onChain);
  return () => {
    provider.removeListener?.("accountsChanged", onAccounts);
    provider.removeListener?.("chainChanged", onChain);
  };
}

/** SIWE message signature. `personal_sign` takes arguments in (message, address) order. */
export async function personalSign(message: string, address: string): Promise<string> {
  const provider = getInjectedProvider();
  if (!provider) throw new WalletError("No browser wallet is available", false);

  try {
    return (await provider.request({
      method: "personal_sign",
      params: [message, address],
    })) as string;
  } catch (caught) {
    throw toWalletError(caught, "Could not sign");
  }
}

/**
 * EIP-712 typed data signature.
 *
 * Passes the server's structure as-is. Rebuilding it here can make what the user sees in the wallet
 * differ from what the server verifies — the most common way to lose track of what was
 * actually signed.
 */
export async function signTypedDataWithWallet(
  typedData: unknown,
  address: string,
): Promise<string> {
  const provider = getInjectedProvider();
  if (!provider) throw new WalletError("No browser wallet is available", false);

  try {
    return (await provider.request({
      method: "eth_signTypedData_v4",
      params: [address, JSON.stringify(typedData)],
    })) as string;
  } catch (caught) {
    throw toWalletError(caught, "Could not sign");
  }
}
