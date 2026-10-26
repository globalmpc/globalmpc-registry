import { z } from "zod";
import { READINESS_STATUSES, GRADES } from "@mpc/domain";
import { hex32, isoDateTime, responseMeta } from "./common.js";

export const LEDGER_ITEM_STATUSES = [
  "missing", "unreviewed", "reviewed", "needs_re_review", "conflicting", "rejected", "not_applicable",
] as const;
export const evidenceLedgerItem = z.object({
  claimType: z.string(), catalogVersion: z.number().int().positive(), displayName: z.string(),
  status: z.enum(LEDGER_ITEM_STATUSES), grade:z.enum(GRADES).nullable(), reviewScope:z.array(z.string()),
  reviews:z.array(z.object({reviewerHandle:hex32,credentialType:z.string(),attestationType:z.string(),signedAt:isoDateTime,limitations:z.string()}).strict()), claimIds: z.array(z.string().guid()),
  attestationIds: z.array(z.string().guid()), reasons: z.array(z.string()), limitations: z.array(z.string()),
}).strict();
export const evidenceLedgerStage = z.object({
  gateId: z.string(), policySetId: z.string().guid(), ruleSetVersion: z.string(),
  status: z.enum(READINESS_STATUSES), missing: z.array(z.string()),
  reviewedItems:z.string().regex(/^(0|[1-9][0-9]*)$/),requiredItems:z.string().regex(/^(0|[1-9][0-9]*)$/),
}).strict();
export const evidenceLedgerSnapshot = z.object({
  id: z.string().guid().nullable(), projectId: z.string().guid(), evaluatedAt: isoDateTime,
  inputSnapshotHash: hex32, evaluatorVersion: z.literal("1"), inputBasis: z.record(z.string(), z.unknown()),
  items: z.array(evidenceLedgerItem), stages: z.array(evidenceLedgerStage),
  currentStage: z.string().nullable(), limitations: z.array(z.string()),
}).strict();
/** Safe summary is frozen by the existing independent disclosure approval. No raw evidence or reviewer data. */
export const publicEvidenceLedger = z.object({
  snapshotId: z.string().guid(), evaluatedAt: isoDateTime, inputSnapshotHash: hex32,
  items: z.array(evidenceLedgerItem.omit({ claimIds: true, attestationIds: true }).extend({catalogVersion:z.string().regex(/^[1-9][0-9]*$/)})),
  stages: z.array(evidenceLedgerStage.omit({ policySetId: true })),
  currentStage: z.string().nullable(), limitations: z.array(z.string()),
}).strict();
export const evidenceLedgerResponse = responseMeta.extend({ snapshot: evidenceLedgerSnapshot });
export const persistedEvidenceLedgerResponse = evidenceLedgerResponse.extend({publicProjection:publicEvidenceLedger});
export const publicEvidenceLedgerCurrent = z.object({
  evaluatedAt: isoDateTime,
  warnings: z.array(z.object({
    claimType: z.string(), catalogVersion:z.string().regex(/^[1-9][0-9]*$/), status: z.enum(["needs_re_review", "conflicting", "rejected"]),
    reasons: z.array(z.string()),
  }).strict()),
}).strict();
export type EvidenceLedgerSnapshot = z.infer<typeof evidenceLedgerSnapshot>;
export type EvidenceLedgerItem = z.infer<typeof evidenceLedgerItem>;
export type PublicEvidenceLedger = z.infer<typeof publicEvidenceLedger>;
