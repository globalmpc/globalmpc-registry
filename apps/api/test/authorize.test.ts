import { authorizedProjectLookup } from "../src/services/authorized-project-lookup.js";
import { describe, expect, it } from "vitest";
import { ACTION_POLICIES, type ResourceContext } from "@mpc/api-contract";
import { AppError, RegistrySubjectNotFoundError } from "../src/errors.js";
import {
  canActForOrganization,
  assertAuthorized,
  bindingToAuthorizationContext,
  sessionFacts,
  visibleProjectScope,
  holdsActionRole,
} from "../src/plugins/authorize.js";
import type { Session } from "../src/plugins/session.js";

const WALLET_ONLY: Session = {
  principal: "person",
  sessionId: "session-1",
  firstFactor: "email_code",
  secondFactor: "passkey",
  recoveryLimited: false,
  aal: "aal3",
  narrowedRoles: [],
  subjectId: "subject-reader",
  assuranceLevel: "wallet_only",
  roleBindings: [],
  projectIds: [],
};

const GATE_APPROVER: Session = {
  ...WALLET_ONLY,
  subjectId: "subject-approver",
  assuranceLevel: "high_assurance",
  roleBindings: [{ role: "reviewer", scopeKind: "organization", organizationId: "org-1", projectId: "project-1" }],
  projectIds: ["project-1"],
};

const RESOURCE: ResourceContext = {
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
  throw new Error("was not denied");
}

