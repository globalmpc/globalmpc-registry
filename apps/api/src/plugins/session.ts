import type postgres from "postgres";
import {
  BREAK_GLASS_INCIDENT_DUE_HOURS,
  BREAK_GLASS_ROLE,
  deriveAuthenticationLevel,
  requiredAuthenticationLevel,
  satisfiesAuthenticationLevel,
  SERVICE_ONLY_ROLES,
  TENANT_WIDE_ROLES,
  type AssuranceLevel,
  type AuthenticationLevel,
  type FirstFactor,
  type SecondFactor,
  type ServiceScope,
} from "@mpc/api-contract";
import { withTenant } from "@mpc/db";
import type { ResolvedServiceToken, ResolvedSessionRow } from "./session-token.js";

type RoleBinding = {
  readonly role: string;
  readonly organizationId: string | null;
  readonly projectId: string | null;
  /**
   * Jurisdictions the binding is limited to (02 §2.5). `null` or absent: not scoped.
   */
  readonly jurisdiction?: readonly string[] | null;
  /** Set only on the `break_glass` binding: the elevation that grants it. */
  readonly elevationId?: string;
};

/**
 * Who is calling, resolved once per request.
 *
 * `principal` separates a person's session from a service token. A service has no factors and no
 * AAL; what it may reach is fixed by its token's scopes (server.ts) and its subject's roles.
 */
export interface Session {
  readonly principal: "person" | "service";
  /** The session id, or the service token id. Recorded in sign-in and sign-out audit rows. */
  readonly sessionId: string;
  /**
   * Every session belongs to a subject in a tenant. Typed nullable because routes written for the
   * former unbound wallet session still check it; the resolvers never return null here.
   */
  readonly subjectId: string | null;
  readonly tenantId: string | null;
  /** Identity assurance of the subject (admin-set). Not the authentication level. */
  readonly assuranceLevel: AssuranceLevel;
  /** Null for a service. */
  readonly firstFactor: FirstFactor | null;
  readonly secondFactor: SecondFactor | null;
  /**
   * Restored by a recovery code and not yet past a real factor (WP3): the request hook lets it
   * reach only `allowsRecoveryLimited` routes, and none of its roles is effective.
   */
  readonly recoveryLimited: boolean;
  /** Derived from the factors (`deriveAuthenticationLevel`). Null for a service. */
  readonly aal: AuthenticationLevel | null;
  /** The token's scopes. Only on a service session. */
  readonly serviceScopes?: readonly ServiceScope[];
  /**
   * The **effective** role bindings: those whose AAL minimum this session meets. Everything that
   * authorizes reads this list, so a narrowed role cannot be used by any path.
   */
  readonly roleBindings: readonly RoleBinding[];
  /** Roles the subject holds that this session does not meet (priority rule 4). */
  readonly narrowedRoles: readonly { readonly role: string; readonly requiredAal: AuthenticationLevel | null }[];
  readonly projectIds: readonly string[];
  /**
   * Organization ID → project IDs owned by that organization.
   *
   * Determines how far a party role's organization-level binding reaches. If absent,
   * it reaches no project (narrowed, not widened).
   */
  readonly organizationProjectIds?: Readonly<Record<string, readonly string[]>>;
  /**
   * Project ID → host jurisdiction, for the tenant's projects.
   *
   * Loaded only when a binding is jurisdiction-scoped. If absent, a scoped binding reaches no
   * project (narrowed, not widened).
   */
  readonly projectJurisdictions?: Readonly<Record<string, string>>;
  /** Device facts the server can see, for the audit record (02 §2.7). Filled per request. */
  readonly device?: { readonly userAgentHash: string | null };
}

/**
 * Session row → request session.
 *
 * Priority rule 1 lives in the database (revoked, expired, idle). The AAL is derived from the
 * factors, and the subject's roles are narrowed to those this AAL meets (rule 4). Rule 2 — a
 * first-factor-only session reaches only MFA, logout and its own session — is the request hook's
 * (server.ts).
 */
