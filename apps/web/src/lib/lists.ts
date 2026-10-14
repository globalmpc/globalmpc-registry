/**
 * Capped lists.
 *
 * The server caps these lists and says when it did (`truncated`). A screen that renders only
 * the rows it received reads as "that is everything", so each one states how much it shows.
 */

/** What every capped list response carries on top of its rows. */
export interface ListWindow {
  /** `true` when rows exist beyond what this response carries. */
  truncated: boolean;
  /** The cap the server applied. */
  limit: number;
}

/** Plus a count, where the server can count cheaply (per-project lists). */
export interface CountedListWindow extends ListWindow {
  total: number;
}

/**
 * `noun` carries the order the server applied ("notifications, newest first"), so the reader
 * knows which end of the list was cut.
 */
export function truncationText({
  shown,
  total,
  noun,
}: {
  shown: number;
  total?: number;
  noun: string;
}): string {
  if (total !== undefined) {
    return `Showing ${shown.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} ${noun}.`;
  }
  return `Showing ${shown.toLocaleString("en-US")} ${noun}. More exist and are not listed here.`;
}
