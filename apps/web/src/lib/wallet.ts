/**
 * 브라우저 지갑(EIP-1193) 연동.
 *
 * 데모 계정은 알려진 private key로 브라우저에서 직접 서명한다. 실제 사용자는
 * 자기 키를 우리에게 주지 않는다 — 지갑 확장이 서명하고 우리는 결과만 받는다.
 *
 * **두 경로가 같은 SIWE·EIP-712 흐름을 쓴다.** 서명 주체만 다르고 서버가 보는
 * 것은 동일하다. 그래서 서버에는 "데모냐 실지갑이냐"를 구분하는 코드가 없다 —
 * 구분이 있으면 데모 경로가 실지갑 경로보다 느슨해질 수 있다.
 */

/** EIP-1193 provider의 우리가 쓰는 부분만 정의한다. */
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
 * 설치된 지갑 하나 — EIP-6963.
 *
 * `window.ethereum`은 자리가 하나뿐이라 확장을 둘 이상 깔면 **먼저 잡은 쪽이
 * 이긴다.** 사용자가 MetaMask로 로그인하려 해도 다른 지갑이 응답하고, 그 지갑이
 * 거절하면 원인이 화면에 드러나지 않는다. EIP-6963은 각 지갑이 자기를 알리게
 * 해서 사용자가 고르게 한다.
 */
export interface DiscoveredWallet {
  /** 지갑의 역-DNS 식별자. 같은 이름의 지갑이 둘일 수 있어 이것으로 고른다. */
  readonly id: string;
  readonly name: string;
  /** data URI. 없을 수 있다. */
  readonly icon: string | null;
  readonly provider: Eip1193Provider;
}

interface Eip6963ProviderDetail {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: Eip1193Provider;
}

/** 사용자가 고른 지갑. 고르기 전에는 `window.ethereum`으로 떨어진다. */
let selectedProvider: Eip1193Provider | null = null;

/**
 * 알림을 구독한다.
 *
 * 지갑은 요청을 받은 뒤에 자기를 알린다. 구독 → 요청 순서를 지키지 않으면 이미
 * 지나간 알림을 놓친다. 알림은 여러 번 올 수 있으므로 id로 중복을 지운다.
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
    /** 사용자가 직접 거부한 것인가. 오류가 아니라 선택이다. */
    readonly rejectedByUser: boolean,
    /**
     * 지갑이 준 원래 코드. 감싸면서 잃으면 연결 기록이 "no code"를 남기고, 어느
     * 지갑이 무엇으로 멈췄는지 재현할 수 없다(2026-09-11 E2E에서 드러났다).
     */
    readonly code?: number,
  ) {
    super(message);
    this.name = "WalletError";
  }
}

/** EIP-1193의 사용자 거부 코드. 이것을 오류로 표시하면 선택을 실패로 보이게 한다. */
const USER_REJECTED = 4001;

/** JSON-RPC 내부 오류. MetaMask 모바일은 진짜 코드를 이 안에 싸서 준다. */
const INTERNAL_ERROR = -32603;

/**
 * 지갑 오류에서 코드를 꺼낸다.
 *
 * **지갑마다 코드를 싣는 자리가 다르다.** 데스크톱 MetaMask는 최상위 `code`에
 * 4902(체인 없음)를 주지만, MetaMask 모바일은 최상위를 `-32603`으로 두고 진짜
 * 코드를 `data.originalError.code`에 넣는다(metamask-mobile #3312). 최상위만 보면
 * 모바일 사용자는 체인 추가 제안 없이 "전환 실패"에서 멈춘다.
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
 * 계정 연결 요청.
 *
 * 지갑은 사용자가 승인해야 주소를 알려준다. 승인 없이 주소를 얻는 방법은 없고,
 * 있어서도 안 된다.
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
 * 체인 확인.
 *
 * 서버는 특정 chainId의 서명만 받는다. 다른 체인에 연결된 지갑으로 서명하면
 * 검증에 실패하는데, 그 실패는 "서명이 틀렸다"로 보여 원인을 찾기 어렵다.
 * 미리 확인하고 무엇이 다른지 말한다.
 */
