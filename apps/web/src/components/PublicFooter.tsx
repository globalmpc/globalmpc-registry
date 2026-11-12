"use client";

import Link from "next/link";
import { activateNavigationMenu } from "@/lib/navigation-menus";
import { useSession } from "@/lib/session";
import { PUBLIC_TOOLS } from "@/lib/copy";


export function PublicFooter() {
  const { session } = useSession();
  return <footer className="footer" onClick={activateNavigationMenu}>
    <div className="footer-inner">
      <span>{session?.authenticated ? "MPC Registry workspace" : "Read-only public record"}</span>
      <span>Original evidence stays in the private workspace.</span>
      <details className="footer-navigation">
        <summary>Search & verification tools</summary>
        <nav aria-label="Public destinations" onClick={event => { if (event.target instanceof Element && event.target.closest("a")) { const menu = event.currentTarget.closest("details"); if (menu) menu.open = false; } }}>
          {PUBLIC_TOOLS.map(entry => <Link key={entry.href} href={entry.href}>{entry.label}</Link>)}

        </nav>
      </details>
      <Link href="/disclosures">Disclosures & incidents</Link>
      <Link href="/legal">Terms, data handling, and support</Link>
    </div>
  </footer>;
}
