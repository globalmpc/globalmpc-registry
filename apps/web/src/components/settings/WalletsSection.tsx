"use client";

import { useCallback, useEffect, useState } from "react";
import {
  bindWallet,
  createWalletBindingChallenge,
  disableOwnWallet,
  listWallets,
  type AccountWallet,
  type WalletBindingChallenge,
  type WalletReplaceReason,
} from "@/lib/account-api";
import { authErrorMessage } from "@/lib/auth-errors";
import { AUTH_COPY } from "@/lib/copy";
import { useSession } from "@/lib/session";
import { assuranceNarrowedRoles } from "@/lib/access";
import { connectWallet, ensureChain, selectWallet, signTypedDataWithWallet } from "@/lib/wallet";
import { Address } from "@/components/Address";
import { ErrorLine, useAction } from "./useAction";

const C = AUTH_COPY.settings;

const REASONS = [
  { value: "key_lost", label: "Key lost" },
  { value: "key_compromised", label: "Key compromised" },
  { value: "rotation", label: "Planned rotation" },
  { value: "offboarding", label: "No longer needed" },
] as const;

const REPLACE_REASONS: readonly WalletReplaceReason[] = ["rotation", "key_lost", "key_compromised"];

interface Pending {
  readonly address: string;
  readonly challenge: WalletBindingChallenge;
}

/**
 * The account's one signing wallet (WP5, 0130). A wallet is bound by its holder's proof: the
 * server issues an EIP-712 binding message naming this account, the wallet signs it, the server
 * checks the signer. Binding while the account holds a wallet replaces it — the server says which
 * wallet the challenge replaces, and that is shown before the wallet is asked to sign. The wallet
 * is connected only for that signature — never to sign in.
 *
 * After a replace the session is read again and the screen says what changed: replacing a
 * wallet an operator had verified resets the identity assurance, and the roles above it stop
 * taking effect until an administrator sets the identity assurance again.
 */
