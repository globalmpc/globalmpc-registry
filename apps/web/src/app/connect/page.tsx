"use client";

import { useRouter } from "next/navigation";
import { DEMO_ACCOUNTS, demoAddress, useSession } from "@/lib/session";
import { REQUIRED_BOUNDARY_COPY } from "@mpc/ui";

/**
 * 계정 연결 — 이 화면은 `/`가 아니라 `/connect`에 있다.
 *
 * `/`가 로그인 화면이던 동안 제품이 무엇인지 설명하는 공개 진입점이 없었다.
 * 로그인은 공개 표면의 한 갈래이지 그 입구가 아니다.
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

  // 데모 계정은 빌드 플래그로만 들어온다(`lib/session`). 꺼진 빌드에서는 이 화면에
  // 지갑 연결만 남아야 한다 — 빈 목록을 그대로 그리면 설명 없는 빈 자리가 된다.
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
          {/* 개인키가 우리에게 오지 않는다는 것을 로그인 전에 밝힌다. */}
          Your wallet signs; we only receive the result. Your private key never reaches this site.
        </p>
        {/*
          설치된 지갑을 사용자가 고른다.

          `window.ethereum`은 자리가 하나뿐이라 확장을 둘 이상 깔면 먼저 잡은 쪽이
          응답한다. 사용자가 의도한 지갑이 아닌 쪽이 거절하면 "연결이 안 된다"로만
          보이고 어느 지갑이 거절했는지는 드러나지 않는다.
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
                  // 지갑이 보낸 data URI다. 외부에서 받아오지 않는다.
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
              // 성공했을 때만 넘어간다. 실패해도 넘어가면 위의 오류 안내가
              // 그려지기 전에 화면이 사라진다.
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
        마지막 연결 시도의 단계 — 2026-09-11.

        연결은 이 브라우저 안에서 일어나고 서버에는 결과만 남는다. 어느 지갑이
        응답했는지, 체인 전환이 어떤 코드로 멈췄는지는 여기에만 있다. 실패했을 때
        펼쳐 두고, 복사해 전달할 수 있게 한다. 이 기록은 서버로 보내지 않는다.
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
                // 성공했을 때만 넘어간다. 지갑 경로와 같은 규칙이다 — 실패한 채
                // 이동하면 오류 안내가 그려지기 전에 화면이 사라진다.
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
          {/* 경계 문구는 `@mpc/ui`가 원본이다. 화면마다 다르게 번역되면 그
              문구를 강제하는 의미가 없다. */}
          <li>{REQUIRED_BOUNDARY_COPY.verification.en}</li>
          <li>{REQUIRED_BOUNDARY_COPY.readiness.en}</li>
          <li>{REQUIRED_BOUNDARY_COPY.sourceStatus.en}</li>
          <li>{REQUIRED_BOUNDARY_COPY.proofResult.en}</li>
        </ul>
      </div>
    </>
  );
}
