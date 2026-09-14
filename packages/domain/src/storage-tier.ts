import type { Sensitivity } from "./disclosure.js";

/**
 * Storage path decision — OD-17·OD-18 (draft decision of 2026-08-14).
 *
 * The draft stage has **only one storage path**: a single bucket encrypted with a
 * provider-managed key, with no per-tenant key separation and no rotation runbook. Only
 * material for which that suffices may pass through it.
 *
 * When real contracts or personal data must be uploaded, a **separate secured route** is built,
 * deciding per-tenant key separation, rotation, and crypto-shredding together (OD-18 re-decision).
 *
 * **Why build the gate now:** build only the simple path and add the gate later, and sensitive
 * material uploaded in between goes straight through the simple path. Storage can be undone, but
 * the fact that "it was processed in that jurisdiction with that key" cannot.
 */

/** Sensitivity levels the draft path can accept. */
const DRAFT_TIER_ALLOWED = ["public", "restricted"] as const;

export type StorageTier = "draft" | "secured";

/** Which path this sensitivity level must take. */
export function storageTierFor(sensitivity: Sensitivity): StorageTier {
  return (DRAFT_TIER_ALLOWED as readonly string[]).includes(sensitivity) ? "draft" : "secured";
}

export type StorageAdmission =
  | { readonly admitted: true; readonly tier: "draft" }
  | {
      readonly admitted: false;
      readonly requiredTier: "secured";
      readonly reason: string;
      readonly nextAction: string;
    };

/**
 * Can this material be accepted now?
 *
 * While no secured route exists, sensitive levels are rejected. **"We can move it later" does
 * not hold** — moving the file leaves the fact of processing during the interim.
 */
export function admitToStorage(sensitivity: Sensitivity): StorageAdmission {
  if (storageTierFor(sensitivity) === "draft") {
    return { admitted: true, tier: "draft" };
  }

  return {
    admitted: false,
    requiredTier: "secured",
    reason:
      `${sensitivity} material is not accepted by the draft storage path. ` +
      "Current storage uses a provider-managed key, with no per-tenant key separation or destruction procedure",
    nextAction:
      "Upload after the secured route opens. That route is built together with the OD-18 re-decision (key ownership, rotation, " +
      "crypto-shredding)",
  };
}
