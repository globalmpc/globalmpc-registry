import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { z } from "zod";
import { withTenant } from "@mpc/db";
import {
  ACTION_POLICIES,
  ROLE_MINIMUM_ASSURANCE,
  satisfiesAssurance,
  type AssuranceLevel,
} from "@mpc/api-contract";
import { notFound } from "../errors.js";
import { assertAuthorized, projectResource, sessionFacts } from "../plugins/authorize.js";
import { requireReadContext } from "./shared.js";

/**
 * Review assignment options — Q-032.
 *
 * The assignment form used to send one fixed reviewer, credential, and schema (the E2E seed's
 * ids), so on any real tenant every assignment failed. This read returns what an assignment on
 * this project can actually use, and nothing an assignee could never sign with:
 *
 * - a reviewer-role binding that is not revoked and reaches this project (organization-level
 *   reviewer bindings reach every project — reviewer roles are tenant-wide; a project-level
 *   binding reaches only its project);
 * - an active wallet whose assurance meets that role's minimum, or signing is refused later;
 * - credentials that are valid now; schemas that are active.
 *
 * Authorized with `claim.curate`, the action that creates the assignment. Reviewers and
 * role-less sessions do not assign, so they have no reason to browse other reviewers'
 * credentials.
 */

/** Roles that sign attestations. Read from the policy table so a new reviewer role is included. */
const REVIEWER_ROLES: readonly string[] = ACTION_POLICIES["attestation.sign"]?.allowedRoles ?? [];

const projectIdSchema = z.string().uuid();

type Tx = postgres.TransactionSql;

interface BindingRow {
  subject_id: string;
  display_name: string;
  role: string;
}

interface WalletRow {
  subject_id: string;
  assurance_level: AssuranceLevel;
}

interface CredentialRow {
  id: string;
  subject_id: string;
  credential_type: string;
  issuer_reference: string;
  credential_scope: string[];
  jurisdiction: string[];
  expires_at: Date | null;
}

interface SchemaRow {
  id: string;
  schema_key: string;
  schema_version: string;
  attestation_type: string;
  jurisdiction_profile: string;
}

/** Roles the subject can exercise with at least one of its active wallets. */
function exercisableRoles(roles: readonly string[], levels: readonly AssuranceLevel[]): string[] {
  return [...new Set(roles)]
    .filter((role) => {
      const required = ROLE_MINIMUM_ASSURANCE[role] ?? "high_assurance";
      return levels.some((level) => satisfiesAssurance(level, required));
    })
    .sort();
}

function toCredential(row: CredentialRow) {
  return {
    id: row.id,
    credentialType: row.credential_type,
    issuerReference: row.issuer_reference,
    scope: row.credential_scope,
    jurisdiction: row.jurisdiction,
    expiresAt: row.expires_at?.toISOString() ?? null,
  };
}

async function readReviewers(tx: Tx, tenantId: string, projectId: string) {
  const bindings = await tx<BindingRow[]>`
    SELECT rb.subject_id, s.display_name, rb.role
    FROM core.role_bindings rb
    JOIN core.subjects s ON s.id = rb.subject_id
    WHERE rb.tenant_id = ${tenantId}
      AND rb.revoked_at IS NULL
      AND rb.role = ANY(${[...REVIEWER_ROLES]})
      AND (rb.project_id IS NULL OR rb.project_id = ${projectId})
    ORDER BY s.display_name, rb.subject_id
  `;
  const subjectIds = [...new Set(bindings.map((row) => row.subject_id))];
  if (subjectIds.length === 0) return [];

  const wallets = await tx<WalletRow[]>`
    SELECT subject_id, assurance_level
    FROM core.wallet_identities
    WHERE tenant_id = ${tenantId} AND subject_id = ANY(${subjectIds}::uuid[])
      AND disabled_at IS NULL
  `;
  const credentials = await tx<CredentialRow[]>`
    SELECT id, subject_id, credential_type, issuer_reference, credential_scope,
           jurisdiction, expires_at
    FROM core.credentials
    WHERE tenant_id = ${tenantId} AND subject_id = ANY(${subjectIds}::uuid[])
      AND current_status = 'valid' AND revoked_at IS NULL
      AND issued_at <= now() AND (expires_at IS NULL OR expires_at > now())
    ORDER BY issued_at DESC, id
  `;

  return subjectIds.flatMap((subjectId) => {
    const own = bindings.filter((row) => row.subject_id === subjectId);
    const roles = exercisableRoles(
      own.map((row) => row.role),
      wallets.filter((row) => row.subject_id === subjectId).map((row) => row.assurance_level),
    );
    if (roles.length === 0) return [];
    return [
      {
        subjectId,
        displayName: own[0]!.display_name,
        roles,
        credentials: credentials.filter((row) => row.subject_id === subjectId).map(toCredential),
      },
    ];
  });
}

async function readSchemas(tx: Tx, tenantId: string) {
  const rows = await tx<SchemaRow[]>`
    SELECT id, schema_key, schema_version, attestation_type::text AS attestation_type,
           jurisdiction_profile
    FROM core.attestation_schemas
    WHERE tenant_id = ${tenantId} AND state = 'active'
    ORDER BY schema_key, schema_version, id
  `;
  return rows.map((row) => ({
    id: row.id,
    schemaKey: row.schema_key,
    schemaVersion: row.schema_version,
    attestationType: row.attestation_type,
    jurisdictionProfile: row.jurisdiction_profile,
  }));
}

export async function registerReviewOptionRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/review-assignment-options",
    async (request) => {
      const { session, tenantId } = requireReadContext(request);
      const { projectId } = request.params;

      assertAuthorized(
        session,
        "claim.curate",
        projectResource(tenantId, projectId),
        sessionFacts(session),
      );
      if (!projectIdSchema.safeParse(projectId).success) throw notFound("Project not found");

      const { requestId, asOf } = request.context;
      return withTenant(sql, { tenantId }, async (tx) => {
        // Another tenant's project is invisible under RLS; it reads as not found.
        const [project] = await tx<{ id: string }[]>`
          SELECT id FROM core.projects WHERE tenant_id = ${tenantId} AND id = ${projectId}
        `;
        if (!project) throw notFound("Project not found");

        return {
          reviewers: await readReviewers(tx, tenantId, projectId),
          schemas: await readSchemas(tx, tenantId),
          requestId,
          asOf,
        };
      });
    },
  );
}
