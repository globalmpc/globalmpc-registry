"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { getSession, logout as logoutRequest, SESSION_MARKER, type SessionInfo } from "./api";
import { listWallets } from "./account-api";
import { AUTH_COPY } from "./copy";
import {
  connectWallet,
  ensureChain,
  signTypedDataWithWallet,
  subscribeWallets,
  type DiscoveredWallet,
  WalletError,
} from "./wallet";

/**
 * Keys older builds left in storage: the token before WP6 moved it into an HttpOnly cookie, and
 * the demo account, wallet, chosen extension and connection trace of the wallet sign-in WP7
 * removed. Removed on load so nothing lingers where any script can read it.
 */
const STALE_KEYS = [
  "mpc.session.token",
  "mpc.session.account",
  "mpc.session.wallet",
  "mpc.session.walletId",
  "mpc.wallet.trace",
];

/** EIP-712 signature request. Passes the server-provided structure to the wallet as-is. */
export interface TypedDataRequest {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

interface SessionContextValue {
  /**
   * `SESSION_MARKER` while a session exists, else null. **Not a credential** — the token is an
   * HttpOnly cookie page script cannot read (WP6). Screens pass it to the API client so each call
   * still says it is made as the signed-in person.
   */
  token: string | null;
  session: SessionInfo | null;
  /**
   * Installed wallets (EIP-6963).
   *
   * With two or more, the user must choose. Looking only at `window.ethereum` lets whichever extension
   * claimed it first win, and when a wallet the user did not intend rejects, the reason stays hidden.
   */
  wallets: readonly DiscoveredWallet[];
  loading: boolean;
  signOut(): Promise<void>;
  /** Re-reads the session — after a sign-in, a second factor or a step-up. */
  refresh(): Promise<SessionInfo | null>;
  signTypedData(request: TypedDataRequest): Promise<string>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/**
 * Is this a signed-in account session? Every session is one since WP7 removed the wallet sign-in;
 * a session without a first factor is not one the server issues, so it is not treated as one.
 */
export function isAccountSession(session: SessionInfo | null): boolean {
  return Boolean(session?.authenticated && session.firstFactor);
}

/**
 * Does this session still owe its second factor (or a re-enrolment after a recovery code)?
 * Such a session reaches only the MFA screens; the server refuses everything else (priority rule 2).
 */
export function needsSecondFactor(session: SessionInfo | null): boolean {
  return Boolean(session?.authenticated && (session.aal === "aal1" || session.recoveryLimited));
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [wallets, setWallets] = useState<readonly DiscoveredWallet[]>([]);
  const [loading, setLoading] = useState(true);

  /**
   * `loading` is the first read only. A later read (after a second factor, a step-up or a sign-in)
   * keeps what is on screen: flipping back to "loading" made the workspace gate swap the page out
   * and back, and the remount dropped state shown once — the recovery codes a step-up had just
   * produced (found in the WP6 browser run).
   */
  const load = useCallback(async (): Promise<SessionInfo | null> => {
    try {
      const next = await getSession(null);
      setSession(next);
      return next;
    } catch {
      setSession(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    for (const key of STALE_KEYS) {
      try {
        window.localStorage.removeItem(key);
        window.sessionStorage.removeItem(key);
      } catch {
        // Storage may be blocked (private browsing); nothing is left there to remove then.
      }
    }

    // Wallets announce themselves after receiving a request. Subscribe first so none are missed.
    const unsubscribe = subscribeWallets(setWallets);

    void load();
    return unsubscribe;
  }, [load]);

  const signOut = useCallback(async () => {
    // Revoke the session on the server; the web server clears the cookie whatever the API says.
    await logoutRequest().catch(() => undefined);
    setSession(null);
  }, []);

  const refresh = useCallback(() => load(), [load]);

  /**
   * EIP-712 signature.
   *
   * **The server does not sign on anyone's behalf.** It only creates the signature request; the private key
   * exists only on this side. The server separately checks that the recovered address is an active wallet
   * bound to the assigned reviewer — a valid signature and that person's authority are separate facts
   * (invariant 13).
   *
   * **The wallet is connected here, at the moment of signing** (WP6). Signing in never needs one: an
   * account session signs with any of the wallets bound to it (WP5), whichever is connected now.
   */
  const signTypedData = useCallback(
    async (request: TypedDataRequest): Promise<string> => {
      if (!isAccountSession(session)) throw new Error("No account is signed in.");

      const address = await connectWallet();
      await assertBoundWallet(address, Number(request.domain["chainId"]));

      /**
       * EIP-712 requires the correct chain.
       *
       * MetaMask and Trust Wallet reject the signature when the domain chainId differs from the
       * wallet's current chain ("Provided chainId must match the active chainId").
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
      return signTypedDataWithWallet(request, address);
    },
    [session],
  );

  return (
    <SessionContext.Provider
      value={{
        token: session?.authenticated ? SESSION_MARKER : null,
        session,
        wallets,
        loading,
        signOut,
        refresh,
        signTypedData,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}

/**
 * Refuses, before the wallet opens, a key the account has not bound on this chain. The server
 * checks the same thing after signing (`assertSubjectSigner`); saying it first spares the person a
 * signature that can only be refused, and tells them where to bind the key.
 */
async function assertBoundWallet(address: string, chainId: number): Promise<void> {
  const { items } = await listWallets();
  const bound = items.some(
    (wallet) =>
      wallet.disabledAt === null &&
      wallet.walletAddress.toLowerCase() === address.toLowerCase() &&
      (!Number.isInteger(chainId) || chainId <= 0 || wallet.chainId === chainId),
  );
  if (!bound) throw new Error(AUTH_COPY.signing.walletNotBound(address));
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession can only be used inside SessionProvider");
  return value;
}
