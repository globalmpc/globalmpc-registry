"use client";

import { useState } from "react";
import { approveWalletRecovery, bindWallet, confirmWalletRecovery, createWalletBindingChallenge,
  requestWalletRecovery, walletRecoveries, type WalletRecovery } from "@/lib/account-api";
import { authErrorMessage } from "@/lib/auth-errors";
import { connectWallet, ensureChain, signTypedDataWithWallet } from "@/lib/wallet";

export function WalletRecoveryPanel({ admin = false, onBound }: {
  readonly admin?: boolean;
  readonly onBound?: () => Promise<void>;
}) {
  const [items, setItems] = useState<WalletRecovery[]>([]);
  const [proof, setProof] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  async function run(action?: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      if (action) await action();
      const list = await walletRecoveries(admin);
      setItems(list.items);
      setLoaded(true);
    } catch (cause) {
      setError(authErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function finish(item: WalletRecovery) {
    const address = await connectWallet();
    if (address.toLowerCase() !== item.address) throw new Error("Connect the approved replacement wallet");
    const challenge = await createWalletBindingChallenge(address);
    await ensureChain(challenge.chainId);
    const signature = await signTypedDataWithWallet(challenge.typedData, address);
    await bindWallet(challenge.challengeId, signature, "key_lost");
    await onBound?.();
  }

  const start = () => run(async () => {
    await requestWalletRecovery(await connectWallet());
    setProof("");
  });

  return <details className="panel" onToggle={event => { if (event.currentTarget.open) void run(); }}>
    <summary>{admin ? "Wallet recovery requests" : "Recover signing wallet"}</summary>
    {error && <p role="alert">{error}</p>}
    <fieldset disabled={busy}>
      {items.map(item => <div key={item.id} className="field">
        <p>{admin && <strong>{item.name} · </strong>}<code>{item.address}</code> · Chain {item.chainId}</p>
        {admin ? <button type="button" onClick={() => void run(() => approveWalletRecovery(item.id))}>Approve replacement</button>
          : item.approved ? <button type="button" onClick={() => void run(() => finish(item))}>Sign with replacement wallet</button>
          : item.confirmed ? <p>Waiting for administrator approval.</p> : <>
            <label htmlFor="wallet-recovery-key">Confirmation key from your registered email</label>
            <input id="wallet-recovery-key" value={proof} onChange={event => setProof(event.target.value)} autoComplete="off" />
            <button type="button" disabled={!proof.trim()} onClick={() => void run(() => confirmWalletRecovery(item.id, proof.trim()))}>Confirm email</button>
          </>}
      </div>)}
      {!admin && <button type="button" onClick={() => void start()}>{items.length ? "Restart with replacement wallet" : "Connect replacement wallet and send email"}</button>}
      {admin && loaded && !items.length && <p>No confirmed requests awaiting approval.</p>}
      <button type="button" onClick={() => void run()}>Refresh status</button>
    </fieldset>
  </details>;
}