describe("assertAuthorized", () => {
  it("requires organisation-wide authority to register another project", () => {
    const binding = { role: "project_member", organizationId: "org-1", projectId: "project-1" };
    const allowed = (projectId: string | null) => canActForOrganization(
      { ...GATE_APPROVER, roleBindings: [{ ...binding, projectId }] }, "project.create", "org-1");
    expect(allowed(binding.projectId)).toBe(false);
    expect(allowed(null)).toBe(true);
  });

  it("does not turn project-scoped administration or review into Registry-wide authority", () => {
    const registryResource = { ...RESOURCE, projectId: null };
    for (const [role, action] of [["administrator", "admin.role.approve"], ["administrator", "audit.export"], ["reviewer", "review_registry.approve"], ["reviewer", "authority.review"], ["administrator", "registry.draft"], ["administrator", "registry.revoke"], ["reviewer", "registry.publish"], ["administrator", "anchor.submit"], ["reviewer", "anchor.read"]] as const) {
      const scoped: Session = { ...GATE_APPROVER, roleBindings: [{ role, scopeKind: "organization", organizationId: "org-1", projectId: "project-1" }] };
      expect(denialOf(() => assertAuthorized(scoped, action, registryResource, FACTS)).statusCode).toBe(403);
      const registryWide: Session = { ...scoped, roleBindings: [{ role, scopeKind: "registry", organizationId: "org-1", projectId: null }] };
      expect(() => assertAuthorized(registryWide, action, registryResource, FACTS)).not.toThrow();
    }
  });

  it("requires one unrestricted Registry-wide binding for mixed-project operations and their UI action", () => {
    const scoped:Session={...GATE_APPROVER,roleBindings:[{role:"administrator",scopeKind:"organization",organizationId:"org-1",projectId:"project-1"}]};
    expect(holdsActionRole(scoped,"anchor.submit")).toBe(false);
    expect(holdsActionRole(scoped,"anchor.read")).toBe(false);
    expect(denialOf(()=>assertAuthorized(scoped,"anchor.submit",RESOURCE,FACTS)).statusCode).toBe(403);
    const regional:Session={...scoped,roleBindings:[{role:"administrator",scopeKind:"registry",organizationId:"org-1",projectId:null,jurisdiction:["MNG"]}],projectJurisdictions:{"project-1":"MNG"}};
    expect(holdsActionRole(regional,"anchor.submit")).toBe(false);
    const mixed:Session={...regional,roleBindings:[...regional.roleBindings,...scoped.roleBindings]};
    expect(holdsActionRole(mixed,"anchor.submit")).toBe(false);
    expect(denialOf(()=>assertAuthorized(mixed,"anchor.submit",RESOURCE,FACTS)).statusCode).toBe(403);
    expect(denialOf(()=>assertAuthorized(regional,"anchor.submit",RESOURCE,FACTS)).statusCode).toBe(403);
    expect(denialOf(()=>assertAuthorized(scoped,"registry.read",{...RESOURCE,projectId:null,requiresRegistryScope:true},FACTS)).statusCode).toBe(403);
    expect(()=>assertAuthorized(scoped,"registry.draft",RESOURCE,FACTS)).not.toThrow();
  });

  it("passes when the permission is held", () => {
    expect(() => assertAuthorized(GATE_APPROVER, "gate.decide", RESOURCE, FACTS)).not.toThrow();
  });

  it("returns 403 and the required roles when the role is missing", () => {
    const error = denialOf(() =>
      assertAuthorized(WALLET_ONLY, "gate.decide", RESOURCE, FACTS),
    );
    expect(error.statusCode).toBe(403);
    expect(error.code).toBe("AUTHORIZATION_DENIED");
    expect(error.details?.["reason"]).toBe("ROLE_ACTION_NOT_ALLOWED");
    expect(error.details?.["requiredRoles"]).toContain("reviewer");
    expect(error.details?.["accessRequestPath"]).toContain("project-1");
  });

  it("returns the required level when the assurance level is insufficient", () => {
    const lowAssurance: Session = { ...GATE_APPROVER, assuranceLevel: "wallet_only" };
    const error = denialOf(() =>
      assertAuthorized(lowAssurance, "gate.decide", RESOURCE, FACTS),
    );
    expect(error.details?.["reason"]).toBe("ASSURANCE_LEVEL_INSUFFICIENT");
    expect(error.details?.["requiredAssurance"]).toBe("high_assurance");
  });

  it("rejects an out-of-scope project and returns the access request path", () => {
    const error = denialOf(() =>
      assertAuthorized(GATE_APPROVER, "gate.decide", { ...RESOURCE, projectId: "project-9" }, FACTS),
    );
    expect(error.details?.["reason"]).toBe("PROJECT_SCOPE_MISMATCH");
    expect(error.details?.["accessRequestPath"]).toContain("project-9");
  });

  it("rejects when sensitivity clearance is insufficient", () => {
    const error = denialOf(() =>
      assertAuthorized(GATE_APPROVER, "gate.decide", { ...RESOURCE, sensitivity: "confidential" }, FACTS),
    );
    expect(error.details?.["reason"]).toBe("SENSITIVITY_CLEARANCE_INSUFFICIENT");
  });

  it("rejects when the resource state does not allow the action", () => {
    const error = denialOf(() =>
      assertAuthorized(GATE_APPROVER, "gate.decide", { ...RESOURCE, state: "suspended" }, FACTS),
    );
    expect(error.details?.["reason"]).toBe("RESOURCE_STATE_FORBIDS_ACTION");
  });

  it("rejects an unresolved conflict of interest", () => {
    const error = denialOf(() =>
      assertAuthorized(GATE_APPROVER, "gate.decide", RESOURCE, {
        ...FACTS,
        conflictStatus: "unresolved",
      }),
    );
    expect(error.details?.["reason"]).toBe("CONFLICT_OR_SEPARATION_VIOLATION");
  });

  it("returns 400 for an unknown action — does not silently allow it", () => {
    const error = denialOf(() =>
      assertAuthorized(GATE_APPROVER, "readiness.override", RESOURCE, FACTS),
    );
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe("ACTION_UNKNOWN");
  });

  it("has no readiness override action in the policy table", () => {
    expect(ACTION_POLICIES["readiness.override"]).toBeUndefined();
  });

  it("allows when any one of several roles passes", () => {
    const multiRole: Session = {
      ...GATE_APPROVER,
      roleBindings: [
        { role: "administrator", organizationId: null, projectId: null },
        { role: "reviewer", scopeKind: "organization", organizationId: "org-1", projectId: "project-1" },
      ],
    };
    expect(() => assertAuthorized(multiRole, "gate.decide", RESOURCE, FACTS)).not.toThrow();
  });
});

