import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import {
  ROLE_MINIMUM_ASSURANCE,
  SERVICE_ONLY_ROLES,
  SERVICE_SCOPES,
  type ServiceScope,
} from "@mpc/api-contract";
import { requireDeploymentOwner } from "./deploy-authority.js";
import { ROLE_DEPLOY_BOUND } from "./audit.js";
import { SERVICE_TOKEN_PREFIX, generateServiceToken, hashToken } from "./plugins/session-token.js";

/**
 * Service tokens — decision D7. Operator side (CLI), over the migration connection.
 *
 * The API only resolves tokens (`core.resolve_service_token`); issuing, rotating and revoking
 * happen here, run by someone with deployment access — the same trust as `bootstrap`. Every
 * change is written to the tenant's audit trail as `deploy_bound`: the runner is not a subject
 * the application knows, so no actor is invented.
 *
 * The raw token is returned once, to be stored in the service's secret store. Only its hash is
 * kept.
 *
 * A deployed service's token can instead be generated ahead of time (`generateServiceTokenValue`),
 * kept in the environment's secret store, and registered at deploy by `ensureServiceToken` — the
 * scan worker's path. Then no step after the migration needs a person to copy a value anywhere.
 */

export class ServiceTokenError extends Error {
  readonly code = "SERVICE_TOKEN_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ServiceTokenError";
  }
}

/** Longest lifetime a token may be issued for. The database allows a little more (0109). */
export const MAX_SERVICE_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;
/** Longest the old token keeps working after a rotation. */
export const MAX_ROTATION_OVERLAP_SECONDS = 7 * 24 * 60 * 60;

const LABEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * The exact shape `generateServiceToken` produces: the prefix and 32 random bytes, base64url.
 * `ensureServiceToken` accepts nothing else, so a hand-typed, truncated or placeholder value is
 * refused instead of becoming a credential that is weaker than the ones the CLI issues.
 */
export const SERVICE_TOKEN_PATTERN = new RegExp(`^${SERVICE_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`);

/** A new token for the environment's secret store. Touches no database; nothing is registered. */
export function generateServiceTokenValue(): string {
  return generateServiceToken().token;
}

function assertScopes(scopes: readonly string[]): asserts scopes is readonly ServiceScope[] {
  if (scopes.length === 0) throw new ServiceTokenError("at least one scope is required");
  const unknown = scopes.filter((scope) => !(SERVICE_SCOPES as readonly string[]).includes(scope));
  if (unknown.length > 0) {
    throw new ServiceTokenError(
      `unknown scope ${unknown.join(", ")}. Allowed: ${SERVICE_SCOPES.join(", ")}`,
    );
  }
}

function assertTtl(ttlSeconds: number): void {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > MAX_SERVICE_TOKEN_TTL_SECONDS) {
    throw new ServiceTokenError("ttl must be between 60 seconds and 365 days");
  }
}

function assertOverlap(overlapSeconds: number): void {
  if (
    !Number.isInteger(overlapSeconds) ||
    overlapSeconds < 0 ||
    overlapSeconds > MAX_ROTATION_OVERLAP_SECONDS
  ) {
    throw new ServiceTokenError("overlap must be between 0 seconds and 7 days");
  }
}

function assertLabel(label: string): void {
  if (!LABEL_PATTERN.test(label)) {
    throw new ServiceTokenError("label must be lowercase letters, digits, '.', '_' or '-' (max 64)");
  }
}

function assertServiceRole(role: string): void {
  if (!SERVICE_ONLY_ROLES.includes(role)) {
    throw new ServiceTokenError(
      `role must be a service role: ${SERVICE_ONLY_ROLES.join(", ")} — given ${role}`,
    );
  }
}

