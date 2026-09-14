import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { runMigrations } from "@mpc/db";
import { resolveVoteWeight, snapshotBlockFor } from "../src/services/vote-weight.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Vote weight snapshot — 04 §4.5.
 *
 * The point is that **a voter cannot set their own weight**. The request body value is used
 * only for proposals with no token configured.
 */

describe("snapshot block selection", () => {
  it("uses a finalized block, not head", () => {
    // head can be reorged, erasing the weight basis of votes already cast.
    expect(snapshotBlockFor(1000, 12)).toBe(988);
  });

  it("does not go negative early in the chain", () => {
    expect(snapshotBlockFor(5, 12)).toBe(0);
  });
});

describeDb("weight resolution", () => {
  let sql: postgres.Sql;
  let tenantId: string;
  let proposalId: string;
  const wallet = `0x${"1f".repeat(20)}`;
  const token = `0x${"2e".repeat(20)}`;

  beforeAll(async () => {
    sql = postgres(process.env["DATABASE_URL"]!, { onnotice: () => {}, prepare: false });
    await runMigrations(sql);
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    tenantId = randomUUID();
    proposalId = randomUUID();

    await sql`
      INSERT INTO core.tenants (id, slug, display_name)
      VALUES (${tenantId}, ${`vw-${tenantId.slice(0, 8)}`}, 'vote weight')
    `;
    const subjectId = randomUUID();
    await sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name)
      VALUES (${subjectId}, ${tenantId}, 'person', 'proposer')
    `;
    await sql`
      INSERT INTO core.governance_proposals (
        id, tenant_id, space, proposal_type, title, rationale, proposer_subject_id,
        quorum_numerator, quorum_denominator, threshold_numerator, threshold_denominator
      ) VALUES (
        ${proposalId}, ${tenantId}, 'protocol', 'fee_schedule', 'title', 'reason',
        ${subjectId}, 1, 4, 1, 2
      )
    `;
  });

  const base = () => ({
    tenantId,
    proposalId,
    walletAddress: wallet,
    snapshotBlock: 1000,
    snapshotTokenAddress: token,
    manualWeight: null,
  });

  it("reads the onchain balance as weight", async () => {
    const result = await sql.begin((tx) =>
      resolveVoteWeight(tx, base(), async () => 5000n),
    );

    expect(result).toMatchObject({ weight: 5000n, source: "onchain_snapshot" });
  });

  it("ignores the weight in the request body", async () => {
    // If voters set their own weight, it is a declaration, not a vote.
    const result = await sql.begin((tx) =>
      resolveVoteWeight(tx, { ...base(), manualWeight: "999999" }, async () => 100n),
    );

    expect((result as { weight: bigint }).weight).toBe(100n);
  });

  it("uses the stored value on the second lookup", async () => {
    await sql.begin((tx) => resolveVoteWeight(tx, base(), async () => 100n));

    // Re-reading would yield a different value if the block was reorged in between.
    const second = await sql.begin((tx) =>
      resolveVoteWeight(tx, base(), async () => 999n),
    );
    expect((second as { weight: bigint }).weight).toBe(100n);
  });

  it("does not read a lookup failure as a zero balance", async () => {
    // 0 means "holds no token"; failure means "unknown". Recording the former silently
    // strips voting power.
    await expect(
      sql.begin((tx) =>
        resolveVoteWeight(tx, base(), async () => {
          throw new Error("archive node required");
        }),
      ),
    ).rejects.toThrow(/Could not read the balance|VOTE_WEIGHT_UNAVAILABLE/);
  });

  it("falls back to manual weight when no token is set", async () => {
    const result = await sql.begin((tx) =>
      resolveVoteWeight(
        tx,
        { ...base(), snapshotBlock: null, snapshotTokenAddress: null, manualWeight: "42" },
        async () => 0n,
      ),
    );

    // This is not hidden — a result tallied with manual weight must not be read as
    // onchain-backed.
    expect(result).toMatchObject({ weight: 42n, source: "manual", blockNumber: null });
  });

  it("cannot vote with neither a token nor a manual weight", async () => {
    await expect(
      sql.begin((tx) =>
        resolveVoteWeight(
          tx,
          { ...base(), snapshotBlock: null, snapshotTokenAddress: null },
          async () => 0n,
        ),
      ),
    ).rejects.toThrow(/VOTE_WEIGHT_REQUIRED|must be specified/);
  });

  it("cannot modify a snapshotted weight", async () => {
    await sql.begin((tx) => resolveVoteWeight(tx, base(), async () => 100n));

    // If weight can be changed, results can be changed.
    await expect(
      sql`
        UPDATE core.governance_vote_weights SET weight = 999
        WHERE proposal_id = ${proposalId}
      `,
    ).rejects.toThrow(/수정할 수 없다/);
  });

  it("does not change the snapshot block once set", async () => {
    await sql`
      UPDATE core.governance_proposals SET snapshot_block = 1000 WHERE id = ${proposalId}
    `;

    // Moving the block mid-vote erases the weight basis of votes already cast.
    await expect(
      sql`
        UPDATE core.governance_proposals SET snapshot_block = 2000 WHERE id = ${proposalId}
      `,
    ).rejects.toThrow(/바꿀 수 없다/);
  });

  it("keeps precision for 18-decimal weights", async () => {
    const huge = 10n ** 24n + 7n;
    const result = await sql.begin((tx) => resolveVoteWeight(tx, base(), async () => huge));
    expect((result as { weight: bigint }).weight).toBe(huge);
  });
});
