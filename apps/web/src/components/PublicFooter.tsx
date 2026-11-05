"use client";

import Link from "next/link";
import { activateNavigationMenu } from "@/lib/navigation-menus";
import { useSession } from "@/lib/session";
import { PUBLIC_NAV } from "@/lib/copy";

export function PublicFooter() {
  const { session } = useSession();
  return <footer className="footer" onClick={activateNavigationMenu}>
    <div className="footer-inner">
      <span>{session?.authenticated ? "MPC Registry workspace" : "Read-only public record"}</span>
      <span>Original evidence stays in the private workspace.</span>
      <details className="footer-navigation">
        <summary>More</summary>
        <nav aria-label="Public destinations">
          {PUBLIC_NAV.map((entry) => <Link key={entry.href} href={entry.href} onClick={(event) => { const menu = event.currentTarget.closest("details"); if (menu) menu.open = false; }}>{entry.label}</Link>)}
          <Link href="/legal" onClick={(event) => { const menu = event.currentTarget.closest("details"); if (menu) menu.open = false; }}>Terms, data handling, and support</Link>
        </nav>
      </details>
    </div>
  </footer>;
}
