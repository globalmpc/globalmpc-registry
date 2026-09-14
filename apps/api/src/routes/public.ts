import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { verifyMerkleProof } from "@mpc/canonical";
import { isPublicField } from "@mpc/domain";
import {
  PROOF_DOES_NOT_PROVE,
  PROOF_PROVES,
  publicCursorQuery,
  publicProjection,
  publicRegistryListQuery,
  publicSearchQuery,
  type publicSearchResult,
} from "@mpc/api-contract";
import type { z } from "zod";
import type { AppConfig } from "../config.js";
import { badRequest } from "../errors.js";
import { buildInclusionProof } from "../services/anchor-batch.js";
import { etagOf } from "./shared.js";

/**
 * 무인증 공개 route — spec 07 §7.1, OD-02.
 *
 * 이 파일이 따로 있는 이유는 길이가 아니라 **경계가 다르기 때문**이다. 여기의
 * route는 세션도 tenant도 없이 돌고, RLS를 만족시킬 수 없어 전부 `core.public_*`
 * SECURITY DEFINER 함수를 지난다(0009 · 0027 · 0034). 워크스페이스 route 사이에
 * 섞여 있으면 "여기는 tenant가 없다"가 매번 다시 확인해야 하는 사실이 된다.
 *
 * 공통 규칙:
 *
 * - 게시된 것만 낸다. `draft`는 어떤 경로로도 나가지 않는다.
 * - tenant_id를 반환하지 않는다.
 * - 공개 allowlist 밖의 필드를 담지 않는다(05 §5.7).
 * - 목록은 keyset cursor를 쓴다. OFFSET은 앞쪽에 행이 늘면 페이지가 어긋난다.
 */

/**
 * cursor는 정렬 키를 감싼 불투명 문자열이다.
 *
 * 왜 감싸는가: 클라이언트가 정렬 키를 조립하기 시작하면 정렬을 바꿀 수 없다.
 * base64는 암호가 아니고 숨기려는 것도 아니다 — "이 값은 우리가 만든 것을
 * 그대로 돌려주는 자리"라는 계약을 형태로 만든다.
 */
