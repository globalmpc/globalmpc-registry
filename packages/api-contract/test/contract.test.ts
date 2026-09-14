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

describe("route 정의", () => {
  it("모든 mutation route에 action이 있다", () => {
    expect(findRoutesWithoutAction()).toEqual([]);
  });

  it("모든 action이 정책표에 있다", () => {
    for (const route of ROUTES) {
      if (route.action === null) continue;
      expect(ACTION_POLICIES[route.action], `${route.action} 정책 누락`).toBeDefined();
    }
  });

  it("readiness 결과를 수정하는 route가 없다 (REQ-DAPP-017)", () => {
    const mutating = ROUTES.filter(
      (route) =>
        (route.method === "patch" || route.method === "delete") &&
        route.path.includes("readiness"),
    );
    expect(mutating).toEqual([]);
  });

  it("readiness·gate·attestation·registry에 DELETE route가 없다", () => {
    const deletes = ROUTES.filter((route) => route.method === "delete");
    expect(deletes).toEqual([]);
  });

  it("public route는 인증을 요구하지 않고 별도 prefix를 쓴다", () => {
    const publicDataRoutes = ROUTES.filter(
      (route) => route.public && !route.path.includes("/auth/"),
    );
    expect(publicDataRoutes.length).toBeGreaterThan(0);
    for (const route of publicDataRoutes) {
      expect(route.path).toContain("/public/");
      expect(route.mutation).toBe(false);
    }
  });

  it("operationId가 중복되지 않는다", () => {
    const ids = ROUTES.map((route) => route.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("If-Match를 요구하는 route는 mutation이다", () => {
    // 07 §7.1은 versioned resource mutation에 If-Match를 요구한다. 읽기에
    // 요구하면 조회할 때마다 버전을 알아야 하는 모순이 된다.
    const guarded = ROUTES.filter((route) => route.requiresIfMatch);
    expect(guarded.length).toBeGreaterThan(0);
    for (const route of guarded) {
      expect(route.mutation, route.operationId).toBe(true);
    }
  });

  it("버전이 올라가는 mutation은 If-Match를 요구한다", () => {
    // 기존 resource의 version을 바꾸는 route 목록이다. 여기 있는데 계약이
    // false면 나중 요청이 앞의 판단을 조용히 덮는다.
    //
    // 새로 만들기만 하는 route(create)는 대상이 아니다. 덮어쓸 이전 상태가 없다.
    // attestation 서명은 evidence snapshot 해시 비교가 같은 일을 한다 —
    // 서명 요청 이후 근거가 바뀌면 EVIDENCE_SNAPSHOT_CHANGED로 거절된다.
    const versionMutating = ["createClaimConflict", "revokeRegistryVersion"];

    for (const operationId of versionMutating) {
      const route = ROUTES.find((candidate) => candidate.operationId === operationId);
      expect(route, operationId).toBeDefined();
      expect(route!.requiresIfMatch, operationId).toBe(true);
    }
  });

  it("모든 mutation은 최소한 Idempotency-Key를 요구한다", () => {
    const mutations = ROUTES.filter((route) => route.mutation);
    expect(mutations.length).toBeGreaterThan(0);
    // If-Match가 없는 동안에도 재시도 안전성은 idempotency key가 담보한다.
    for (const route of mutations) {
      expect(route.action, route.operationId).not.toBeNull();
    }
  });
});

describe("authorization — 02 §2.1의 7개 조건", () => {
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

  it("모든 조건이 충족되면 허용한다", () => {
    expect(authorize(ACTION_POLICIES["gate.decide"]!, ACTOR, RESOURCE).allow).toBe(true);
  });

  it("역할이 맞지 않으면 필요한 역할과 요청 경로를 반환한다", () => {
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

  it("assurance level이 부족하면 거절하고 필요한 수준을 반환한다", () => {
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

  it("cross-tenant는 거절한다", () => {
    const decision = authorize(ACTION_POLICIES["gate.decide"]!, ACTOR, {
      ...RESOURCE,
      tenantId: "tenant-b",
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toBe("TENANT_SCOPE_MISMATCH");
  });

  it("scope 밖 프로젝트는 거절하고 access request 경로를 준다", () => {
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
   * 거절이 가리키는 경로는 세 개뿐이고, 각각에 화면이 있어야 한다
   * (`apps/web/e2e/access-request-paths.spec.ts`). 네 번째를 늘리면 여기가 깨진다 —
   * 화면 없는 경로를 안내하면 사용자가 404를 만난다.
   */
  it("access request 경로는 화면이 있는 셋뿐이다 (§11.7)", () => {
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

  it("민감도 clearance가 부족하면 거절한다", () => {
    const decision = authorize(ACTION_POLICIES["gate.decide"]!, ACTOR, {
      ...RESOURCE,
      sensitivity: "confidential",
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toBe("SENSITIVITY_CLEARANCE_INSUFFICIENT");
  });

  it("resource state가 허용하지 않으면 거절한다", () => {
    const decision = authorize(ACTION_POLICIES["gate.decide"]!, ACTOR, {
      ...RESOURCE,
      state: "suspended",
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toBe("RESOURCE_STATE_FORBIDS_ACTION");
  });

  it("미해결 이해상충은 거절한다", () => {
    const decision = authorize(
      ACTION_POLICIES["gate.decide"]!,
      { ...ACTOR, conflictStatus: "unresolved" },
      RESOURCE,
    );
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toBe("CONFLICT_OR_SEPARATION_VIOLATION");
  });

  it("readiness override action이 정책표에 없다", () => {
    expect(ACTION_POLICIES["readiness.override"]).toBeUndefined();
  });
});

describe("assurance level — OD-04", () => {
  it("reviewer 역할은 wallet만으로 부여되지 않는다", () => {
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

  it("public reader와 governance 참여는 wallet만으로 가능하다", () => {
    for (const role of ["public_reader", "protocol_voter", "project_voter"]) {
      expect(satisfiesAssurance("wallet_only", ROLE_MINIMUM_ASSURANCE[role]!)).toBe(true);
    }
  });
});

describe("AC-22 — public projection은 allowlist 밖 필드를 거절한다", () => {
  const VALID = {
    stableId: "SYNTH-PROJECT-001",
    status: "registered",
    version: "1",
    asOf: "2026-08-01T00:00:00Z",
    sourceAge: "12",
    staleStatus: "fresh",
    limitations: ["법률 권리 확인은 이 검토 범위 밖이다"],
    legalEffect: "none" as const,
    disclaimerCodes: ["VERIFICATION_IS_NOT_GUARANTEE"],
  };

  it("allowlist 필드만 있으면 통과한다", () => {
    expect(publicProjection.safeParse(VALID).success).toBe(true);
  });

  it("원문 응답 필드가 섞이면 거절한다", () => {
    const result = publicProjection.safeParse({ ...VALID, rawSourceResponse: "{...}" });
    expect(result.success).toBe(false);
  });

  it("자연인 식별자 필드가 섞이면 거절한다", () => {
    expect(publicProjection.safeParse({ ...VALID, personalIdentifier: "홍길동" }).success).toBe(
      false,
    );
    expect(publicProjection.safeParse({ ...VALID, reviewerLegalName: "홍길동" }).success).toBe(
      false,
    );
  });

  it("좌표·계약 본문이 섞이면 거절한다", () => {
    expect(
      publicProjection.safeParse({ ...VALID, preciseGeologicalCoordinates: [1, 2] }).success,
    ).toBe(false);
    expect(publicProjection.safeParse({ ...VALID, contractBody: "..." }).success).toBe(false);
  });

  it("limitations와 legalEffect는 필수다", () => {
    const { limitations, ...withoutLimitations } = VALID;
    expect(publicProjection.safeParse(withoutLimitations).success).toBe(false);
    const { legalEffect, ...withoutLegalEffect } = VALID;
    expect(publicProjection.safeParse(withoutLegalEffect).success).toBe(false);
  });

  it("legalEffect는 none 또는 counsel_required만 가능하다", () => {
    expect(publicProjection.safeParse({ ...VALID, legalEffect: "valid" }).success).toBe(false);
    expect(
      publicProjection.safeParse({ ...VALID, legalEffect: "counsel_required" }).success,
    ).toBe(true);
  });
});

describe("AC-23 — inclusion proof는 무엇을 증명하지 않는지 함께 반환한다", () => {
  it("proves와 doesNotProve가 응답 스키마에 있다", () => {
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

  it("규격 버전 셋이 필수다", () => {
    // 셋이 없으면 검증자가 leaf를 **어떤 규격으로** 다시 만들어야 하는지 모른다.
    // 선택 항목으로 두면 어느 배포에서는 빠지고, 빠진 응답도 계약을 지킨 것이 된다.
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

  it("serializationVersion은 \"1\"에 고정되지 않는다", () => {
    // 규격을 올리면 값이 바뀐다(CLAUDE.md). 계약이 "1"을 강제하면 그날 응답이
    // 계약을 위반한다.
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

  it("doesNotProve에 사실성·법률 효력·투자 적합성이 명시된다", () => {
    const joined = PROOF_DOES_NOT_PROVE.join(" ");
    expect(joined).toContain("사실성");
    expect(joined).toContain("법률 효력");
    expect(joined).toContain("투자 적합성");
  });

  it("included가 boolean이고 verified 같은 이름을 쓰지 않는다", () => {
    const keys = Object.keys(inclusionProofResponse.shape);
    expect(keys).toContain("included");
    expect(keys).not.toContain("verified");
    expect(keys).not.toContain("valid");
  });
});

describe("AC-01 — limitations 없는 attestation 요청을 거절한다", () => {
  it("빈 문자열을 거절한다", () => {
    const result = createAttestationRequest.safeParse({
      caseId: "case-1",
      assignmentId: "assign-1",
      attestationType: "professional_signoff",
      claimScope: ["claim-1"],
      limitations: "",
    });
    expect(result.success).toBe(false);
  });

  it("claim scope가 비면 거절한다", () => {
    const result = createAttestationRequest.safeParse({
      caseId: "case-1",
      assignmentId: "assign-1",
      attestationType: "professional_signoff",
      claimScope: [],
      limitations: "범위 제한",
    });
    expect(result.success).toBe(false);
  });
});

describe("gate decision 요청", () => {
  it("rationale 없이는 결정을 기록할 수 없다", () => {
    const result = createGateDecisionRequest.safeParse({
      gateId: "registry_publication",
      decision: "go",
      inputAssessmentId: "assessment-1",
      rationale: "",
    });
    expect(result.success).toBe(false);
  });

  it("결정은 4개 중 하나여야 한다", () => {
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
  it("12개 result를 그대로 받는다", () => {
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

  it("별칭을 거절한다", () => {
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
  it("retryable이 필수다 — 클라이언트가 재시도 여부를 추측하면 안 된다", () => {
    expect(
      errorEnvelope.safeParse({
        code: "SOURCE_UNAVAILABLE",
        message: "현재 출처 확인 불가",
        correlationId: "corr-1",
      }).success,
    ).toBe(false);

    expect(
      errorEnvelope.safeParse({
        code: "SOURCE_UNAVAILABLE",
        message: "현재 출처 확인 불가",
        retryable: true,
        correlationId: "corr-1",
      }).success,
    ).toBe(true);
  });
});

/**
 * 투표 요청 — 04 §4.5.
 *
 * 온체인 스냅숏이 있는 제안에서는 서버가 무게를 정한다. 계약이 무게를 필수로
 * 두면 클라이언트는 무시될 값을 지어내야 하고, 그 값이 반영된다고 읽는다.
 */
describe("castVoteRequest", () => {
  it("무게 없이 던질 수 있다 — 스냅숏이 있으면 서버가 정한다", () => {
    expect(castVoteRequest.safeParse({ choice: "for" }).success).toBe(true);
  });

  it("무게를 보내면 형식을 검사한다", () => {
    expect(castVoteRequest.safeParse({ choice: "for", weight: "-1" }).success).toBe(false);
    expect(castVoteRequest.safeParse({ choice: "for", weight: "100" }).success).toBe(true);
  });
});

/**
 * 정족수의 분모 — 09 §9.6.
 *
 * 0을 받으면 `참여 × D >= 0 × N`이 항상 참이라 분모를 두고도 정족수가 통과만
 * 한다.
 */
describe("createProposalRequest", () => {
  const base = {
    space: "protocol",
    proposalType: "fee_schedule",
    title: "수수료 변경",
    rationale: "현행 수수료가 운영 비용을 담지 못한다",
  };

  it("정족수의 분모로 0을 받지 않는다", () => {
    expect(createProposalRequest.safeParse({ ...base, eligibleWeight: "0" }).success).toBe(false);
  });

  it("분모 없이도 제안은 만들 수 있다 — 투표를 열 때 막힌다", () => {
    expect(createProposalRequest.safeParse(base).success).toBe(true);
  });
});
