import { describe, expect, it } from "vitest";
import { ROUTES } from "../src/routes.js";
import {
  ACTION_POLICIES,
  BREAK_GLASS_ACTIONS,
  BREAK_GLASS_ROLE,
  TENANT_WIDE_ROLES,
  authorize,
  type AuthorizationContext,
  type ResourceContext,
} from "../src/authorization.js";
import { ROLE_MINIMUM_ASSURANCE } from "../src/auth.js";
import {
  PRIMARY_LAYERS,
  ROUTE_LAYER_RULES,
  layersOf,
  matchesLayerPattern,
} from "../src/layers.js";
import { NINE_STRUCTURES, schemaFields, type StructureLink } from "../src/structures.js";

const ACTOR: AuthorizationContext = {
  role: "reviewer_legal",
  assuranceLevel: "high_assurance",
  actorTenantId: "tenant-a",
  actorProjectIds: "all",
  sensitivityClearance: ["public", "restricted"],
  hasRequiredCredential: true,
  hasRequiredAssignment: true,
  conflictStatus: "none",
};

const RESOURCE: ResourceContext = {
  tenantId: "tenant-a",
  projectId: "project-1",
  sensitivity: "restricted",
  state: "active",
  statesAllowingAction: ["active"],
  requiresCredential: false,
  requiresAssignment: false,
  separationSensitive: false,
};

const POLICY = { action: "verification.read", allowedRoles: ["reviewer_legal"] };

describe("jurisdiction[] condition (02 §2.5)", () => {
  it("allows a scoped binding on a project hosted in its jurisdiction", () => {
    const decision = authorize(
      POLICY,
      { ...ACTOR, jurisdictionScope: ["MNG"] },
      { ...RESOURCE, jurisdiction: "MNG" },
    );
    expect(decision.allow).toBe(true);
  });

  it("denies a scoped binding on a project hosted elsewhere", () => {
    const decision = authorize(
      POLICY,
      { ...ACTOR, jurisdictionScope: ["MNG"] },
      { ...RESOURCE, jurisdiction: "KAZ" },
    );
    expect(decision).toMatchObject({ allow: false, reason: "JURISDICTION_SCOPE_MISMATCH" });
  });

  it("fails closed when the resource's jurisdiction is unknown", () => {
    const unknown = authorize(POLICY, { ...ACTOR, jurisdictionScope: ["MNG"] }, RESOURCE);
    const tenantLevel = authorize(
      POLICY,
      { ...ACTOR, jurisdictionScope: ["MNG"] },
      { ...RESOURCE, projectId: null, jurisdiction: null },
    );
    expect(unknown).toMatchObject({ allow: false, reason: "JURISDICTION_SCOPE_MISMATCH" });
    expect(tenantLevel).toMatchObject({ allow: false, reason: "JURISDICTION_SCOPE_MISMATCH" });
  });

  it("lets a scoped binding read a tenant list only when the list is filtered by scope", () => {
    const list = authorize(
      POLICY,
      { ...ACTOR, jurisdictionScope: ["MNG"] },
      { ...RESOURCE, projectId: null, filteredByProjectScope: true },
    );
    expect(list.allow).toBe(true);
  });

  it("leaves unscoped bindings as they were", () => {
    expect(authorize(POLICY, ACTOR, { ...RESOURCE, jurisdiction: "KAZ" }).allow).toBe(true);
    expect(authorize(POLICY, { ...ACTOR, jurisdictionScope: null }, RESOURCE).allow).toBe(true);
  });
});

