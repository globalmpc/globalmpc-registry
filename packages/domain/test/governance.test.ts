import { describe, expect, it } from "vitest";
import {
  PROJECT_PROPOSAL_TYPES,
  PROTOCOL_PROPOSAL_TYPES,
  checkProposalSpace,
  tallyVotes,
  checkVoteEligibility,
  isForbiddenTarget,
  type GovernanceSpace,
} from "../src/governance.js";

const PROJECT_A: GovernanceSpace = { kind: "project", projectId: "01JZPROJECTA" };
const PROJECT_B: GovernanceSpace = { kind: "project", projectId: "01JZPROJECTB" };

describe("AC-05 — cross-governance blocking", () => {
  it("cannot propose a project disposition in the protocol space", () => {
    const result = checkProposalSpace("protocol", "project_disposition");
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("GOVERNANCE_SPACE_MISMATCH");
  });

  it("cannot propose protocol treasury in the project space", () => {
    const result = checkProposalSpace(PROJECT_A, "protocol_treasury");
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("GOVERNANCE_SPACE_MISMATCH");
  });

  it("cannot change the fee schedule in the project space", () => {
    expect(checkProposalSpace(PROJECT_A, "fee_schedule").allowed).toBe(false);
  });

  it("cannot change reviewer pool criteria in the project space", () => {
    expect(checkProposalSpace(PROJECT_A, "reviewer_pool_criteria").allowed).toBe(false);
  });

  it("every protocol type is allowed only in the protocol space", () => {
    for (const type of PROTOCOL_PROPOSAL_TYPES) {
      expect(checkProposalSpace("protocol", type).allowed).toBe(true);
      expect(checkProposalSpace(PROJECT_A, type).allowed).toBe(false);
    }
  });

  it("every project type is allowed only in the project space", () => {
    for (const type of PROJECT_PROPOSAL_TYPES) {
      expect(checkProposalSpace(PROJECT_A, type).allowed).toBe(true);
      expect(checkProposalSpace("protocol", type).allowed).toBe(false);
    }
  });

  it("rejects an unknown proposal type", () => {
    const result = checkProposalSpace("protocol", "arbitrary_admin_action");
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("GOVERNANCE_UNKNOWN_PROPOSAL_TYPE");
  });
});

describe("voting eligibility", () => {
  it("a protocol voter votes only on protocol proposals", () => {
    expect(checkVoteEligibility("protocol", "protocol").allowed).toBe(true);
    expect(checkVoteEligibility("protocol", PROJECT_A).allowed).toBe(false);
  });

  it("a project voter cannot vote on protocol proposals", () => {
    expect(checkVoteEligibility(PROJECT_A, "protocol").allowed).toBe(false);
  });

  it("a project voter votes only on its own project", () => {
    expect(checkVoteEligibility(PROJECT_A, PROJECT_A).allowed).toBe(true);
    const cross = checkVoteEligibility(PROJECT_A, PROJECT_B);
    expect(cross.allowed).toBe(false);
    if (!cross.allowed) expect(cross.reason).toBe("GOVERNANCE_PROJECT_SCOPE_MISMATCH");
  });
});

describe("targets forbidden in every space", () => {
  it("governance cannot create a readiness override", () => {
    expect(isForbiddenTarget("readiness_override")).toBe(true);
  });

  it("governance cannot create legal issuance approval", () => {
    expect(isForbiddenTarget("legal_issuance_approval")).toBe(true);
  });

  it("governance cannot change the audit log", () => {
    expect(isForbiddenTarget("audit_log_mutation")).toBe(true);
  });

  it("governance cannot change attestation content", () => {
    expect(isForbiddenTarget("attestation_content_change")).toBe(true);
  });

  it("a normal protocol parameter is not forbidden", () => {
    expect(isForbiddenTarget("fee_schedule")).toBe(false);
  });
});

describe("exclusivity of the proposal type sets", () => {
  it("the two sets do not overlap", () => {
    const protocol = new Set<string>(PROTOCOL_PROPOSAL_TYPES);
    const overlap = PROJECT_PROPOSAL_TYPES.filter((type) => protocol.has(type));
    expect(overlap).toEqual([]);
  });
});

describe("vote tally", () => {
  const base = {
    forWeight: 0n,
    againstWeight: 0n,
    abstainWeight: 0n,
    eligibleWeight: 1000n,
    quorumNumerator: 1,
    quorumDenominator: 4,
    thresholdNumerator: 1,
    thresholdDenominator: 2,
  };

  it("no_quorum when participation is below quorum", () => {
    const result = tallyVotes({ ...base, forWeight: 100n });
    // 100/1000 = 10% < 25%
    expect(result.outcome).toBe("no_quorum");
    expect(result.quorumMet).toBe(false);
  });

  it("distinguishes missing quorum from rejection", () => {
    // The next step differs — the former means announcing again, the latter revising the proposal.
    const noQuorum = tallyVotes({ ...base, forWeight: 100n });
    const defeated = tallyVotes({ ...base, forWeight: 100n, againstWeight: 400n });

    expect(noQuorum.outcome).toBe("no_quorum");
    expect(defeated.outcome).toBe("defeated");
    expect(noQuorum.reason).not.toBe(defeated.reason);
  });

  it("counts abstentions as participation", () => {
    // Quorum measures "how much interest", not "how much support".
    const result = tallyVotes({ ...base, forWeight: 200n, abstainWeight: 100n });
    expect(result.quorumMet).toBe(true);
    expect(result.participatedWeight).toBe(300n);
  });

  it("does not count abstentions as against", () => {
    // 300 for / 0 against / 200 abstain → 300 of the 300 for+against are for, so it passes.
    const result = tallyVotes({ ...base, forWeight: 300n, abstainWeight: 200n });
    expect(result.outcome).toBe("succeeded");
  });

  it("does not decide when there are only abstentions", () => {
    const result = tallyVotes({ ...base, abstainWeight: 500n });
    expect(result.outcome).toBe("defeated");
    expect(result.reason).toContain("Only abstentions");
  });

  it("decides with fractions at the boundary", () => {
    // Exactly 25%. Floating point can split on a 0.25 comparison.
    const exact = tallyVotes({ ...base, forWeight: 250n });
    expect(exact.quorumMet).toBe(true);

    const justBelow = tallyVotes({ ...base, forWeight: 249n });
    expect(justBelow.quorumMet).toBe(false);
  });

  it("the pass threshold is exact at the boundary too", () => {
    // Exactly 250 for out of 500 for+against = 50%. The threshold is 1/2, so it passes.
    const exact = tallyVotes({ ...base, forWeight: 250n, againstWeight: 250n });
    expect(exact.outcome).toBe("succeeded");

    const justBelow = tallyVotes({ ...base, forWeight: 249n, againstWeight: 251n });
    expect(justBelow.outcome).toBe("defeated");
  });

  it("is exact with large numbers", () => {
    // Token weight has 18 decimals. Handling it as number loses precision.
    const huge = 10n ** 30n;
    const result = tallyVotes({
      ...base,
      eligibleWeight: huge * 4n,
      forWeight: huge,
    });
    expect(result.quorumMet).toBe(true);
  });
});