export async function resolveSession(sql: postgres.Sql, row: ResolvedSessionRow): Promise<Session> {
  const aal = deriveAuthenticationLevel({ firstFactor: row.firstFactor, secondFactor: row.secondFactor });

  return {
    principal: "person",
    sessionId: row.sessionId,
    firstFactor: row.firstFactor,
    secondFactor: row.secondFactor,
    recoveryLimited: row.recoveryLimited,
    aal,
    subjectId: row.subjectId,
    tenantId: row.tenantId,
    assuranceLevel: row.assuranceLevel,
    ...(await resolveAuthority(sql, row.tenantId, row.subjectId, (role) => {
      const required = requiredAuthenticationLevel(role);
      // A recovery code proves possession of a printed code, not of an authenticator: until the
      // session enrols or proves one, no role is effective, whatever level it would need.
      if (row.recoveryLimited) return required;
      return required !== null && satisfiesAuthenticationLevel(aal, required) ? true : required;
    })),
  };
}

/**
 * Service token → request session.
 *
 * No factors and no AAL: a service proves possession of its token, and its reach is the token's
 * scopes (enforced before any route runs) and its subject's roles.
 */
export async function resolveServiceSession(
  sql: postgres.Sql,
  token: ResolvedServiceToken,
): Promise<Session> {
  return {
    principal: "service",
    sessionId: token.tokenId,
    subjectId: token.subjectId,
    tenantId: token.tenantId,
    assuranceLevel: token.assuranceLevel,
    firstFactor: null,
    secondFactor: null,
    recoveryLimited: false,
    aal: null,
    serviceScopes: token.scopes,
    // Only service roles take effect through a token. A person role the subject holds (by
    // mistake or on purpose) stays narrowed, so a token never acts as a person.
    ...(await resolveAuthority(sql, token.tenantId, token.subjectId, (role) =>
      SERVICE_ONLY_ROLES.includes(role) ? true : null,
    )),
  };
}

/**
 * The subject's role bindings, narrowed, and what those bindings reach.
 *
 * `meets(role)` is `true` when the role is effective in this session, otherwise the AAL it would
 * need (`null`: never in this kind of session). Narrowing happens before anything is derived from
 * the bindings, so a narrowed role reaches no project and grants no elevation.
 */
async function resolveAuthority(
  sql: postgres.Sql,
  tenantId: string,
  subjectId: string,
  meets: (role: string) => true | AuthenticationLevel | null,
): Promise<
  Pick<Session, "roleBindings" | "narrowedRoles" | "projectIds" | "organizationProjectIds" | "projectJurisdictions">
> {
  const held = await sql<
    {
      role: string;
      organization_id: string | null;
      project_id: string | null;
      jurisdiction: string[] | null;
    }[]
  >`
    SELECT * FROM core.resolve_role_bindings(${subjectId})
  `;

  const narrowed = new Map<string, AuthenticationLevel | null>();
  const bindings = held.filter((row) => {
    const verdict = meets(row.role);
    if (verdict === true) return true;
    narrowed.set(row.role, verdict);
    return false;
  });

  // Only a current, effective `security_operator` holder can be elevated. Revoking that role ends
  // any elevation with it, and sessions without it skip the lookup. The elevation is itself a role
  // with its own minimum.
  let elevation: string | null = null;
  if (bindings.some((row) => row.role === "security_operator")) {
    const candidate = await resolveBreakGlassElevation(sql, tenantId, subjectId);
    if (candidate !== null) {
      const verdict = meets(BREAK_GLASS_ROLE);
      if (verdict === true) elevation = candidate;
      else narrowed.set(BREAK_GLASS_ROLE, verdict);
    }
  }
  const scoped = bindings.some((row) => row.jurisdiction !== null);

  return {
    roleBindings: [
      ...bindings.map((row) => ({
        role: row.role,
        organizationId: row.organization_id,
        projectId: row.project_id,
        // Only scoped bindings carry the key, so unscoped ones read exactly as before.
        ...(row.jurisdiction !== null ? { jurisdiction: row.jurisdiction } : {}),
      })),
      ...(elevation
        ? [{ role: BREAK_GLASS_ROLE, organizationId: null, projectId: null, elevationId: elevation }]
        : []),
    ],
    narrowedRoles: [...narrowed].map(([role, requiredAal]) => ({ role, requiredAal })),
    projectIds: bindings
      .map((row) => row.project_id)
      .filter((value): value is string => value !== null),
    organizationProjectIds: await resolveOrganizationProjects(sql, tenantId, bindings),
    ...(scoped
      ? {
          projectJurisdictions: await resolveProjectJurisdictions(
            sql,
            tenantId,
            [...new Set(bindings.flatMap((row) => row.jurisdiction ?? []))],
          ),
        }
      : {}),
  };
}

