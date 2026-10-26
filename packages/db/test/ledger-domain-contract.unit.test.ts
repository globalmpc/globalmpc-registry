import { describe, expect, it } from "vitest";
import {
  deriveLedgerItemStatus,
  ledgerRequirementEvidence,
  type LedgerAttestation,
  type LedgerClaim,
  type LedgerItem,
} from "../src/evidence-ledger.js";

const claim: LedgerClaim = {
  id: "licence-v1", claim_type: "licence", catalog_entry_id: "definition-v1", catalog_version: 1,
  grade: "verified", as_of: new Date("2026-10-26T00:00:00Z"), value_text: "Private evidence",
  stale: false, has_evidence: true, conflict_ids: [], conflict_types: [], upload_ids: ["upload"],
  signal_ids: [], excluded_by_rule: false,
};
const review: LedgerAttestation = {
  id: "review", claim_scope: [claim.id], attestation_type: "professional_signoff", state: "signed",
  limitations: "Evidence only", valid: true, credential_id: "credential", valid_until: null,
};
const missing = { ...claim, has_evidence: false };
const rejected = { ...missing, grade: "rejected" as const };
const staleRejected = { ...rejected, stale: true };
const conflictedRejected = { ...staleRejected, conflict_ids: ["conflict"], conflict_types: ["contradiction"] };

// Expected outcomes are domain decisions, including the contrast obtained by removing
// one higher-priority condition. Evidence absence must never hide a stronger result.
describe("ledger combined-condition priority contracts", () => {
  it.each([
    { name: "conflict above stale, rejection and exclusion", claim: conflictedRejected, review, excluded: true,
      status: "conflicting", reason: "UNRESOLVED_CONFLICT" },
    { name: "removing conflict exposes actual staleness", claim: staleRejected, review, excluded: true,
      status: "needs_re_review", reason: "EVIDENCE_OR_REVIEW_NO_LONGER_CURRENT" },
    { name: "removing staleness exposes rejection despite missing evidence", claim: rejected, review, excluded: true,
      status: "rejected", reason: "REJECTED_OR_EXCLUDED_EVIDENCE" },
    { name: "rule exclusion above missing evidence and manual exclusion", claim: { ...missing, excluded_by_rule: true }, review, excluded: true,
      status: "rejected", reason: "REJECTED_OR_EXCLUDED_EVIDENCE" },
    { name: "invalid scoped review above rejection", claim: rejected, review: { ...review, valid: false }, excluded: true,
      status: "needs_re_review", reason: "EVIDENCE_OR_REVIEW_NO_LONGER_CURRENT" },
    { name: "disputed review above stale rejected evidence", claim: staleRejected, review: { ...review, state: "disputed", valid: false }, excluded: true,
      status: "conflicting", reason: "UNRESOLVED_CONFLICT" },
    { name: "healthy manual exclusion above missing positive evidence", claim: missing, review, excluded: true,
      status: "not_applicable", reason: "RECORDED_NOT_APPLICABLE" },
    { name: "removing manual exclusion restores the evidence obligation", claim: missing, review, excluded: false,
      status: "unreviewed", reason: "CURRENT_SCOPED_REVIEW_REQUIRED" },
  ])("$name", ({ claim: input, review: scoped, excluded, status, reason }) => {
    const result = deriveLedgerItemStatus([input], [scoped], excluded);
    expect(result.status).toBe(status);
    expect(result.reasons).toEqual([reason]);
  });
});

describe("review scope noninterference", () => {
  it("ignores unrelated disputed or expired reviews without dropping a relevant mixed scope", () => {
    const mixed = { ...review, claim_scope: [claim.id, "historical-filtered-claim"] };
    const unrelated = { ...review, id: "unrelated", claim_scope: ["historical-filtered-claim"], valid: false, state: "disputed" };
    const before = deriveLedgerItemStatus([claim], [mixed]);
    expect(before.status).toBe("reviewed");
    expect(deriveLedgerItemStatus([claim], [mixed, unrelated])).toEqual(before);
    expect(deriveLedgerItemStatus([claim], [mixed, { ...unrelated, state: "revoked" }])).toEqual(before);
    expect(deriveLedgerItemStatus([claim], [{ ...mixed, valid: false }, unrelated])).toMatchObject({
      status: "needs_re_review", attestationIds: ["review"], reasons: ["EVIDENCE_OR_REVIEW_NO_LONGER_CURRENT"],
    });
    expect(mixed.claim_scope).toEqual([claim.id, "historical-filtered-claim"]);
  });
});

const excludedV1: LedgerItem = {
  claimType: "licence", catalogVersion: 1, displayName: "Licence v1", status: "not_applicable", grade: "verified",
  reviewScope: [], reviews: [], claimIds: [claim.id], attestationIds: [], reasons: ["RECORDED_NOT_APPLICABLE"], limitations: [],
};

describe("catalog version applicability boundaries", () => {
  it("keeps evidence obligations for another pinned version of the same type", () => {
    const v2 = { ...claim, id: "licence-v2", catalog_entry_id: "definition-v2", catalog_version: 2, grade: "partially_verified" as const };
    const reviewedV2 = { ...review, claim_scope: [v2.id] };
    const now = new Date("2026-10-26T12:00:00Z");
    expect(ledgerRequirementEvidence(["licence"], [claim, v2], [reviewedV2], [excludedV1], now)).toEqual({
      presentClaimTypes: ["licence"], grade: "partially_verified", presentAttestations: ["professional_signoff"],
      evidenceAgeDays: "0", unresolvedConflictTypes: [], staleEvidence: [],
    });
    // Excluding v1 cannot mask the absence of a review for v2.
    expect(ledgerRequirementEvidence(["licence"], [claim, v2], [review], [excludedV1], now)).toMatchObject({
      grade: "partially_verified", presentAttestations: [], staleEvidence: ["licence"],
    });
  });
});

describe("UTC evidence age contracts", () => {
  it("uses UTC days rather than the source timestamp's local date or elapsed hours", () => {
    const evidence = { ...claim, as_of: new Date("2026-10-25T23:30:00-02:00") };
    const facts = (at: string) => ledgerRequirementEvidence(["licence"], [evidence], [review], [], new Date(at));
    expect(facts("2026-10-26T00:00:00Z")).toMatchObject({ evidenceAgeDays: "0", staleEvidence: [] });
    expect(facts("2026-10-27T00:00:00Z")).toMatchObject({ evidenceAgeDays: "1", staleEvidence: [] });
    expect(facts("2026-10-25T23:59:59.999Z")).toMatchObject({ evidenceAgeDays: null, staleEvidence: ["licence"] });
  });
});
