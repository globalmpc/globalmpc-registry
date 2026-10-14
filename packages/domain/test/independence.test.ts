import { describe, expect, it } from "vitest";
import { reviewIndependence, type IndependenceFacts } from "../src/independence.js";

const INDEPENDENT: IndependenceFacts = {
  reviewerSubjectId: "reviewer",
  assignerSubjectId: "steward",
  evidenceSubmitterIds: ["steward"],
  allSubmittersKnown: true,
  reviewerOrganizationIds: ["review-firm"],
  operatorOrganizationIds: ["operator"],
};

describe("02 §2.4 — reviewer independence", () => {
  it("reviews an independent assignment", () => {
    expect(reviewIndependence(INDEPENDENT)).toEqual({ reviewed: true, violations: [], gaps: [] });
  });

  it("rule 1: the submitter of the evidence cannot review it", () => {
    const review = reviewIndependence({ ...INDEPENDENT, evidenceSubmitterIds: ["reviewer"] });
    expect(review.reviewed).toBe(false);
    expect(review.violations).toEqual(["REVIEWER_SUBMITTED_EVIDENCE"]);
  });

  it("rule 2: the reviewer cannot belong to the operating organization", () => {
    const review = reviewIndependence({
      ...INDEPENDENT,
      reviewerOrganizationIds: ["review-firm", "operator"],
    });
    expect(review.violations).toEqual(["REVIEWER_SHARES_OPERATOR_ORGANIZATION"]);
  });

  it("02 §2.8: the assigner cannot appoint themselves", () => {
    const review = reviewIndependence({ ...INDEPENDENT, assignerSubjectId: "reviewer" });
    expect(review.violations).toContain("SELF_ASSIGNMENT");
  });

  it("an unknown submitter is a gap, not a pass", () => {
    const review = reviewIndependence({ ...INDEPENDENT, allSubmittersKnown: false });
    expect(review).toEqual({
      reviewed: false,
      violations: [],
      gaps: ["EVIDENCE_SUBMITTER_UNKNOWN"],
    });
  });

  it("a reviewer with no organization on record is a gap, not a pass", () => {
    const review = reviewIndependence({ ...INDEPENDENT, reviewerOrganizationIds: [] });
    expect(review.reviewed).toBe(false);
    expect(review.gaps).toEqual(["REVIEWER_ORGANIZATION_UNKNOWN"]);
  });

  it("a known violation is reported even when other facts are missing", () => {
    const review = reviewIndependence({
      ...INDEPENDENT,
      evidenceSubmitterIds: ["reviewer"],
      allSubmittersKnown: false,
    });
    expect(review.violations).toEqual(["REVIEWER_SUBMITTED_EVIDENCE"]);
  });
});
