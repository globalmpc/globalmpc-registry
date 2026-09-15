import {
  ACTION_POLICIES,
  authorize,
  TENANT_WIDE_ROLES,
  type AuthorizationContext,
  type ProjectScope,
  type ResourceContext,
} from "@mpc/api-contract";
import { badRequest, forbidden } from "../errors.js";
import type { Session } from "./session.js";

/** Facts that must be looked up outside the session. Routes fill them for their own resource. */
export interface ActorFacts {
  readonly sensitivityClearance: readonly string[];
  readonly hasRequiredCredential: boolean;
  readonly hasRequiredAssignment: boolean;
  readonly conflictStatus: "none" | "disclosed_resolved" | "unresolved";
}

/**
 * Sensitivity clearance per assurance level — 02 §2.2, 06 §6.7.
 *
 * Previously each route passed `["public","restricted"]` as a constant. Clearance was then the
 * same whatever the session, and the decision formula's `sensitivity_clearance_sufficient` took
 * no part in the verdict.
 *
 * `confidential` and above are not opened here. No storage path for that grade exists yet
 * (OD-18, `admitToStorage`), and opening reads first would claim that things that cannot be
 * stored can be read.
 */
const CLEARANCE_BY_ASSURANCE: Readonly<Record<Session["assuranceLevel"], readonly string[]>> = {
  wallet_only: ["public"],
  identity_bound: ["public", "restricted"],
  high_assurance: ["public", "restricted"],
};

/**
 * Facts decidable from the session alone.
 *
 * Credential, assignment, and conflict of interest differ per resource, so they are not filled here.
 * **Defaults are "not required", not "satisfied"** — once a resource turns on
 * `requiresCredential`, the route must pass the real lookup result; if it does not, the result
 * is rejection, not a pass.
 */
export function sessionFacts(session: Session, overrides: Partial<ActorFacts> = {}): ActorFacts {
  return {
    sensitivityClearance: CLEARANCE_BY_ASSURANCE[session.assuranceLevel],
    hasRequiredCredential: false,
    hasRequiredAssignment: false,
    conflictStatus: "none",
    ...overrides,
  };
}

/** One role binding. Organization-level (project_id NULL) covers all of that org's projects. */
type Binding = Session["roleBindings"][number];

/**
 * Projects a binding reaches.
 *
 * Previously every organization-level binding became `"all"`. The comment said "all of that
 * organization's projects", but nothing compared organizations, so a company B steward in the
 * same tenant could upload to company A's project.
 */
function scopeOf(session: Session, binding: Binding): ProjectScope {
  if (binding.projectId !== null) return [binding.projectId];
  if (TENANT_WIDE_ROLES.includes(binding.role)) return "all";
  if (binding.organizationId === null) return [];
  return session.organizationProjectIds?.[binding.organizationId] ?? [];
}

/** Bindings of the roles permitted for this action. */
function usableBindings(session: Session, action: string): readonly Binding[] {
  const policy = ACTION_POLICIES[action];
  if (!policy) return [];
  return session.roleBindings.filter((binding) => policy.allowedRoles.includes(binding.role));
}

/** Whether the session holds any role for this action. Decides whether lists carry decision targets. */
export function holdsActionRole(session: Session, action: string): boolean {
  return usableBindings(session, action).length > 0;
}

/**
 * Whether the session may act in this organization's name — the owning-organization check on
 * project creation.
 *
 * Tenant operations roles can register projects owned by other organizations via onboarding.
 * Party roles create only their own organization's. Otherwise company B could create a project
 * under company A's name and appear as that project's party.
 */
export function canActForOrganization(
  session: Session,
  action: string,
  organizationId: string,
): boolean {
  const scope = actableOrganizations(session, action);
  return scope === "all" || scope.includes(organizationId);
}

/**
 * Organizations the session may act for with this action.
 *
 * The owning-organization rule lives here once, so the organization lookup the registration form
 * uses and the check on project creation cannot diverge — a listed organization the server then
 * refuses is a dead end on screen.
 *
 * `"all"`: a tenant operations role holds the action. Otherwise the organizations named by the
 * party bindings that hold it.
 */
export function actableOrganizations(session: Session, action: string): "all" | readonly string[] {
  const bindings = usableBindings(session, action);
  if (bindings.some((binding) => TENANT_WIDE_ROLES.includes(binding.role))) return "all";
  return [
    ...new Set(
      bindings.flatMap((binding) => (binding.organizationId === null ? [] : [binding.organizationId])),
    ),
  ];
}

