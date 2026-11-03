import {
  ACTION_POLICIES,
  assuranceLevel as assuranceLevelSchema,
  ROLE_MINIMUM_ASSURANCE,
  satisfiesAssurance,
  type AssuranceLevel,
} from "@mpc/api-contract";
import type { SessionInfo } from "./api";

/**
 * What the screen may offer this session — guidance only.
 *
 * The server decides every request (02 §2.1); these helpers read the session the server returned
 * so the screen does not offer what every request would refuse. They never widen: a session the
 * helpers cannot judge is treated as holding nothing.
 */

type Session = Pick<
  SessionInfo,
  "authenticated" | "aal" | "recoveryLimited" | "roleBindings" | "narrowedRoles" | "assuranceLevel" | "actions" | "tenantId"
>;

/** Whether the session's effective roles allow this action (server-computed `actions`). */
export function can(session: Pick<SessionInfo, "actions"> | null | undefined, action: string): boolean {
  return session?.actions?.includes(action) ?? false;
}

/**
 * A role the subject holds that this session cannot use because the subject's identity assurance
 * is below the role's minimum (plan priority rule 4). Replacing an operator-bound wallet resets the
 * assurance to `wallet_only`, so a reviewer or approver lands here until an admin sets it again.
 */
export interface AssuranceNarrowedRole {
  readonly role: string;
  readonly requiredAssurance: AssuranceLevel;
}

function sessionAssurance(session: Session): AssuranceLevel | null {
  const parsed = assuranceLevelSchema.safeParse(session.assuranceLevel);
  return parsed.success ? parsed.data : null;
}

/**
 * Roles held at this session's sign-in level but not usable at the subject's assurance level —
 * the same rule the server's `usableBindings` applies (an unknown role needs `high_assurance`).
 */
export function assuranceNarrowedRoles(session: Session | null | undefined): readonly AssuranceNarrowedRole[] {
  if (!session?.authenticated) return [];
  const actual = sessionAssurance(session);
  const seen = new Set<string>();
  const narrowed: AssuranceNarrowedRole[] = [];
  for (const { role } of session.roleBindings ?? []) {
    if (seen.has(role)) continue;
    seen.add(role);
    const required = ROLE_MINIMUM_ASSURANCE[role] ?? "high_assurance";
    if (actual === null || !satisfiesAssurance(actual, required)) narrowed.push({ role, requiredAssurance: required });
  }
  return narrowed;
}

/** Roles in effect: held, met by the sign-in level, and met by the identity assurance. */
export function effectiveRoles(session: Session | null | undefined): readonly string[] {
  const narrowed = new Set(assuranceNarrowedRoles(session).map((entry) => entry.role));
  return [...new Set((session?.roleBindings ?? []).map((binding) => binding.role))].filter(
    (role) => !narrowed.has(role),
  );
}

/** Inactive roles (assurance) among those an action allows — what a screen explains up front. */
export function assuranceNarrowedFor(
  session: Session | null | undefined,
  actions: readonly string[],
): readonly AssuranceNarrowedRole[] {
  const allowed = new Set(actions.flatMap((action) => ACTION_POLICIES[action]?.allowedRoles ?? []));
  return assuranceNarrowedRoles(session).filter((entry) => allowed.has(entry.role));
}

/**
 * Signed in, past the second factor, in a tenant — and holding no role at all (plan §4 journey 1:
 * "access pending" until a two-person role grant lands). Roles held but narrowed by the sign-in
 * level are not pending: the person steps up instead.
 */
export function accessPending(session: Session | null | undefined): boolean {
  if (!session?.authenticated || !session.tenantId) return false;
  if (session.aal === "aal1" || session.recoveryLimited) return false;
  return (session.roleBindings?.length ?? 0) === 0 && (session.narrowedRoles?.length ?? 0) === 0;
}

/**
 * Holds roles, but none of them is usable: every one is below its identity-assurance minimum.
 * The workspace would show only refusals, so the gate explains this instead.
 */
export function rolesAllInactive(session: Session | null | undefined): boolean {
  if (!session?.authenticated || !session.tenantId) return false;
  if (session.aal === "aal1" || session.recoveryLimited) return false;
  if ((session.narrowedRoles?.length ?? 0) > 0) return false;
  return (session.roleBindings?.length ?? 0) > 0 && effectiveRoles(session).length === 0;
}