async function audit(
  tx: postgres.TransactionSql,
  input: { tenantId: string; command: string; tokenId: string; detail: Record<string, unknown> },
): Promise<void> {
  await tx`
    INSERT INTO audit.events (
      tenant_id, actor_subject_id, actor_wallet, effective_role,
      command, resource_type, resource_id, correlation_id, detail
    ) VALUES (
      ${input.tenantId}, NULL, NULL, ${ROLE_DEPLOY_BOUND},
      ${input.command}, 'service_token', ${input.tokenId}, ${`cli:${randomUUID()}`},
      ${tx.json(input.detail as never)}
    )
  `;
}

/**
 * Creates a service subject with one service role.
 *
 * Only `SERVICE_ONLY_ROLES` may be granted here: a service token makes no other role effective
 * anyway (session.ts), and granting a person role from a CLI would bypass the two-person grant.
 */
export async function createServiceSubject(
  sql: postgres.Sql,
  input: { tenantId: string; displayName: string; role: string },
): Promise<{ subjectId: string }> {
  assertServiceRole(input.role);
  if (input.displayName.trim() === "") throw new ServiceTokenError("display name is required");

  return sql.begin(async (tx) => insertServiceSubject(tx, input));
}

async function insertServiceSubject(
  tx: postgres.TransactionSql,
  input: { tenantId: string; displayName: string; role: string },
): Promise<{ subjectId: string }> {
  {
    const subjectId = randomUUID();
    await tx`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name, assurance_level)
      VALUES (
        ${subjectId}, ${input.tenantId}, 'service', ${input.displayName},
        ${ROLE_MINIMUM_ASSURANCE[input.role] ?? "high_assurance"}
      )
    `;
    await tx`
      INSERT INTO core.role_bindings (id, tenant_id, subject_id, role)
      VALUES (${randomUUID()}, ${input.tenantId}, ${subjectId}, ${input.role})
    `;
    await audit(tx, {
      tenantId: input.tenantId,
      command: "service_subject.created",
      tokenId: subjectId,
      detail: { subjectId, role: input.role },
    });
    return { subjectId };
  }
}

export interface IssuedServiceToken {
  readonly token: string;
  readonly tokenId: string;
  readonly expiresAt: string;
}

export async function issueServiceToken(
  sql: postgres.Sql,
  input: {
    tenantId: string;
    subjectId: string;
    scopes: readonly string[];
    label: string;
    ttlSeconds: number;
  },
): Promise<IssuedServiceToken> {
  const scopes = input.scopes;
  assertScopes(scopes);
  assertTtl(input.ttlSeconds);
  assertLabel(input.label);

  const { token, hash } = generateServiceToken();
  const inserted = await sql.begin(async (tx) =>
    insertToken(tx, { ...input, scopes, hash, rotatedFrom: null }),
  );
  return { token, ...inserted };
}

async function insertToken(
  tx: postgres.TransactionSql,
  input: {
    tenantId: string;
    subjectId: string;
    scopes: readonly ServiceScope[];
    label: string;
    ttlSeconds: number;
    hash: string;
    rotatedFrom: string | null;
    command?: string;
  },
): Promise<{ tokenId: string; expiresAt: string }> {
  const { hash } = input;
  const tokenId = randomUUID();
  const [row] = await tx<{ expires_at: Date }[]>`
    INSERT INTO core.service_tokens (
      id, tenant_id, subject_id, label, token_hash, scopes, expires_at, rotated_from
    ) VALUES (
      ${tokenId}, ${input.tenantId}, ${input.subjectId}, ${input.label}, ${hash},
      ${[...input.scopes]}::text[], now() + make_interval(secs => ${input.ttlSeconds}),
      ${input.rotatedFrom}
    )
    RETURNING expires_at
  `;
  await audit(tx, {
    tenantId: input.tenantId,
    command: input.command ?? (input.rotatedFrom ? "service_token.rotated" : "service_token.issued"),
    tokenId,
    detail: {
      subjectId: input.subjectId,
      label: input.label,
      scopes: [...input.scopes],
      expiresAt: row!.expires_at.toISOString(),
      ...(input.rotatedFrom ? { rotatedFrom: input.rotatedFrom } : {}),
    },
  });
  return { tokenId, expiresAt: row!.expires_at.toISOString() };
}

