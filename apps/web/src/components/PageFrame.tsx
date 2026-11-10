"use client";

import { usePathname } from "next/navigation";

/** Auth forms share one measure, including invitation, recovery and provider callbacks. */
export function PageFrame({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  const pathname = usePathname();
  const auth =
    pathname === "/connect" ||
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/invitations/") ||
    pathname.startsWith("/account/");
  return (
    <main
      className={`main${auth ? " auth-page" : ""}${pathname.startsWith("/w/") ? " workspace-page" : ""}`}
      id="main"
    >
      {children}
    </main>
  );
}
