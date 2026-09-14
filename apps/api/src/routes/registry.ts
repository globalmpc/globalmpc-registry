import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { z } from "zod";
import { withTenant } from "@mpc/db";
import { hashProjection, verifyMerkleProof, type Hex } from "@mpc/canonical";
import { checkPublishable, isPublicField } from "@mpc/domain";
import {
  PROOF_DOES_NOT_PROVE,
  PROOF_PROVES,
  publicProjection,
  publicRegistryListQuery,
} from "@mpc/api-contract";
import type { AppConfig } from "../config.js";
import { badRequest, conflict, notFound, unprocessable } from "../errors.js";
import {
  assertAuthorized,
  sessionFacts,
  tenantResource,
} from "../plugins/authorize.js";
import { hashRequest, withIdempotency } from "../plugins/idempotency.js";
import { recordAudit } from "../audit.js";
import { enqueueEvent } from "../outbox.js";
import {
  assertVersionMatches,
  etagOf,
  requireIfMatch,
  requireMutationContext,
  requireReadContext,
} from "./shared.js";
import { buildAnchorBatch, buildInclusionProof } from "../services/anchor-batch.js";

/**
 * Registry publication and public lookup — spec 05 §5.6·§5.7, 08 §8.11.
 *
 * What this route guarantees:
 *
 * - Publication is rejected if any field is outside the allowlist (AC-22).
 * - Natural-person identifiers are public only when all five safeguards are present (AC-32).
 * - A published version cannot be overwritten. Revoke is a new state, not a deletion.
 * - Public routes are unauthenticated and return only published versions.
 * - An inclusion proof is returned with what it does **not** prove (AC-23).
 */

const publishSchema = z.object({
  registryType: z.enum(["project", "verification", "asset"]),
  subjectId: z.string().uuid(),
  publicKey: z.string().min(1),
  projection: z.record(z.unknown()),
  sourceSnapshotHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  policyVersion: z.string().min(1),
  schemaVersion: z.string().min(1),
  containsPersonLevelIdentifier: z.boolean().default(false),
  personIdentifierSafeguards: z
    .object({
      lawfulBasisRecorded: z.boolean(),
      explicitPublicationApproval: z.boolean(),
      purposeRecorded: z.boolean(),
      retentionRecorded: z.boolean(),
      irreversibilityAcknowledged: z.boolean(),
    })
    .default({
      lawfulBasisRecorded: false,
      explicitPublicationApproval: false,
      purposeRecorded: false,
      retentionRecorded: false,
      irreversibilityAcknowledged: false,
    }),
  commercialReuse: z.enum(["confirmed", "unconfirmed", "prohibited"]).default("unconfirmed"),
  publishedAsCommercialBasis: z.boolean().default(false),
});

