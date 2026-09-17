import { satisfiesAssurance, ROLE_MINIMUM_ASSURANCE, type AssuranceLevel } from "./auth.js";

/**
 * Authorization decision — the access decision formula of spec 02 §2.1 in code.
 *
 *   allow = role_action_allowed
 *        AND tenant_scope_matches
 *        AND project_scope_matches
 *        AND sensitivity_clearance_sufficient
 *        AND credential_or_assignment_valid_if_required
 *        AND resource_state_allows_action
 *        AND no_conflict_or_separation_violation
 *
 * Evaluates the seven conditions in order and **preserves the first failure
 * reason**. §11.7 requires "Permission: the required role and the access request
 * path", so the denial reason must reach the UI. With a bare boolean, the user
 * would not know what to do next.
 */

export type DenyReason =
  | "ROLE_ACTION_NOT_ALLOWED"
  | "ASSURANCE_LEVEL_INSUFFICIENT"
  | "TENANT_SCOPE_MISMATCH"
  | "PROJECT_SCOPE_MISMATCH"
  | "SENSITIVITY_CLEARANCE_INSUFFICIENT"
  | "CREDENTIAL_OR_ASSIGNMENT_INVALID"
  | "RESOURCE_STATE_FORBIDS_ACTION"
  | "CONFLICT_OR_SEPARATION_VIOLATION";

/**
 * Projects this role binding reaches.
 *
 * `"all"` is the whole tenant — only organization-level bindings of
 * `TENANT_WIDE_ROLES` qualify. An array lists the projects reached: a
 * project-level binding reaches that project; an organization-level binding of a
 * project-party role reaches **the projects that organization owns**.
 *
 * The two are not merged into one array. If an empty array could mean both "no
 * restriction" and "no projects", an account with a misconfigured binding would
 * fall through to full access.
 */
export type ProjectScope = "all" | readonly string[];

/**
 * Roles whose organization-level binding reaches the whole tenant — 02 §2.2.
 *
 * These roles do not own projects. Operators (`mpc_operator` etc.) run the
 * tenant; reviewers, gate approvers, and ERSPs handle **other companies'
 * projects** (§2.4 rule 2); voting and public read are unrelated to ownership.
 * Their individual actions are gated separately by assignment, credential, and
 * sensitivity conditions.
 *
 * **Roles not listed here are narrowed to the owning organization.** Adding a new
 * role and forgetting this list narrows access instead of widening it — a
 * visible 403 beats silent over-permission.
 * Currently narrowed roles: project_admin, data_steward, project_sponsor_operator,
 * spv_representative, issuer_officer, project_proposer, execution_recorder.
 */
export const TENANT_WIDE_ROLES: readonly string[] = [
  "public_reader",
  "mpc_operator",
  "security_operator",
  "auditor",
  "scan_service",
  "treasury_signer",
  "gate_approver",
  "protocol_proposer",
  "protocol_voter",
  "project_voter",
  "external_regulated_service_provider",
  "reviewer_cp_qp",
  "reviewer_lab",
  "reviewer_legal",
  "reviewer_assurance",
];

/**
 * Screens a denial points to.
 *
 * **Every path here must have a real screen.** Otherwise a user who follows the
 * "request access" guidance hits a 404 — worse than being blocked. A blocked
 * user knows why; a 404 does not even say what went wrong.
 *
 * When adding a path, build its screen under `apps/web/src/app/w/…`;
 * `apps/web/e2e/access-request-paths.spec.ts` actually opens all three.
 */
export const ACCESS_REQUEST_PATHS = {
  /** Insufficient identity assurance. */
  assurance: "/w/identity/upgrade",
  /** Missing role — outside project scope. */
  role: "/w/access-requests",
  /** Missing role or scope — a specific project. */
  project: (projectId: string): string => `/w/projects/${projectId}/access-requests`,
} as const;