/**
 * Issues a successor with the same subject, label and scopes, and ends the old token after the
 * overlap — long enough to roll the new secret out, short enough that a leaked old one dies.
 */
export async function rotateServiceToken(
  sql: postgres.Sql,
  input: { tokenId: string; overlapSeconds: number; ttlSeconds: number },
): Promise<IssuedServiceToken & { readonly previousExpiresAt: string }> {
  assertTtl(input.ttlSeconds);
  assertOverlap(input.overlapSeconds);

  const { token, hash } = generateServiceToken();
  return sql.begin(async (tx) => {
    const [old] = await tx<
      { tenant_id: string; subject_id: string; label: string; scopes: ServiceScope[] }[]
    >`
      SELECT tenant_id, subject_id, label, scopes FROM core.service_tokens
      WHERE id = ${input.tokenId} AND revoked_at IS NULL AND expires_at > now()
      FOR UPDATE
    `;
    if (!old) throw new ServiceTokenError("no live token with that id");

    const [shortened] = await tx<{ expires_at: Date }[]>`
      UPDATE core.service_tokens
      SET expires_at = LEAST(expires_at, now() + make_interval(secs => ${input.overlapSeconds}))
      WHERE id = ${input.tokenId}
      RETURNING expires_at
    `;
    const issued = await insertToken(tx, {
      tenantId: old.tenant_id,
      subjectId: old.subject_id,
      scopes: old.scopes,
      label: old.label,
      ttlSeconds: input.ttlSeconds,
      hash,
      rotatedFrom: input.tokenId,
    });
    return { token, ...issued, previousExpiresAt: shortened!.expires_at.toISOString() };
  });
}

/** How long before expiry `ensureServiceToken` starts asking for a new value. */
export const ENSURE_RENEWAL_NOTICE_SECONDS = 30 * 24 * 60 * 60;

export interface EnsuredServiceToken {
  /**
   * `unchanged`: this token was already registered and live. `registered`: the service had no
   * live token. `rotated`: it had one; this token was added and the old ones end after the
   * overlap.
   */
  readonly outcome: "unchanged" | "registered" | "rotated";
  readonly subjectId: string;
  readonly subjectCreated: boolean;
  readonly tokenId: string;
  readonly expiresAt: string;
  /** Tokens of the same service whose expiry this call brought forward to the overlap. */
  readonly retired: readonly { readonly tokenId: string; readonly expiresAt: string }[];
  /** Expires within {@link ENSURE_RENEWAL_NOTICE_SECONDS}: generate and store a new value. */
  readonly renewalDue: boolean;
}

/**
 * Registers a token generated ahead of time, for a deployed service — the deploy-time half of
 * `generateServiceTokenValue`. Idempotent: run on every deploy, it changes nothing until the
 * stored value changes.
 *
 * The service is identified by tenant, role and label: a `service` subject named `label` holding
 * `role`, created on first use. Then, by the token's hash:
 *
 * - already this service's, live, same scopes → `unchanged` (its expiry is not extended: a
 *   static value still has to be replaced before it runs out — `renewalDue` says when);
 * - not registered → added; every other live token of the service now ends after the overlap
 *   (`rotated`), or there was none (`registered`);
 * - registered but revoked or expired → refused. A revocation must not be undone by the next
 *   deploy; store a new value instead;
 * - registered but superseded — a later token of the service exists, so a rotation already
 *   shortened this one to the overlap → refused. The stored value is out of date (rolled back,
 *   or a stale secret); reporting `unchanged` would let a deploy run on a token that is about to
 *   end;
 * - registered to another service, or with other scopes → refused.
 *
 * The token itself is never returned, logged or stored; only its keccak256 is.
 */
