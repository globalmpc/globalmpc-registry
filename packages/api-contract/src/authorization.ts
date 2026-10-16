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
 * Evaluates the seven conditions, plus the `jurisdiction[]` attribute of §2.5, in order and
 * **preserves the first failure reason**. §11.7 requires "Permission: the required role and the access request
 * path", so the denial reason must reach the UI. With a bare boolean, the user
 * would not know what to do next.
 */

export type DenyReason =
  | "ROLE_ACTION_NOT_ALLOWED"
  | "ASSURANCE_LEVEL_INSUFFICIENT"
  | "TENANT_SCOPE_MISMATCH"
  | "PROJECT_SCOPE_MISMATCH"
  | "JURISDICTION_SCOPE_MISMATCH"
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
  "disclosure_approver",
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
  /**
   * Jurisdictions this binding is limited to — 02 §2.5 `jurisdiction[]`.
   *
   * `null` or absent: the binding is not scoped by jurisdiction and the check is skipped, which
   * is how every binding behaved before the attribute existed.
   */
  readonly jurisdictionScope?: readonly string[] | null;
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
  /**
   * Host jurisdiction of the project this resource belongs to (ISO 3166-1 alpha-3).
   *
   * `null` or absent for tenant-level resources, or when it was not looked up. A
   * jurisdiction-scoped binding treats both as a mismatch — an unknown location is not a match.
   */
  readonly jurisdiction?: string | null;
  /**
   * A tenant-level list whose rows the route filters by project scope (`visibleProjectScope`),
   * which already narrows jurisdiction-scoped bindings to their jurisdictions. Only such lists
   * let a scoped binding through at tenant level; every other tenant-level action stays closed.
   */
  readonly filteredByProjectScope?: boolean;
}

export interface ActionPolicy {
  readonly action: string;
  readonly allowedRoles: readonly string[];
  /**
   * Set when this action is the **second person** of a two-person rule — it decides, publishes
   * or confirms what someone else started, and must not be that someone. The value names the
   * rule. See `SECOND_PERSON_ROLES`.
   */
  readonly secondPerson?: string;
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

function jurisdictionMatches(actor: AuthorizationContext, resource: ResourceContext): boolean {
  /**
   * Jurisdiction condition — 02 §2.5.
   *
   * **Fails closed for scoped bindings.** A binding limited to some jurisdictions passes only
   * when the resource's host jurisdiction is known and listed. A tenant-level resource has no
   * host jurisdiction, so a scoped binding cannot act on it: treating "no location" as "any
   * location" would let the narrowest binding reach the widest resources. The one exception is
   * a list the route filters by project scope, where the filter itself applies the limit.
   */
  return !(
    actor.jurisdictionScope !== undefined &&
    actor.jurisdictionScope !== null &&
    !(resource.projectId === null && resource.filteredByProjectScope === true) &&
    (resource.jurisdiction === undefined ||
      resource.jurisdiction === null ||
      !actor.jurisdictionScope.includes(resource.jurisdiction))
  );
}

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

  if (!jurisdictionMatches(actor, resource)) {
    return { allow: false, reason: "JURISDICTION_SCOPE_MISMATCH" };
  }

  return authorizeResourceConditions(actor, resource);
}

