import { ACTION_POLICIES, ACCESS_REQUEST_PATHS } from "@mpc/api-contract";
import { AppError, forbidden, RegistrySubjectNotFoundError } from "../errors.js";
import { assertAuthorized, sessionFacts, registryResource, visibleProjectScope } from "../plugins/authorize.js";
import type { Session } from "../plugins/session.js";

/** Read-only scope resolution before any row lock; callers still enforce the full action policy. */
export async function authorizedProjectLookup<T>(
  session: Session,
  action: string,
  load: () => Promise<T>,
  projectOf: (value: T) => string | null,
): Promise<T> {
  const scope = visibleProjectScope(session, action);
  const deny = () => forbidden("AUTHORIZATION_DENIED", "You do not have permission to perform this action", {
    reason: "PROJECT_SCOPE_MISMATCH",
    requiredRoles: ACTION_POLICIES[action]?.allowedRoles ?? [],
    accessRequestPath: ACCESS_REQUEST_PATHS.role,
  });
  if (scope !== "all" && scope.length === 0) {
    // Preserve role, identity assurance and sign-in step-up guidance without naming a target.
    assertAuthorized(session, action, registryResource({
      sensitivity: "public", requiresRegistryScope: true,
    }), sessionFacts(session));
    throw deny();
  }
  let value: T;
  try {
    value = await load();
  } catch (error) {
    // Scoped callers must not distinguish a missing target from an out-of-scope target.
    if (scope !== "all" && error instanceof AppError && (error.statusCode === 404 || error instanceof RegistrySubjectNotFoundError)) throw deny();
    throw error;
  }
  const projectId = projectOf(value);
  if (scope !== "all" && (projectId === null || !scope.includes(projectId))) throw deny();
  return value;
}