export function WalletsSection({
  onSessionEnded,
  onAccountChanged,
}: {
  readonly onSessionEnded: () => void;
  /** After any change here: sessions and the session's own facts may have changed. */
  readonly onAccountChanged?: () => void;
}) {
  const { wallets: discovered, refresh } = useSession();
  const [replaced, setReplaced] = useState<{
    readonly operatorVerified: boolean;
    readonly assurance: string | null;
    readonly inactive: readonly string[];
  } | null>(null);
  const [items, setItems] = useState<AccountWallet[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState<string>("rotation");
  const [replaceReason, setReplaceReason] = useState<WalletReplaceReason>("rotation");
  const [detail, setDetail] = useState("");

  const load = useCallback(async () => {
    try {
      setItems((await listWallets()).items);
      setLoadError(null);
    } catch (caught) {
      setLoadError(authErrorMessage(caught));
    }
  }, []);
  const changed = useCallback(async () => {
    await load();
    onAccountChanged?.();
  }, [load, onAccountChanged]);
  const { act, busy, error } = useAction(changed);

  useEffect(() => {
    void load();
  }, [load]);

  const active = items.find((wallet) => wallet.disabledAt === null) ?? null;
  const history = items.filter((wallet) => wallet.disabledAt !== null);

  async function sign({ address, challenge }: Pending, why?: WalletReplaceReason) {
    await ensureChain(challenge.chainId);
    const signature = await signTypedDataWithWallet(challenge.typedData, address);
    await bindWallet(challenge.challengeId, signature, why);
  }

  /** Asks the server first: if the challenge replaces a wallet, nothing is signed until confirmed. */
  async function start() {
    setPending(null);
    setReplaced(null);
    const address = await connectWallet();
    const challenge = await createWalletBindingChallenge(address);
    if (challenge.replaces) {
      setReplaceReason("rotation");
      setPending({ address, challenge });
      return;
    }
    await sign({ address, challenge });
  }

  const label = active ? C.replace : C.bind;

  return (
    <div className="panel" data-testid="settings-wallets">
      <h2>{C.wallets}</h2>
      <p className="sub" style={{ marginTop: 0 }}>
        {C.walletsLead}
      </p>
      <ErrorLine error={loadError ?? error} />

      <div data-testid="wallet-list">
        {active ? (
          <div data-testid="wallet-current">
            <Address value={active.walletAddress} />{" "}
            <span className="meta">
              · chain {active.chainId} · {C.boundVia(active.boundVia)}
            </span>
            <p className="meta">{C.currentWallet}</p>
          </div>
        ) : (
          <p className="meta">{C.noWallets}</p>
        )}

        {history.length > 0 ? (
          <>
            <h3>{C.walletHistory}</h3>
            <ul data-testid="wallet-history">
              {history.map((wallet) => (
                <li key={wallet.id}>
                  <Address value={wallet.walletAddress} />{" "}
                  <span className="meta">
                    · chain {wallet.chainId} · {C.disabled}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>

      {pending ? (
        <div className="notice" data-testid="replace-confirm">
          <p>{C.replaceWarning(pending.challenge.replaces!.walletAddress, pending.address)}</p>
          {active?.id === pending.challenge.replaces!.id && active.boundVia === "operator" ? (
            <p data-testid="replace-operator-verified">{C.replaceOperatorVerified}</p>
          ) : null}
          <div className="field">
            <label htmlFor="wallet-replace-reason">{C.replaceReason}</label>
            <select
              id="wallet-replace-reason"
              data-testid="replace-reason"
              value={replaceReason}
              onChange={(event) => setReplaceReason(event.target.value as WalletReplaceReason)}
            >
              {REPLACE_REASONS.map((value) => (
                <option key={value} value={value}>
                  {C.replaceReasons[value]}
                </option>
              ))}
            </select>
          </div>
          {replaceReason === "key_compromised" ? <p className="meta">{C.replaceCompromised}</p> : null}
          <div className="row">
            <button
              className="primary"
              type="button"
              disabled={busy}
              data-testid="confirm-replace"
              onClick={() =>
                void act(async () => {
                  const operatorVerified =
                    active?.id === pending.challenge.replaces!.id && active.boundVia === "operator";
                  await sign(pending, replaceReason);
                  setPending(null);
                  const fresh = await refresh();
                  setReplaced({
                    operatorVerified,
                    assurance: fresh?.assuranceLevel ?? null,
                    inactive: assuranceNarrowedRoles(fresh).map((entry) => entry.role),
                  });
                })
              }
            >
              {C.confirmReplace}
            </button>
            <button type="button" disabled={busy} onClick={() => setPending(null)}>
              {AUTH_COPY.stepUp.cancel}
            </button>
          </div>
        </div>
      ) : null}

      {replaced && !pending ? (
        <div className="notice" role="status" data-testid="replace-done">
          <p>{C.replaceDone}</p>
          {replaced.operatorVerified ? (
            <div data-testid="replace-done-operator">
              <p>{C.replaceDoneOperator(replaced.assurance ?? "wallet_only")}</p>
              {replaced.inactive.length > 0 ? (
                <p>
                  {C.replaceDoneInactive}{" "}
                  <span className="mono" data-testid="replace-done-inactive">
                    {replaced.inactive.join(", ")}
                  </span>
                </p>
              ) : null}
              <p>{C.replaceDoneNext}</p>
            </div>
          ) : null}
        </div>
      ) : null}

      {disabling && active ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await disableOwnWallet(active.id, { reasonCode: reason, detail: detail.trim() });
              setDisabling(false);
              // Every session of the account ended, this one included (AC-27).
              onSessionEnded();
            });
          }}
        >
          <p className="meta">{C.disableWarning}</p>
          <div className="field">
            <label htmlFor="wallet-reason">{AUTH_COPY.admin.reason}</label>
            <select id="wallet-reason" value={reason} onChange={(event) => setReason(event.target.value)}>
              {REASONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="wallet-detail">{AUTH_COPY.admin.decisionReason}</label>
            <input id="wallet-detail" value={detail} onChange={(event) => setDetail(event.target.value)} />
          </div>
          <div className="row">
            <button className="primary" type="submit" disabled={busy || detail.trim() === ""}>
              {C.disable}
            </button>
            <button type="button" onClick={() => setDisabling(false)}>
              {AUTH_COPY.stepUp.cancel}
            </button>
          </div>
        </form>
      ) : null}

      <div className="row" style={{ marginTop: 12 }}>
        {discovered.length > 1 ? (
          discovered.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              disabled={busy}
              onClick={() => {
                selectWallet(candidate);
                void act(start);
              }}
            >
              {label} · {candidate.name}
            </button>
          ))
        ) : (
          <button
            type="button"
            className="primary"
            disabled={busy}
            data-testid={active ? "replace-wallet" : "bind-wallet"}
            onClick={() => void act(start)}
          >
            {busy ? C.binding : label}
          </button>
        )}
        {active ? (
          <button type="button" disabled={busy} data-testid="disable-wallet" onClick={() => setDisabling(true)}>
            {C.disable}
          </button>
        ) : null}
      </div>
    </div>
  );
}
