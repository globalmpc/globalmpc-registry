"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { COPY } from "@/lib/copy";
import { useSession } from "@/lib/session";
import { Address } from "@/components/Address";

/**
 * 워크스페이스에 들어오기 전의 세 상태를 화면 하나가 먼저 가른다.
 *
 * 1. 세션을 읽는 중 — 아무것도 부르지 않는다.
 * 2. 로그인하지 않았다 — 연결 안내.
 * 3. 로그인했지만 지갑이 조직(tenant)에 묶이지 않았다 — 연결 대기 안내.
 *
 * 예전에는 3번에서도 각 화면이 API를 불렀고, 화면마다 `401 UNAUTHENTICATED`가
 * 떴다. 방금 서명한 사람에게 "인증이 필요하다"는 틀린 말이고, 다시 서명해도 같다.
 * 3번은 오류가 아니라 **아직 자리가 없는 상태**이므로 오류 상자가 아니라 안내로 둔다.
 *
 * 역할이 없거나 프로젝트 밖인 경우(403)는 여기서 막지 않는다. 그것은 화면마다
 * 무엇이 부족한지 다르고, `ErrorNotice`가 필요한 역할과 요청 경로를 보여 준다.
 */
/**
 * 막힌 사람이 도착하는 화면 — 11 §11.7.
 *
 * 로그인하지 않았거나 지갑이 묶이지 않았어도 무엇이 부족한지 읽을 수 있어야 한다.
 * 게이트가 이 화면까지 가리면 거절 안내를 따라온 사람이 또 다른 안내를 만난다.
 */
function isAccessRequestPath(pathname: string): boolean {
  return (
    pathname === "/w/access-requests" ||
    pathname === "/w/identity/upgrade" ||
    /^\/w\/projects\/[^/]+\/access-requests$/.test(pathname)
  );
}

export function WorkspaceGate({ children }: { readonly children: React.ReactNode }) {
  const { session, loading } = useSession();
  const pathname = usePathname();

  if (isAccessRequestPath(pathname)) return <>{children}</>;

  if (loading) {
    return <p className="sub">Loading your session…</p>;
  }

  if (!session?.authenticated) {
    return (
      <div className="panel" data-testid="workspace-signed-out">
        <h1>Connect your wallet to open the workspace</h1>
        <p className="sub">
          {COPY.session.required} Published records stay open without an account —{" "}
          <Link href="/explorer">browse the Explorer</Link>.
        </p>
        <Link href="/connect" className="btn-connect">
          {COPY.session.connect}
        </Link>
      </div>
    );
  }

  if (!session.tenantId) {
    return <EnrollmentPanel walletAddress={session.walletAddress ?? ""} />;
  }

  return <>{children}</>;
}

/** 지갑은 연결됐지만 조직에 묶이지 않은 상태. */
export function EnrollmentPanel({ walletAddress }: { readonly walletAddress: string }) {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Your wallet is connected, but not linked to a workspace yet</h1>
          <p className="sub">
            Signing in proved that you control this wallet. Workspace data belongs to
            organizations, and a wallet sees it only after an operator links it to one. Signing in
            again will not change this.
          </p>
        </div>
      </div>

      <div className="panel" data-testid="enrollment-panel">
        <h2>What to do next</h2>
        <ol style={{ margin: 0, paddingLeft: 18 }}>
          <li>
            Send this wallet address to your organization&rsquo;s operator:{" "}
            <span data-testid="enrollment-wallet">
              <Address value={walletAddress} />
            </span>
          </li>
          <li>The operator links the wallet and grants a role. There is no self-service request yet.</li>
          <li>Reload this page after they confirm. The workspace menu appears with your role.</li>
        </ol>
        <p className="sub" style={{ marginBottom: 0 }}>
          Meanwhile, published records need no workspace access:{" "}
          <Link href="/explorer">Explorer</Link> · <Link href="/verify">Proof Verifier</Link>.
        </p>
      </div>
    </>
  );
}