describe("break-glass role (02 §2.6)", () => {
  const holding = Object.values(ACTION_POLICIES)
    .filter((policy) => policy.allowedRoles.includes(BREAK_GLASS_ROLE))
    .map((policy) => policy.action)
    .sort();

  it("holds exactly the listed emergency actions", () => {
    expect(holding).toEqual([...BREAK_GLASS_ACTIONS].sort());
  });

  it("emergency actions are held by no standing role", () => {
    for (const action of BREAK_GLASS_ACTIONS) {
      expect(ACTION_POLICIES[action]?.allowedRoles).toEqual([BREAK_GLASS_ROLE]);
    }
  });

  it("cannot touch evidence, readiness, votes, attestations or the Registry", () => {
    const forbidden = holding.filter((action) =>
      /^(source|claim|evidence|readiness|gate|attestation|governance|registry|anchor|authority|review_registry|project\.create)/.test(
        action,
      ),
    );
    expect(forbidden).toEqual([]);
  });

  it("cannot be granted as a standing role and reaches no project", () => {
    // The role grant route refuses roles missing from this table.
    expect(ROLE_MINIMUM_ASSURANCE[BREAK_GLASS_ROLE]).toBeUndefined();
    expect(TENANT_WIDE_ROLES).not.toContain(BREAK_GLASS_ROLE);
  });

  it("elevation is managed by security operators only", () => {
    for (const action of [
      "break_glass.request",
      "break_glass.approve",
      "break_glass.incident",
      "break_glass.release",
    ]) {
      expect(ACTION_POLICIES[action]?.allowedRoles).toEqual(["security_operator"]);
    }
  });
});

describe("connection security review (02 §2.8)", () => {
  it("is a separate action from configuring the connection", () => {
    expect(ACTION_POLICIES["connection.security_review"]?.allowedRoles).toEqual([
      "security_operator",
    ]);
    const route = ROUTES.find((candidate) => candidate.path.endsWith("/security-reviews"));
    expect(route?.action).toBe("connection.security_review");
    // The version reviewed is the version the reviewer read.
    expect(route?.requiresIfMatch).toBe(true);
  });
});

describe("primary layer per route (REQ-DAPP-002)", () => {
  it("every route maps to exactly one of the five layers", () => {
    const wrong = ROUTES.map((route) => ({
      route: `${route.method.toUpperCase()} ${route.path}`,
      layers: layersOf(route),
    })).filter((entry) => entry.layers.length !== 1);
    expect(wrong).toEqual([]);
  });

  it("every rule is used — a stale rule would hide a renamed route", () => {
    const unused = ROUTE_LAYER_RULES.filter(
      (rule) => !ROUTES.some((route) => matchesLayerPattern(rule.pattern, route.path)),
    ).map((rule) => rule.pattern);
    expect(unused).toEqual([]);
  });

  it("all five layers are represented", () => {
    const used = new Set(ROUTES.flatMap((route) => layersOf(route)));
    expect([...used].sort()).toEqual([...PRIMARY_LAYERS].sort());
  });
});

describe("nine structures — ID · version · status · event linkage (13 §13.13)", () => {
  it("names all nine structures of 06 §6 once", () => {
    expect(NINE_STRUCTURES.map((structure) => structure.name)).toEqual([
      "Authority & Trust Registry",
      "Verification Party Registry",
      "Attestation Schema Registry",
      "Verification Attestation",
      "Compliance Policy Engine",
      "Evidence Snapshot + BNB Chain Anchor",
      "Public Explorer",
      "Evidence Adapter Framework",
      "Mongolia Jurisdiction Profile",
    ]);
  });

  it("every named field exists in its contract schema", () => {
    const missing = NINE_STRUCTURES.flatMap((structure) =>
      [structure.id, structure.version, structure.status]
        .filter((ref) => ref !== null)
        .filter((ref) => !schemaFields(ref!.schema).includes(ref!.field))
        .map((ref) => `${structure.name}: ${ref!.schemaName}.${ref!.field}`),
    );
    expect(missing).toEqual([]);
  });

  it("every absent linkage is a declared gap, and every declared gap is absent", () => {
    const mismatched = NINE_STRUCTURES.flatMap((structure) => {
      const present: Record<StructureLink, boolean> = {
        id: true,
        version: structure.version !== null,
        status: structure.status !== null,
        events: structure.events.length > 0,
      };
      return (Object.keys(present) as StructureLink[])
        .filter((link) => present[link] === (structure.gaps[link] !== undefined))
        .map((link) => `${structure.name}: ${link}`);
    });
    expect(mismatched).toEqual([]);
  });
});
