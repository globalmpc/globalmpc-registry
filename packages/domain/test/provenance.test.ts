import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  GRADES,
  computeClaimGrade,
  gradeAtLeast,
  weakestGrade,
  type AttestationType,
  type ClaimGradeInput,
  type EvidenceTier,
  type Grade,
  type VerificationState,
} from "../src/provenance.js";

const BASE: ClaimGradeInput = {
  verificationState: "unreviewed",
  evidenceTier: "P1",
  attestationTypes: [],
  unresolvedConflictCount: 0,
  excludedByRule: false,
};

describe("computeClaimGrade — truth table (spec 05 §5.3)", () => {
  it("rejected: excluded by rule", () => {
    expect(computeClaimGrade({ ...BASE, excludedByRule: true })).toBe("rejected");
  });

  it("rejected: verification state is rejected", () => {
    expect(computeClaimGrade({ ...BASE, verificationState: "rejected" })).toBe("rejected");
  });

  it("rejected beats every other condition", () => {
    expect(
      computeClaimGrade({
        verificationState: "independently_assured",
        evidenceTier: "P1",
        attestationTypes: ["professional_signoff", "independent_assurance"],
        unresolvedConflictCount: 0,
        excludedByRule: true,
      }),
    ).toBe("rejected");
  });

  it("unverified: no evidence", () => {
    expect(computeClaimGrade({ ...BASE, evidenceTier: null })).toBe("unverified");
  });

  it("unverified: before review", () => {
    expect(computeClaimGrade({ ...BASE, verificationState: "unreviewed" })).toBe("unverified");
  });

  it("verified: independent assurance + professional signoff + P1/P2 + 0 conflicts", () => {
    expect(
      computeClaimGrade({
        verificationState: "independently_assured",
        evidenceTier: "P1",
        attestationTypes: ["professional_signoff", "independent_assurance"],
        unresolvedConflictCount: 0,
        excludedByRule: false,
      }),
    ).toBe("verified");
  });

  it("not verified: with an unresolved conflict", () => {
    expect(
      computeClaimGrade({
        verificationState: "independently_assured",
        evidenceTier: "P1",
        attestationTypes: ["professional_signoff", "independent_assurance"],
        unresolvedConflictCount: 1,
        excludedByRule: false,
      }),
    ).toBe("partially_verified");
  });

  it("not verified: when the tier is P3", () => {
    expect(
      computeClaimGrade({
        verificationState: "independently_assured",
        evidenceTier: "P3",
        attestationTypes: ["professional_signoff", "independent_assurance"],
        unresolvedConflictCount: 0,
        excludedByRule: false,
      }),
    ).toBe("partially_verified");
  });

  it("not verified: without a professional signoff", () => {
    expect(
      computeClaimGrade({
        verificationState: "independently_assured",
        evidenceTier: "P1",
        attestationTypes: ["independent_assurance"],
        unresolvedConflictCount: 0,
        excludedByRule: false,
      }),
    ).toBe("partially_verified");
  });

  it("not verified: without an independent assurance attestation", () => {
    expect(
      computeClaimGrade({
        verificationState: "independently_assured",
        evidenceTier: "P1",
        attestationTypes: ["professional_signoff"],
        unresolvedConflictCount: 0,
        excludedByRule: false,
      }),
    ).toBe("partially_verified");
  });

  it("partially_verified: analyst_checked + P1~P3", () => {
    for (const tier of ["P1", "P2", "P3"] as EvidenceTier[]) {
      expect(
        computeClaimGrade({ ...BASE, verificationState: "analyst_checked", evidenceTier: tier }),
      ).toBe("partially_verified");
    }
  });

  it("self_reported: self-declared at machine_checked or below", () => {
    expect(computeClaimGrade({ ...BASE, verificationState: "machine_checked" })).toBe(
      "self_reported",
    );
  });

  it("self_reported: reviewed but tier is P4/P5", () => {
    for (const tier of ["P4", "P5"] as EvidenceTier[]) {
      expect(
        computeClaimGrade({
          ...BASE,
          verificationState: "independently_assured",
          evidenceTier: tier,
          attestationTypes: ["professional_signoff", "independent_assurance"],
        }),
      ).toBe("self_reported");
    }
  });
});

describe("weakestGrade — weakest link", () => {
  it("picks the lowest grade", () => {
    expect(weakestGrade(["verified", "partially_verified", "self_reported"])).toBe(
      "self_reported",
    );
  });

  it("rejected if any one is rejected", () => {
    expect(weakestGrade(["verified", "verified", "rejected"])).toBe("rejected");
  });

  it("an empty set is unverified — having no required claims is not a good state", () => {
    expect(weakestGrade([])).toBe("unverified");
  });

  it("verified only when all are verified", () => {
    expect(weakestGrade(["verified", "verified"])).toBe("verified");
  });
});

describe("property — grade derivation", () => {
  const gradeInput = fc.record<ClaimGradeInput>({
    verificationState: fc.constantFrom<VerificationState>(
      "unreviewed",
      "machine_checked",
      "analyst_checked",
      "independently_assured",
      "rejected",
    ),
    evidenceTier: fc.option(fc.constantFrom<EvidenceTier>("P1", "P2", "P3", "P4", "P5"), {
      nil: null,
    }),
    attestationTypes: fc.uniqueArray(
      fc.constantFrom<AttestationType>(
        "professional_signoff",
        "laboratory_accreditation",
        "independent_assurance",
        "legal_notarization",
        "cryptographic_attestation",
      ),
      { maxLength: 5 },
    ),
    unresolvedConflictCount: fc.nat({ max: 5 }),
    excludedByRule: fc.boolean(),
  });

  it("every input combination yields exactly one grade (AC-11 determinism)", () => {
    fc.assert(
      fc.property(gradeInput, (input) => {
        const first = computeClaimGrade(input);
        expect(GRADES).toContain(first);
        expect(computeClaimGrade(input)).toBe(first);
      }),
      { numRuns: 500 },
    );
  });

  it("weakestGrade is independent of input order", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom<Grade>(...GRADES), { maxLength: 8 }), (grades) => {
        expect(weakestGrade([...grades].reverse())).toBe(weakestGrade(grades));
      }),
      { numRuns: 300 },
    );
  });

  it("the weakestGrade result is always a grade from the input", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<Grade>(...GRADES), { minLength: 1, maxLength: 8 }),
        (grades) => {
          expect(grades).toContain(weakestGrade(grades));
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("gradeAtLeast", () => {
  it("minimum grade comparison", () => {
    expect(gradeAtLeast("verified", "partially_verified")).toBe(true);
    expect(gradeAtLeast("partially_verified", "verified")).toBe(false);
    expect(gradeAtLeast("self_reported", "self_reported")).toBe(true);
    expect(gradeAtLeast("rejected", "unverified")).toBe(false);
  });
});
