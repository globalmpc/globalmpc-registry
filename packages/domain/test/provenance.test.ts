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
  it("rejected: 규칙상 배제", () => {
    expect(computeClaimGrade({ ...BASE, excludedByRule: true })).toBe("rejected");
  });

  it("rejected: verification state가 rejected", () => {
    expect(computeClaimGrade({ ...BASE, verificationState: "rejected" })).toBe("rejected");
  });

  it("rejected가 다른 모든 조건을 이긴다", () => {
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

  it("unverified: 근거가 없다", () => {
    expect(computeClaimGrade({ ...BASE, evidenceTier: null })).toBe("unverified");
  });

  it("unverified: 검토 전", () => {
    expect(computeClaimGrade({ ...BASE, verificationState: "unreviewed" })).toBe("unverified");
  });

  it("verified: 독립 assurance + professional signoff + P1/P2 + conflict 0", () => {
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

  it("verified가 되지 않는다: unresolved conflict가 있으면", () => {
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

  it("verified가 되지 않는다: tier가 P3면", () => {
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

  it("verified가 되지 않는다: professional signoff가 없으면", () => {
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

  it("verified가 되지 않는다: independent assurance attestation이 없으면", () => {
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

  it("self_reported: machine_checked 이하의 자기 신고", () => {
    expect(computeClaimGrade({ ...BASE, verificationState: "machine_checked" })).toBe(
      "self_reported",
    );
  });

  it("self_reported: 검토는 있었으나 tier가 P4/P5", () => {
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
  it("최저 grade를 고른다", () => {
    expect(weakestGrade(["verified", "partially_verified", "self_reported"])).toBe(
      "self_reported",
    );
  });

  it("rejected가 하나라도 있으면 rejected다", () => {
    expect(weakestGrade(["verified", "verified", "rejected"])).toBe("rejected");
  });

  it("빈 집합은 unverified다 — 필수 claim이 없는 것은 좋은 상태가 아니다", () => {
    expect(weakestGrade([])).toBe("unverified");
  });

  it("모두 verified여야 verified다", () => {
    expect(weakestGrade(["verified", "verified"])).toBe("verified");
  });
});

describe("property — grade 산출", () => {
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

  it("모든 입력 조합이 정확히 하나의 grade를 만든다 (AC-11 결정성)", () => {
    fc.assert(
      fc.property(gradeInput, (input) => {
        const first = computeClaimGrade(input);
        expect(GRADES).toContain(first);
        expect(computeClaimGrade(input)).toBe(first);
      }),
      { numRuns: 500 },
    );
  });

  it("weakestGrade는 입력 순서와 무관하다", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom<Grade>(...GRADES), { maxLength: 8 }), (grades) => {
        expect(weakestGrade([...grades].reverse())).toBe(weakestGrade(grades));
      }),
      { numRuns: 300 },
    );
  });

  it("weakestGrade 결과는 항상 입력에 포함된 grade다", () => {
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
  it("최소 등급 비교", () => {
    expect(gradeAtLeast("verified", "partially_verified")).toBe(true);
    expect(gradeAtLeast("partially_verified", "verified")).toBe(false);
    expect(gradeAtLeast("self_reported", "self_reported")).toBe(true);
    expect(gradeAtLeast("rejected", "unverified")).toBe(false);
  });
});
