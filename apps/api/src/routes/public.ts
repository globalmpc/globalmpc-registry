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
 * Unauthenticated public routes — spec 07 §7.1, OD-02.
 *
 * This file is separate not because of length but because **the boundary differs**. Routes
 * here run with no session and no tenant, cannot satisfy RLS, and so all go through
 * `core.public_*` SECURITY DEFINER functions (0009 · 0027 · 0034). Mixed in with workspace
 * routes, "there is no tenant here" becomes a fact that must be re-checked every time.
 *
 * Common rules:
 *
 * - Only published data goes out. `draft` never leaves through any path.
 * - tenant_id is not returned.
 * - No field outside the public allowlist is included (05 §5.7).
 * - Lists use a keyset cursor. With OFFSET, pages drift when rows are added up front.
 */

/**
 * The cursor is an opaque string that wraps the sort key.
 *
 * Why wrap it: once clients start assembling sort keys, the sort order can no longer change.
 * base64 is not encryption and hides nothing — it gives shape to the contract "this is a
 * value we issued, to be returned as is".
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
    // A tampered cursor is not silently reset to the first page. That would make the client
    // refetch the list forever without ever believing it has reached the end.
    throw badRequest("INVALID_CURSOR", "Cursor was not issued by this list");
  }
  return { at, id: matched.groups!["id"]! };
}

type SearchMatch = z.infer<typeof publicSearchResult>["matches"][number];

/** Shape public search treats as a hash. 32-byte hex — tx, root, leaf, and batch ids all look like this. */
const HASH_SHAPE = /^0x[0-9a-f]{64}$/;
const REGISTRY_TYPES = ["project", "verification", "asset"] as const;
/** Cap on name-search results per registry. Unified search is a signpost, not a listing. */
const TEXT_MATCH_LIMIT = 10;

/** Parameters outside the contract are not ignored. Ignoring them turns a mistyped filter into "everything". */
function parseQuery<T>(schema: { safeParse(input: unknown): { success: boolean; data?: T; error?: { issues: { path: (string | number)[]; message: string }[] } } }, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success || parsed.data === undefined) {
    throw badRequest("INVALID_QUERY", "Query parameters do not match the contract", {
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
      // Parameters outside the contract are rejected, not ignored (`.strict()`). Ignoring them
      // lets a mistyped filter silently fall through to "the full list".
      const query = parseQuery(publicRegistryListQuery, request.query);
      const after = query.cursor ? decodeCursor(query.cursor) : null;

      // Knowing whether a next page exists takes one extra row. No total is counted because
      // as the public list grows, COUNT would scan everything on every request.
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

      // Public lists are cacheable reads. They are not personalized, so shared caches are
      // allowed; publishing is infrequent, so the TTL is kept short.
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
          // The projection is not spread — whether only public-allowed fields went out must be
          // decidable from the response alone.
          projection: row.public_projection,
        })),
        // The cursor is built from the sort key, not `published_at`. The two diverge when
        // published_at is empty, and building from published_at then makes pages drift.
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
      // Public routes do not know the tenant — they are read by readers who are not signed in.
      // RLS policies cannot be satisfied, so only the public path is split out into a SECURITY
      // DEFINER function (0009_public_read.sql). That function returns only the public
      // projection of published versions and does not return tenant_id.
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
        // Lets the client tell from a header which version it is viewing.
        // Same value as the body's version; it can be passed to If-Match as is.
        reply.header("etag", etagOf(current.version));
      }
      if (!current) {
        return reply.status(404).send({
          code: "NOT_FOUND",
          message: "Public record not found",
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
        // Earlier versions are not hidden. Correction and revocation history is part of the disclosure (§11.3).
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
          message: "This version is not anchored yet",
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
        // AC-23: included is true only when confirmed. Before that, it is not final.
        included: verified && proof.confirmationState === "confirmed",
        merkleVerified: verified,
        proves: [...PROOF_PROVES],
        doesNotProve: [...PROOF_DOES_NOT_PROVE],
        // The spec version is returned as the **stored value**. Hard-coding a constant would
        // leave responses stating the old value after the spec is bumped.
        policyVersion: proof.policyVersion,
        schemaVersion: proof.schemaVersion,
        serializationVersion: proof.serializationVersion,
        requestId: request.context.requestId,
        asOf: request.context.asOf,
      };
    },
  );

  // --- Public unified search --------------------------------------------

  app.get("/api/v1/public/search", async (request, reply) => {
    const { q } = parseQuery(publicSearchQuery, request.query);
    reply.header("cache-control", "public, max-age=30");
    // chainId lets the UI link a transaction hash to that chain's explorer.
    const base = {
      query: q,
      chainId: config.chainId,
      requestId: request.context.requestId,
      asOf: request.context.asOf,
    };

    // Hashes are stored lowercase. Uppercase hex copied from a wallet or explorer is the same value.
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

    // Exact key matches come first. Someone pasting a shared key must not find that record
    // buried under other records with similar names.
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

  // Public field list. Tells the Explorer what it can expect.
  app.get("/api/v1/public/projection-fields", async (request) => ({
    fields: Object.keys(publicProjection.shape).filter(isPublicField),
    requestId: request.context.requestId,
    asOf: request.context.asOf,
  }));

  // --- Public governance ------------------------------------------------
  //
  // Protocol space only, `draft` excluded, no voter roster. Rationale is in the 0027 header.

  /** `NUMERIC(78,0)` does not fit in a JSON number. It is carried over as a string. */
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
          message: "Public proposal not found",
          retryable: false,
          correlationId: request.context.correlationId,
        });
      }

      // The current state alone makes "ended short of quorum" and "cancelled" look the same.
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

  // --- Public history — corrections and revocations --------------------------------------

  /**
   * Event kinds this list does not cover.
   *
   * Without distinguishing an empty list from "that kind never comes here", users read it as
   * "that never happened". The response states its own scope.
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
        // Only entries from a registry version carry this group. Others are null — an empty
        // object would read as "there is a version, but it is empty".
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
