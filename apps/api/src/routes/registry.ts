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
 * Registry 게시와 공개 조회 — spec 05 §5.6·§5.7, 08 §8.11.
 *
 * 이 라우트가 지키는 것:
 *
 * - allowlist 밖 필드가 하나라도 있으면 게시를 거절한다(AC-22).
 * - 자연인 식별자는 safeguard 다섯 개가 모두 있어야 공개된다(AC-32).
 * - 게시된 version은 덮어쓸 수 없다. revoke는 삭제가 아니라 새 상태다.
 * - 공개 route는 무인증이며 게시된 version만 반환한다.
 * - inclusion proof는 무엇을 증명하지 **않는지**를 함께 반환한다(AC-23).
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
  // --- 게시 ---------------------------------------------------------------

  app.post("/api/v1/registry-entries", async (request) => {
    const { session, tenantId, idempotencyKey } = requireMutationContext(request);

    const parsed = publishSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest("REQUEST_INVALID", "요청 형식이 올바르지 않다", {
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

    // 공개 가능 여부는 도메인이 판정한다. 라우트가 allowlist를 다시 쓰지 않는다.
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
      throw unprocessable(publishCheck.reason, "이 projection은 공개할 수 없다", {
        offendingFields: publishCheck.offendingFields,
      });
    }

    // 스키마로 한 번 더 거른다. `.strict()`가 allowlist 밖 필드를 거절한다.
    const projectionCheck = publicProjection.safeParse(data.projection);
    if (!projectionCheck.success) {
      throw unprocessable("PUBLICATION_PROJECTION_INVALID", "projection이 공개 스키마와 다르다", {
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
         * `status`는 게시 **이후**의 lifecycle을 담는다.
         *
         * 클라이언트가 보낸 값을 그대로 저장하면 첫 게시 version이 `draft`로
         * 남는다. 화면이 게시 직전 상태를 담아 보내기 때문이다. 그런데 11 §11.4의
         * `registered`는 "Registry 기록 존재"이고, 그 기록을 만드는 것이 바로 이
         * 요청이다 — 즉 저장되는 순간 이미 `draft`가 아니다.
         *
         * 서버가 정한다. lifecycle은 공개 projection에서 **클라이언트가 주장할
         * 값이 아니다.**
         */
        const publishedProjection = { ...(data.projection as Record<string, unknown>) };
        if (data.registryType === "project") {
          const [current] = await tx<{ lifecycle_state: string }[]>`
            SELECT lifecycle_state FROM core.projects
            WHERE tenant_id = ${tenantId} AND id = ${data.subjectId}
          `;
          if (current) {
            // `draft`였다면 이 게시가 그것을 옮긴다(아래). 다른 상태였다면
            // 그대로다 — 게시가 상태를 앞으로 밀지 않는다.
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

        // 이전 version은 지우지 않고 superseded로 연결한다(불변조건 4).
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
         * 전이표의 guard는 "Project Registry 최소 필드와 책임 주체"이고, 그것을
         * 만족시키는 행위가 바로 이 게시다. `registry.publish`를 이미 가진 사람이
         * 하는 일이므로 새 권한이 생기지 않는다.
         *
         * **`draft`에서만 움직인다.** `WHERE`가 그 guard다 — 다른 상태에서 게시하면
         * 상태는 그대로다. suspended를 게시로 되돌리면 incident closure 없이
         * 복귀시키는 셈이 되고, 그 판단 주체는 아직 정해지지 않았다.
         *
         * verification·asset registry는 프로젝트가 등록됐다는 뜻이 아니므로 건드리지
         * 않는다.
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
             * 전이 이력에도 남긴다 — 마이그레이션 `0031`.
             *
             * 감사 로그와 다른 표인 이유: 감사는 "누가 무엇을 했나"이고 이력은
             * "이 프로젝트가 어디를 지나왔나"다. 후자를 감사 로그에서 뽑으려면
             * command 문자열을 파싱해야 하고, 그러면 문자열이 스키마가 된다.
             */
            await tx`
              INSERT INTO core.project_lifecycle_transitions (
                tenant_id, project_id, from_state, to_state, reason, actor_subject_id
              ) VALUES (
                ${tenantId}, ${data.subjectId}, 'draft', 'registered',
                'Project Registry 게시가 04 §4.3의 guard를 만족시켰다',
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
      // 어느 version을 철회하는지 밝힌다. 밝히지 않으면 조회 이후에 새 version이
      // 게시된 경우 의도하지 않은 것을 철회한다.
      const expectedVersion = requireIfMatch(request);

      const parsed = z.object({ reasonCode: z.string().min(1) }).safeParse(request.body);
      if (!parsed.success) throw badRequest("REQUEST_INVALID", "reasonCode가 필요하다");

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

          if (!version) throw notFound("게시된 version을 찾을 수 없다");
          assertVersionMatches(expectedVersion, version.version, "registry_entry_version");

          // 삭제가 아니라 상태 전이다. projection과 content_hash는 그대로 남는다.
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

        // 트랜잭션은 아직 created다. 제출·확정은 chain worker가 한다.
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
          // 아직 체인에 올라가지 않았다. included·confirmed와 구분한다.
          confirmationState: "created",
          requestId,
          asOf,
        };
      }),
    );
  });

  /**
   * anchor batch 상태 조회 — 08 §8.9.
   *
   * batch를 만든 뒤 무슨 일이 일어났는지 볼 경로가 없으면, 운영자는 제출이
   * 막혔는지 확정을 기다리는 중인지 구분할 수 없다. 상태를 "진행중/완료"로
   * 뭉개지 않고 체인 상태 그대로 돌려준다.
   */
  app.get("/api/v1/anchor-batches", async (request) => {
    const { session, tenantId } = requireReadContext(request);
    const { requestId, asOf } = request.context;

    /**
     * 읽기에도 역할을 본다 — 02 §2.1.
     *
     * 이전에는 "RLS가 tenant로 막으니 충분하다"였다. 그러면 tenant에 wallet이
     * 묶였다는 사실이 곧 읽기 권한이 되고, 역할 없는 계정이 batch 상태·트랜잭션
     * 해시를 그대로 본다. 게시된 root는 공개지만 **제출 이력과 실패 상태는
     * 운영 정보**다.
     *
     * 공개 조회는 아래 `/api/v1/public/*`이 담당하며 그쪽은 무인증이다.
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
        // 트랜잭션 행이 없으면 아직 만들어지지 않은 것이다. 성공으로 보이지 않게 한다.
        confirmationState: row.state ?? "created",
        transactionHash: row.tx_hash,
        blockNumber: row.block_number,
        confirmations: row.confirmations ?? 0,
        attempts: row.attempts ?? 0,
        lastError: row.last_error,
        submittedAt: row.submitted_at?.toISOString() ?? null,
        confirmedAt: row.confirmed_at?.toISOString() ?? null,
        reorgCount: Number(row.reorg_count),
        // 자동으로 풀리지 않는 상태를 따로 표시한다. 사람이 개입해야 한다.
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
   * 멈춘 anchor batch 재제출 — 08 §8.9.
   *
   * `dropped`·`reconciliation_required`·`failed`는 자동으로 풀리지 않는다.
   * worker가 알아서 재제출하면 같은 root를 두 번 올릴 수 있고, 컨트랙트가
   * `BatchAlreadyExists`로 거절하더라도 가스는 소모된다.
   *
   * **root는 다시 만들지 않는다.** 같은 batch를 같은 root로 다시 올린다 —
   * 재제출은 새 사실을 만드는 것이 아니라 이미 정해진 사실을 체인에 올리는
   * 시도를 반복하는 것이다.
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

          if (!transaction) throw notFound("이 batch의 트랜잭션을 찾을 수 없다");

          // 진행 중인 것을 되돌리지 않는다. submitted·included를 created로 돌리면
          // 이미 체인에 있는 트랜잭션을 잊고 같은 root를 다시 올린다.
          const RESUBMITTABLE = ["dropped", "reconciliation_required", "failed", "reverted"];
          if (!RESUBMITTABLE.includes(transaction.state)) {
            throw conflict("ANCHOR_NOT_RESUBMITTABLE", "이 상태는 재제출 대상이 아니다", {
              currentState: transaction.state,
              resubmittableStates: RESUBMITTABLE,
            });
          }

          // 시도 횟수를 0으로 되돌린다. 사람이 원인을 확인하고 결정한 것이므로
          // 이전 시도의 상한을 물려받지 않는다.
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