export async function ensureServiceToken(
  sql: postgres.Sql,
  input: {
    tenantId: string;
    label: string;
    role: string;
    scopes: readonly string[];
    token: string;
    ttlSeconds: number;
    overlapSeconds: number;
  },
): Promise<EnsuredServiceToken> {
  // Checked first, and the message never quotes the value.
  if (!SERVICE_TOKEN_PATTERN.test(input.token)) {
    throw new ServiceTokenError(
      `the token is not a generated service token (${SERVICE_TOKEN_PREFIX} and 43 base64url characters). ` +
        "Create one with `service-token generate`",
    );
  }
  const scopes = input.scopes;
  assertScopes(scopes);
  assertTtl(input.ttlSeconds);
  assertOverlap(input.overlapSeconds);
  assertLabel(input.label);
  assertServiceRole(input.role);
  const hash = hashToken(input.token);

  await requireDeploymentOwner(sql);
  return sql.begin(async (tx): Promise<EnsuredServiceToken> => {
    await tx`SELECT set_config('app.current_tenant', ${input.tenantId}, true)`;
    // Two deploys running the step at once would otherwise both see "not registered".
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`service-token-ensure:${input.tenantId}:${input.label}`}))`;

    const [found] = await tx<{ id: string }[]>`
      SELECT s.id FROM core.subjects s
      WHERE s.tenant_id = ${input.tenantId} AND s.kind = 'service' AND s.display_name = ${input.label}
        AND EXISTS (
          SELECT 1 FROM core.role_bindings b
          WHERE b.subject_id = s.id AND b.role = ${input.role} AND b.revoked_at IS NULL
        )
      ORDER BY s.created_at, s.id
      LIMIT 1
    `;
    const subjectCreated = !found;
    const subjectId =
      found?.id ??
      (await insertServiceSubject(tx, {
        tenantId: input.tenantId,
        displayName: input.label,
        role: input.role,
      })).subjectId;

    const [existing] = await tx<
      {
        id: string;
        tenant_id: string;
        subject_id: string;
        label: string;
        scopes: string[];
        revoked: boolean;
        expired: boolean;
        expires_at: Date;
        renewal_due: boolean;
        superseded: boolean;
      }[]
    >`
      SELECT t.id, t.tenant_id, t.subject_id, t.label, t.scopes,
             t.revoked_at IS NOT NULL AS revoked, t.expires_at <= now() AS expired, t.expires_at,
             t.expires_at <= now() + make_interval(secs => ${ENSURE_RENEWAL_NOTICE_SECONDS}) AS renewal_due,
             EXISTS (
               SELECT 1 FROM core.service_tokens n
               WHERE n.id <> t.id
                 AND (n.rotated_from = t.id
                   OR (n.subject_id = t.subject_id AND n.label = t.label AND n.issued_at > t.issued_at))
             ) AS superseded
      FROM core.service_tokens t WHERE t.token_hash = ${hash}
    `;
    if (existing) {
      if (
        existing.tenant_id !== input.tenantId ||
        existing.subject_id !== subjectId ||
        existing.label !== input.label
      ) {
        throw new ServiceTokenError("this token is registered for another service; generate a new one");
      }
      if (existing.revoked) {
        throw new ServiceTokenError(
          `token ${existing.id} was revoked; generate a new one and store it — a revocation is not undone by a deploy`,
        );
      }
      if (existing.expired) {
        throw new ServiceTokenError(`token ${existing.id} has expired; generate a new one and store it`);
      }
      if (existing.superseded) {
        throw new ServiceTokenError(
          `token ${existing.id} was replaced by a later token of this service and ends at ` +
            `${existing.expires_at.toISOString()}; the stored value is out of date — store the current ` +
            "value, or generate a new one",
        );
      }
      if ([...existing.scopes].sort().join(",") !== [...scopes].sort().join(",")) {
        throw new ServiceTokenError(
          `token ${existing.id} has scopes ${existing.scopes.join(",")}, not ${scopes.join(",")}; generate a new one`,
        );
      }
      return {
        outcome: "unchanged",
        subjectId,
        subjectCreated,
        tokenId: existing.id,
        expiresAt: existing.expires_at.toISOString(),
        retired: [],
        renewalDue: existing.renewal_due,
      };
    }

    const previous = await tx<{ id: string }[]>`
      SELECT id FROM core.service_tokens
      WHERE subject_id = ${subjectId} AND label = ${input.label}
        AND revoked_at IS NULL AND expires_at > now()
      ORDER BY issued_at DESC, id
    `;
    const inserted = await insertToken(tx, {
      tenantId: input.tenantId,
      subjectId,
      scopes,
      label: input.label,
      ttlSeconds: input.ttlSeconds,
      hash,
      rotatedFrom: previous[0]?.id ?? null,
      command: previous.length > 0 ? "service_token.rotated" : "service_token.registered",
    });
    const retired = previous.length === 0
      ? []
      : await tx<{ id: string; expires_at: Date }[]>`
          UPDATE core.service_tokens
          SET expires_at = LEAST(expires_at, now() + make_interval(secs => ${input.overlapSeconds}))
          WHERE id IN ${tx(previous.map((row) => row.id))}
          RETURNING id, expires_at
        `;

    return {
      outcome: previous.length > 0 ? "rotated" : "registered",
      subjectId,
      subjectCreated,
      tokenId: inserted.tokenId,
      expiresAt: inserted.expiresAt,
      retired: retired.map((row) => ({ tokenId: row.id, expiresAt: row.expires_at.toISOString() })),
      renewalDue: input.ttlSeconds <= ENSURE_RENEWAL_NOTICE_SECONDS,
    };
  }).catch((error: unknown) => {
    if ((error as { code?: string; constraint_name?: string }).code === "23505" &&
        (error as { constraint_name?: string }).constraint_name === "service_tokens_token_hash_key") {
      throw new ServiceTokenError("this token is registered for another service; generate a new one");
    }
    throw error;
  });
}

export async function revokeServiceToken(sql: postgres.Sql, tokenId: string): Promise<boolean> {
  return sql.begin(async (tx) => {
    const [row] = await tx<{ tenant_id: string }[]>`
      UPDATE core.service_tokens SET revoked_at = now()
      WHERE id = ${tokenId} AND revoked_at IS NULL
      RETURNING tenant_id
    `;
    if (!row) return false;
    await audit(tx, {
      tenantId: row.tenant_id,
      command: "service_token.revoked",
      tokenId,
      detail: {},
    });
    return true;
  });
}

export interface ServiceTokenSummary {
  readonly id: string;
  readonly subjectId: string;
  readonly label: string;
  readonly scopes: readonly string[];
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly lastUsedAt: string | null;
  readonly rotatedFrom: string | null;
}

/** Never returns hashes: a listing is for deciding what to rotate, not for authenticating. */
export async function listServiceTokens(
  sql: postgres.Sql,
  tenantId: string,
): Promise<ServiceTokenSummary[]> {
  const rows = await sql<
    {
      id: string;
      subject_id: string;
      label: string;
      scopes: string[];
      issued_at: Date;
      expires_at: Date;
      revoked_at: Date | null;
      last_used_at: Date | null;
      rotated_from: string | null;
    }[]
  >`
    SELECT id, subject_id, label, scopes, issued_at, expires_at, revoked_at, last_used_at, rotated_from
    FROM core.service_tokens WHERE tenant_id = ${tenantId}
    ORDER BY issued_at
  `;
  return rows.map((row) => ({
    id: row.id,
    subjectId: row.subject_id,
    label: row.label,
    scopes: row.scopes,
    issuedAt: row.issued_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    rotatedFrom: row.rotated_from,
  }));
}
