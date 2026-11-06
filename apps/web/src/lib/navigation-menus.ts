import type { MouseEvent } from "react";

export const NAVIGATION_MENUS = "header.topbar details[open], footer details[open]";

/** Close siblings before the native summary click opens its menu, including keyboard clicks. */
export function activateNavigationMenu(event: MouseEvent<HTMLElement>) {
  if (!(event.target instanceof Element)) return;
  const summary = event.target.closest("summary");
  const current = summary?.parentElement;
  if (!(current instanceof HTMLDetailsElement) || current.open) return;
  document.querySelectorAll<HTMLDetailsElement>(NAVIGATION_MENUS).forEach((menu) => {
    if (menu !== current) menu.open = false;
  });
}
