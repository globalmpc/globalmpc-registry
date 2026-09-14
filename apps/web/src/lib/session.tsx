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
 * Demo accounts.
 *
 * **From R1, login uses a real SIWE signature.** The development wallet-header path is removed.
 *
 * So the flow can be checked without a browser wallet extension (EIP-1193),
 * demo accounts sign directly in the browser with known private keys. **These keys are
 * demo-only and hold no assets.** When `window.ethereum` is present, the real
 * wallet integration takes precedence.
 */
export interface DemoAccount {
  readonly label: string;
  readonly privateKey: `0x${string}`;
  readonly description: string;
}

/**
 * Demo account names and roles. **The keys are not here.**
 *
 * A key in the repository lets anyone who knows it log in with that role at the deployed address.
 * Deleting it does not remove it from past commits either. So keys are supplied at runtime —
 * put them in `NEXT_PUBLIC_DEMO_ACCOUNT_KEYS` as `{"Operator A": "0x…"}`.
 * E2E generates fresh keys on every run (`playwright.config.ts`).
 *
 * Without a value the list is empty and the login screen shows only wallet connection.
 * Deployments are built in that state.
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
  // A system identity, not a person. It is listed so that E2E can call the API with the
  // checking service's session.
  { label: "Scan Service", description: "Tenant A · scan_service · reports scan results only" },
];

/**
 * Reads keys supplied from outside.
 *
 * A malformed value does not stop the screen from loading — it falls back to the same state as
 * having no demo accounts. Deployments have no value to begin with.
 */