export function bindingToAuthorizationContext(
  session: Session,
  binding: Binding,
  facts: ActorFacts,
): AuthorizationContext {
  return {
    role: binding.role,
    assuranceLevel: session.assuranceLevel,
    actorTenantId: session.tenantId ?? "",
    actorProjectIds: scopeOf(session, binding),
    sensitivityClearance: facts.sensitivityClearance,
    hasRequiredCredential: facts.hasRequiredCredential,
    hasRequiredAssignment: facts.hasRequiredAssignment,
    conflictStatus: facts.conflictStatus,
  };
}

/**
 * Projects reachable with this action — for list queries.
 *
 * Single reads are covered by `assertAuthorized` blocking, but lists are not. Without filtering,
 * names and IDs of out-of-scope projects go out in the list. Not receiving a 403 does not make
 * it any less of a leak.
 *
 * `"all"` means there is at least one organization-level binding of a tenant operations role.
 */
export function visibleProjectScope(session: Session, action: string): ProjectScope {
  const scopes = usableBindings(session, action).map((binding) => scopeOf(session, binding));

  if (scopes.some((scope) => scope === "all")) return "all";
  return [...new Set(scopes.flatMap((scope) => scope as readonly string[]))];
}

/**
 * Default resource context.
 *
 * Writing 7 fields by hand per route means forgetting one silently changes the verdict for that
 * route alone. Every default is **the narrowest option** — for credential and assignment it does
 * not mean "not required"; it means a route that requires them must say so explicitly.
 */
const RESOURCE_DEFAULTS = {
  sensitivity: "restricted",
  state: "active",
  statesAllowingAction: ["active"],
  requiresCredential: false,
  requiresAssignment: false,
  separationSensitive: false,
} as const;

/** Tenant-wide resource. Only for operations actions with no project boundary. */
export function tenantResource(
  tenantId: string,
  overrides: Partial<Omit<ResourceContext, "tenantId" | "projectId">> = {},
): ResourceContext {
  return { ...RESOURCE_DEFAULTS, ...overrides, tenantId, projectId: null };
}

/** Project-bound resource. `projectId` must be passed for project scope to be evaluated. */
export function projectResource(
  tenantId: string,
  projectId: string,
  overrides: Partial<Omit<ResourceContext, "tenantId" | "projectId">> = {},
): ResourceContext {
  return { ...RESOURCE_DEFAULTS, ...overrides, tenantId, projectId };
}

/** Session with no roles. Having a wallet bound is not a role. */
const PUBLIC_READER: Binding = {
  role: "public_reader",
  organizationId: null,
  projectId: null,
};

/**
 * The server makes the final authorization decision — 02 §2.1.
 *
 * **Decides per role binding, not per role.** An organization-level binding reaches all the
 * organization's projects; a project-level binding reaches only that project. Looking only at
 * role names lets a reviewer of project A pass in project B with the same role.
 *
 * Allows if any binding passes. If all fail, returns **the last rejection reason**,
 * because the user needs to know what to do (§11.7).
 *
 * **Returns the role of the binding that passed.** The audit record's `effective_role` must be
 * this value (02 §2.7). Using the session's first binding instead records an action that a
 * person with two bindings passed via the second as the first role. `core.resolve_role_bindings`
 * has no ORDER BY, so that "first" can differ per run — the record would be not only wrong but
 * unreproducible.
 */
export function assertAuthorized(
  session: Session,
  action: string,
  resource: ResourceContext,
  facts: ActorFacts,
): string {
  const policy = ACTION_POLICIES[action];
  if (!policy) {
    throw badRequest("ACTION_UNKNOWN", `Unknown action: ${action}`);
  }

  const candidates = session.roleBindings.length > 0 ? session.roleBindings : [PUBLIC_READER];

  let lastDenial: ReturnType<typeof authorize> | null = null;

  for (const binding of candidates) {
    const decision = authorize(
      policy,
      bindingToAuthorizationContext(session, binding, facts),
      resource,
    );
    if (decision.allow) return binding.role;
    lastDenial = decision;
  }

  if (lastDenial && !lastDenial.allow) {
    throw forbidden("AUTHORIZATION_DENIED", "You do not have permission to perform this action", {
      reason: lastDenial.reason,
      ...(lastDenial.requiredRoles ? { requiredRoles: lastDenial.requiredRoles } : {}),
      ...(lastDenial.requiredAssurance
        ? { requiredAssurance: lastDenial.requiredAssurance }
        : {}),
      ...(lastDenial.accessRequestPath
        ? { accessRequestPath: lastDenial.accessRequestPath }
        : {}),
    });
  }

  throw forbidden("AUTHORIZATION_DENIED", "You do not have permission to perform this action");
}