/**
 * The subject's effective break-glass elevation, if any — 02 §2.6.
 *
 * **Expiry is evaluated here, on every request,** against the database clock. Nothing has to run
 * for an elevation to end: once `expires_at` passes, the next request resolves without the
 * `break_glass` binding. The same holds for an elevation whose incident record is overdue.
 */
async function resolveBreakGlassElevation(
  sql: postgres.Sql,
  tenantId: string,
  subjectId: string,
): Promise<string | null> {
  const [row] = await withTenant(sql, { tenantId }, (tx) =>
    tx<{ id: string }[]>`
      SELECT id FROM core.break_glass_elevations
      WHERE subject_id = ${subjectId}
        AND state = 'active'
        AND expires_at > now()
        AND (
          incident_recorded_at IS NOT NULL
          OR decided_at + make_interval(hours => ${BREAK_GLASS_INCIDENT_DUE_HOURS}) > now()
        )
      LIMIT 1
    `,
  );
  return row?.id ?? null;
}

/** Host jurisdiction of every project in the tenant. Read only for jurisdiction-scoped sessions. */
async function resolveProjectJurisdictions(
  sql: postgres.Sql,
  tenantId: string,
  jurisdictions: readonly string[],
): Promise<Readonly<Record<string, string>>> {
  // Only projects inside the scoped bindings' jurisdictions. One outside them is absent, which
  // the decision reads as a mismatch, the same answer its host country would give. Unscoped
  // bindings do not read the jurisdiction at all.
  const rows = await withTenant(sql, { tenantId }, (tx) =>
    tx<{ id: string; host_country_iso3: string }[]>`
      SELECT id, host_country_iso3 FROM core.projects
      WHERE host_country_iso3 = ANY(${jurisdictions as string[]}::text[])
    `,
  );
  return Object.fromEntries(rows.map((row) => [row.id, row.host_country_iso3]));
}

/**
 * Project list for organization-level bindings, narrowed to the owning organization.
 *
 * Sessions are re-resolved per request (server.ts), so a new project an organization creates
 * is reachable from the next request. The tenant is known by then, so it reads via RLS (`withTenant`).
 */
async function resolveOrganizationProjects(
  sql: postgres.Sql,
  tenantId: string,
  bindings: readonly { role: string; organization_id: string | null; project_id: string | null }[],
): Promise<Readonly<Record<string, readonly string[]>>> {
  const organizations = [
    ...new Set(
      bindings
        .filter(
          (row) =>
            row.project_id === null &&
            row.organization_id !== null &&
            !TENANT_WIDE_ROLES.includes(row.role),
        )
        .map((row) => row.organization_id as string),
    ),
  ];
  if (organizations.length === 0) return {};

  const rows = await withTenant(sql, { tenantId }, (tx) =>
    tx<{ id: string; owner_organization_id: string }[]>`
      SELECT id, owner_organization_id
      FROM core.projects
      WHERE owner_organization_id = ANY(${organizations}::uuid[])
    `,
  );

  return organizations.reduce<Record<string, readonly string[]>>(
    (acc, organizationId) => ({
      ...acc,
      [organizationId]: rows
        .filter((row) => row.owner_organization_id === organizationId)
        .map((row) => row.id),
    }),
    {},
  );
}
