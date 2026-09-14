"use client";

import Link from "next/link";
import type { MouseEvent } from "react";
import { useSession } from "@/lib/session";
import { COPY, PUBLIC_NAV } from "@/lib/copy";
import { visibleNav } from "@/lib/nav";
import { Address } from "@/components/Address";

/** 공개 메뉴에서 링크를 누르면 펼친 목록을 닫는다. 페이지가 바뀌어도 열려 있으면 본문을 가린다. */
function closeMenu(event: MouseEvent<HTMLAnchorElement>): void {
  const menu = event.currentTarget.closest("details");
  if (menu) menu.open = false;
}

export function TopBar() {
  const { session, signOut } = useSession();
  const authenticated = session?.authenticated === true;
  const workspace = authenticated && session ? visibleNav(session) : [];

  return (
    <header className="topbar">
      <div className="row topbar-start" style={{ gap: 20 }}>
        {/* 워드마크를 본문 서체로 조판하지 않는다(@mpc/design logo.md). 마크는
            자산 원본을 그대로 쓰고, 제품명만 텍스트로 붙인다. 높이 28px는 마크
            최소 크기 24px 위이고, 클리어스페이스 0.5×(=14px)를 gap으로 준다. */}
        <Link href="/" className="brand" style={{ color: "var(--foreground)" }}>
          <img src="/brand/mpc-mark-on-dark.svg" alt="MPC" width={22} height={28} />
          <span>{COPY.productName}</span>
        </Link>
        {/* 링크는 로컬 배열이 아니라 단일 레지스트리에서 온다(@mpc/design "크롬"). */}
        <nav className="row" style={{ gap: 14 }}>
          {authenticated ? (
            <>
              {workspace.map((entry) => (
                <Link key={entry.href} href={entry.href}>
                  {entry.label}
                </Link>
              ))}
              {/* 역할이 하나도 없으면 갈 곳이 없다는 것만 남는다. 다음 행동을 준다. */}
              {session?.roleBindings?.length ? null : (
                <Link href="/w/access-requests">{COPY.session.requestAccess}</Link>
              )}
              {/* 로그인해도 공개 화면은 사라지지 않는다. 워크스페이스 메뉴와
                  섞지 않고 한 묶음으로 둔다 — 둘은 답하는 질문이 다르다(copy.ts). */}
              <details className="nav-public">
                <summary>{COPY.session.publicMenu}</summary>
                <div className="nav-public-menu">
                  {PUBLIC_NAV.map((entry) => (
                    <Link key={entry.href} href={entry.href} onClick={closeMenu}>
                      {entry.label}
                    </Link>
                  ))}
                </div>
              </details>
            </>
          ) : (
            PUBLIC_NAV.map((entry) => (
              <Link key={entry.href} href={entry.href}>
                {entry.label}
              </Link>
            ))
          )}
        </nav>
      </div>

      <div className="row topbar-end">
        {authenticated && session ? (
          <>
            <span className="meta">
              {session.walletAddress ? <Address value={session.walletAddress} /> : null} ·{" "}
              {session.roleBindings?.map((binding) => binding.role).join(", ") ||
                COPY.session.noRoles}{" "}
              · {session.assuranceLevel}
            </span>
            <button onClick={() => void signOut()}>{COPY.session.disconnect}</button>
          </>
        ) : (
          <>
            <span className="meta">{COPY.session.none}</span>
            <Link href="/connect" className="btn-connect sm">
              Connect account →
            </Link>
          </>
        )}
      </div>
    </header>
  );
}
