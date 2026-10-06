import type { DocumentImpact, DocumentLink, DocumentLinkKind, DocumentNode } from "@/lib/api";

/**
 * Shared wording and shapes for the document-relations screens.
 *
 * Three screens show the same links and impacts. Written per screen, "rests on" would become
 * "depends on" on one and "linked to" on another, and people would read three relations where
 * there is one.
 */

/** Files nobody relies on. Same set the server refuses to link. */
export const UNUSABLE_STATES: ReadonlySet<string> = new Set(["scanned_infected", "rejected"]);

export const KIND_LABEL: Record<DocumentLinkKind, string> = {
  depends_on: "rests on",
  references: "cites",
};

/** What each kind does when the upstream document changes. Shown next to the choice. */
export const KIND_EXPLANATION: Record<DocumentLinkKind, string> = {
  depends_on:
    "Rests on — when the other document changes, this one needs a second look, and so does whatever rests on this one.",
  references:
    "Cites — when the other document changes, this one is flagged, and the change stops here.",
};

export const ORIGIN_LABEL: Record<DocumentLink["origin"], string> = {
  user: "Linked by a person",
  rule: "From a type rule",
  carried_over: "Carried over from the previous version",
};

export const CAUSE_LABEL: Record<DocumentImpact["cause"], string> = {
  superseded: "replaced by a new version",
  expired: "past its validity date",
};

export const RESOLUTION_LABEL: Record<DocumentImpact["resolution"], string> = {
  open: "Open",
  revised: "Revised — a new version took effect",
  no_change_needed: "No change needed",
  not_applicable: "Not applicable",
};

/** A name people recognise. The file name is restricted but already on these workspace screens. */
export function documentLabel(node: DocumentNode | undefined, uploadId: string): string {
  const name = node?.originalFilename ?? `Document ${uploadId.slice(0, 8)}`;
  return node?.documentType ? `${name} (${node.documentType})` : name;
}

/** Whole days from today (UTC) to `day`. Negative once the day has passed. */
export function daysFromToday(day: string, today: Date = new Date()): number {
  const start = Date.parse(`${today.toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.round((Date.parse(`${day}T00:00:00Z`) - start) / 86_400_000);
}

/**
 * Validity in words.
 *
 * Days left carry no warning colour. When to start worrying is an operational threshold nobody
 * has set, and a colour here would set one silently.
 */
export function validityText(validUntil: string | null, daysUntilExpiry?: number | null): string {
  if (!validUntil) return "—";
  const days = daysUntilExpiry ?? daysFromToday(validUntil);
  if (days < 0) return `Expired ${validUntil}`;
  if (days === 0) return `${validUntil} · last valid day`;
  return `${validUntil} · ${days} day${days === 1 ? "" : "s"} left`;
}

export interface TreeItem {
  readonly uploadId: string;
  readonly viaUploadId: string | null;
}

/**
 * Children keyed by the document just above them.
 *
 * The server sends each document once, on its shortest route, with the document above it. That
 * is enough to rebuild the tree without the screen walking links itself.
 */
export function childrenByParent<T extends TreeItem>(items: readonly T[]): Map<string, T[]> {
  const children = new Map<string, T[]>();
  for (const item of items) {
    if (item.viaUploadId === null) continue;
    children.set(item.viaUploadId, [...(children.get(item.viaUploadId) ?? []), item]);
  }
  return children;
}
