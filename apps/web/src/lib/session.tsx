"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { TypedDataDefinition } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import {
  getSession,
  logout as logoutRequest,
  requestSiweNonce,
  verifySiwe,
  type SessionInfo,
} from "./api";
import {
  connectWallet,
  ensureChain,
  getInjectedProvider,
  hasInjectedWallet,
  selectWallet,
  subscribeWallets,
  type DiscoveredWallet,
  personalSign,
  signTypedDataWithWallet,
  rpcErrorCode,
  subscribeProviderEvents,
  walletFlags,
  WalletError,
} from "./wallet";

/**
 * 데모 계정.
 *
 * **R1부터 실제 SIWE 서명으로 로그인한다.** 개발용 wallet 헤더 경로는 제거됐다.
 *
 * 브라우저 지갑 확장(EIP-1193)이 없는 환경에서도 흐름을 확인할 수 있도록,
 * 데모 계정은 알려진 private key로 브라우저에서 직접 서명한다. **이 키는 데모
 * 전용이며 어떤 자산도 보유하지 않는다.** 실제 지갑 연동은 `window.ethereum`이
 * 있을 때 그것을 우선 사용한다.
 */
export interface DemoAccount {
  readonly label: string;
  readonly privateKey: `0x${string}`;
  readonly description: string;
}

/**
 * 데모 계정의 이름과 역할. **키는 여기 없다.**
 *
 * 키를 저장소에 두면 그것을 아는 누구나 배포된 주소에서 그 역할로 로그인한다.
 * 지운다고 과거 커밋에서 사라지지도 않는다. 그래서 키는 실행할 때 밖에서 준다 —
 * `NEXT_PUBLIC_DEMO_ACCOUNT_KEYS`에 `{"Operator A": "0x…"}` 형태로 넣는다.
 * E2E는 실행마다 새 키를 만들어 넣는다(`playwright.config.ts`).
 *
 * 값을 주지 않으면 목록이 비고 로그인 화면에는 지갑 연결만 남는다. 배포는 그
 * 상태로 만든다.
 */
const DEMO_ACCOUNT_PROFILES: readonly Omit<DemoAccount, "privateKey">[] = [
  { label: "Operator A", description: "Tenant A · mpc_operator · high_assurance" },
  { label: "Operator B", description: "Tenant B · mpc_operator · high_assurance" },
  { label: "Operator C", description: "Tenant C · mpc_operator · no projects" },
  { label: "Reader A", description: "Tenant A · no roles · wallet_only" },
  { label: "Steward A", description: "Tenant A · data_steward · handles evidence and claims" },
  { label: "Approver A", description: "Tenant A · gate_approver · records human decisions" },
  { label: "Reviewer A", description: "Tenant A · reviewer_cp_qp · signs under a credential" },
  { label: "Proposer A", description: "Tenant A · protocol_proposer · creates proposals" },
  { label: "Voter A", description: "Tenant A · protocol_voter · votes only" },
  // 사람이 아니라 시스템 identity다. 화면에 두는 이유는 E2E가 검사 서비스의
  // 세션으로 API를 부를 수 있어야 하기 때문이다.
  { label: "Scan Service", description: "Tenant A · scan_service · reports scan results only" },
];

/**
 * 밖에서 준 키를 읽는다.
 *
 * 형식이 깨졌다고 화면을 못 뜨게 하지 않는다 — 데모 계정이 없는 것과 같은 상태로
 * 떨어뜨린다. 배포에서는 애초에 값이 없다.
 */
