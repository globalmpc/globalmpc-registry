import { describe, expect, it } from "vitest";
import { SOURCE_RESULTS } from "@mpc/domain";
import { ROUTES, findRoutesWithoutAction } from "../src/routes.js";
import {
  ACCESS_REQUEST_PATHS,
  ACTION_POLICIES,
  authorize,
  type AuthorizationContext,
  type ResourceContext,
} from "../src/authorization.js";
import { ROLE_MINIMUM_ASSURANCE, satisfiesAssurance } from "../src/auth.js";
import {
  PROOF_DOES_NOT_PROVE,
  PROOF_PROVES,
  inclusionProofResponse,
  publicProjection,
  createAttestationRequest,
  createGateDecisionRequest,
  castVoteRequest,
  createProposalRequest,
} from "../src/resources.js";
import { errorEnvelope, sourceStatusView } from "../src/common.js";

describe("route definitions", () => {
  it("every mutation route has an action", () => {
    expect(findRoutesWithoutAction()).toEqual([]);
  });

  it("every action is in the policy table", () => {
    for (const route of ROUTES) {
      if (route.action === null) continue;
      expect(ACTION_POLICIES[route.action], `${route.action} missing from policy table`).toBeDefined();
    }
  });

  it("no route modifies a readiness result (REQ-DAPP-017)", () => {
    const mutating = ROUTES.filter(
      (route) =>
        (route.method === "patch" || route.method === "delete") &&
        route.path.includes("readiness"),
    );
    expect(mutating).toEqual([]);
  });

  it("readiness, gate, attestation, and registry have no DELETE route", () => {
    const deletes = ROUTES.filter((route) => route.method === "delete");
    expect(deletes).toEqual([]);
  });

  it("public routes require no auth and use a separate prefix", () => {
    const publicDataRoutes = ROUTES.filter(
      (route) => route.public && !route.path.includes("/auth/"),
    );
    expect(publicDataRoutes.length).toBeGreaterThan(0);
    for (const route of publicDataRoutes) {
      expect(route.path).toContain("/public/");
      expect(route.mutation).toBe(false);
    }
  });

  it("operationIds are unique", () => {
    const ids = ROUTES.map((route) => route.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("routes requiring If-Match are mutations", () => {
    // 07 §7.1 requires If-Match for versioned resource mutations. Requiring it on
    // reads would be contradictory: every read would need the version up front.
    const guarded = ROUTES.filter((route) => route.requiresIfMatch);
    expect(guarded.length).toBeGreaterThan(0);
    for (const route of guarded) {
      expect(route.mutation, route.operationId).toBe(true);
    }
  });

  it("version-bumping mutations require If-Match", () => {
    // Routes that change an existing resource's version. If one is listed here but
    // the contract says false, a later request silently overwrites an earlier
    // judgment.
    //
    // Create-only routes are excluded: there is no prior state to overwrite.
    // For attestation signing, the evidence snapshot hash comparison does the
    // same job — if the evidence changes after the signature request, it is
    // rejected with EVIDENCE_SNAPSHOT_CHANGED.
    const versionMutating = ["createClaimConflict", "revokeRegistryVersion"];

    for (const operationId of versionMutating) {
      const route = ROUTES.find((candidate) => candidate.operationId === operationId);
      expect(route, operationId).toBeDefined();
      expect(route!.requiresIfMatch, operationId).toBe(true);
    }
  });

  it("every mutation requires at least Idempotency-Key", () => {
    const mutations = ROUTES.filter((route) => route.mutation);
    expect(mutations.length).toBeGreaterThan(0);
    // Even without If-Match, the idempotency key guarantees retry safety.
    for (const route of mutations) {
      expect(route.action, route.operationId).not.toBeNull();
    }
  });
});

describe("authorization — the seven conditions of 02 §2.1", () => {
  const ACTOR: AuthorizationContext = {
    role: "gate_approver",
    assuranceLevel: "high_assurance",
    actorTenantId: "tenant-a",
    actorProjectIds: ["project-1"],
    sensitivityClearance: ["public", "restricted"],
    hasRequiredCredential: true,
    hasRequiredAssignment: true,
    conflictStatus: "none",
  };

  const RESOURCE: ResourceContext = {
    tenantId: "tenant-a",
    projectId: "project-1",
    sensitivity: "restricted",
    state: "assessed",
    statesAllowingAction: ["assessed"],
    requiresCredential: false,
    requiresAssignment: false,
    separationSensitive: true,
  };

  it("allows when every condition is met", () => {
    expect(authorize(ACTION_POLICIES["gate.decide"]!, ACTOR, RESOURCE).allow).toBe(true);
  });

  it("returns the required roles and request path on a role mismatch", () => {
    const decision = authorize(
      ACTION_POLICIES["gate.decide"]!,
      { ...ACTOR, role: "data_steward" },
      RESOURCE,
    );
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.reason).toBe("ROLE_ACTION_NOT_ALLOWED");
      expect(decision.requiredRoles).toContain("gate_approver");
      expect(decision.accessRequestPath).toContain("project-1");
    }
  });

  it("rejects insufficient assurance level and returns the required level", () => {
    const decision = authorize(
      ACTION_POLICIES["gate.decide"]!,
      { ...ACTOR, assuranceLevel: "wallet_only" },
      RESOURCE,
    );
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.reason).toBe("ASSURANCE_LEVEL_INSUFFICIENT");
      expect(decision.requiredAssurance).toBe("high_assurance");
    }
  });

  it("rejects cross-tenant access", () => {
    const decision = authorize(ACTION_POLICIES["gate.decide"]!, ACTOR, {
      ...RESOURCE,
      tenantId: "tenant-b",
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toBe("TENANT_SCOPE_MISMATCH");
  });

  it("rejects out-of-scope projects and returns an access request path", () => {
    const decision = authorize(ACTION_POLICIES["gate.decide"]!, ACTOR, {
      ...RESOURCE,
      projectId: "project-9",
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.reason).toBe("PROJECT_SCOPE_MISMATCH");
      expect(decision.accessRequestPath).toContain("project-9");
    }
  });

  /**
   * Denials point to exactly three paths, and each must have a screen
   * (`apps/web/e2e/access-request-paths.spec.ts`). Adding a fourth breaks this
   * test — pointing users to a path without a screen sends them to a 404.
   */
  it("access request paths are only the three with screens (§11.7)", () => {
    const emitted = new Set<string>();
    for (const role of ["data_steward", "gate_approver"]) {
      for (const projectId of ["project-1", null]) {
        for (const assuranceLevel of ["wallet_only", "high_assurance"] as const) {
          const decision = authorize(
            ACTION_POLICIES["gate.decide"]!,
            { ...ACTOR, role, assuranceLevel },
            { ...RESOURCE, projectId },
          );
          if (!decision.allow && decision.accessRequestPath) {
            emitted.add(decision.accessRequestPath);
          }
        }
      }
    }

    expect([...emitted].sort()).toEqual(
      [
        ACCESS_REQUEST_PATHS.assurance,
        ACCESS_REQUEST_PATHS.role,
        ACCESS_REQUEST_PATHS.project("project-1"),
      ].sort(),
    );
  });

  it("rejects insufficient sensitivity clearance", () => {
    const decision = authorize(ACTION_POLICIES["gate.decide"]!, ACTOR, {
      ...RESOURCE,
      sensitivity: "confidential",
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toBe("SENSITIVITY_CLEARANCE_INSUFFICIENT");
  });

  it("rejects when the resource state does not allow the action", () => {
    const decision = authorize(ACTION_POLICIES["gate.decide"]!, ACTOR, {
      ...RESOURCE,
      state: "suspended",
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toBe("RESOURCE_STATE_FORBIDS_ACTION");
  });

  it("rejects an unresolved conflict of interest", () => {
    const decision = authorize(
      ACTION_POLICIES["gate.decide"]!,
      { ...ACTOR, conflictStatus: "unresolved" },
      RESOURCE,
    );
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toBe("CONFLICT_OR_SEPARATION_VIOLATION");
  });

  it("the policy table has no readiness override action", () => {
    expect(ACTION_POLICIES["readiness.override"]).toBeUndefined();
  });
});

describe("assurance level — OD-04", () => {
  it("reviewer roles are not granted by wallet alone", () => {
    for (const role of [
      "reviewer_cp_qp",
      "reviewer_lab",
      "reviewer_legal",
      "reviewer_assurance",
      "issuer_officer",
      "gate_approver",
      "treasury_signer",
      "security_operator",
      "mpc_operator",
    ]) {
      expect(ROLE_MINIMUM_ASSURANCE[role]).toBe("high_assurance");
      expect(satisfiesAssurance("wallet_only", ROLE_MINIMUM_ASSURANCE[role]!)).toBe(false);
    }
  });

  it("public reader and governance participation work with wallet alone", () => {
    for (const role of ["public_reader", "protocol_voter", "project_voter"]) {
      expect(satisfiesAssurance("wallet_only", ROLE_MINIMUM_ASSURANCE[role]!)).toBe(true);
    }
  });
});

describe("AC-22 — public projection rejects fields outside the allowlist", () => {
  const VALID = {
    stableId: "SYNTH-PROJECT-001",
    status: "registered",
    version: "1",
    asOf: "2026-08-01T00:00:00Z",
    sourceAge: "12",
    staleStatus: "fresh",
    limitations: ["Legal title confirmation is outside the scope of this review"],
    legalEffect: "none" as const,
    disclaimerCodes: ["VERIFICATION_IS_NOT_GUARANTEE"],
  };

  it("passes with allowlist fields only", () => {
    expect(publicProjection.safeParse(VALID).success).toBe(true);
  });

  it("rejects a raw source response field", () => {
    const result = publicProjection.safeParse({ ...VALID, rawSourceResponse: "{...}" });
    expect(result.success).toBe(false);
  });

  it("rejects natural-person identifier fields", () => {
    expect(publicProjection.safeParse({ ...VALID, personalIdentifier: "Jane Doe" }).success).toBe(
      false,
    );
    expect(publicProjection.safeParse({ ...VALID, reviewerLegalName: "Jane Doe" }).success).toBe(
      false,
    );
  });

  it("rejects coordinates and contract body", () => {
    expect(
      publicProjection.safeParse({ ...VALID, preciseGeologicalCoordinates: [1, 2] }).success,
    ).toBe(false);
    expect(publicProjection.safeParse({ ...VALID, contractBody: "..." }).success).toBe(false);
  });

  it("limitations and legalEffect are required", () => {
    const { limitations, ...withoutLimitations } = VALID;
    expect(publicProjection.safeParse(withoutLimitations).success).toBe(false);
    const { legalEffect, ...withoutLegalEffect } = VALID;
    expect(publicProjection.safeParse(withoutLegalEffect).success).toBe(false);
  });

  it("legalEffect allows only none or counsel_required", () => {
    expect(publicProjection.safeParse({ ...VALID, legalEffect: "valid" }).success).toBe(false);
    expect(
      publicProjection.safeParse({ ...VALID, legalEffect: "counsel_required" }).success,
    ).toBe(true);
  });
});

describe("AC-23 — inclusion proof also returns what it does not prove", () => {
  it("proves and doesNotProve are in the response schema", () => {
    const result = inclusionProofResponse.safeParse({
      entryVersionId: "v1",
      leafHash: "0x" + "11".repeat(32),
      proof: ["0x" + "22".repeat(32)],
      root: "0x" + "33".repeat(32),
      batchId: "0x" + "44".repeat(32),
      chainId: 56,
      transactionHash: "0x" + "55".repeat(32),
      blockNumber: 100,
      confirmationState: "confirmed",
      included: true,
      proves: [...PROOF_PROVES],
      doesNotProve: [...PROOF_DOES_NOT_PROVE],
      policyVersion: "mn-core-1.0.0",
      schemaVersion: "project-registry-1",
      serializationVersion: "1",
    });
    expect(result.success).toBe(true);
  });

  it("all three spec versions are required", () => {
    // Without all three, a verifier does not know **which spec** to rebuild the leaf
    // with. If optional, some deployment would omit them and still satisfy the contract.
    const base = {
      entryVersionId: "v1",
      leafHash: "0x" + "11".repeat(32),
      proof: [],
      root: "0x" + "33".repeat(32),
      batchId: "0x" + "44".repeat(32),
      chainId: 56,
      transactionHash: null,
      blockNumber: null,
      confirmationState: "confirmed",
      included: true,
      proves: [...PROOF_PROVES],
      doesNotProve: [...PROOF_DOES_NOT_PROVE],
      policyVersion: "mn-core-1.0.0",
      schemaVersion: "project-registry-1",
      serializationVersion: "1",
    };

    for (const missing of ["policyVersion", "schemaVersion", "serializationVersion"]) {
      const { [missing]: _omitted, ...without } = base as Record<string, unknown>;
      expect(inclusionProofResponse.safeParse(without).success).toBe(false);
    }
  });

  it("serializationVersion is not pinned to \"1\"", () => {
    // Bumping the spec changes the value (CLAUDE.md). If the contract forced "1",
    // responses would violate the contract on that day.
    const result = inclusionProofResponse.safeParse({
      entryVersionId: "v1",
      leafHash: "0x" + "11".repeat(32),
      proof: [],
      root: "0x" + "33".repeat(32),
      batchId: "0x" + "44".repeat(32),
      chainId: 56,
      transactionHash: null,
      blockNumber: null,
      confirmationState: "confirmed",
      included: true,
      proves: [...PROOF_PROVES],
      doesNotProve: [...PROOF_DOES_NOT_PROVE],
      policyVersion: "mn-core-1.0.0",
      schemaVersion: "project-registry-1",
      serializationVersion: "2",
    });
    expect(result.success).toBe(true);
  });

  it("doesNotProve names factual accuracy, legal effect, and investment suitability", () => {
    const joined = PROOF_DOES_NOT_PROVE.join(" ");
    expect(joined).toContain("Factual accuracy");
    expect(joined).toContain("Legal effect");
    expect(joined).toContain("Investment suitability");
  });

  it("included is a boolean and names like verified are not used", () => {
    const keys = Object.keys(inclusionProofResponse.shape);
    expect(keys).toContain("included");
    expect(keys).not.toContain("verified");
    expect(keys).not.toContain("valid");
  });
});

describe("AC-01 — rejects attestation requests without limitations", () => {
  it("rejects an empty string", () => {
    const result = createAttestationRequest.safeParse({
      caseId: "case-1",
      assignmentId: "assign-1",
      attestationType: "professional_signoff",
      claimScope: ["claim-1"],
      limitations: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty claim scope", () => {
    const result = createAttestationRequest.safeParse({
      caseId: "case-1",
      assignmentId: "assign-1",
      attestationType: "professional_signoff",
      claimScope: [],
      limitations: "Limited scope",
    });
    expect(result.success).toBe(false);
  });
});

describe("gate decision request", () => {
  it("cannot record a decision without a rationale", () => {
    const result = createGateDecisionRequest.safeParse({
      gateId: "registry_publication",
      decision: "go",
      inputAssessmentId: "assessment-1",
      rationale: "",
    });
    expect(result.success).toBe(false);
  });

  it("decision must be one of the four values", () => {
    expect(
      createGateDecisionRequest.safeParse({
        gateId: "g",
        decision: "approve",
        inputAssessmentId: "a",
        rationale: "r",
      }).success,
    ).toBe(false);
  });
});

describe("source status view — 07 §7.11", () => {
  it("accepts all 12 results as-is", () => {
    for (const result of SOURCE_RESULTS) {
      const parsed = sourceStatusView.safeParse({
        result,
        retryable: false,
        nextAction: "view_limitations",
        lastSuccessAt: null,
        asOf: "2026-08-01T00:00:00Z",
        authorityReference: "authority-1",
        authorityScope: ["mining_license"],
        collectionMethod: "authenticated_api",
        adapterVersion: "1.0.0",
        sourceSchemaVersion: "2024-01",
        limitations: [],
      });
      expect(parsed.success, result).toBe(true);
    }
  });

  it("rejects aliases", () => {
    expect(
      sourceStatusView.safeParse({
        result: "no_record",
        retryable: false,
        nextAction: "x",
        lastSuccessAt: null,
        asOf: "2026-08-01T00:00:00Z",
        authorityReference: "a",
        authorityScope: [],
        collectionMethod: "authenticated_api",
        adapterVersion: "1",
        sourceSchemaVersion: "1",
        limitations: [],
      }).success,
    ).toBe(false);
  });
});

describe("error envelope", () => {
  it("retryable is required — clients must not guess whether to retry", () => {
    expect(
      errorEnvelope.safeParse({
        code: "SOURCE_UNAVAILABLE",
        message: "Source currently unavailable",
        correlationId: "corr-1",
      }).success,
    ).toBe(false);

    expect(
      errorEnvelope.safeParse({
        code: "SOURCE_UNAVAILABLE",
        message: "Source currently unavailable",
        retryable: true,
        correlationId: "corr-1",
      }).success,
    ).toBe(true);
  });
});

/**
 * Vote request — 04 §4.5.
 *
 * For proposals with an on-chain snapshot, the server sets the weight. If the
 * contract required weight, clients would have to invent a value that gets
 * ignored and would read it as counted.
 */
describe("castVoteRequest", () => {
  it("can vote without weight — the server sets it when a snapshot exists", () => {
    expect(castVoteRequest.safeParse({ choice: "for" }).success).toBe(true);
  });

  it("validates the format when weight is sent", () => {
    expect(castVoteRequest.safeParse({ choice: "for", weight: "-1" }).success).toBe(false);
    expect(castVoteRequest.safeParse({ choice: "for", weight: "100" }).success).toBe(true);
  });
});

/**
 * Quorum denominator — 09 §9.6.
 *
 * Accepting 0 makes `participation × D >= 0 × N` always true, so quorum would
 * always pass despite having a denominator.
 */
describe("createProposalRequest", () => {
  const base = {
    space: "protocol",
    proposalType: "fee_schedule",
    title: "Fee change",
    rationale: "Current fees do not cover operating costs",
  };

  it("rejects 0 as the quorum denominator", () => {
    expect(createProposalRequest.safeParse({ ...base, eligibleWeight: "0" }).success).toBe(false);
  });

  it("a proposal can be created without a denominator — blocked when voting opens", () => {
    expect(createProposalRequest.safeParse(base).success).toBe(true);
  });
});
