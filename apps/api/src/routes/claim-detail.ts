import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { withTenant } from "@mpc/db";
import { createClaimDerivationRequest } from "@mpc/api-contract";
import { badRequest, conflict, notFound, unprocessable } from "../errors.js";
import { assertAuthorized, projectResource, sessionFacts } from "../plugins/authorize.js";
import { hashRequest, withIdempotency } from "../plugins/idempotency.js";
import { recordAudit } from "../audit.js";
import { enqueueEvent } from "../outbox.js";
import { requireMutationContext, requireReadContext } from "./shared.js";

/**
 * Claim Detail — spec 11 §11.3, 04 §4.2.
 *
 * The claim page used to find its claim in the project's claim list, which carries the value and
 * grade only. The screen needs the original statement with its source coordinate, the
 * attestations that cover it with their limitations, conflicts, how a derived value was
 * calculated, its version history and whether a published record containing it was anchored.
 *
 * **Anchors are listed as inclusion, not truth.** A claim reaches the chain only inside a
 * registry version; the proof says those bytes were included, never that the value is right
 * (04 invariant 9).
 */

interface ClaimRow {
  catalog_entry_id: string | null;
  catalog_version: number | null;
  structured_values: Record<string, string | boolean> | null;
  document_upload_ids: string[];
  id: string;
  project_id: string;
  claim_type: string;
  value_text: string;
  unit: string | null;
  as_of: Date | null;
  source_coordinate: Record<string, unknown>;
  source_receipt_id: string | null;
  evidence_tier: string | null;
  verification_state: string;
  grade: "rejected" | "unverified" | "self_reported" | "partially_verified" | "verified";
  excluded_by_rule: boolean;
  stale_since: Date | null;
  version: number;
}

async function readClaim(tx: postgres.TransactionSql, tenantId: string, claimId: string) {
  const [claim] = await tx<ClaimRow[]>`
    SELECT catalog_entry_id, catalog_version, structured_values, document_upload_ids, id, project_id, claim_type, value_text, unit, as_of, source_coordinate,
           source_receipt_id, evidence_tier, verification_state, grade, excluded_by_rule,
           stale_since, version
    FROM core.claims WHERE tenant_id = ${tenantId} AND id = ${claimId}
  `;
  return claim;
}

async function readDerivation(tx: postgres.TransactionSql, tenantId: string, claimId: string) {
  const [row] = await tx<
    {
      claim_id: string;
      formula: string;
      input_claim_ids: string[];
      unit: string | null;
      as_of: Date | null;
      author_subject_id: string;
      recorded_at: Date;
    }[]
  >`
    SELECT claim_id, formula, input_claim_ids, unit, as_of, author_subject_id, recorded_at
    FROM core.claim_derivations WHERE tenant_id = ${tenantId} AND claim_id = ${claimId}
  `;
  if (!row) return null;
  return {
    claimId: row.claim_id,
    formula: row.formula,
    inputClaimIds: row.input_claim_ids,
    unit: row.unit,
    asOf: row.as_of ? row.as_of.toISOString().slice(0, 10) : null,
    authorSubjectId: row.author_subject_id,
    recordedAt: row.recorded_at.toISOString(),
  };
}