describe("bindingToAuthorizationContext", () => {
  it("scopes a project binding to that project only", () => {
    const context = bindingToAuthorizationContext(
      GATE_APPROVER,
      { role: "reviewer", scopeKind: "organization", organizationId: "org-1", projectId: "project-1" },
      FACTS,
    );
    expect(context.role).toBe("reviewer");
    expect(context.actorProjectIds).toEqual(["project-1"]);
  });

  it("gives an organization binding no project restriction", () => {
    const context = bindingToAuthorizationContext(
      GATE_APPROVER,
      { role: "reviewer", scopeKind: "registry", organizationId: "org-1", projectId: null },
      FACTS,
    );
    expect(context.actorProjectIds).toBe("all");
  });
});

describe("project scope per role binding", () => {
  it("does not let another role's organization binding widen a project binding's scope", () => {
    /**
     * A session holding both an organization-level `administrator` and a project-level
     * `reviewer`. Judging on role names alone would apply administrator's unrestricted scope
     * to reviewer too, letting it decide gates on out-of-scope projects.
     */
    const mixed: Session = {
      ...GATE_APPROVER,
      roleBindings: [
        { role: "administrator", organizationId: "org-1", projectId: null },
        { role: "reviewer", scopeKind: "organization", organizationId: "org-1", projectId: "project-1" },
      ],
    };

    const error = denialOf(() =>
      assertAuthorized(mixed, "gate.decide", { ...RESOURCE, projectId: "project-9" }, FACTS),
    );
    expect(error.details?.["reason"]).toBe("PROJECT_SCOPE_MISMATCH");
  });
});