export async function currentChainId(): Promise<number> {
  const provider = getInjectedProvider();
  if (!provider) throw new WalletError("No browser wallet is available", false);

  const hex = (await provider.request({ method: "eth_chainId" })) as string;
  return Number.parseInt(hex, 16);
}

/**
 * 지갑이 그 체인을 모를 때 추가를 제안하기 위한 값.
 *
 * 서버가 받는 체인은 56과 97뿐이다(`apps/api/src/config.ts`). 그 외를 여기에
 * 두면 넣을 수 없는 체인으로 지갑을 옮기게 된다.
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
 * transaction hash의 체인 탐색기 주소.
 *
 * 공개 기록의 tx hash는 방문자가 BscScan에서 직접 확인할 수 있어야 한다. 서버가
 * 받는 체인(56·97) 밖이거나 hash 모양이 아니면 링크를 만들지 않는다 — 없는
 * 페이지로 보내는 것보다 글자로 두는 편이 낫다.
 */
export function blockExplorerTxUrl(chainId: number, hash: string): string | null {
  const base = CHAIN_PARAMS[chainId]?.blockExplorerUrls[0];
  return base && /^0x[0-9a-fA-F]{64}$/.test(hash) ? `${base}/tx/${hash}` : null;
}

/**
 * 체인 전환 — 없으면 추가한다.
 *
 * **4902를 기다리지 않고 추가를 시도한다.** 지갑이 그
 * 체인을 모를 때 주는 응답이 제각각이다: 데스크톱 MetaMask는 4902, MetaMask
 * 모바일은 `-32603`에 싼 4902 또는 아예 코드 없음(#3312·#12502). 코드를 맞히려
 * 하면 한 지갑에서 또 멈춘다. 사용자가 거부한 경우만 멈추고, 나머지는 추가를
 * 제안한다 — 이미 있는 체인이면 지갑이 전환만 한다.
 *
 * 추가 뒤에 전환하지 않는 지갑이 있어 한 번 더 확인한다.
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
    // 거부는 선택이다. 추가를 이어서 띄우면 거부를 무시하는 것이 된다.
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
 * 지갑을 그 체인에 맞춘다. 이미 맞으면 아무것도 하지 않는다.
 *
 * 결과를 돌려준다 — 연결 기록(`session.tsx`)이 "전환했는가"를 남긴다.
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
 * 응답하는 지갑이 스스로 밝힌 표시.
 *
 * **기록용이다 — 판정에 쓰지 않는다.** 표시는 지갑이 자기를 그렇게 부르는 것일
 * 뿐이고(여러 지갑이 `isMetaMask`를 켠다), 그것으로 분기하면 지갑마다 다른 코드가
 * 생긴다. 무엇이 응답했는지 알아야 문제를 재현할 수 있어서 남긴다.
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
 * 지갑에서 계정·체인을 바꾸는 것을 듣는다.
 *
 * 세션은 서버에서 옛 주소에 묶여 있으므로 권한 문제는 아니다. 문제는 사용자가
 * 지갑에서 본 계정과 화면의 계정이 다르다는 것이다 — 서명을 요청받는 순간
 * 엉뚱한 계정으로 서명하거나 거절이 이유 없이 난다.
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

/** SIWE 메시지 서명. `personal_sign`은 인자 순서가 (message, address)다. */
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
 * EIP-712 typed data 서명.
 *
 * 서버가 준 구조를 그대로 넘긴다. 여기서 재구성하면 사용자가 지갑에서 본 것과
 * 서버가 검증하는 것이 달라질 수 있다 — 그것이 무엇에 서명했는지 모르게 되는
 * 가장 흔한 경로다.
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