export interface AuthorizationContext {
  readonly role: string;
  readonly assuranceLevel: AssuranceLevel;
  readonly actorTenantId: string;
  readonly actorProjectIds: ProjectScope;
  readonly sensitivityClearance: readonly string[];
  readonly hasRequiredCredential: boolean;
  readonly hasRequiredAssignment: boolean;
  readonly conflictStatus: "none" | "disclosed_resolved" | "unresolved";
}

export interface ResourceContext {
  readonly tenantId: string;
  readonly projectId: string | null;
  readonly sensitivity: string;
  readonly state: string;
  /** Resource states in which this action is allowed. */
  readonly statesAllowingAction: readonly string[];
  readonly requiresCredential: boolean;
  readonly requiresAssignment: boolean;
  /** Whether this action is subject to conflict-of-interest separation rules (02 §2.4). */
  readonly separationSensitive: boolean;
}

export interface ActionPolicy {
  readonly action: string;
  readonly allowedRoles: readonly string[];
}

export type AuthorizationDecision =
  | { readonly allow: true }
  | {
      readonly allow: false;
      readonly reason: DenyReason;
      readonly requiredRoles?: readonly string[];
      readonly requiredAssurance?: AssuranceLevel;
      readonly accessRequestPath?: string;
    };

export function authorize(
  policy: ActionPolicy,
  actor: AuthorizationContext,
  resource: ResourceContext,
): AuthorizationDecision {
  if (!policy.allowedRoles.includes(actor.role)) {
    return {
      allow: false,
      reason: "ROLE_ACTION_NOT_ALLOWED",
      requiredRoles: policy.allowedRoles,
      accessRequestPath: resource.projectId
        ? ACCESS_REQUEST_PATHS.project(resource.projectId)
        : ACCESS_REQUEST_PATHS.role,
    };
  }

  const requiredAssurance = ROLE_MINIMUM_ASSURANCE[actor.role] ?? "high_assurance";
  if (!satisfiesAssurance(actor.assuranceLevel, requiredAssurance)) {
    return {
      allow: false,
      reason: "ASSURANCE_LEVEL_INSUFFICIENT",
      requiredAssurance,
      accessRequestPath: ACCESS_REQUEST_PATHS.assurance,
    };
  }

  if (actor.actorTenantId !== resource.tenantId) {
    return { allow: false, reason: "TENANT_SCOPE_MISMATCH" };
  }

  if (
    resource.projectId !== null &&
    actor.actorProjectIds !== "all" &&
    !actor.actorProjectIds.includes(resource.projectId)
  ) {
    return {
      allow: false,
      reason: "PROJECT_SCOPE_MISMATCH",
      accessRequestPath: ACCESS_REQUEST_PATHS.project(resource.projectId),
    };
  }

  if (!actor.sensitivityClearance.includes(resource.sensitivity)) {
    return { allow: false, reason: "SENSITIVITY_CLEARANCE_INSUFFICIENT" };
  }

  if (resource.requiresCredential && !actor.hasRequiredCredential) {
    return { allow: false, reason: "CREDENTIAL_OR_ASSIGNMENT_INVALID" };
  }

  if (resource.requiresAssignment && !actor.hasRequiredAssignment) {
    return { allow: false, reason: "CREDENTIAL_OR_ASSIGNMENT_INVALID" };
  }

  if (!resource.statesAllowingAction.includes(resource.state)) {
    return { allow: false, reason: "RESOURCE_STATE_FORBIDS_ACTION" };
  }

  if (resource.separationSensitive && actor.conflictStatus === "unresolved") {
    return { allow: false, reason: "CONFLICT_OR_SEPARATION_VIOLATION" };
  }

  return { allow: true };
}

/**
 * Roles that can read workspace data — 02 §2.1·§2.3.
 *
 * **`public_reader` is absent.** A wallet signature alone grants only public read
 * and governance participation (02 §2.9); workspace evidence, review, and
 * readiness are not public. A wallet being bound to a tenant is not a role —
 * treating it as read permission would turn the RLS tenant boundary into the
 * authorization itself.
 */