function readDemoKeys(): Readonly<Record<string, string>> {
  /**
   * production 번들에는 데모 계정이 없다.
   *
   * 빌드가 이미 거절하지만(`next.config.ts`) 여기서도 본다. 방어가 하나뿐이면
   * 그 하나가 바뀌는 순간 막는 것이 없고, 이 값이 뚫리면 곧 인증 우회다.
   */
  if (process.env.NODE_ENV === "production") return {};

  try {
    const parsed: unknown = JSON.parse(process.env.NEXT_PUBLIC_DEMO_ACCOUNT_KEYS ?? "{}");
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

export const DEMO_ACCOUNTS: readonly DemoAccount[] = DEMO_ACCOUNT_PROFILES.flatMap(
  (profile) => {
    const privateKey = readDemoKeys()[profile.label];
    return privateKey ? [{ ...profile, privateKey: privateKey as `0x${string}` }] : [];
  },
);

export function demoAddress(account: DemoAccount): string {
  return privateKeyToAccount(account.privateKey).address.toLowerCase();
}

/** 마지막 지갑 연결 시도의 단계 기록. 탭을 닫으면 사라진다 — 진단용이다. */
const TRACE_KEY = "mpc.wallet.trace";
/** 사용자가 고른 지갑(EIP-6963 rdns). 새로고침 뒤에도 같은 지갑을 부르기 위해서다. */
const WALLET_ID_KEY = "mpc.session.walletId";
const STORAGE_KEY = "mpc.session.token";
const ACCOUNT_KEY = "mpc.session.account";
/** 실지갑으로 로그인했는지. 새로고침 뒤에도 서명 주체를 알아야 한다. */
const WALLET_KEY = "mpc.session.wallet";

/** EIP-712 서명 요청. 서버가 내려준 구조를 그대로 지갑에 넘긴다. */
export interface TypedDataRequest {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

/**
 * 지갑 연결의 한 단계 — 2026-09-11.
 *
 * 연결은 브라우저에서 일어나고 서버는 결과만 본다. 어느 지갑이 응답했는지, 체인
 * 전환이 어떤 코드로 실패했는지는 **어디에도 남지 않았다.** 사용자가 겪은 것을
 * 재현하려면 그 단계가 필요하다. 개인키·서명 값은 넣지 않는다.
 */
export interface ConnectionStep {
  readonly at: string;
  readonly step: string;
  readonly detail: string;
}

interface SessionContextValue {
  token: string | null;
  session: SessionInfo | null;
  /** 현재 연결된 데모 계정. 실지갑으로 로그인했으면 null이다. */
  account: DemoAccount | null;
  /** 실지갑으로 연결된 주소. 데모 계정이면 null이다. */
  walletAddress: string | null;
  /** 브라우저에 지갑 확장이 있는가. 없으면 데모 계정만 쓸 수 있다. */
  walletAvailable: boolean;
  /**
   * 설치된 지갑 목록(EIP-6963).
   *
   * 둘 이상이면 사용자가 골라야 한다. `window.ethereum`만 보면 먼저 잡은 확장이
   * 이기고, 사용자가 의도한 지갑이 아닌 쪽이 거절해도 이유가 드러나지 않는다.
   */
  wallets: readonly DiscoveredWallet[];
  /** 마지막 지갑 연결 시도의 단계. 연결 화면이 보여 주고 복사하게 한다. */
  connectionLog: readonly ConnectionStep[];
  loading: boolean;
  signingIn: boolean;
  error: string | null;
  /** 성공 여부를 돌려준다. 실패한 채로 워크스페이스로 보내면 안내가 사라진다. */
  signIn(account: DemoAccount): Promise<boolean>;
  /**
   * 브라우저 지갑으로 로그인한다. 개인키는 우리에게 오지 않는다.
   *
   * 성공 여부를 돌려준다 — 호출한 화면이 실패했는데도 다음 화면으로 넘어가면
   * 오류 안내가 그려질 자리가 사라진다.
   */
  signInWithWallet(wallet?: DiscoveredWallet): Promise<boolean>;
  signOut(): Promise<void>;
  refresh(): Promise<void>;
  signTypedData(request: TypedDataRequest): Promise<string>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [account, setAccount] = useState<DemoAccount | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [walletAvailable, setWalletAvailable] = useState(false);
  const [wallets, setWallets] = useState<readonly DiscoveredWallet[]>([]);
  const [loading, setLoading] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionLog, setConnectionLog] = useState<readonly ConnectionStep[]>([]);

  const load = useCallback(async (value: string | null) => {
    setLoading(true);
    try {
      setSession(await getSession(value));
    } catch {
      setSession(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    setToken(stored);

    // 새로고침 뒤에도 어느 계정으로 서명해야 하는지 알아야 한다. 토큰만 남기면
    // 세션은 살아 있는데 서명은 못 하는 상태가 된다.
    const storedLabel = window.localStorage.getItem(ACCOUNT_KEY);
    setAccount(DEMO_ACCOUNTS.find((candidate) => candidate.label === storedLabel) ?? null);
    setWalletAddress(window.localStorage.getItem(WALLET_KEY));
    try {
      setConnectionLog(
        JSON.parse(window.sessionStorage.getItem(TRACE_KEY) ?? "[]") as ConnectionStep[],
      );
    } catch {
      setConnectionLog([]);
    }

    // 지갑 확장은 페이지 로드 직후 주입되지 않을 수 있다. 한 번 더 확인한다.
    setWalletAvailable(hasInjectedWallet());
    const timer = setTimeout(() => setWalletAvailable(hasInjectedWallet()), 500);

    // 지갑은 요청을 받은 뒤 자기를 알린다. 구독을 먼저 걸어야 놓치지 않는다.
    const storedWalletId = window.localStorage.getItem(WALLET_ID_KEY);
    const unsubscribe = subscribeWallets((found) => {
      setWallets(found);
      if (found.length > 0) setWalletAvailable(true);
      // 새로고침 뒤에도 로그인한 그 지갑을 부른다. 아니면 `window.ethereum`을 먼저
      // 잡은 다른 확장이 서명 요청을 받는다.
      const previous = found.find((candidate) => candidate.id === storedWalletId);
      if (previous) selectWallet(previous);
    });

    void load(stored);
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [load]);

  /**
   * SIWE 로그인.
   *
   * nonce 발급 → 메시지 서명 → 검증 → 세션 토큰. 서버가 서명을 검증하기 전에는
   * 어떤 권한도 생기지 않는다.
   */
  const signIn = useCallback(
    async (demo: DemoAccount): Promise<boolean> => {
      setSigningIn(true);
      setError(null);
      try {
        const account = privateKeyToAccount(demo.privateKey);
        const address = account.address.toLowerCase();

        // 서명할 체인은 서버가 정한다.
        const challenge = await requestSiweNonce(address);

        const message = createSiweMessage({
          address: account.address,
          chainId: challenge.chainId,
          domain: challenge.domain,
          nonce: challenge.nonce,
          statement: challenge.statement,
          // 서버가 검증하는 값을 그대로 쓴다. 여기서 추측하면 서버와 갈라진다.
          uri: challenge.uri,
          version: "1",
          issuedAt: new Date(),
        });

        const signature = await account.signMessage({ message });
        const verified = await verifySiwe(message, signature);

        window.localStorage.setItem(STORAGE_KEY, verified.sessionToken);
        window.localStorage.setItem(ACCOUNT_KEY, demo.label);
        window.localStorage.removeItem(WALLET_KEY);
        setToken(verified.sessionToken);
        setAccount(demo);
        setWalletAddress(null);
        await load(verified.sessionToken);
        return true;
      } catch (caught) {
        // 실패를 삼키지 않는다. 여기서 true를 돌려주면 호출부가 이동하고,
        // 사용자는 이유 없이 빈 워크스페이스에 도착한다(§11.7).
        setError(caught instanceof Error ? caught.message : String(caught));
        return false;
      } finally {
        setSigningIn(false);
      }
    },
    [load],
  );

  /**
   * 브라우저 지갑으로 로그인.
   *
   * 데모 계정과 **같은 SIWE 흐름**을 쓴다. nonce 발급 → 메시지 서명 → 검증.
   * 다른 것은 서명하는 주체뿐이며 서버는 둘을 구분하지 않는다.
   *
   * 체인이 다르면 먼저 전환을 요청한다. 다른 체인의 서명은 검증에 실패하는데,
   * 그 실패가 "서명이 틀렸다"로 보이면 원인을 찾기 어렵다.
   */
  const signInWithWallet = useCallback(async (wallet?: DiscoveredWallet) => {
    setSigningIn(true);
    setError(null);

    // 이번 시도의 단계. 성공해도 실패해도 남긴다 — 성공한 경로도 비교 대상이다.
    const steps: ConnectionStep[] = [];
    const record = (step: string, detail: string) => {
      steps.push({ at: new Date().toISOString(), step, detail });
      setConnectionLog([...steps]);
      try {
        window.sessionStorage.setItem(TRACE_KEY, JSON.stringify(steps));
      } catch {
        // 저장이 막힌 브라우저(사생활 보호 모드)에서도 로그인은 되어야 한다.
      }
    };
    const describe = (caught: unknown) =>
      `${rpcErrorCode(caught) ?? (caught as { code?: unknown } | null)?.code ?? "no code"}: ${
        caught instanceof Error ? caught.message : String(caught)
      }`;

    try {
      // 사용자가 고른 지갑으로 요청을 보낸다. 고르지 않았으면 `window.ethereum`이다.
      selectWallet(wallet ?? null);
      record(
        "wallet",
        `${wallet ? `${wallet.name} (${wallet.id})` : "window.ethereum"} · ${
          walletFlags(getInjectedProvider()).join(" ") || "no flags"
        } · ${navigator.userAgent}`,
      );

      const address = await connectWallet();
      record("account", `${address.slice(0, 6)}…${address.slice(-4)}`);

      // 서명할 체인은 서버가 정한다.
      const challenge = await requestSiweNonce(address);
      record("nonce", `chain ${challenge.chainId}`);

      /**
       * 체인을 곧바로 맞추되 **로그인을 막지 않는다**.
       *
       * SIWE 서명(`personal_sign`)은 체인과 무관하다 — 메시지 안의 chain ID를
       * 서버가 볼 뿐이다. 전환을 로그인의 조건으로 두면 체인을 추가하지 못하는
       * 지갑(테스트넷을 숨기는 Trust Wallet, 코드를 싸서 주는 MetaMask 모바일)의
       * 사용자가 로그인부터 막힌다. 여기서는 시도하고 결과를 남기며, 체인이 꼭
       * 맞아야 하는 EIP-712 서명 직전에 다시 맞춘다(`signTypedData`).
       */
      try {
        const result = await ensureChain(challenge.chainId);
        record(
          "chain",
          result.switched
            ? `switched ${result.before} → ${challenge.chainId}`
            : `already ${result.before}`,
        );
      } catch (caught) {
        record("chain", `not switched (${describe(caught)})`);
      }

      const message = createSiweMessage({
        address: address as `0x${string}`,
        chainId: challenge.chainId,
        domain: challenge.domain,
        nonce: challenge.nonce,
        statement: challenge.statement,
        // 서버가 검증하는 값을 그대로 쓴다. 여기서 추측하면 서버와 갈라진다.
        uri: challenge.uri,
        version: "1",
        issuedAt: new Date(),
      });

      const signature = await personalSign(message, address);
      record("signature", "signed");
      const verified = await verifySiwe(message, signature);
      record("session", "verified");

      window.localStorage.setItem(STORAGE_KEY, verified.sessionToken);
      window.localStorage.setItem(WALLET_KEY, address);
      if (wallet) window.localStorage.setItem(WALLET_ID_KEY, wallet.id);
      else window.localStorage.removeItem(WALLET_ID_KEY);
      window.localStorage.removeItem(ACCOUNT_KEY);
      setToken(verified.sessionToken);
      setWalletAddress(address);
      setAccount(null);
      await load(verified.sessionToken);
      return true;
    } catch (caught) {
      record("failed", describe(caught));
      // 사용자가 거부한 것은 오류가 아니다. 그렇게 보이면 다시 시도하게 만든다.
      if (caught instanceof WalletError && caught.rejectedByUser) {
        setError("The wallet rejected the request. Press connect to try again.");
      } else {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
      return false;
    } finally {
      setSigningIn(false);
    }
  }, [load]);

  const signOut = useCallback(async () => {
    if (token) {
      // 서버에서 토큰을 폐기한다. 로컬 삭제만 하면 토큰은 만료까지 살아 있다.
      await logoutRequest(token).catch(() => undefined);
    }
    window.localStorage.removeItem(STORAGE_KEY);
    window.localStorage.removeItem(ACCOUNT_KEY);
    window.localStorage.removeItem(WALLET_KEY);
    window.localStorage.removeItem(WALLET_ID_KEY);
    setToken(null);
    setSession(null);
    setAccount(null);
    setWalletAddress(null);
  }, [token]);

  /**
   * 지갑에서 계정·체인을 바꾸면 화면이 안다.
   *
   * 다른 계정으로 바꿨으면 연결을 끊고 다시 연결하라고 말한다. 세션은 서버에서
   * 옛 주소에 묶여 있으므로 권한 문제는 아니지만, 그대로 두면 다음 서명 요청이
   * 지갑에서 보이는 계정과 다른 계정의 이름으로 나간다.
   */
  useEffect(() => {
    if (!walletAddress) return;
    return subscribeProviderEvents({
      onAccounts: (accounts) => {
        if (accounts[0] === walletAddress) return;
        void signOut().then(() =>
          setError(
            accounts.length === 0
              ? "The wallet disconnected. Connect again to continue."
              : "The wallet switched to another account. Connect again to continue as that account.",
          ),
        );
      },
      onChain: (chainId) => {
        setConnectionLog((previous) => [
          ...previous,
          { at: new Date().toISOString(), step: "chainChanged", detail: String(chainId) },
        ]);
      },
    });
  }, [walletAddress, signOut]);

  const refresh = useCallback(() => load(token), [load, token]);

  /**
   * EIP-712 서명.
   *
   * **서버는 대리 서명하지 않는다.** 서명 요청을 만들 뿐이고, 개인키는 이쪽에만
   * 있다. 서버는 복구된 주소가 배정된 검토자인지 별도로 대조한다 — 서명이
   * 유효한 것과 그 사람에게 권한이 있는 것은 다른 사실이다(불변조건 13).
   */
  const signTypedData = useCallback(
    async (request: TypedDataRequest): Promise<string> => {
      // 실지갑으로 로그인했으면 지갑이 서명한다. 서버가 준 구조를 그대로 넘겨
      // 사용자가 지갑에서 본 것과 서버가 검증하는 것을 같게 유지한다.
      if (walletAddress) {
        /**
         * EIP-712는 체인이 맞아야 한다.
         *
         * MetaMask·Trust Wallet은 domain의 chainId가 지갑의 현재 체인과 다르면
         * 서명을 거절한다("Provided chainId must match the active chainId").
         * 로그인은 체인을 강제하지 않으므로 여기서 맞춘다.
         */
        const chainId = Number(request.domain["chainId"]);
        if (Number.isInteger(chainId) && chainId > 0) {
          try {
            await ensureChain(chainId);
          } catch (caught) {
            if (caught instanceof WalletError && caught.rejectedByUser) throw caught;
            const reason = caught instanceof Error ? caught.message : String(caught);
            throw new Error(`Switch the wallet to chain ${chainId} to sign. ${reason}`);
          }
        }
        return signTypedDataWithWallet(request, walletAddress);
      }

      if (!account) throw new Error("No account is connected.");
      const signer = privateKeyToAccount(account.privateKey);

      // 서버는 uint256을 decimal string으로 보낸다. viem은 bigint를 요구한다.
      const numericFields = (request.types[request.primaryType] ?? [])
        .filter((field) => field.type.startsWith("uint") || field.type.startsWith("int"))
        .map((field) => field.name);

      const message = Object.fromEntries(
        Object.entries(request.message).map(([key, value]) =>
          numericFields.includes(key) ? [key, BigInt(value as string)] : [key, value],
        ),
      );

      // typedData의 형태는 런타임에 서버가 정한다. viem의 제네릭은 컴파일 시점에
      // 리터럴 타입을 요구하므로 여기서는 런타임 값으로 넘긴다.
      return signer.signTypedData({
        domain: request.domain,
        types: request.types,
        primaryType: request.primaryType,
        message,
      } as unknown as TypedDataDefinition);
    },
    [account, walletAddress],
  );

  return (
    <SessionContext.Provider
      value={{
        token,
        session,
        account,
        walletAddress,
        walletAvailable,
        wallets,
        loading,
        signingIn,
        error,
        connectionLog,
        signIn,
        signInWithWallet,
        signOut,
        refresh,
        signTypedData,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("SessionProvider 안에서만 사용할 수 있다");
  return value;
}