export async function registerClaimDetailRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  app.get<{ Params: { claimId: string } }>("/api/v1/claims/:claimId", async (request) => {
    const { session, tenantId } = requireReadContext(request);
    const { claimId } = request.params;
    const { requestId, asOf } = request.context;

    return withTenant(sql, { tenantId }, async (tx) => {
      const claim = await readClaim(tx, tenantId, claimId);
      if (!claim) throw notFound("Claim not found");
      // Project scope is known only after the lookup; a denial and a miss are both answered
      // without the claim's content.
      assertAuthorized(
        session,
        "evidence.read",
        projectResource(tenantId, claim.project_id),
        sessionFacts(session),
      );

      const attestations = await tx<
        {
          id: string;
          attestation_type: string;
          state: string;
          limitations: string;
          signed_at: Date;
          valid_until: Date | null;
          credential_status_snapshot: unknown;
          supersedes_id: string | null;
        }[]
      >`
        SELECT id, attestation_type, state, limitations, signed_at, valid_until,
               credential_status_snapshot, supersedes_id
        FROM core.verification_attestations
        WHERE tenant_id = ${tenantId} AND ${claimId}::uuid = ANY(claim_scope)
        ORDER BY signed_at DESC
      `;
      const conflicts = await tx<
        { id: string; conflict_type: string; resolved_at: Date | null; created_at: Date }[]
      >`
        SELECT id, conflict_type, resolved_at, created_at FROM core.claim_conflicts
        WHERE tenant_id = ${tenantId} AND claim_id = ${claimId}
        ORDER BY created_at DESC
      `;
      const edges = await tx<
        { relation_type: string; from_id: string; to_id: string; created_at: Date }[]
      >`
        SELECT relation_type, from_id, to_id, created_at FROM core.lineage_edges
        WHERE tenant_id = ${tenantId} AND (from_id = ${claimId} OR to_id = ${claimId})
        ORDER BY created_at
      `;
      const history = await tx<
        { command: string; before_version: number | null; after_version: number | null; occurred_at: Date }[]
      >`
        SELECT command, before_version, after_version, occurred_at FROM audit.events
        WHERE tenant_id = ${tenantId} AND resource_type = 'claim' AND resource_id = ${claimId}
        ORDER BY occurred_at, id
      `;
      const publishedIn = edges
        .filter((edge) => edge.relation_type === "published_in_registry" && edge.from_id === claimId)
        .map((edge) => edge.to_id);
      const anchors =
        publishedIn.length === 0
          ? []
          : await tx<
              {
                entry_version_id: string;
                merkle_root: string | null;
                tx_hash: string | null;
                chain_id: number | null;
                state: string | null;
              }[]
            >`
              SELECT v.id AS entry_version_id, b.merkle_root, t.tx_hash, t.chain_id,
                     t.state::text AS state
              FROM core.registry_entry_versions v
              LEFT JOIN chain.anchor_batch_leaves l ON l.entry_version_id = v.id
              LEFT JOIN chain.anchor_batches b ON b.id = l.batch_id
              LEFT JOIN chain.transactions t ON t.batch_id = b.id AND t.replaced_by_id IS NULL
              WHERE v.tenant_id = ${tenantId} AND v.id = ANY(${publishedIn}::uuid[])
            `;

      return {
        id: claim.id,
        projectId: claim.project_id,
        claimType: claim.claim_type,
        catalogEntryId: claim.catalog_entry_id,
        catalogVersion: claim.catalog_version,
        structuredValues: claim.structured_values,
        documentUploadIds: claim.document_upload_ids,
        valueText: claim.value_text,
        unit: claim.unit,
        asOf: claim.as_of ? claim.as_of.toISOString().slice(0, 10) : null,
        sourceCoordinate: claim.source_coordinate,
        sourceReceiptId: claim.source_receipt_id,
        evidenceTier: claim.evidence_tier,
        verificationState: claim.verification_state,
        grade: claim.grade,
        excludedByRule: claim.excluded_by_rule,
        staleSince: claim.stale_since?.toISOString() ?? null,
        version: claim.version,
        attestations: attestations.map((row) => ({
          id: row.id,
          attestationType: row.attestation_type,
          state: row.state,
          limitations: row.limitations,
          signedAt: row.signed_at.toISOString(),
          validUntil: row.valid_until?.toISOString() ?? null,
          // What the credential was when signed. Its current status is a separate question.
          credentialStatusAtSigning: row.credential_status_snapshot,
          supersedesId: row.supersedes_id,
        })),
        conflicts: conflicts.map((row) => ({
          id: row.id,
          conflictType: row.conflict_type,
          resolvedAt: row.resolved_at?.toISOString() ?? null,
          createdAt: row.created_at.toISOString(),
        })),
        conflictingClaimIds: edges
          .filter((edge) => edge.relation_type === "contradicts")
          .map((edge) => (edge.from_id === claimId ? edge.to_id : edge.from_id)),
        derivation: await readDerivation(tx, tenantId, claimId),
        lineage: edges
          .filter((edge) => edge.relation_type !== "contradicts")
          .map((edge) => ({
            relationType: edge.relation_type,
            fromId: edge.from_id,
            toId: edge.to_id,
            createdAt: edge.created_at.toISOString(),
          })),
        history: history.map((row) => ({
          command: row.command,
          beforeVersion: row.before_version,
          afterVersion: row.after_version,
          occurredAt: row.occurred_at.toISOString(),
        })),
        anchors: anchors.map((row) => ({
          entryVersionId: row.entry_version_id,
          merkleRoot: row.merkle_root,
          txHash: row.tx_hash,
          chainId: row.chain_id,
          transactionState: row.state,
        })),
        requestId,
        // `asOf` is the claim's own date; the response time goes under another name.
        responseAsOf: asOf,
      };
    });
  });

  /**
   * Record how a derived claim was calculated — 04 §4.2.
   *
   * Immutable and one per claim: a different formula yields a different value, which is a
   * different claim. The inputs must be claims of the same project, and each input gets a
   * `derived_from` lineage edge so a revoked input reaches this claim through the same traversal
   * as every other dependency (05 §5.5).
   */
  app.post<{ Params: { claimId: string } }>(
    "/api/v1/claims/:claimId/derivations",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      const parsed = createClaimDerivationRequest.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "Request format is invalid", {
          issues: parsed.error.issues,
        });
      }
      const data = parsed.data;
      const { claimId } = request.params;
      const { requestId, asOf, correlationId } = request.context;

      return withTenant(sql, { tenantId }, async (tx) => {
        // Authorized before the idempotency lookup, so a replayed key never answers someone
        // without claim.curate.
        const claim = await readClaim(tx, tenantId, claimId);
        if (!claim) throw notFound("Claim not found");
        const effectiveRole = assertAuthorized(
          session,
          "claim.curate",
          projectResource(tenantId, claim.project_id),
          sessionFacts(session),
        );

        return withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {

          const inputs = [...new Set(data.inputClaimIds)];
          if (inputs.includes(claimId)) {
            throw unprocessable("DERIVATION_SELF_INPUT", "A claim cannot be derived from itself");
          }
          const found = await tx<{ id: string }[]>`
            SELECT id FROM core.claims
            WHERE tenant_id = ${tenantId} AND project_id = ${claim.project_id}
              AND id = ANY(${inputs}::uuid[])
          `;
          if (found.length !== inputs.length) {
            const known = new Set(found.map((row) => row.id));
            throw unprocessable("DERIVATION_INPUT_NOT_IN_PROJECT", "Every input must be a claim of this project", {
              missing: inputs.filter((id) => !known.has(id)),
            });
          }
          if (await readDerivation(tx, tenantId, claimId)) {
            throw conflict("DERIVATION_EXISTS", "This claim already has a recorded derivation");
          }

          await tx`
            INSERT INTO core.claim_derivations (
              id, tenant_id, claim_id, formula, input_claim_ids, unit, as_of, author_subject_id
            ) VALUES (
              ${randomUUID()}, ${tenantId}, ${claimId}, ${data.formula}, ${inputs}::uuid[],
              ${data.unit}, ${data.asOf}, ${session.subjectId}
            )
          `;
          for (const input of inputs) {
            await tx`
              INSERT INTO core.lineage_edges (id, tenant_id, from_id, to_id, relation_type)
              VALUES (${randomUUID()}, ${tenantId}, ${claimId}, ${input}, 'derived_from')
              ON CONFLICT (from_id, to_id, relation_type) DO NOTHING
            `;
          }

          await recordAudit(tx, {
            tenantId,
            projectId: claim.project_id,
            session,
            effectiveRole,
            command: "claim.derivation.recorded",
            resourceType: "claim",
            resourceId: claimId,
            beforeVersion: claim.version,
            afterVersion: claim.version,
            correlationId,
            requestIp: request.clientIp,
            detail: { inputClaimIds: inputs },
          });
          await enqueueEvent(tx, {
            tenantId,
            eventType: "claim.derivation.recorded",
            aggregateId: claimId,
            aggregateVersion: claim.version,
            projectId: claim.project_id,
            payload: { inputCount: inputs.length },
            correlationId,
          });

          return { ...(await readDerivation(tx, tenantId, claimId))!, requestId, responseAsOf: asOf };
        });
      });
    },
  );
}