const WORKSPACE_READERS = [
  "mpc_operator",
  "security_operator",
  "auditor",
  "project_admin",
  "project_sponsor_operator",
  "spv_representative",
  "data_steward",
  "gate_approver",
  "issuer_officer",
  "execution_recorder",
  "external_regulated_service_provider",
  "reviewer_cp_qp",
  "reviewer_lab",
  "reviewer_legal",
  "reviewer_assurance",
] as const;

/** Governance derives from holdings, so voters and proposers can read it too (04 §4.5). */
const GOVERNANCE_READERS = [
  ...WORKSPACE_READERS,
  "protocol_voter",
  "project_voter",
  "protocol_proposer",
  "project_proposer",
] as const;

/**
 * Who approves review registry proposals — credentials, attestation schemas and compliance
 * policy sets (02 §2.8, "the Protocol's designated review role").
 *
 * **No role in 02 §2.2 carries that name, and none is called "Credential Verifier" either.**
 * `reviewer_assurance` is the closest existing role: it reviews procedures and controls
 * independently, and it is not a subject-matter reviewer (resource, lab, legal) whose own
 * attestations would rest on the schemas and credentials being approved. `auditor` is left out
 * because 02 §2.2 forbids it mutating operational data, and approving writes a registry row.
 * `mpc_operator` is left out because 02 §2.3 limits it to "rule deployment only" — it proposes.
 *
 * **Pending confirmation by the decision owner.** Kept as one constant so that the decision,
 * once made, changes one line.
 */
export const REGISTRY_APPROVER_ROLES: readonly string[] = ["reviewer_assurance"];

/**
 * Allowed roles per action — 02 §2.3 permission table.
 *
 * `readiness.override` is absent by design. No role may modify a readiness
 * result, so the action itself does not exist (REQ-DAPP-017).
 */