describe("sessionFacts", () => {
  it("derives clearance from the assurance level", () => {
    expect(sessionFacts(WALLET_ONLY).sensitivityClearance).toEqual(["public"]);
    expect(sessionFacts(GATE_APPROVER).sensitivityClearance).toEqual(["public", "restricted"]);
  });

  it("defaults credential and assignment to unmet — the route must fill them when required", () => {
    const facts = sessionFacts(GATE_APPROVER);
    expect(facts.hasRequiredCredential).toBe(false);
    expect(facts.hasRequiredAssignment).toBe(false);
  });

  it("rejects when the resource requires a credential and the fact is absent", () => {
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

describe("scope of organization-level bindings", () => {
  const STEWARD_ORG: Session = {
    ...WALLET_ONLY,
    assuranceLevel: "high_assurance",
    roleBindings: [{ role: "reviewer", scopeKind: "organization", organizationId: "org-1", projectId: null }],
    organizationProjectIds: { "org-1": ["project-1"], "org-2": ["project-2"] },
  };

  it("limits a project-party role to projects its own organization owns", () => {
    const context = bindingToAuthorizationContext(
      STEWARD_ORG,
      STEWARD_ORG.roleBindings[0]!,
      FACTS,
    );
    expect(context.actorProjectIds).toEqual(["project-1"]);
    expect(visibleProjectScope(STEWARD_ORG, "project.read")).toEqual(["project-1"]);
  });

  it("gives a project-party binding without an organization no projects", () => {
    const session: Session = {
      ...STEWARD_ORG,
      roleBindings: [{ role: "reviewer", scopeKind: "organization", organizationId: null, projectId: null }],
    };
    expect(visibleProjectScope(session, "project.read")).toEqual([]);
  });

  it("gives Registry-wide operator roles every project regardless of organization", () => {
    const session: Session = {
      ...STEWARD_ORG,
      assuranceLevel: "high_assurance",
      roleBindings: [{ role: "administrator", organizationId: "org-1", projectId: null }],
    };
    expect(visibleProjectScope(session, "project.read")).toBe("all");
  });
});

describe("visibleProjectScope", () => {
  it("returns the project list when only project bindings exist", () => {
    expect(visibleProjectScope(GATE_APPROVER, "project.read")).toEqual(["project-1"]);
    expect(
      visibleProjectScope(
        { ...GATE_APPROVER, roleBindings: [{ role: "administrator", organizationId: null, projectId: "p1" }] },
        "project.read",
      ),
    ).toEqual(["p1"]);
  });

  it("is unrestricted when any organization binding exists", () => {
    expect(
      visibleProjectScope(
        { ...GATE_APPROVER, roleBindings: [{ role: "administrator", organizationId: "org-1", projectId: null }] },
        "project.read",
      ),
    ).toBe("all");
  });

  it("shows no projects to a role without read permission", () => {
    expect(visibleProjectScope(WALLET_ONLY, "project.read")).toEqual([]);
  });
});

/**
 * Returns the role that granted access — 02 §2.7.
 *
 * The audit record's `effective_role` must be "the role that allowed this action", not "the
 * first role this person holds". If the two differ, the authorization decision cannot be
 * reproduced afterwards.
 */
describe("granting role", () => {
  it("returns the role of the allowing binding, not the first binding", () => {
    const multiRole: Session = {
      ...GATE_APPROVER,
      roleBindings: [
        { role: "administrator", organizationId: null, projectId: null },
        { role: "reviewer", scopeKind: "organization", organizationId: "org-1", projectId: "project-1" },
      ],
    };
    expect(assertAuthorized(multiRole, "gate.decide", RESOURCE, FACTS)).toBe("reviewer");
  });

  it("returns the first binding when it passes", () => {
    expect(assertAuthorized(GATE_APPROVER, "gate.decide", RESOURCE, FACTS)).toBe("reviewer");
  });

  /**
   * Even for the same role, which binding passed matters. Passing via an organization binding
   * and via a project binding carry different authority scopes; if the record cannot tell them
   * apart, reproduction stops there.
   */
  it("skips an out-of-scope binding and returns the one that passed", () => {
    const scoped: Session = {
      ...GATE_APPROVER,
      roleBindings: [
        { role: "reviewer", scopeKind: "organization", organizationId: null, projectId: "other-project" },
        { role: "reviewer", scopeKind: "organization", organizationId: "org-1", projectId: "project-1" },
      ],
    };
    expect(assertAuthorized(scoped, "gate.decide", RESOURCE, FACTS)).toBe("reviewer");
  });
});

describe("authorization before object lookup", () => {
  it("preserves identity assurance and sign-in step-up guidance without reading a target", async () => {
    const cases: {session: Session; details: Record<string,unknown>}[] = [
      {session:{...GATE_APPROVER,assuranceLevel:"wallet_only"},details:{reason:"ASSURANCE_LEVEL_INSUFFICIENT",requiredAssurance:"high_assurance"}},
      {session:{...GATE_APPROVER,roleBindings:[],narrowedRoles:[{role:"reviewer",requiredAal:"aal3"}]},details:{reason:"AUTHENTICATION_LEVEL_INSUFFICIENT",requiredAal:"aal3"}},
    ];
    for (const item of cases) {
      let reads=0;
      await expect(authorizedProjectLookup(item.session,"registry.publish",async()=>{reads++;return "project-1";},id=>id))
        .rejects.toMatchObject({statusCode:403,code:"AUTHORIZATION_DENIED",details:item.details});
      expect(reads).toBe(0);
    }
  });
});

 it("masks only lookup absence, preserving domain errors instead of suggesting new access", async () => {
  for (const error of [new AppError("NOT_FOUND", "missing", 404, false), new RegistrySubjectNotFoundError()]) {
    await expect(authorizedProjectLookup(GATE_APPROVER, "registry.publish", async () => { throw error; }, () => "project-1"))
      .rejects.toMatchObject({ code: "AUTHORIZATION_DENIED", statusCode: 403 });
  }
  for (const error of [new AppError("REGISTRY_SUBJECT_NOT_SIGNED", "unsigned", 422, false), new AppError("PUBLICATION_LEDGER_INVALID", "invalid ledger", 422, false)]) {
    await expect(authorizedProjectLookup(GATE_APPROVER, "registry.publish", async () => { throw error; }, () => "project-1"))
      .rejects.toBe(error);
  }
});
