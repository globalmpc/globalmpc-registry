"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

/** Auth forms share one measure, including invitation, recovery and provider callbacks. */
export function PageFrame({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  const pathname = usePathname();
  const main = useRef<HTMLElement>(null);
  const previousPath = useRef(pathname);
  useEffect(() => {
    if (previousPath.current === pathname) return;
    previousPath.current = pathname;
    if (!window.matchMedia?.("(prefers-reduced-motion: no-preference)").matches) return;
    const animation = main.current?.animate?.(
      [{ opacity: 0.88 }, { opacity: 1 }],
      { duration: 160, easing: "ease-out" },
    );
    return () => animation?.cancel();
  }, [pathname]);
  const auth =
    pathname === "/connect" ||
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/invitations/") ||
    pathname.startsWith("/account/");
  return (
    <main
      ref={main}
      className={`main${auth ? " auth-page" : ""}${pathname.startsWith("/w/") ? " workspace-page" : ""}`}
      id="main"
    >
      {children}
    </main>
  );
}