export const ACTION_POLICIES: Readonly<Record<string, ActionPolicy>> = {
  /**
   * Read actions — 02 §2.1.
   *
   * The decision formula applies to reads too. Checking only writes would let
   * reads break role and project boundaries inside a tenant. RLS enforces only
   * the tenant boundary (0002_rls.sql).
   */
  "project.read": { action: "project.read", allowedRoles: WORKSPACE_READERS },
  "evidence.read": {
    action: "evidence.read",
    // The scan service must see quarantined uploads to report results.
    allowedRoles: [...WORKSPACE_READERS, "scan_service"],
  },
  "verification.read": { action: "verification.read", allowedRoles: WORKSPACE_READERS },
  "readiness.read": { action: "readiness.read", allowedRoles: WORKSPACE_READERS },
  "registry.read": { action: "registry.read", allowedRoles: WORKSPACE_READERS },
  "authority.read": { action: "authority.read", allowedRoles: WORKSPACE_READERS },
  "governance.read": { action: "governance.read", allowedRoles: GOVERNANCE_READERS },

  "project.create": {
    action: "project.create",
    allowedRoles: ["mpc_operator", "project_admin", "project_sponsor_operator"],
  },
  "source.upload": {
    action: "source.upload",
    allowedRoles: [
      "data_steward",
      "project_admin",
      "project_sponsor_operator",
      "spv_representative",
    ],
  },
  /**
   * Record a scan result — 05 §5.2.
   *
   * Does not reuse `source.upload`. That permission belongs to whoever uploads a
   * file; producing a scan result is a different act. Under one permission, **an
   * uploader could pass their own file** and quarantine would be a formality.
   *
   * Only `scan_service` holds it. No human role is included.
   */
  "upload.scan_result": {
    action: "upload.scan_result",
    allowedRoles: ["scan_service"],
  },
  /**
   * Register or update an authority candidate — 02 §2.8.
   *
   * This is Trust Registry operator work. It cannot move an authority to
   * `accepted` — state transitions are `authority.review`, and even if one person
   * holds both permissions, the route separately checks **whether the registrant
   * and the approver are the same person**.
   */
  "authority.register": {
    action: "authority.register",
    allowedRoles: ["mpc_operator"],
  },
  /**
   * Authority state transition — 02 §2.8.
   *
   * **`mpc_operator` is absent.** §2.8 explicitly forbids "operator-only
   * `accepted` transitions"; adding operators here would make registration and
   * approval the same permission.
   *
   * Independent reviewers and auditors decide. Trusting an authority is a review
   * outcome, not an operations task.
   */
  "authority.review": {
    action: "authority.review",
    allowedRoles: ["reviewer_legal", "reviewer_assurance", "auditor"],
  },
  /**
   * Configure a connection — 02 §2.8.
   *
   * Source Connection Admin work, subject to security review. A DB trigger
   * ensures that enabling a connection does not amount to approving the
   * authority — permissions alone cannot, since one person may hold both.
   */
  "connection.configure": {
    action: "connection.configure",
    allowedRoles: ["mpc_operator", "security_operator"],
  },
  /**
   * Official source lookup — 05 §5.12, OD-42.
   *
   * Does not reuse `source.upload`. That permission is for **uploading files you
   * hold**; this one **sends external requests with authority credentials**.
   * Under one permission, everyone who can upload would become an authority API
   * caller.
   *
   * Project-side roles (`project_admin`, `spv_representative`) are excluded. If a
   * party ran registry lookups on its own project, it could pick the result by
   * picking when to look up.
   */
  "source.collect": {
    action: "source.collect",
    allowedRoles: ["data_steward", "mpc_operator"],
  },
  "claim.curate": {
    action: "claim.curate",
    allowedRoles: ["data_steward"],
  },
  /**
   * Tenant-wide document type rules ("documents of type Y rest on documents of type X").
   *
   * Linking two documents is Data Room work and rides on `source.upload`. A rule is different:
   * it writes links into every project of the tenant. A role narrowed to one organization's
   * projects would reach into other organizations' Data Rooms through it, so only a tenant-wide
   * role holds it.
   */
  "document.rule.manage": {
    action: "document.rule.manage",
    allowedRoles: ["mpc_operator"],
  },
  /**
   * Raise a dispute — 04 §4.2.
   *
   * Does not reuse `claim.curate` (data_steward only). Whoever finds a problem may
   * differ from whoever curates the evidence, and the most common case is the
   * signing reviewer noticing a problem later. Blocking them leaves the error
   * silently in place.
   *
   * A dispute is not a ruling but a flag that "this needs another look", so it is
   * open broadly.
   */
  "attestation.dispute": {
    action: "attestation.dispute",
    allowedRoles: [
      "data_steward",
      "reviewer_cp_qp",
      "reviewer_lab",
      "reviewer_legal",
      "reviewer_assurance",
      "auditor",
      "mpc_operator",
      "project_admin",
    ],
  },
  "attestation.sign": {
    action: "attestation.sign",
    allowedRoles: ["reviewer_cp_qp", "reviewer_lab", "reviewer_legal", "reviewer_assurance"],
  },
  "readiness.recompute": {
    action: "readiness.recompute",
    allowedRoles: ["mpc_operator", "data_steward", "gate_approver"],
  },
  "gate.decide": {
    action: "gate.decide",
    allowedRoles: ["gate_approver"],
  },
  "registry.publish": {
    action: "registry.publish",
    allowedRoles: ["mpc_operator"],
  },
  "registry.revoke": {
    action: "registry.revoke",
    allowedRoles: ["mpc_operator"],
  },
  "anchor.submit": {
    action: "anchor.submit",
    allowedRoles: ["mpc_operator"],
  },
  "disclosure.restrict": {
    action: "disclosure.restrict",
    allowedRoles: ["issuer_officer", "mpc_operator"],
  },
  /**
   * Proposal creation and state transitions — 04 §4.5.
   *
   * `protocol_proposer` and `project_proposer` require identity_bound. An
   * anonymous wallet cannot start a governance process.
   */
  "governance.propose": {
    action: "governance.propose",
    allowedRoles: ["protocol_proposer", "project_proposer", "mpc_operator"],
  },
  /**
   * Voting.
   *
   * `wallet_only` suffices — voting rights come from holdings, not identity. In
   * exchange, a vote cannot create off-chain facts (invariant 12).
   */
  "governance.vote": {
    action: "governance.vote",
    allowedRoles: ["protocol_voter", "project_voter", "mpc_operator"],
  },
  "audit.read": {
    action: "audit.read",
    allowedRoles: ["auditor", "security_operator", "mpc_operator"],
  },

  /**
   * Platform administration — 02 §2.8.
   *
   * Exposing role grants through UI and API creates a new **role that grants
   * roles**. If that one role could give itself anything, this whole table would
   * lose its meaning. So proposal and approval are **split into separate
   * actions**, and the DB blocks the same person from doing both
   * (`role_grant_two_person`).
   *
   * Both actions allowing the same roles is intentional. What must be separated
   * is **people**, not roles — splitting by role would, in a deployment with a
   * single approver-role holder, let that one person approve everything, which is
   * not a two-person rule.
   */
  "admin.read": {
    action: "admin.read",
    allowedRoles: ["mpc_operator", "security_operator", "auditor"],
  },
  "admin.subject.manage": {
    action: "admin.subject.manage",
    allowedRoles: ["mpc_operator", "security_operator"],
  },
  /**
   * Wallet disable and rebind — AC-27.
   *
   * Cutting off a lost key is **urgent**. Requiring two people keeps a
   * compromised key alive while waiting for the second person. So this is
   * single-person, and the reason and actor are recorded instead
   * (`wallet_disable_events`). Recovery — binding a new key — is the same action
   * and is immediate for the same reason.
   */
  "admin.wallet.manage": {
    action: "admin.wallet.manage",
    allowedRoles: ["mpc_operator", "security_operator"],
  },
  "admin.role.propose": {
    action: "admin.role.propose",
    allowedRoles: ["mpc_operator", "security_operator"],
  },
  "admin.role.approve": {
    action: "admin.role.approve",
    allowedRoles: ["mpc_operator", "security_operator"],
  },
  /**
   * Notification sink management.
   *
   * A sink URL belongs to the tenant, not a person, so it is not personal data.
   * It still has its own permission because changing a sink **sends
   * notifications elsewhere.** A silent change leaves the original recipient
   * unaware that notifications stopped.
   */
  "admin.notification.manage": {
    action: "admin.notification.manage",
    allowedRoles: ["mpc_operator", "security_operator"],
  },

  /**
   * Review registries — credentials, attestation schemas, compliance policy sets (02 §2.8).
   *
   * **Proposing and approving are different roles and different people.** The operator deploys
   * rules (02 §2.3 "rule deployment only") by proposing them; the designated review role
   * approves. Holding both roles does not help — the DB rejects a decision by the proposer
   * (`registry_proposal_two_person`).
   *
   * Reading is narrower than `registry.read`: pending credential proposals name people and their
   * issuer references, which project parties have no reason to see.
   */
  "review_registry.read": {
    action: "review_registry.read",
    allowedRoles: ["mpc_operator", "security_operator", "auditor", ...REGISTRY_APPROVER_ROLES],
  },
  "review_registry.propose": {
    action: "review_registry.propose",
    allowedRoles: ["mpc_operator"],
  },
  "review_registry.approve": {
    action: "review_registry.approve",
    allowedRoles: REGISTRY_APPROVER_ROLES,
  },

  /**
   * Project lifecycle transitions — 04 §4.3.
   *
   * **Stepping down and stepping forward are split.** Suspension is urgent, so one
   * person does it — requiring two keeps a problematic project running while
   * waiting for the second person (same logic as wallet disable). Forward
   * transitions, by contrast, are not urgent and are hard to reverse.
   *
   * Resuming is an `advance` and additionally **cannot be done by whoever
   * suspended.** If the same person could suspend and resume, suspension would be
   * personal discretion rather than a control.
   */
  "project.lifecycle.suspend": {
    action: "project.lifecycle.suspend",
    allowedRoles: ["mpc_operator", "security_operator", "issuer_officer"],
  },
  "project.lifecycle.advance": {
    action: "project.lifecycle.advance",
    // Whoever makes gate and issuance decisions performs this transition. An
    // operator alone cannot open an offering.
    allowedRoles: ["issuer_officer", "gate_approver"],
  },
};
