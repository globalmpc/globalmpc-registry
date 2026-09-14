import { describe, expect, it } from "vitest";
import { ACTION_POLICIES, type ResourceContext } from "@mpc/api-contract";
import { AppError } from "../src/errors.js";
import {
  assertAuthorized,
  bindingToAuthorizationContext,
  sessionFacts,
  visibleProjectScope,
} from "../src/plugins/authorize.js";
import type { Session } from "../src/plugins/session.js";

const WALLET_ONLY: Session = {
  walletAddress: `0x${"ab".repeat(20)}`,
  chainId: 97,
  subjectId: "subject-reader",
  tenantId: "tenant-a",
  assuranceLevel: "wallet_only",
  roleBindings: [],
  projectIds: [],
};

const GATE_APPROVER: Session = {
  ...WALLET_ONLY,
  subjectId: "subject-approver",
  assuranceLevel: "high_assurance",
  roleBindings: [{ role: "gate_approver", organizationId: "org-1", projectId: "project-1" }],
  projectIds: ["project-1"],
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

const FACTS = {
  sensitivityClearance: ["public", "restricted"],
  hasRequiredCredential: true,
  hasRequiredAssignment: true,
  conflictStatus: "none",
} as const;

function denialOf(fn: () => void): AppError {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("거절되지 않았다");
}

describe("assertAuthorized", () => {
  it("권한이 있으면 통과한다", () => {
    expect(() => assertAuthorized(GATE_APPROVER, "gate.decide", RESOURCE, FACTS)).not.toThrow();
  });

  it("역할이 없으면 403과 필요한 역할을 반환한다", () => {
    const error = denialOf(() =>
      assertAuthorized(WALLET_ONLY, "gate.decide", RESOURCE, FACTS),
    );
    expect(error.statusCode).toBe(403);
    expect(error.code).toBe("AUTHORIZATION_DENIED");
    expect(error.details?.["reason"]).toBe("ROLE_ACTION_NOT_ALLOWED");
    expect(error.details?.["requiredRoles"]).toContain("gate_approver");
    expect(error.details?.["accessRequestPath"]).toContain("project-1");
  });

  it("assurance level이 부족하면 필요한 수준을 반환한다", () => {
    const lowAssurance: Session = { ...GATE_APPROVER, assuranceLevel: "wallet_only" };
    const error = denialOf(() =>
      assertAuthorized(lowAssurance, "gate.decide", RESOURCE, FACTS),
    );
    expect(error.details?.["reason"]).toBe("ASSURANCE_LEVEL_INSUFFICIENT");
    expect(error.details?.["requiredAssurance"]).toBe("high_assurance");
  });

  it("cross-tenant를 거절한다", () => {
    const error = denialOf(() =>
      assertAuthorized(GATE_APPROVER, "gate.decide", { ...RESOURCE, tenantId: "tenant-b" }, FACTS),
    );
    expect(error.details?.["reason"]).toBe("TENANT_SCOPE_MISMATCH");
  });

  it("scope 밖 프로젝트를 거절하고 요청 경로를 준다", () => {
    const error = denialOf(() =>
      assertAuthorized(GATE_APPROVER, "gate.decide", { ...RESOURCE, projectId: "project-9" }, FACTS),
    );
    expect(error.details?.["reason"]).toBe("PROJECT_SCOPE_MISMATCH");
    expect(error.details?.["accessRequestPath"]).toContain("project-9");
  });

  it("민감도 clearance가 부족하면 거절한다", () => {
    const error = denialOf(() =>
      assertAuthorized(GATE_APPROVER, "gate.decide", { ...RESOURCE, sensitivity: "confidential" }, FACTS),
    );
    expect(error.details?.["reason"]).toBe("SENSITIVITY_CLEARANCE_INSUFFICIENT");
  });

  it("resource state가 허용하지 않으면 거절한다", () => {
    const error = denialOf(() =>
      assertAuthorized(GATE_APPROVER, "gate.decide", { ...RESOURCE, state: "suspended" }, FACTS),
    );
    expect(error.details?.["reason"]).toBe("RESOURCE_STATE_FORBIDS_ACTION");
  });

  it("미해결 이해상충을 거절한다", () => {
    const error = denialOf(() =>
      assertAuthorized(GATE_APPROVER, "gate.decide", RESOURCE, {
        ...FACTS,
        conflictStatus: "unresolved",
      }),
    );
    expect(error.details?.["reason"]).toBe("CONFLICT_OR_SEPARATION_VIOLATION");
  });

  it("알 수 없는 action은 400이다 — 조용히 허용하지 않는다", () => {
    const error = denialOf(() =>
      assertAuthorized(GATE_APPROVER, "readiness.override", RESOURCE, FACTS),
    );
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe("ACTION_UNKNOWN");
  });

  it("readiness override action이 정책표에 없다", () => {
    expect(ACTION_POLICIES["readiness.override"]).toBeUndefined();
  });

  it("여러 역할 중 하나라도 통과하면 허용한다", () => {
    const multiRole: Session = {
      ...GATE_APPROVER,
      roleBindings: [
        { role: "auditor", organizationId: null, projectId: null },
        { role: "gate_approver", organizationId: "org-1", projectId: "project-1" },
      ],
    };
    expect(() => assertAuthorized(multiRole, "gate.decide", RESOURCE, FACTS)).not.toThrow();
  });
});

describe("bindingToAuthorizationContext", () => {
  it("프로젝트 바인딩은 그 프로젝트만 범위로 갖는다", () => {
    const context = bindingToAuthorizationContext(
      GATE_APPROVER,
      { role: "gate_approver", organizationId: "org-1", projectId: "project-1" },
      FACTS,
    );
    expect(context.role).toBe("gate_approver");
    expect(context.actorProjectIds).toEqual(["project-1"]);
    expect(context.actorTenantId).toBe("tenant-a");
  });

  it("조직 바인딩은 프로젝트 제한이 없다", () => {
    const context = bindingToAuthorizationContext(
      GATE_APPROVER,
      { role: "gate_approver", organizationId: "org-1", projectId: null },
      FACTS,
    );
    expect(context.actorProjectIds).toBe("all");
  });

  it("tenant가 없으면 빈 문자열로 둔다 — 어떤 리소스와도 매칭되지 않는다", () => {
    const context = bindingToAuthorizationContext(
      { ...WALLET_ONLY, tenantId: null },
      { role: "public_reader", organizationId: null, projectId: null },
      FACTS,
    );
    expect(context.actorTenantId).toBe("");
  });
});

describe("역할 바인딩 단위 project scope", () => {
  it("다른 역할의 조직 바인딩이 프로젝트 바인딩의 범위를 넓히지 않는다", () => {
    /**
     * 조직 수준 `auditor`와 프로젝트 수준 `gate_approver`를 동시에 가진 세션이다.
     * 역할 이름만 모아 판정하면 auditor의 무제한 범위가 gate_approver에게도
     * 적용되어 범위 밖 프로젝트의 게이트를 결정하게 된다.
     */
    const mixed: Session = {
      ...GATE_APPROVER,
      roleBindings: [
        { role: "auditor", organizationId: "org-1", projectId: null },
        { role: "gate_approver", organizationId: "org-1", projectId: "project-1" },
      ],
    };

    const error = denialOf(() =>
      assertAuthorized(mixed, "gate.decide", { ...RESOURCE, projectId: "project-9" }, FACTS),
    );
    expect(error.details?.["reason"]).toBe("PROJECT_SCOPE_MISMATCH");
  });
});

describe("sessionFacts", () => {
  it("clearance를 assurance level에서 끌어온다", () => {
    expect(sessionFacts(WALLET_ONLY).sensitivityClearance).toEqual(["public"]);
    expect(sessionFacts(GATE_APPROVER).sensitivityClearance).toEqual(["public", "restricted"]);
  });

  it("credential·assignment는 기본이 미충족이다 — 요구되면 라우트가 채워야 한다", () => {
    const facts = sessionFacts(GATE_APPROVER);
    expect(facts.hasRequiredCredential).toBe(false);
    expect(facts.hasRequiredAssignment).toBe(false);
  });

  it("리소스가 credential을 요구하는데 사실이 없으면 거절한다", () => {
    const error = denialOf(() =>
      assertAuthorized(
        GATE_APPROVER,
        "gate.decide",
        { ...RESOURCE, requiresCredential: true },
        sessionFacts(GATE_APPROVER),
      ),
    );
    expect(error.details?.["reason"]).toBe("CREDENTIAL_OR_ASSIGNMENT_INVALID");
  });
});

describe("조직 수준 바인딩의 범위", () => {
  const STEWARD_ORG: Session = {
    ...WALLET_ONLY,
    assuranceLevel: "identity_bound",
    roleBindings: [{ role: "data_steward", organizationId: "org-1", projectId: null }],
    organizationProjectIds: { "org-1": ["project-1"], "org-2": ["project-2"] },
  };

  it("프로젝트 당사자 역할은 자기 조직이 소유한 프로젝트에만 닿는다", () => {
    const context = bindingToAuthorizationContext(
      STEWARD_ORG,
      STEWARD_ORG.roleBindings[0]!,
      FACTS,
    );
    expect(context.actorProjectIds).toEqual(["project-1"]);
    expect(visibleProjectScope(STEWARD_ORG, "project.read")).toEqual(["project-1"]);
  });

  it("조직이 없는 당사자 바인딩은 아무 프로젝트에도 닿지 않는다", () => {
    const session: Session = {
      ...STEWARD_ORG,
      roleBindings: [{ role: "data_steward", organizationId: null, projectId: null }],
    };
    expect(visibleProjectScope(session, "project.read")).toEqual([]);
  });

  it("tenant 운영 역할은 조직과 무관하게 tenant 전체다", () => {
    const session: Session = {
      ...STEWARD_ORG,
      assuranceLevel: "high_assurance",
      roleBindings: [{ role: "mpc_operator", organizationId: "org-1", projectId: null }],
    };
    expect(visibleProjectScope(session, "project.read")).toBe("all");
  });
});

describe("visibleProjectScope", () => {
  it("프로젝트 바인딩만 있으면 그 목록이다", () => {
    expect(visibleProjectScope(GATE_APPROVER, "project.read")).toEqual(["project-1"]);
    expect(
      visibleProjectScope(
        { ...GATE_APPROVER, roleBindings: [{ role: "auditor", organizationId: null, projectId: "p1" }] },
        "project.read",
      ),
    ).toEqual(["p1"]);
  });

  it("조직 바인딩이 하나라도 있으면 제한이 없다", () => {
    expect(
      visibleProjectScope(
        { ...GATE_APPROVER, roleBindings: [{ role: "auditor", organizationId: "org-1", projectId: null }] },
        "project.read",
      ),
    ).toBe("all");
  });

  it("읽기 권한이 없는 역할은 아무 프로젝트도 보지 못한다", () => {
    expect(visibleProjectScope(WALLET_ONLY, "project.read")).toEqual([]);
  });
});

/**
 * 통과시킨 역할을 돌려준다 — 02 §2.7.
 *
 * 감사 기록의 `effective_role`은 "이 사람이 가진 첫 역할"이 아니라 "이 행위를
 * 허용한 역할"이어야 한다. 둘이 다르면 사후에 권한 판단을 재현할 수 없다.
 */
describe("통과시킨 역할", () => {
  it("첫 바인딩이 아니라 허용한 바인딩의 역할을 반환한다", () => {
    const multiRole: Session = {
      ...GATE_APPROVER,
      roleBindings: [
        { role: "auditor", organizationId: null, projectId: null },
        { role: "gate_approver", organizationId: "org-1", projectId: "project-1" },
      ],
    };
    expect(assertAuthorized(multiRole, "gate.decide", RESOURCE, FACTS)).toBe("gate_approver");
  });

  it("첫 바인딩이 통과하면 그것을 반환한다", () => {
    expect(assertAuthorized(GATE_APPROVER, "gate.decide", RESOURCE, FACTS)).toBe("gate_approver");
  });

  /**
   * 같은 역할이라도 통과한 바인딩이 어느 것인지가 다르다. 조직 바인딩으로
   * 통과한 것과 프로젝트 바인딩으로 통과한 것은 권한 범위가 다르므로, 기록이
   * 둘을 구분하지 못하면 사후 재현이 거기서 멈춘다.
   */
  it("scope 밖 바인딩을 건너뛰고 통과한 것을 반환한다", () => {
    const scoped: Session = {
      ...GATE_APPROVER,
      roleBindings: [
        { role: "gate_approver", organizationId: null, projectId: "other-project" },
        { role: "gate_approver", organizationId: "org-1", projectId: "project-1" },
      ],
    };
    expect(assertAuthorized(scoped, "gate.decide", RESOURCE, FACTS)).toBe("gate_approver");
  });
});