function readDemoKeys(): Readonly<Record<string, string>> {
  /**
   * Production bundles contain no demo accounts.
   *
   * The build already rejects this (`next.config.ts`), but check here too. With a single defense,
   * nothing blocks once it changes, and a leak of this value is an authentication bypass.
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

/** Step log of the last wallet connection attempt. Cleared when the tab closes — for diagnosis. */
const TRACE_KEY = "mpc.wallet.trace";
/** The wallet the user chose (EIP-6963 rdns). Kept so the same wallet is used after a reload. */
const WALLET_ID_KEY = "mpc.session.walletId";
const STORAGE_KEY = "mpc.session.token";
const ACCOUNT_KEY = "mpc.session.account";
/** Whether login used a real wallet. The signer must be known after a reload. */
const WALLET_KEY = "mpc.session.wallet";

/** EIP-712 signature request. Passes the server-provided structure to the wallet as-is. */
export interface TypedDataRequest {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

/**
 * One step of a wallet connection — 2026-09-11.
 *
 * Connection happens in the browser and the server sees only the result. Which wallet responded,
 * and which code a chain switch failed with, was **recorded nowhere.** Reproducing what a user saw
 * requires those steps. Private keys and signature values are never included.
 */
export interface ConnectionStep {
  readonly at: string;
  readonly step: string;
  readonly detail: string;
}

interface SessionContextValue {
  token: string | null;
  session: SessionInfo | null;
  /** The connected demo account. Null when logged in with a real wallet. */
  account: DemoAccount | null;
  /** Address connected via a real wallet. Null for a demo account. */
  walletAddress: string | null;
  /** Whether the browser has a wallet extension. Without one, only demo accounts are available. */
  walletAvailable: boolean;
  /**
   * Installed wallets (EIP-6963).
   *
   * With two or more, the user must choose. Looking only at `window.ethereum` lets whichever extension
   * claimed it first win, and when a wallet the user did not intend rejects, the reason stays hidden.
   */
  wallets: readonly DiscoveredWallet[];
  /** Steps of the last wallet connection attempt. The connect screen shows them and lets the user copy them. */
  connectionLog: readonly ConnectionStep[];
  loading: boolean;
  signingIn: boolean;
  error: string | null;
  /** Returns success. Sending a failed attempt on to the workspace loses the guidance. */
  signIn(account: DemoAccount): Promise<boolean>;
  /**
   * Log in with a browser wallet. Private keys never reach us.
   *
   * Returns success — if the calling screen moves on to the next screen after a failure,
   * the place where the error guidance would render is gone.
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

    // After a reload we must know which account signs. Keeping only the token leaves
    // a live session that cannot sign.
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

    // Wallet extensions may not be injected right after page load. Check once more.
    setWalletAvailable(hasInjectedWallet());
    const timer = setTimeout(() => setWalletAvailable(hasInjectedWallet()), 500);

    // Wallets announce themselves after receiving a request. Subscribe first so none are missed.
    const storedWalletId = window.localStorage.getItem(WALLET_ID_KEY);
    const unsubscribe = subscribeWallets((found) => {
      setWallets(found);
      if (found.length > 0) setWalletAvailable(true);
      // After a reload, call the same wallet that logged in. Otherwise another extension that
      // claimed `window.ethereum` first receives the signature request.
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
   * SIWE login.
   *
   * nonce issuance → message signature → verification → session token. No permission exists
   * until the server verifies the signature.
   */
  const signIn = useCallback(
    async (demo: DemoAccount): Promise<boolean> => {
      setSigningIn(true);
      setError(null);
      try {
        const account = privateKeyToAccount(demo.privateKey);
        const address = account.address.toLowerCase();

        // The server decides the chain to sign on.
        const challenge = await requestSiweNonce(address);

        const message = createSiweMessage({
          address: account.address,
          chainId: challenge.chainId,
          domain: challenge.domain,
          nonce: challenge.nonce,
          statement: challenge.statement,
          // Use the value the server verifies as-is. Guessing here diverges from the server.
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
        // Do not swallow the failure. Returning true here makes the caller navigate,
        // and the user lands in an empty workspace with no reason given (§11.7).
        setError(caught instanceof Error ? caught.message : String(caught));
        return false;
      } finally {
        setSigningIn(false);
      }
    },
    [load],
  );

  /**
   * Log in with a browser wallet.
   *
   * Uses **the same SIWE flow** as demo accounts: nonce issuance → message signature → verification.
   * Only the signer differs, and the server does not distinguish the two.
   *
   * If the chain differs, request a switch first. A signature on another chain fails verification,
   * and when that failure looks like "wrong signature", the cause is hard to find.
   */
  const signInWithWallet = useCallback(async (wallet?: DiscoveredWallet) => {
    setSigningIn(true);
    setError(null);

    // Steps of this attempt. Kept on success and on failure — successful paths are also compared.
    const steps: ConnectionStep[] = [];
    const record = (step: string, detail: string) => {
      steps.push({ at: new Date().toISOString(), step, detail });
      setConnectionLog([...steps]);
      try {
        window.sessionStorage.setItem(TRACE_KEY, JSON.stringify(steps));
      } catch {
        // Login must still work in browsers with storage blocked (private browsing).
      }
    };
    const describe = (caught: unknown) =>
      `${rpcErrorCode(caught) ?? (caught as { code?: unknown } | null)?.code ?? "no code"}: ${
        caught instanceof Error ? caught.message : String(caught)
      }`;

    try {
      // Send the request to the wallet the user chose. If none was chosen, use `window.ethereum`.
      selectWallet(wallet ?? null);
      record(
        "wallet",
        `${wallet ? `${wallet.name} (${wallet.id})` : "window.ethereum"} · ${
          walletFlags(getInjectedProvider()).join(" ") || "no flags"
        } · ${navigator.userAgent}`,
      );

      const address = await connectWallet();
      record("account", `${address.slice(0, 6)}…${address.slice(-4)}`);

      // The server decides the chain to sign on.
      const challenge = await requestSiweNonce(address);
      record("nonce", `chain ${challenge.chainId}`);

      /**
       * Align the chain right away, but **do not block login**.
       *
       * A SIWE signature (`personal_sign`) is chain-independent — the server only reads the
       * chain ID inside the message. Making the switch a login precondition blocks users of wallets
       * that cannot add the chain (Trust Wallet, which hides testnets; MetaMask mobile, which wraps codes)
       * at login. Here we try and record the result, then align again right before the EIP-712
       * signature, which does require the right chain (`signTypedData`).
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
        // Use the value the server verifies as-is. Guessing here diverges from the server.
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
      // A user rejection is not an error. Showing it as one prompts a retry.
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
      // Revoke the token on the server. Deleting it locally leaves the token alive until expiry.
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
   * The screen notices when the account or chain changes in the wallet.
   *
   * If the account changed, tell the user to disconnect and reconnect. The session is bound to
   * the old address on the server, so it is not a permission problem, but left alone the next signature
   * request goes out under an account different from the one shown in the wallet.
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
   * EIP-712 signature.
   *
   * **The server does not sign on anyone's behalf.** It only creates the signature request; the private key
   * exists only on this side. The server separately checks that the recovered address is the assigned reviewer —
   * a valid signature and that person's authority are separate facts (invariant 13).
   */
  const signTypedData = useCallback(
    async (request: TypedDataRequest): Promise<string> => {
      // When logged in with a real wallet, the wallet signs. Passing the server's structure as-is keeps
      // what the user sees in the wallet identical to what the server verifies.
      if (walletAddress) {
        /**
         * EIP-712 requires the correct chain.
         *
         * MetaMask and Trust Wallet reject the signature when the domain chainId differs from the
         * wallet's current chain ("Provided chainId must match the active chainId").
         * Login does not enforce the chain, so align it here.
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

      // The server sends uint256 as a decimal string. viem requires bigint.
      const numericFields = (request.types[request.primaryType] ?? [])
        .filter((field) => field.type.startsWith("uint") || field.type.startsWith("int"))
        .map((field) => field.name);

      const message = Object.fromEntries(
        Object.entries(request.message).map(([key, value]) =>
          numericFields.includes(key) ? [key, BigInt(value as string)] : [key, value],
        ),
      );

      // The server decides the typedData shape at runtime. viem's generics require literal types
      // at compile time, so pass runtime values here.
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
  if (!value) throw new Error("useSession can only be used inside SessionProvider");
  return value;
}