function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`, "utf8").toString("base64url");
}

const CURSOR_SHAPE = /^(?<at>[^|]+)\|(?<id>[0-9a-f-]{36})$/;

function decodeCursor(cursor: string): { at: Date; id: string } {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const matched = CURSOR_SHAPE.exec(decoded);
  const at = matched ? new Date(matched.groups!["at"]!) : null;
  if (!matched || at === null || Number.isNaN(at.getTime())) {
    // 조작된 cursor를 조용히 첫 페이지로 되돌리지 않는다. 그러면 클라이언트가
    // 목록을 끝없이 다시 받으며 끝났다고 믿지 못한다.
    throw badRequest("INVALID_CURSOR", "cursor가 이 목록에서 발급된 값이 아니다");
  }
  return { at, id: matched.groups!["id"]! };
}

type SearchMatch = z.infer<typeof publicSearchResult>["matches"][number];

/** 공개 검색이 hash로 보는 형태. 32바이트 hex — tx·root·leaf·batch id가 전부 이 모양이다. */
const HASH_SHAPE = /^0x[0-9a-f]{64}$/;
const REGISTRY_TYPES = ["project", "verification", "asset"] as const;
/** registry마다 이름 검색 결과 상한. 통합 검색은 목록이 아니라 길잡이다. */
const TEXT_MATCH_LIMIT = 10;

/** 계약에 없는 파라미터를 무시하지 않는다. 무시하면 오타 난 필터가 전체가 된다. */
function parseQuery<T>(schema: { safeParse(input: unknown): { success: boolean; data?: T; error?: { issues: { path: (string | number)[]; message: string }[] } } }, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success || parsed.data === undefined) {
    throw badRequest("INVALID_QUERY", "질의 파라미터가 계약과 다르다", {
      issues: (parsed.error?.issues ?? []).map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

export async function registerPublicRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
  config: AppConfig,
): Promise<void> {
  app.get<{ Params: { registryType: string } }>(
    "/api/v1/public/registries/:registryType",
    async (request, reply) => {
      // 계약에 없는 파라미터는 무시하지 않고 거절한다(`.strict()`). 무시하면
      // 오타 난 필터가 "전체 목록"으로 조용히 넘어간다.
      const query = parseQuery(publicRegistryListQuery, request.query);
      const after = query.cursor ? decodeCursor(query.cursor) : null;

      // 다음 페이지가 있는지 알려면 한 줄 더 받아야 한다. 총계를 세지 않는
      // 이유는 공개 목록이 커질수록 COUNT가 매 요청마다 전체를 훑기 때문이다.
      const rows = await sql<
        {
          entry_id: string;
          public_key: string;
          entry_version_id: string;
          version: number;
          status: string;
          public_projection: Record<string, unknown>;
          published_at: Date | null;
          sort_at: Date;
          revoked_at: Date | null;
          superseded_by_id: string | null;
        }[]
      >`
        SELECT * FROM core.public_registry_list(
          ${request.params.registryType},
          ${query.q ?? null},
          ${query.status ?? null},
          ${query.limit + 1},
          ${after?.at ?? null},
          ${after?.id ?? null}
        )
      `;

      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      const hasMore = rows.length > query.limit;

      // 공개 목록은 캐시해도 되는 읽기다. 다만 개인화된 것이 아니므로 공유
      // 캐시를 허용하고, 게시가 자주 일어나지 않으므로 짧게 잡는다.
      reply.header("cache-control", "public, max-age=30");

      return {
        items: page.map((row) => ({
          publicKey: row.public_key,
          entryVersionId: row.entry_version_id,
          version: String(row.version),
          status: row.status,
          publishedAt: row.published_at?.toISOString() ?? null,
          revokedAt: row.revoked_at?.toISOString() ?? null,
          supersededBy: row.superseded_by_id,
          // projection을 펼치지 않는다 — 공개 허용 필드만 나갔는지 응답만 보고
          // 판정할 수 있어야 한다.
          projection: row.public_projection,
        })),
        // cursor는 `published_at`이 아니라 정렬 키로 만든다. 둘은 published_at이
        // 비어 있을 때 갈라지고, 그때 published_at으로 만들면 페이지가 어긋난다.
        nextCursor: hasMore && last ? encodeCursor(last.sort_at, last.entry_id) : null,
        sort: "publishedAt:desc,entryId:desc" as const,
        requestId: request.context.requestId,
        asOf: request.context.asOf,
      };
    },
  );


  app.get<{ Params: { registryType: string; publicKey: string } }>(
    "/api/v1/public/registries/:registryType/:publicKey",
    async (request, reply) => {
      // 공개 route는 tenant를 모른다 — 로그인하지 않은 독자가 조회하기 때문이다.
      // RLS 정책을 만족시킬 수 없으므로 공개 경로만 SECURITY DEFINER 함수로
      // 분리한다(0009_public_read.sql). 그 함수는 게시된 version의 public
      // projection만 반환하며 tenant_id를 돌려주지 않는다.
      const rows = await sql<
        {
          id: string;
          public_projection: Record<string, unknown>;
          version: number;
          status: string;
          published_at: Date | null;
          revoked_at: Date | null;
          superseded_by_id: string | null;
        }[]
      >`
        SELECT * FROM core.public_registry_versions(
          ${request.params.registryType}, ${request.params.publicKey}
        )
      `;

      const current = rows[0];
      if (current) {
        // 클라이언트가 어느 version을 보고 있는지 헤더로도 알 수 있게 한다.
        // 본문의 version과 같은 값이며 If-Match에 그대로 넣을 수 있다.
        reply.header("etag", etagOf(current.version));
      }
      if (!current) {
        return reply.status(404).send({
          code: "NOT_FOUND",
          message: "공개된 기록을 찾을 수 없다",
          retryable: false,
          correlationId: request.context.correlationId,
        });
      }

      return {
        ...current.public_projection,
        entryVersionId: current.id,
        version: String(current.version),
        status: current.status,
        publishedAt: current.published_at?.toISOString() ?? null,
        revokedAt: current.revoked_at?.toISOString() ?? null,
        supersededBy: current.superseded_by_id,
        // 이전 version을 감추지 않는다. 정정·철회 이력이 공개의 일부다(§11.3).
        history: rows.slice(1).map((row) => ({
          entryVersionId: row.id,
          version: String(row.version),
          status: row.status,
          revokedAt: row.revoked_at?.toISOString() ?? null,
        })),
        requestId: request.context.requestId,
        asOf: request.context.asOf,
      };
    },
  );

  app.get<{ Params: { entryVersionId: string } }>(
    "/api/v1/public/proofs/:entryVersionId",
    async (request, reply) => {
      const proof = await buildInclusionProof(sql, request.params.entryVersionId);

      if (!proof) {
        return reply.status(404).send({
          code: "NOT_FOUND",
          message: "이 version은 아직 anchor되지 않았다",
          retryable: true,
          correlationId: request.context.correlationId,
        });
      }

      const verified = verifyMerkleProof(proof.leafHash, proof.proof, proof.root);

      return {
        entryVersionId: request.params.entryVersionId,
        leafHash: proof.leafHash,
        proof: proof.proof,
        root: proof.root,
        batchId: proof.batchId,
        chainId: config.chainId,
        transactionHash: proof.transactionHash,
        blockNumber: proof.blockNumber,
        confirmationState: proof.confirmationState,
        // AC-23: included는 confirmed일 때만 참이다. 그 전에는 아직 확정되지 않았다.
        included: verified && proof.confirmationState === "confirmed",
        merkleVerified: verified,
        proves: [...PROOF_PROVES],
        doesNotProve: [...PROOF_DOES_NOT_PROVE],
        // 규격 버전은 **저장된 값**을 그대로 낸다. 상수로 고정하면
        // 규격을 올렸을 때 응답만 옛 값을 계속 말한다.
        policyVersion: proof.policyVersion,
        schemaVersion: proof.schemaVersion,
        serializationVersion: proof.serializationVersion,
        requestId: request.context.requestId,
        asOf: request.context.asOf,
      };
    },
  );

  // --- 공개 통합 검색 --------------------------------------------

  app.get("/api/v1/public/search", async (request, reply) => {
    const { q } = parseQuery(publicSearchQuery, request.query);
    reply.header("cache-control", "public, max-age=30");
    // chainId는 화면이 transaction hash를 그 체인의 탐색기로 잇는 데 쓴다.
    const base = {
      query: q,
      chainId: config.chainId,
      requestId: request.context.requestId,
      asOf: request.context.asOf,
    };

    // hash는 저장 형식이 소문자다. 지갑·탐색기에서 복사한 대문자 hex도 같은 값이다.
    const lowered = q.toLowerCase();
    if (HASH_SHAPE.test(lowered)) {
      const rows = await sql<
        {
          matched_on: SearchMatch["matchedOn"];
          registry_type: SearchMatch["registryType"];
          public_key: string;
          entry_version_id: string;
          version: number;
          status: string;
          merkle_root: string;
          transaction_hash: string | null;
        }[]
      >`SELECT * FROM core.public_hash_lookup(${lowered})`;

      return {
        ...base,
        kind: "hash" as const,
        matches: rows.map(
          (row): SearchMatch => ({
            matchedOn: row.matched_on,
            registryType: row.registry_type,
            publicKey: row.public_key,
            entryVersionId: row.entry_version_id,
            version: String(row.version),
            status: row.status,
            merkleRoot: row.merkle_root,
            transactionHash: row.transaction_hash,
          }),
        ),
      };
    }

    // key 정확 일치를 먼저 둔다. 공유받은 key를 붙여 넣은 사람에게 그 기록이
    // 이름이 비슷한 다른 기록 아래에 묻히면 안 된다.
    const exact = (
      await Promise.all(
        REGISTRY_TYPES.map(async (registryType): Promise<SearchMatch[]> => {
          const [row] = await sql<{ id: string; version: number; status: string }[]>`
            SELECT id, version, status FROM core.public_registry_versions(${registryType}, ${q})
          `;
          return row
            ? [
                {
                  matchedOn: "public_key",
                  registryType,
                  publicKey: q,
                  entryVersionId: row.id,
                  version: String(row.version),
                  status: row.status,
                  merkleRoot: null,
                  transactionHash: null,
                },
              ]
            : [];
        }),
      )
    ).flat();

    const listed = (
      await Promise.all(
        REGISTRY_TYPES.map(async (registryType): Promise<SearchMatch[]> => {
          const rows = await sql<
            { public_key: string; entry_version_id: string; version: number; status: string }[]
          >`
            SELECT public_key, entry_version_id, version, status
            FROM core.public_registry_list(${registryType}, ${q}, NULL, ${TEXT_MATCH_LIMIT}, NULL, NULL)
          `;
          return rows.map((row) => ({
            matchedOn: "text",
            registryType,
            publicKey: row.public_key,
            entryVersionId: row.entry_version_id,
            version: String(row.version),
            status: row.status,
            merkleRoot: null,
            transactionHash: null,
          }));
        }),
      )
    )
      .flat()
      .filter((match) => !exact.some((hit) => hit.entryVersionId === match.entryVersionId));

    return { ...base, kind: "text" as const, matches: [...exact, ...listed] };
  });

  // 공개 필드 목록. Explorer가 무엇을 기대할 수 있는지 알려준다.
  app.get("/api/v1/public/projection-fields", async (request) => ({
    fields: Object.keys(publicProjection.shape).filter(isPublicField),
    requestId: request.context.requestId,
    asOf: request.context.asOf,
  }));

  // --- 공개 거버넌스 ------------------------------------------------
  //
  // protocol space만, `draft` 제외, 투표자 명단 없음. 근거는 0027 머리말.

  /** `NUMERIC(78,0)`은 JSON number에 담기지 않는다. 문자열로 그대로 옮긴다. */
  function tallyOf(row: {
    weight_for: string;
    weight_against: string;
    weight_abstain: string;
    voter_count: string;
  }) {
    return {
      for: String(row.weight_for),
      against: String(row.weight_against),
      abstain: String(row.weight_abstain),
      voterCount: Number(row.voter_count),
    };
  }

  interface ProposalRow {
    id: string;
    proposal_type: string;
    title: string;
    rationale: string;
    state: string;
    quorum_numerator: number;
    quorum_denominator: number;
    threshold_numerator: number;
    threshold_denominator: number;
    voting_opens_at: Date | null;
    voting_closes_at: Date | null;
    created_at: Date;
    weight_for: string;
    weight_against: string;
    weight_abstain: string;
    voter_count: string;
  }

  function toProposal(row: ProposalRow) {
    return {
      id: row.id,
      proposalType: row.proposal_type,
      title: row.title,
      rationale: row.rationale,
      state: row.state,
      quorum: { numerator: row.quorum_numerator, denominator: row.quorum_denominator },
      threshold: { numerator: row.threshold_numerator, denominator: row.threshold_denominator },
      votingOpensAt: row.voting_opens_at?.toISOString() ?? null,
      votingClosesAt: row.voting_closes_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
      tally: tallyOf(row),
    };
  }

  app.get("/api/v1/public/governance/proposals", async (request, reply) => {
    const query = parseQuery(publicCursorQuery, request.query);
    const after = query.cursor ? decodeCursor(query.cursor) : null;

    const rows = await sql<ProposalRow[]>`
      SELECT * FROM core.public_protocol_proposals(
        ${query.limit + 1}, ${after?.at ?? null}, ${after?.id ?? null}
      )
    `;

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    reply.header("cache-control", "public, max-age=30");

    return {
      items: page.map(toProposal),
      nextCursor:
        rows.length > query.limit && last ? encodeCursor(last.created_at, last.id) : null,
      sort: "createdAt:desc,id:desc" as const,
      requestId: request.context.requestId,
      asOf: request.context.asOf,
    };
  });

  app.get<{ Params: { proposalId: string } }>(
    "/api/v1/public/governance/proposals/:proposalId",
    async (request, reply) => {
      const rows = await sql<ProposalRow[]>`
        SELECT * FROM core.public_protocol_proposals(100, NULL, NULL)
        WHERE id = ${request.params.proposalId}
      `;

      const proposal = rows[0];
      if (!proposal) {
        return reply.status(404).send({
          code: "NOT_FOUND",
          message: "공개된 제안을 찾을 수 없다",
          retryable: false,
          correlationId: request.context.correlationId,
        });
      }

      // 현재 상태만 보면 "정족수 미달로 끝났다"와 "취소됐다"가 같아 보인다.
      const transitions = await sql<
        {
          from_state: string;
          to_state: string;
          reason: string;
          occurred_at: Date;
          tally_snapshot: Record<string, unknown> | null;
        }[]
      >`
        SELECT * FROM core.public_protocol_proposal_transitions(${request.params.proposalId})
      `;

      reply.header("cache-control", "public, max-age=30");

      return {
        ...toProposal(proposal),
        transitions: transitions.map((row) => ({
          fromState: row.from_state,
          toState: row.to_state,
          reason: row.reason,
          occurredAt: row.occurred_at.toISOString(),
          tallySnapshot: row.tally_snapshot,
        })),
        requestId: request.context.requestId,
        asOf: request.context.asOf,
      };
    },
  );

  // --- 공개 이력 — 정정과 철회 --------------------------------------

  /**
   * 이 목록이 덮지 않는 사건 종류.
   *
   * 빈 목록과 "그 종류는 애초에 여기 오지 않는다"를 구분하지 않으면 사용자가
   * "그런 일이 없었다"로 읽는다. 응답이 스스로 범위를 말한다.
   */
  const NOT_COVERED = [
    {
      kind: "credential_revocation",
      reason:
        "This list publishes that an event happened, when, and which published record it attaches to \u2014 never its content or the parties involved. " +
        "A credential revocation's record is a person, so that rule cannot express it. It is excluded by the rule, not by an undecided question.",
    },
  ] as const;

  app.get("/api/v1/public/disclosures", async (request, reply) => {
    const query = parseQuery(publicCursorQuery, request.query);
    const after = query.cursor ? decodeCursor(query.cursor) : null;

    const rows = await sql<
      {
        event_id: string;
        event_kind: "revocation" | "source_correction" | "suspension" | "pause" | "dispute";
        occurred_at: Date;
        registry_type: "project" | "verification" | "asset";
        public_key: string;
        entry_version_id: string | null;
        entry_version: number | null;
        public_projection: Record<string, unknown> | null;
        superseded_by_id: string | null;
        from_state: string | null;
        to_state: string | null;
        resolved_at: Date | null;
      }[]
    >`
      SELECT * FROM core.public_disclosure_events(
        ${query.limit + 1}, ${after?.at ?? null}, ${after?.id ?? null}
      )
    `;

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    reply.header("cache-control", "public, max-age=30");

    return {
      items: page.map((row) => ({
        eventId: row.event_id,
        eventKind: row.event_kind,
        occurredAt: row.occurred_at.toISOString(),
        registryType: row.registry_type,
        publicKey: row.public_key,
        // registry version에서 온 것만 이 묶음을 갖는다. 나머지는 null이다 —
        // 빈 객체로 두면 "version이 있는데 비었다"로 읽힌다.
        registryVersion:
          row.entry_version_id === null
            ? null
            : {
                entryVersionId: row.entry_version_id,
                version: String(row.entry_version),
                supersededBy: row.superseded_by_id,
                projection: row.public_projection ?? {},
              },
        lifecycle:
          row.from_state === null || row.to_state === null
            ? null
            : { fromState: row.from_state, toState: row.to_state },
        resolvedAt: row.resolved_at?.toISOString() ?? null,
      })),
      nextCursor:
        rows.length > query.limit && last ? encodeCursor(last.occurred_at, last.event_id) : null,
      sort: "occurredAt:desc,eventId:desc" as const,
      notCovered: NOT_COVERED,
      requestId: request.context.requestId,
      asOf: request.context.asOf,
    };
  });
}