export async function registerRegistryRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
  config: AppConfig,
): Promise<void> {
  // --- Publish -----------------------------------------------------------

  app.post("/api/v1/registry-entries", async (request) => {
    const { session, tenantId, idempotencyKey } = requireMutationContext(request);

    const parsed = publishSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest("REQUEST_INVALID", "Request format is invalid", {
        issues: parsed.error.issues,
      });
    }

    const effectiveRole = assertAuthorized(
      session,
      "registry.publish",
      tenantResource(tenantId, {
        sensitivity: "public",
        state: "approved",
        statesAllowingAction: ["approved"],
      }),
      sessionFacts(session),
    );

    const data = parsed.data;
    const { requestId, asOf, correlationId } = request.context;
    const requestHash = hashRequest(request.body);

    // The domain decides publishability. The route does not rewrite the allowlist.
    const publishCheck = checkPublishable({
      fields: Object.keys(data.projection),
      sensitivity: "public",
      disclosureApproved: true,
      containsPersonLevelIdentifier: data.containsPersonLevelIdentifier,
      personIdentifierSafeguards: data.personIdentifierSafeguards,
      commercialReuse: data.commercialReuse,
      publishedAsCommercialBasis: data.publishedAsCommercialBasis,
    });

    if (!publishCheck.allowed) {
      throw unprocessable(publishCheck.reason, "This projection cannot be published", {
        offendingFields: publishCheck.offendingFields,
      });
    }

    // Filters once more through the schema. `.strict()` rejects fields outside the allowlist.
    const projectionCheck = publicProjection.safeParse(data.projection);
    if (!projectionCheck.success) {
      throw unprocessable("PUBLICATION_PROJECTION_INVALID", "Projection does not match the public schema", {
        issues: projectionCheck.error.issues,
      });
    }

    return withTenant(sql, { tenantId }, (tx) =>
      withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
        const [existingEntry] = await tx<{ id: string }[]>`
          SELECT id FROM core.registry_entries
          WHERE registry_type = ${data.registryType} AND public_key = ${data.publicKey}
        `;

        const entryId = existingEntry?.id ?? randomUUID();
        if (!existingEntry) {
          await tx`
            INSERT INTO core.registry_entries (
              id, tenant_id, registry_type, subject_id, public_key
            ) VALUES (
              ${entryId}, ${tenantId}, ${data.registryType}, ${data.subjectId}, ${data.publicKey}
            )
          `;
        }

        const [previous] = await tx<{ id: string; version: number }[]>`
          SELECT id, version FROM core.registry_entry_versions
          WHERE entry_id = ${entryId} ORDER BY version DESC LIMIT 1
        `;

        const versionId = randomUUID();
        const nextVersion = (previous?.version ?? 0) + 1;

        /**
         * `status` holds the lifecycle **after** publication.
         *
         * Storing the client's value as is would leave the first published version as `draft`,
         * because the UI sends the pre-publication state. But `registered` in 11 §11.4 means
         * "a Registry record exists", and this very request creates that record — so the moment
         * it is stored, it is no longer `draft`.
         *
         * The server decides. In the public projection, lifecycle is **not a value the client
         * gets to claim.**
         */
        const publishedProjection = { ...(data.projection as Record<string, unknown>) };
        if (data.registryType === "project") {
          const [current] = await tx<{ lifecycle_state: string }[]>`
            SELECT lifecycle_state FROM core.projects
            WHERE tenant_id = ${tenantId} AND id = ${data.subjectId}
          `;
          if (current) {
            // If it was `draft`, this publication moves it (below). Any other state
            // stays — publication does not push the state forward.
            publishedProjection["status"] =
              current.lifecycle_state === "draft" ? "registered" : current.lifecycle_state;
          }
        }
        const contentHash = hashProjection(publishedProjection as never);

        await tx`
          INSERT INTO core.registry_entry_versions (
            id, tenant_id, entry_id, version, status, public_projection,
            content_hash, source_snapshot_hash, policy_version, schema_version,
            previous_version_id, published_at
          ) VALUES (
            ${versionId}, ${tenantId}, ${entryId}, ${nextVersion}, 'published',
            ${tx.json(publishedProjection as never)}, ${contentHash}, ${data.sourceSnapshotHash},
            ${data.policyVersion}, ${data.schemaVersion}, ${previous?.id ?? null}, now()
          )
        `;

        // The previous version is not deleted; it is linked as superseded (invariant 4).
        if (previous) {
          await tx`
            UPDATE core.registry_entry_versions
            SET status = 'superseded', superseded_by_id = ${versionId}
            WHERE id = ${previous.id}
          `;
        }

        /**
         * 04 §4.3 — `draft→registered`.
         *
         * The transition table's guard is "Project Registry minimum fields and accountable subject",
         * and this publication is what satisfies it. It is done by someone who already holds
         * `registry.publish`, so no new permission is created.
         *
         * **Moves only from `draft`.** The `WHERE` is that guard — publishing from another state
         * leaves the state as is. Reverting suspended via publication would reinstate without
         * incident closure, and who decides that is not yet determined.
         *
         * Verification and asset registries do not mean the project is registered, so they are not
         * touched.
         */
        if (data.registryType === "project") {
          const moved = await tx<{ id: string; version: number }[]>`
            UPDATE core.projects
            SET lifecycle_state = 'registered', version = version + 1, updated_at = now()
            WHERE id = ${data.subjectId} AND lifecycle_state = 'draft'
            RETURNING id, version
          `;

          if (moved.length > 0) {
            /**
             * Also recorded in the transition history — migration `0031`.
             *
             * Why a separate table from the audit log: audit is "who did what" and history is
             * "where this project has been". Extracting the latter from the audit log would require
             * parsing command strings, which turns the strings into a schema.
             */
            await tx`
              INSERT INTO core.project_lifecycle_transitions (
                tenant_id, project_id, from_state, to_state, reason, actor_subject_id
              ) VALUES (
                ${tenantId}, ${data.subjectId}, 'draft', 'registered',
                'Project Registry publication satisfied the 04 §4.3 guard',
                ${session.subjectId}
              )
            `;

            await recordAudit(tx, {
              effectiveRole,
              tenantId,
              session,
              command: "project.lifecycle.transitioned",
              resourceType: "project",
              resourceId: data.subjectId,
              afterVersion: moved[0]!.version,
              correlationId,
              requestIp: request.ip,
              detail: { from: "draft", to: "registered", cause: "registry.version.published" },
            });
          }
        }

        await recordAudit(tx, {
          effectiveRole,
          tenantId,
          session,
          command: "registry.version.published",
          resourceType: "registry_entry_version",
          resourceId: versionId,
          afterVersion: nextVersion,
          correlationId,
          requestIp: request.ip,
          detail: { registryType: data.registryType, publicKey: data.publicKey },
        });

        await enqueueEvent(tx, {
          tenantId,
          eventType: "registry.version.published",
          aggregateId: versionId,
          aggregateVersion: nextVersion,
          payload: { registryType: data.registryType, contentHash },
          correlationId,
        });

        return {
          id: versionId,
          entryId,
          registryType: data.registryType,
          publicKey: data.publicKey,
          version: nextVersion,
          status: "published",
          contentHash,
          policyVersion: data.policyVersion,
          schemaVersion: data.schemaVersion,
          serializationVersion: "1" as const,
          publishedAt: new Date().toISOString(),
          requestId,
          asOf,
        };
      }),
    );
  });

  app.post<{ Params: { entryId: string } }>(
    "/api/v1/registry-entries/:entryId/revoke",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      // States which version is revoked. Otherwise, if a new version was published after the
      // lookup, the wrong one would be revoked.
      const expectedVersion = requireIfMatch(request);

      const parsed = z.object({ reasonCode: z.string().min(1) }).safeParse(request.body);
      if (!parsed.success) throw badRequest("REQUEST_INVALID", "reasonCode is required");

      const effectiveRole = assertAuthorized(
        session,
        "registry.revoke",
        tenantResource(tenantId, {
          sensitivity: "public",
          state: "published",
          statesAllowingAction: ["published"],
        }),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request.body);

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          const [version] = await tx<{ id: string; status: string; version: number }[]>`
            SELECT id, status, version FROM core.registry_entry_versions
            WHERE entry_id = ${request.params.entryId} AND status = 'published'
            ORDER BY version DESC
            FOR UPDATE
            LIMIT 1
          `;

          if (!version) throw notFound("Published version not found");
          assertVersionMatches(expectedVersion, version.version, "registry_entry_version");

          // A state transition, not a deletion. projection and content_hash remain as is.
          await tx`
            UPDATE core.registry_entry_versions
            SET status = 'revoked', revoked_at = now()
            WHERE id = ${version.id}
          `;

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            session,
            command: "registry.version.revoked",
            resourceType: "registry_entry_version",
            resourceId: version.id,
            reason: parsed.data.reasonCode,
            correlationId,
            requestIp: request.ip,
          });

          await enqueueEvent(tx, {
            tenantId,
            eventType: "registry.version.revoked",
            aggregateId: version.id,
            aggregateVersion: version.version,
            payload: { reasonCode: parsed.data.reasonCode },
            correlationId,
          });

          return {
            id: version.id,
            status: "revoked",
            revokedAt: new Date().toISOString(),
            requestId,
            asOf,
          };
        }),
      );
    },
  );

  // --- anchor ------------------------------------------------------------

  app.post("/api/v1/anchor-batches", async (request) => {
    const { session, tenantId, idempotencyKey } = requireMutationContext(request);

    const effectiveRole = assertAuthorized(
      session,
      "anchor.submit",
      tenantResource(tenantId, {
        sensitivity: "public",
        state: "ready",
        statesAllowingAction: ["ready"],
      }),
      sessionFacts(session),
    );

    const { requestId, asOf, correlationId } = request.context;
    const requestHash = hashRequest(request.body ?? {});

    return withTenant(sql, { tenantId }, (tx) =>
      withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
        const batch = await buildAnchorBatch(tx, tenantId);
        const batchRowId = randomUUID();

        await tx`
          INSERT INTO chain.anchor_batches (
            id, tenant_id, batch_id, merkle_root, manifest_hash,
            manifest_object_key, schema_version, record_count
          ) VALUES (
            ${batchRowId}, ${tenantId}, ${batch.batchId}, ${batch.root},
            ${batch.manifestHash}, ${`manifests/${batch.batchId}.json`}, '1',
            ${batch.recordCount}
          )
        `;

        for (const [index, leaf] of batch.leaves.entries()) {
          await tx`
            INSERT INTO chain.anchor_batch_leaves (batch_id, leaf_hash, entry_version_id, leaf_index)
            VALUES (${batchRowId}, ${leaf.leafHash}, ${leaf.entryVersionId}, ${index})
          `;
        }

        // The transaction is still created. The chain worker submits and confirms it.
        await tx`
          INSERT INTO chain.transactions (
            id, tenant_id, batch_id, intent_key, chain_id, state
          ) VALUES (
            ${randomUUID()}, ${tenantId}, ${batchRowId},
            ${`anchor:${batch.batchId}`}, ${config.chainId}, 'created'
          )
        `;

        await recordAudit(tx, {
          effectiveRole,
          tenantId,
          session,
          command: "anchor.batch.created",
          resourceType: "anchor_batch",
          resourceId: batchRowId,
          correlationId,
          requestIp: request.ip,
          detail: { recordCount: batch.recordCount, root: batch.root },
        });

        await enqueueEvent(tx, {
          tenantId,
          eventType: "anchor.submitted",
          aggregateId: batchRowId,
          aggregateVersion: 1,
          payload: { batchId: batch.batchId, root: batch.root },
          correlationId,
        });

        return {
          id: batchRowId,
          batchId: batch.batchId,
          root: batch.root,
          manifestHash: batch.manifestHash,
          recordCount: batch.recordCount,
          // Not on chain yet. Kept distinct from included/confirmed.
          confirmationState: "created",
          requestId,
          asOf,
        };
      }),
    );
  });

  /**
   * Anchor batch status lookup — 08 §8.9.
   *
   * Without a way to see what happened after a batch was created, an operator cannot tell
   * whether submission is stuck or awaiting confirmation. The state is not flattened into
   * "in progress/done"; the chain state is returned as is.
   */
  app.get("/api/v1/anchor-batches", async (request) => {
    const { session, tenantId } = requireReadContext(request);
    const { requestId, asOf } = request.context;

    /**
     * Reads also check roles — 02 §2.1.
     *
     * Previously it was "RLS scopes by tenant, so that is enough". That made a wallet bound
     * to a tenant equal read permission, letting accounts without roles see batch state and
     * transaction hashes. Published roots are public, but **submission history and failure state
     * are operational information**.
     *
     * Public lookup is handled by `/api/v1/public/*` below, which is unauthenticated.
     */
    assertAuthorized(
      session,
      "registry.read",
      tenantResource(tenantId, { sensitivity: "public" }),
      sessionFacts(session),
    );

    const rows = await withTenant(sql, { tenantId }, (tx) =>
      tx<
        {
          id: string;
          batch_id: string;
          merkle_root: string;
          manifest_hash: string;
          record_count: number;
          created_at: Date;
          chain_id: number | null;
          state: string | null;
          tx_hash: string | null;
          block_number: string | null;
          confirmations: number | null;
          attempts: number | null;
          last_error: string | null;
          submitted_at: Date | null;
          confirmed_at: Date | null;
          reorg_count: string;
          proposal_safe_address: string | null;
          proposal_calldata_hash: string | null;
          proposal_state: string | null;
          proposal_created_at: Date | null;
        }[]
      >`
        SELECT b.id, b.batch_id, b.merkle_root, b.manifest_hash, b.record_count,
               b.created_at, t.chain_id, t.state, t.tx_hash, t.block_number,
               t.confirmations, t.attempts, t.last_error, t.submitted_at,
               t.confirmed_at,
               (SELECT count(*) FROM chain.reorg_events r WHERE r.transaction_id = t.id)
                 AS reorg_count,
               p.safe_address AS proposal_safe_address,
               p.calldata_hash AS proposal_calldata_hash,
               p.state AS proposal_state,
               p.created_at AS proposal_created_at
        FROM chain.anchor_batches b
        LEFT JOIN chain.transactions t ON t.batch_id = b.id
        LEFT JOIN chain.anchor_proposals p
          ON p.transaction_id = t.id AND p.state = 'proposed'
        ORDER BY b.created_at DESC
        LIMIT 100
      `,
    );

    return {
      items: rows.map((row) => ({
        id: row.id,
        batchId: row.batch_id,
        root: row.merkle_root,
        manifestHash: row.manifest_hash,
        recordCount: row.record_count,
        createdAt: row.created_at.toISOString(),
        chainId: row.chain_id ?? config.chainId,
        // No transaction row means it has not been created yet. It must not look like success.
        confirmationState: row.state ?? "created",
        transactionHash: row.tx_hash,
        blockNumber: row.block_number,
        confirmations: row.confirmations ?? 0,
        attempts: row.attempts ?? 0,
        lastError: row.last_error,
        submittedAt: row.submitted_at?.toISOString() ?? null,
        confirmedAt: row.confirmed_at?.toISOString() ?? null,
        reorgCount: Number(row.reorg_count),
        // Flags states that do not resolve on their own. A person must intervene.
        needsAttention: ["failed", "reverted", "dropped", "reconciliation_required"].includes(
          row.state ?? "",
        ),
        proposal: row.proposal_safe_address
          ? {
              safeAddress: row.proposal_safe_address,
              calldataHash: row.proposal_calldata_hash!,
              state: row.proposal_state!,
              createdAt: row.proposal_created_at!.toISOString(),
            }
          : null,
      })),
      requestId,
      asOf,
    };
  });

  /**
   * Resubmission of a stuck anchor batch — 08 §8.9.
   *
   * `dropped`, `reconciliation_required`, and `failed` do not resolve on their own.
   * If the worker resubmitted on its own it could post the same root twice, and even if the
   * contract rejects with `BatchAlreadyExists`, gas is spent.
   *
   * **The root is not rebuilt.** The same batch is posted again with the same root —
   * resubmission does not create a new fact; it retries putting an already settled fact
   * on chain.
   */
  app.post<{ Params: { batchId: string } }>(
    "/api/v1/anchor-batches/:batchId/resubmit",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);

      const effectiveRole = assertAuthorized(
        session,
        "anchor.submit",
        tenantResource(tenantId, {
          sensitivity: "public",
          state: "ready",
          statesAllowingAction: ["ready"],
        }),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request.body ?? {});

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          const [transaction] = await tx<
            { id: string; state: string; attempts: number; batch_id: string }[]
          >`
            SELECT t.id, t.state, t.attempts, t.batch_id
            FROM chain.transactions t
            WHERE t.batch_id = ${request.params.batchId}
            ORDER BY t.created_at DESC
            FOR UPDATE
            LIMIT 1
          `;

          if (!transaction) throw notFound("Transaction for this batch not found");

          // Does not roll back in-flight work. Resetting submitted/included to created would forget
          // a transaction already on chain and post the same root again.
          const RESUBMITTABLE = ["dropped", "reconciliation_required", "failed", "reverted"];
          if (!RESUBMITTABLE.includes(transaction.state)) {
            throw conflict("ANCHOR_NOT_RESUBMITTABLE", "This state is not eligible for resubmission", {
              currentState: transaction.state,
              resubmittableStates: RESUBMITTABLE,
            });
          }

          // Resets the attempt count to 0. A person checked the cause and decided, so the
          // previous attempts' cap is not inherited.
          await tx`
            UPDATE chain.transactions
            SET state = 'created', attempts = 0,
                tx_hash = NULL, block_number = NULL, block_hash = NULL,
                confirmations = 0, confirmed_at = NULL, submitted_at = NULL,
                last_error = ${`resubmitted_from_${transaction.state}`},
                updated_at = now()
            WHERE id = ${transaction.id}
          `;

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            session,
            command: "anchor.batch.resubmit_requested",
            resourceType: "anchor_batch",
            resourceId: request.params.batchId,
            reason: `from_${transaction.state}`,
            correlationId,
            requestIp: request.ip,
            detail: { previousAttempts: transaction.attempts },
          });

          return {
            id: request.params.batchId,
            confirmationState: "created",
            previousState: transaction.state,
            attempts: 0,
            requestId,
            asOf,
          };
        }),
      );
    },
  );
}
