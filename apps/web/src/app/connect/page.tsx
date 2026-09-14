"use client";

import { useRouter } from "next/navigation";
import { DEMO_ACCOUNTS, demoAddress, useSession } from "@/lib/session";
import { REQUIRED_BOUNDARY_COPY } from "@mpc/ui";

/**
 * Account connect — this screen lives at `/connect`, not `/`.
 *
 * While `/` was the sign-in screen, there was no public entry point explaining the product.
 * Sign-in is one branch of the public surface, not its entrance.
 */
export default function SignInPage() {
  const {
    signIn,
    signInWithWallet,
    session,
    loading,
    signingIn,
    error,
    walletAvailable,
    wallets,
    connectionLog,
  } = useSession();
  const router = useRouter();

  // Demo accounts come in only via a build flag (`lib/session`). In builds without it, this screen
  // must show only wallet connect — rendering an empty list leaves an unexplained blank.
  const demoAvailable = DEMO_ACCOUNTS.length > 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Connect account</h1>
          <p className="sub">
            {demoAvailable
              ? "Choose an account to connect. The server resolves the identity, roles, and assurance level bound to that wallet."
              : "Connect with a wallet. The server resolves the identity, roles, and assurance level bound to that wallet."}
          </p>
        </div>
      </div>

      {demoAvailable ? (
        <div className="notice" style={{ color: "var(--alert)" }}>
          <div className="title">Demo accounts · they sign in through real SIWE</div>
          Choosing an account makes the browser sign an EIP-4361 message, and the server issues a
          session token only after it verifies that signature. The demo keys hold no assets. In
          production a wallet extension (EIP-1193) takes this place.
        </div>
      ) : null}

      {error ? (
        <div className="notice" style={{ color: "var(--destructive-text)" }} role="alert">
          <div className="title">Sign-in failed</div>
          {error}
        </div>
      ) : null}

      <div className="panel" data-testid="wallet-connect">
        <h2>Connect with a browser wallet</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          {/* State before sign-in that private keys never come to us. */}
          Your wallet signs; we only receive the result. Your private key never reaches this site.
        </p>
        {/*
          The user picks an installed wallet.

          `window.ethereum` has only one slot, so with two or more extensions installed, whichever grabbed it first
          responds. If a wallet the user did not intend rejects, it only looks like "cannot connect",
          and which wallet rejected is not revealed.
        */}
        {wallets.length > 0 ? (
          <div className="wallet-choices" data-testid="wallet-choices">
            {wallets.map((wallet) => (
              <button
                key={wallet.id}
                className="primary"
                data-testid={`connect-wallet-${wallet.id}`}
                disabled={signingIn}
                onClick={async () => {
                  if (await signInWithWallet(wallet)) router.push("/w/projects");
                }}
              >
                {wallet.icon ? (
                  // A data URI sent by the wallet. Nothing is fetched externally.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={wallet.icon} alt="" width={18} height={18} aria-hidden />
                ) : null}
                Connect {wallet.name}
              </button>
            ))}
          </div>
        ) : walletAvailable ? (
          <button
            className="primary"
            data-testid="connect-wallet"
            disabled={signingIn}
            onClick={async () => {
              // Navigate only on success. Navigating on failure removes the screen before the error
              // notice above is drawn.
              if (await signInWithWallet()) router.push("/w/projects");
            }}
          >
            Connect wallet
          </button>
        ) : (
          <p className="meta" style={{ margin: 0 }}>
            No wallet extension found. The demo accounts below follow the same SIWE flow; the
            server does not distinguish between the two paths.
          </p>
        )}
      </div>

      {/*
        Steps of the last connect attempt — 2026-09-11.

        Connecting happens inside this browser and only the result reaches the server. Which wallet
        responded and which code stopped the chain switch exist only here. On failure
        it is expanded and can be copied and forwarded. This log is never sent to the server.
      */}
      {connectionLog.length > 0 ? (
        <details className="panel" data-testid="connection-log" open={Boolean(error)}>
          <summary>Connection details — last attempt</summary>
          <p className="meta">
            Recorded in this browser only and never sent to the server. Copy it when a wallet does
            not connect — it shows which wallet answered and where it stopped.
          </p>
          <ol className="mono meta" data-testid="connection-steps">
            {connectionLog.map((entry, index) => (
              <li key={`${entry.at}-${index}`}>
                {entry.at.slice(11, 19)} · {entry.step} · {entry.detail}
              </li>
            ))}
          </ol>
          <button
            type="button"
            onClick={() =>
              void navigator.clipboard
                ?.writeText(
                  connectionLog.map((entry) => `${entry.at} ${entry.step} ${entry.detail}`).join("\n"),
                )
                .catch(() => undefined)
            }
          >
            Copy details
          </button>
        </details>
      ) : null}

      {demoAvailable ? (
        <div className="account-grid">
          {DEMO_ACCOUNTS.map((account) => (
            <button
              key={account.label}
              className="account-card"
              disabled={signingIn}
              onClick={async () => {
                // Navigate only on success. Same rule as the wallet path — navigating after a failure
                // removes the screen before the error notice is drawn.
                if (await signIn(account)) router.push("/w/projects");
              }}
            >
              <div className="name">{account.label}</div>
              <div className="desc">{account.description}</div>
              <div className="mono meta">{demoAddress(account)}</div>
            </button>
          ))}
        </div>
      ) : null}

      {!loading && session?.authenticated ? (
        <p className="sub" style={{ marginTop: 18 }}>
          Already connected. <a href="/w/projects">Go to projects →</a>
        </p>
      ) : null}

      <div className="panel" style={{ marginTop: 24 }}>
        <h2>Boundaries this workspace enforces</h2>
        <ul style={{ margin: 0, paddingLeft: 18, color: "var(--muted-foreground)" }}>
          {/* Boundary copy originates in `@mpc/ui`. If each screen rewords it differently,
              enforcing that copy means nothing. */}
          <li>{REQUIRED_BOUNDARY_COPY.verification}</li>
          <li>{REQUIRED_BOUNDARY_COPY.readiness}</li>
          <li>{REQUIRED_BOUNDARY_COPY.sourceStatus}</li>
          <li>{REQUIRED_BOUNDARY_COPY.proofResult}</li>
        </ul>
      </div>
    </>
  );
}
