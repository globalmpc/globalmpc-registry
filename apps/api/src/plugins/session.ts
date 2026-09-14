import { randomBytes } from "node:crypto";
import type postgres from "postgres";
import { recoverMessageAddress } from "viem";
import { parseSiweMessage } from "viem/siwe";
import { TENANT_WIDE_ROLES, type AssuranceLevel } from "@mpc/api-contract";
import { withTenant } from "@mpc/db";
import type { AppConfig } from "../config.js";
import { unauthorized } from "../errors.js";

export interface Session {
  readonly walletAddress: `0x${string}`;
  readonly chainId: number;
  readonly subjectId: string | null;
  readonly tenantId: string | null;
  readonly assuranceLevel: AssuranceLevel;
  readonly roleBindings: readonly {
    readonly role: string;
    readonly organizationId: string | null;
    readonly projectId: string | null;
  }[];
  readonly projectIds: readonly string[];
  /**
   * Organization ID → project IDs owned by that organization.
   *
   * Determines how far a party role's organization-level binding reaches. If absent,
   * it reaches no project (narrowed, not widened).
   */
  readonly organizationProjectIds?: Readonly<Record<string, readonly string[]>>;
}

const NONCE_TTL_MS = 10 * 60 * 1000;

export const SIWE_STATEMENT =
  "Sign in to MPC Registry. This signature does not move assets or grant any approval.";

export async function issueNonce(
  sql: postgres.Sql,
  walletAddress: string,
  chainId: number,
): Promise<{ nonce: string; expiresAt: string }> {
  // A SIWE nonce must be at least 8 alphanumeric characters (EIP-4361).
  const nonce = randomBytes(12).toString("hex");
  const expiresAt = new Date(Date.now() + NONCE_TTL_MS).toISOString();

  await sql`
    INSERT INTO core.siwe_nonces (nonce, wallet_address, chain_id, expires_at)
    VALUES (${nonce}, ${walletAddress.toLowerCase()}, ${chainId}, ${expiresAt})
  `;

  return { nonce, expiresAt };
}

/**
 * SIWE verification — ADR-T06.
 *
 * Checks: signature validity, domain match, chainId match, unused nonce, expiry.
 * Does not check: who this address is. Identity binding is a separate record (02 §2.9).
 *
 * Only EOA signatures are supported. `recoverMessageAddress` recovers the address locally
 * without RPC, so the login path does not depend on external node availability. Smart contract
 * wallets (EIP-1271) need RPC and are deferred to a separate decision.
 */
export async function verifySiwe(
  sql: postgres.Sql,
  config: AppConfig,
  message: string,
  signature: `0x${string}`,
): Promise<Session> {
  const parsed = parseSiweMessage(message);
  if (!parsed.address || !parsed.nonce) {
    throw unauthorized("SIWE_MESSAGE_INVALID", "Cannot parse the SIWE message");
  }

  if (parsed.domain !== config.siweDomain) {
    throw unauthorized("SIWE_DOMAIN_MISMATCH", "The message domain does not match this service");
  }
  if (parsed.chainId !== config.chainId) {
    throw unauthorized("SIWE_CHAIN_MISMATCH", "The message chain ID does not match this service");
  }
  if (parsed.expirationTime && parsed.expirationTime.getTime() < Date.now()) {
    throw unauthorized("SIWE_MESSAGE_EXPIRED", "The message has expired");
  }
  /**
   * `notBefore` is the signer stating "do not use before this time".
   *
   * Ignoring it makes that declaration meaningless and lets a pre-signed message be used outside
   * the time the signer intended. That is why EIP-4361 defines the field.
   */
  if (parsed.notBefore && parsed.notBefore.getTime() > Date.now()) {
    throw unauthorized("SIWE_MESSAGE_NOT_YET_VALID", "The message is not valid yet");
  }
  /**
   * `uri` is compared too — 07 §7.1.
   *
   * Checking only the domain lets a signature lured from another origin on the same host pass.
   * What the wallet showed the user and what the server accepts must be the same.
   */
  if (parsed.uri !== config.siweUri) {
    throw unauthorized("SIWE_URI_MISMATCH", "The message uri does not match this service");
  }

  const address = parsed.address.toLowerCase() as `0x${string}`;

  // Consume the nonce atomically. If two requests arrive together, only one succeeds.
  const [consumed] = await sql<{ nonce: string }[]>`
    UPDATE core.siwe_nonces
    SET consumed_at = now()
    WHERE nonce = ${parsed.nonce}
      AND consumed_at IS NULL
      AND expires_at > now()
      AND wallet_address = ${address}
    RETURNING nonce
  `;

  if (!consumed) {
    throw unauthorized("SIWE_NONCE_ALREADY_USED", "This nonce has already been used or has expired");
  }

  let recovered: string;
  try {
    recovered = (await recoverMessageAddress({ message, signature })).toLowerCase();
  } catch {
    throw unauthorized("SIWE_SIGNATURE_INVALID", "Cannot verify the signature");
  }

  if (recovered !== address) {
    throw unauthorized("SIWE_SIGNATURE_INVALID", "The signer does not match the message address");
  }

  return resolveSession(sql, address, config.chainId);
}

/**
 * wallet → identity and role resolution.
 *
 * 02 §2.9: the wallet is an authentication method; identity binding, credential, role binding,
 * and assignment are each separate records. Without a link the state is `wallet_only`, which
 * allows only public read and governance participation (OD-04).
 */
export async function resolveSession(
  sql: postgres.Sql,
  walletAddress: `0x${string}`,
  chainId: number,
): Promise<Session> {
  // At login the tenant is not yet known, so RLS policies cannot be satisfied.
  // Only the auth path is split into SECURITY DEFINER functions (0005_session_resolver.sql).
  // No path other than these two functions bypasses RLS.
  const [identity] = await sql<
    { subject_id: string | null; tenant_id: string; assurance_level: AssuranceLevel }[]
  >`
    SELECT * FROM core.resolve_wallet_session(${walletAddress}, ${chainId})
  `;

  if (!identity || identity.subject_id === null) {
    return {
      walletAddress,
      chainId,
      subjectId: null,
      tenantId: identity?.tenant_id ?? null,
      assuranceLevel: "wallet_only",
      roleBindings: [],
      projectIds: [],
    };
  }

  const bindings = await sql<
    { role: string; organization_id: string | null; project_id: string | null }[]
  >`
    SELECT * FROM core.resolve_role_bindings(${identity.subject_id})
  `;

  return {
    walletAddress,
    chainId,
    subjectId: identity.subject_id,
    tenantId: identity.tenant_id,
    assuranceLevel: identity.assurance_level,
    roleBindings: bindings.map((row) => ({
      role: row.role,
      organizationId: row.organization_id,
      projectId: row.project_id,
    })),
    projectIds: bindings
      .map((row) => row.project_id)
      .filter((value): value is string => value !== null),
    organizationProjectIds: await resolveOrganizationProjects(sql, identity.tenant_id, bindings),
  };
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
