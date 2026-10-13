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
  publishRegistryDraftRequest,
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
import {
  projectionMismatches,
  resolvePublicationSubject,
} from "../services/registry-publication.js";
import {
  lockDraft,
  parseBody,
  registerRegistryDraftRoutes,
  safeguardsOf,
  subjectOf,
} from "./registry-drafts.js";

/**
 * Registry publication and public lookup — spec 02 §2.8, 05 §5.6·§5.7·§5.9, 07 §7.2, 08 §8.11.
 *
 * What this route guarantees:
 *
 * - Publication takes two steps and two people. A draft (`registry-drafts.ts`) records what
 *   would be published; a Disclosure Approver who did not draft it publishes (DB
 *   `registry_draft_two_person`).
 * - What the server can know is not taken from the client: the evidence snapshot hash, the
 *   commercial-reuse status of the sources, the subject's identity and lifecycle.
 * - Publication is rejected if any field is outside the allowlist (AC-22).
 * - Natural-person identifiers are public only when all five safeguards are on record (AC-32).
 * - A published version cannot be overwritten. Revoke is a new state, not a deletion.
 * - Public routes are unauthenticated and return only published versions.
 * - An inclusion proof is returned with what it does **not** prove (AC-23).
 */

export async function registerRegistryRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
  config: AppConfig,
): Promise<void> {
  // --- Draft (step 1) ----------------------------------------------------

  await registerRegistryDraftRoutes(app, sql);

  // --- Publish (step 2) --------------------------------------------------

  app.post<{ Params: { draftId: string } }>(
    "/api/v1/registry-entries/drafts/:draftId/publish",
    async (request, reply) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      // The approver states which revision of the draft they read.
      const expectedDraftVersion = requireIfMatch(request);

      const effectiveRole = assertAuthorized(
        session,
        "registry.publish",
        tenantResource(tenantId, {
          sensitivity: "public",
          state: "pending",
          statesAllowingAction: ["pending"],
          // Publication requires independence from whoever drafted it (02 §2.8).
          separationSensitive: true,
        }),
        sessionFacts(session),
      );
      const body = parseBody(publishRegistryDraftRequest, request.body);
      const publisher = subjectOf(session);

      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request.body);

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          const draft = await lockDraft(tx, tenantId, request.params.draftId);
          if (!draft) throw notFound("Draft not found");
          assertVersionMatches(expectedDraftVersion, draft.version, "registry_publication_draft");

          if (draft.state !== "pending") {
            throw unprocessable("REGISTRY_DRAFT_ALREADY_DECIDED", "Draft is already decided", {
              state: draft.state,
            });
          }

          /**
           * Two-person rule — 02 §2.8.
           *
           * The DB CHECK blocks the same thing, but filtering here first says why. A constraint
           * violation message does not tell the user what to do next.
           */
          if (draft.proposed_by_subject_id === publisher) {
            throw unprocessable(
              "REGISTRY_DRAFT_SELF_PUBLICATION",
              "The person who drafted this cannot publish it",
              { hint: "Another Disclosure Approver publishes" },
            );
          }

          /**
           * The draft is re-checked against the subject as it is **now**.
           *
           * Between drafting and publishing, evidence can be added, a source's terms can change
           * and the project can be suspended. The approver approves what the draft shows; if
           * that is no longer true, publishing it would anchor a stale statement.
           */
          // The project's lifecycle becomes the published status. Locked here, in the same order
          // as lifecycle transitions, so a suspension cannot commit between reading and writing it.
          if (draft.registry_type === "project") {
            await tx`
              SELECT 1 FROM core.projects
              WHERE tenant_id = ${tenantId} AND id = ${draft.subject_id}
              FOR UPDATE
            `;
          }
          const subject = await resolvePublicationSubject(
            tx,
            tenantId,
            draft.registry_type,
            draft.subject_id,
          );
          const staleFields = [
            ...(subject.sourceSnapshotHash === draft.source_snapshot_hash
              ? []
              : ["sourceSnapshotHash"]),
            ...(subject.commercialReuse === draft.commercial_reuse ? [] : ["commercialReuse"]),
            ...projectionMismatches(draft.projection, subject),
          ];
          if (staleFields.length > 0) {
            throw conflict(
              "REGISTRY_DRAFT_STALE",
              "The record changed since this draft was made. Reject it and draft again",
              { staleFields },
            );
          }

          const publishCheck = checkPublishable({
            fields: Object.keys(draft.projection),
            sensitivity: "public",
            // Given by this request: a Disclosure Approver who is not the drafter.
            disclosureApproved: true,
            containsPersonLevelIdentifier: draft.contains_person_level_identifier,
            personIdentifierSafeguards: safeguardsOf(
              {
                lawfulBasis: draft.lawful_basis,
                purpose: draft.purpose,
                retention: draft.retention,
                acknowledgedAt: draft.irreversibility_acknowledged_at,
              },
              body.personIdentifierPublicationApproved,
            ),
            commercialReuse: subject.commercialReuse,
            publishedAsCommercialBasis: draft.published_as_commercial_basis,
          });
          if (!publishCheck.allowed) {
            throw unprocessable(publishCheck.reason, "This projection cannot be published", {
              offendingFields: publishCheck.offendingFields,
            });
          }

          /**
           * `status` holds the lifecycle **after** publication.
           *
           * The draft may carry the pre-publication state the screen showed (`draft`), but
           * `registered` in 11 §11.4 means "a Registry record exists", and this very request
           * creates that record. The server decides; lifecycle is **not a value the client
           * gets to claim.**
           */
          const publishedProjection = { ...draft.projection, status: subject.publishedStatus };
          const projectionCheck = publicProjection.safeParse(publishedProjection);
          if (!projectionCheck.success) {
            throw unprocessable(
              "PUBLICATION_PROJECTION_INVALID",
              "Projection does not match the public schema",
              { issues: projectionCheck.error.issues },
            );
          }
          const contentHash = hashProjection(publishedProjection as never);

          const [existingEntry] = await tx<{ id: string; subject_id: string }[]>`
            SELECT id, subject_id FROM core.registry_entries
            WHERE registry_type = ${draft.registry_type} AND public_key = ${draft.public_key}
          `;
          if (existingEntry && existingEntry.subject_id !== draft.subject_id) {
            throw conflict("REGISTRY_KEY_TAKEN", "This public key belongs to another subject");
          }

          const entryId = existingEntry?.id ?? randomUUID();
          if (!existingEntry) {
            await tx`
              INSERT INTO core.registry_entries (
                id, tenant_id, registry_type, subject_id, public_key
              ) VALUES (
                ${entryId}, ${tenantId}, ${draft.registry_type}, ${draft.subject_id},
                ${draft.public_key}
              )
            `;
          }

          const [previous] = await tx<{ id: string; version: number }[]>`
            SELECT id, version FROM core.registry_entry_versions
            WHERE entry_id = ${entryId} ORDER BY version DESC LIMIT 1
          `;

          const versionId = randomUUID();
          const nextVersion = (previous?.version ?? 0) + 1;

          await tx`
            INSERT INTO core.registry_entry_versions (
              id, tenant_id, entry_id, version, status, public_projection,
              content_hash, source_snapshot_hash, policy_version, schema_version,
              previous_version_id, published_at
            ) VALUES (
              ${versionId}, ${tenantId}, ${entryId}, ${nextVersion}, 'published',
              ${tx.json(publishedProjection as never)}, ${contentHash},
              ${draft.source_snapshot_hash}, ${draft.policy_version}, ${draft.schema_version},
              ${previous?.id ?? null}, now()
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

          await tx`
            UPDATE core.registry_publication_drafts
            SET state = 'published', decided_by_subject_id = ${publisher}, decided_at = now(),
                person_identifier_publication_approved = ${body.personIdentifierPublicationApproved},
                entry_version_id = ${versionId}, version = version + 1
            WHERE tenant_id = ${tenantId} AND id = ${draft.id}
          `;

          /**
           * 04 §4.3 — `draft→registered`.
           *
           * The transition table's guard is "Project Registry minimum fields and accountable
           * subject", and this publication is what satisfies it.
           *
           * **Moves only from `draft`.** The `WHERE` is that guard — publishing from another
           * state leaves the state as is. Reverting suspended via publication would reinstate
           * without incident closure, and who decides that is not yet determined.
           *
           * Verification registries do not mean the project is registered, so they are not
           * touched.
           */
          if (draft.registry_type === "project") {
            const moved = await tx<{ id: string; version: number }[]>`
              UPDATE core.projects
              SET lifecycle_state = 'registered', version = version + 1, updated_at = now()
              WHERE id = ${subject.projectId} AND lifecycle_state = 'draft'
              RETURNING id, version
            `;

            if (moved.length > 0) {
              /**
               * Also recorded in the transition history — migration `0031`.
               *
               * Why a separate table from the audit log: audit is "who did what" and history is
               * "where this project has been". Extracting the latter from the audit log would
               * require parsing command strings, which turns the strings into a schema.
               */
              await tx`
                INSERT INTO core.project_lifecycle_transitions (
                  tenant_id, project_id, from_state, to_state, reason, actor_subject_id
                ) VALUES (
                  ${tenantId}, ${subject.projectId}, 'draft', 'registered',
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
                resourceId: subject.projectId,
                afterVersion: moved[0]!.version,
                correlationId,
                requestIp: request.clientIp,
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
            requestIp: request.clientIp,
            detail: {
              registryType: draft.registry_type,
              publicKey: draft.public_key,
              draftId: draft.id,
              draftedBySubjectId: draft.proposed_by_subject_id,
              personIdentifierPublicationApproved: body.personIdentifierPublicationApproved,
            },
          });

          await enqueueEvent(tx, {
            tenantId,
            eventType: "registry.version.published",
            aggregateId: versionId,
            aggregateVersion: nextVersion,
            payload: { registryType: draft.registry_type, contentHash },
            correlationId,
          });

          reply.header("etag", etagOf(draft.version + 1));
          return {
            id: versionId,
            entryId,
            draftId: draft.id,
            registryType: draft.registry_type,
            publicKey: draft.public_key,
            version: nextVersion,
            status: "published",
            contentHash,
            policyVersion: draft.policy_version,
            schemaVersion: draft.schema_version,
            serializationVersion: "1" as const,
            publishedAt: new Date().toISOString(),
            requestId,
            asOf,
          };
        }),
      );
    },
  );

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
            requestIp: request.clientIp,
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
        // One batch build per tenant at a time. Two concurrent requests would read the same
        // unanchored versions and anchor each of them in two roots. The second waits here and,
        // with a fresh snapshot, finds them taken. The unique index on
        // `anchor_batch_leaves.entry_version_id` (0041) holds even if this lock is skipped.
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`anchor-batch:${tenantId}`}::TEXT, 0))`;
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
          requestIp: request.clientIp,
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
            requestIp: request.clientIp,
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