function authorizeResourceConditions(
  actor: AuthorizationContext,
  resource: ResourceContext,
): AuthorizationDecision {
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
  // Reads what it is asked to make public — 02 §2.8 "privacy·terms·jurisdiction policy".
  "disclosure_approver",
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
 * Who approves review registry proposals — credentials, attestation schemas, compliance policy
 * sets and jurisdiction profile versions (02 §2.8, "the Protocol's designated review role").
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

/** Roles per governance space — 02 §2.2·§2.3. See the governance entries of `ACTION_POLICIES`. */
const GOVERNANCE_SPACE_ROLES = {
  protocol: {
    propose: ["protocol_proposer"],
    vote: ["protocol_voter"],
    administer: ["protocol_proposer", "mpc_operator"],
  },
  project: {
    propose: ["project_proposer"],
    vote: ["project_voter"],
    administer: ["project_proposer", "mpc_operator"],
  },
} as const;

export type GovernanceVerb = "propose" | "vote" | "administer";

/** The action a route authorizes once it knows the proposal's space. */
export function governanceAction(space: "protocol" | "project", verb: GovernanceVerb): string {
  return `governance.${space}.${verb}`;
}

function governanceActions(): Record<string, ActionPolicy> {
  const entries: Record<string, ActionPolicy> = {};
  for (const verb of ["propose", "vote", "administer"] as const) {
    const union = new Set<string>();
    for (const space of ["protocol", "project"] as const) {
      const action = governanceAction(space, verb);
      const roles = GOVERNANCE_SPACE_ROLES[space][verb];
      entries[action] = { action, allowedRoles: roles };
      roles.forEach((role) => union.add(role));
    }
    entries[`governance.${verb}`] = { action: `governance.${verb}`, allowedRoles: [...union] };
  }
  return entries;
}

/**
 * Who makes a drafted registry version public — 02 §2.8 "public projection approval:
 * Data Owner + Disclosure Approver".
 *
 * 02 §2.8 names the Disclosure Approver but 02 §2.2 has no role that carries it, and none of the
 * existing roles is a good stand-in: `mpc_operator` drafts (02 §2.3 "publish workflow"), so it
 * cannot also be the second person by role, and project-party roles would approve their own
 * project's disclosure. So the role carries the spec's name. **Nobody holds it until it is
 * granted** through the two-person role grant, so a deployment without one cannot publish —
 * a visible refusal rather than a silent single-person publication.
 */
export const DISCLOSURE_APPROVER_ROLES: readonly string[] = ["disclosure_approver"];

/**
 * The elevated role of an approved break-glass elevation — 02 §2.6.
 *
 * Not in 02 §2.2 and not in `ROLE_MINIMUM_ASSURANCE`, so it cannot be proposed as a standing
 * role grant (the grant route refuses unknown roles). It is also absent from
 * `TENANT_WIDE_ROLES`, so it reaches no project: the emergency actions are tenant-level.
 */
export const BREAK_GLASS_ROLE = "break_glass";

/**
 * Every action the `break_glass` role may perform.
 *
 * 02 §2.6 lists pause, credential revoke, key disable and access quarantine, and forbids changing
 * evidence, readiness, votes or financial entitlements. The standing `security_operator` role
 * already holds pause (`project.lifecycle.suspend`) and key disable (`admin.wallet.manage`); what
 * it lacks is an immediate access cut, because revoking a role normally takes two people. A test
 * keeps this list and `ACTION_POLICIES` in step.
 */
export const BREAK_GLASS_ACTIONS: readonly string[] = ["break_glass.quarantine"];

/** 02 §2.6: an incident record is due within 24 hours of the elevation taking effect. */
export const BREAK_GLASS_INCIDENT_DUE_HOURS = 24;

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
  /**
   * Project identity edits — name and minerals only (07 §7.2 `PATCH /projects/{id}`).
   *
   * The owner organization and the reference label are not editable through this action: moving
   * the owner changes who reaches the project, and the label is fixed (05 §5.10).
   */
  "project.update": {
    action: "project.update",
    allowedRoles: ["mpc_operator", "project_admin"],
  },
  /**
   * Submit a project party — 02 §2.3 ("Project Registry: project parties request").
   *
   * A submitted party is `pending`. Parties may name themselves; that is a self-statement
   * (05 §5.11), and confirming it is `project.fact.record`, which none of the party roles hold.
   */
  "project.party.submit": {
    action: "project.party.submit",
    allowedRoles: [
      "project_admin",
      "project_sponsor_operator",
      "spv_representative",
      "issuer_officer",
      "data_steward",
    ],
  },
  /**
   * Record a confirmed/pending matrix fact or a party's confirmation — 04 §4.2, 11 §11.5.
   *
   * Curation, not submission (02 §2.3 "Project Registry: steward curate"). Only the steward holds
   * it, so a party cannot confirm facts about its own project. `mpc_operator` is absent: it runs
   * the publish workflow, and confirming the facts it then publishes would merge two checks.
   */
  "project.fact.record": {
    action: "project.fact.record",
    allowedRoles: ["data_steward"],
  },
  /** Ask for Project Registry registration — 07 §7.2. Asking is not publishing. */
  "project.registration.request": {
    action: "project.registration.request",
    allowedRoles: ["project_admin", "project_sponsor_operator"],
  },
  /**
   * Stakeholder/obligation event history — 12 §12.7.
   *
   * The sponsor submits relationship and consent material (02 §2.2); the steward curates.
   * Recording an event as `confirmed` additionally needs `project.fact.record` — the route checks it.
   */
  "project.stakeholder.record": {
    action: "project.stakeholder.record",
    allowedRoles: ["data_steward", "project_sponsor_operator"],
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
    secondPerson: "registrant ≠ approver (route SEPARATION_OF_DUTIES)",
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
    secondPerson: "reviewer ≠ activator (route CONNECTION_REVIEW_SAME_PERSON)",
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
    secondPerson: "first ≠ second confirmer (source_receipt_second_reviewer_differs, 0021)",
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
    secondPerson: "claim submitter ≠ reviewer (02 §2.4, separation-sensitive resource)",
    allowedRoles: ["reviewer_cp_qp", "reviewer_lab", "reviewer_legal", "reviewer_assurance"],
  },
  /**
   * Withdraw one's own signed attestation — 07 §7.2 `POST /attestations/{id}/revoke`.
   *
   * The same roles that sign, and the route further requires the signer. Operations roles are
   * absent: `break_glass` cannot change an attestation (02 §2.8).
   */
  "attestation.revoke": {
    action: "attestation.revoke",
    allowedRoles: ["reviewer_cp_qp", "reviewer_lab", "reviewer_legal", "reviewer_assurance"],
  },
  /**
   * Credential status change — expire, suspend, revoke, lift a suspension (02 §2.8 "credential
   * check", REQ-DAPP-042·044).
   *
   * The Credential Verifier is the role that approves credentials into the registry.
   * `security_operator` is here for `break_glass` credential revocation (02 §2.6); the route
   * limits it to revoke and suspend.
   */
  "credential.status.change": {
    action: "credential.status.change",
    secondPerson: "credential holder ≠ changer (route CREDENTIAL_SELF_STATUS_CHANGE)",
    allowedRoles: [...REGISTRY_APPROVER_ROLES, "security_operator"],
  },
  "readiness.recompute": {
    action: "readiness.recompute",
    allowedRoles: ["mpc_operator", "data_steward", "gate_approver"],
  },
  "gate.decide": {
    action: "gate.decide",
    secondPerson: "independent gate decision (02 §2.4, separation-sensitive resource)",
    allowedRoles: ["gate_approver"],
  },
  /**
   * Registry publication — two steps, two people (02 §2.8, 07 §7.2).
   *
   * Drafting checks and records a projection; nothing is public yet. Publishing makes it
   * public and anchorable, so it is the step that needs the Disclosure Approver. The DB rejects
   * publication by the person who drafted (`registry_draft_two_person`), whatever roles they
   * hold.
   */
  "registry.draft": {
    action: "registry.draft",
    allowedRoles: ["mpc_operator"],
  },
  "registry.publish": {
    action: "registry.publish",
    secondPerson: "drafter ≠ publisher (registry_draft_two_person, 0056)",
    allowedRoles: DISCLOSURE_APPROVER_ROLES,
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
   * Governance — 02 §2.2·§2.3, 09 §9.1, REQ-DAPP-021.
   *
   * **Each space has its own proposer and voter role.** A protocol proposer cannot create a
   * project asset proposal and a protocol voter cannot vote on one; the reverse holds for the
   * project roles. Routes authorize the space-specific action (`governanceAction`) once the
   * proposal's space is known; the unscoped action is what the route contract declares, the
   * union of both spaces, derived so the two cannot drift apart.
   *
   * **`mpc_operator` neither proposes nor votes.** 02 §2.3 gives it "administer" on both
   * proposal kinds, not C/V, and 02 §2.2 forbids it project asset decisions. It keeps the
   * administrative transitions, which the tally and state machine constrain.
   *
   * Proposers require identity_bound — an anonymous wallet cannot start a governance process.
   * Voters need only `wallet_only`: voting rights come from holdings, not identity, and in
   * exchange a vote cannot create off-chain facts (invariant 12).
   */
  ...governanceActions(),
  /**
   * Off-chain execution records — 02 §2.3 "Off-chain Execution", 09 §9.7.
   *
   * Only the execution recorder writes them. It records what was done and on what evidence;
   * it cannot change the vote snapshot or tally (02 §2.4 rule 9).
   */
  "governance.execution.record": {
    action: "governance.execution.record",
    allowedRoles: ["execution_recorder"],
  },
  "audit.read": {
    action: "audit.read",
    allowedRoles: ["auditor", "security_operator", "mpc_operator"],
  },
  /**
   * Bulk audit export — 12 §12.4. Narrower than reading: an export leaves the system as a file,
   * so it is held to the two roles whose job is review (02 §2.2 auditor, security_operator).
   */
  "audit.export": {
    action: "audit.export",
    allowedRoles: ["auditor", "security_operator"],
  },
  /**
   * Project export package — 07 §7.9. Anyone who can read the project may ask; the package is
   * redacted to the requester's clearance, so asking never widens what they can see.
   */
  "project.export": { action: "project.export", allowedRoles: WORKSPACE_READERS },

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
    secondPerson: "proposer ≠ decider (role_grant_two_person 0028, role_revocation_two_person 0042, role_grant_not_self_target 0076)",
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
   * Review registries — credentials, attestation schemas, compliance policy sets and jurisdiction
   * profile versions (02 §2.8, 04 §4.9).
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
    secondPerson: "proposer ≠ approver (registry_proposal_two_person, 0043)",
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
    secondPerson: "suspender ≠ reinstater (route LIFECYCLE_RESUME_SELF)",
    // Whoever makes gate and issuance decisions performs this transition. An
    // operator alone cannot open an offering.
    allowedRoles: ["issuer_officer", "gate_approver"],
  },

  /**
   * Source connection security review — 02 §2.8 "security and data rights review".
   *
   * Separate from `connection.configure`. With one permission the person who configures a
   * connection would also be the one who clears it; the route additionally refuses activation
   * by the reviewer, so review and activation are always two people.
   */
  "connection.security_review": {
    action: "connection.security_review",
    secondPerson: "reviewer ≠ activator (route CONNECTION_REVIEW_SAME_PERSON)",
    allowedRoles: ["security_operator"],
  },

  /**
   * Break-glass elevation management — 02 §2.6.
   *
   * Only `security_operator` holders request, approve, record the incident and release. The
   * requester is the one elevated; the DB refuses approval or release by that same person
   * (`break_glass_two_person`). Auditors read.
   */
  "break_glass.read": {
    action: "break_glass.read",
    allowedRoles: ["security_operator", "auditor"],
  },
  "break_glass.request": {
    action: "break_glass.request",
    allowedRoles: ["security_operator"],
  },
  "break_glass.approve": {
    action: "break_glass.approve",
    secondPerson: "elevated subject ≠ approver (break_glass_two_person, 0073)",
    allowedRoles: ["security_operator"],
  },
  "break_glass.incident": {
    action: "break_glass.incident",
    allowedRoles: ["security_operator"],
  },
  "break_glass.release": {
    action: "break_glass.release",
    secondPerson: "elevated subject ≠ releaser (break_glass_release_two_person, 0073)",
    allowedRoles: ["security_operator"],
  },
  /**
   * Access quarantine under an active elevation — 02 §2.6 "access quarantine".
   *
   * **Only the `break_glass` role holds it,** and that role is never a standing binding: the
   * session carries it only while an approved elevation is unexpired, unreleased and not
   * overdue on its incident record.
   */
  "break_glass.quarantine": {
    action: "break_glass.quarantine",
    allowedRoles: [BREAK_GLASS_ROLE],
  },
};

/**
 * Every role that can act as the second person of a two-person rule — derived from the
 * `secondPerson` marks above, so a role added to a marked action is covered without a second
 * edit.
 *
 * A UI wallet binding is a one-person act. An operator who binds their own key to a holder of
 * one of these roles stands on both sides of a rule, so the admin routes refuse that binding
 * and refuse granting these roles to a subject whose key was bound from the UI.
 */
export const SECOND_PERSON_ROLES: readonly string[] = [
  ...new Set(
    Object.values(ACTION_POLICIES)
      .filter((policy) => policy.secondPerson !== undefined)
      .flatMap((policy) => policy.allowedRoles),
  ),
].sort();
