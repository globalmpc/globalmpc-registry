import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { listMigrations, runMigrations } from "../src/migrate.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const describeDb = DATABASE_URL ? describe : describe.skip;

const TARGET = "0130_single_signing_wallet.sql";

const address = (byte: string) => `0x${byte.repeat(40)}`;

/**
 * 0130 — one signing wallet per account.
 *
 * Seeds, under the schema before 0130, people holding several active wallets (dev and seed data
 * could), one with a designated governance wallet, and a snapshot vote; migrates; and checks that
 * each person keeps exactly the wallet the header promises, that every other one is disabled with
 * the system reason and audited, that no session ended, and that the new uniqueness and history
 * rules hold even for the table owner.
 */
describeDb("migration 0130: single signing wallet", () => {
  const dbName = `m0130_probe_${process.pid}_${Date.now()}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  const tenant = randomUUID();
  const [alice, bob, carol, dave, erin, frank] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const wallets = {
    aliceOld: randomUUID(),
    aliceGovernance: randomUUID(),
    aliceNewest: randomUUID(),
    bobOld: randomUUID(),
    bobNewest: randomUUID(),
    carolOnly: randomUUID(),
    carolDisabled: randomUUID(),
    daveDisabledGovernance: randomUUID(),
    daveNewest: randomUUID(),
    daveOld: randomUUID(),
    erinOperator: randomUUID(),
    erinDevProof: randomUUID(),
    frankIdentityBound: randomUUID(),
    frankNewerProof: randomUUID(),
  };
  const session = randomUUID();
  const proposal = randomUUID();

  beforeAll(async () => {
    admin = postgres(DATABASE_URL!, { onnotice: () => {}, max: 1 });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    const url = new URL(DATABASE_URL!);
    url.pathname = `/${dbName}`;
    sql = postgres(url.toString(), { onnotice: () => {}, max: 1 });

    const all = listMigrations();
    const index = all.findIndex((migration) => migration.name === TARGET);
    expect(index).toBeGreaterThan(0);
    await runMigrations(sql, all.slice(0, index));

    await sql`INSERT INTO core.tenants (id, slug, display_name) VALUES (${tenant}, ${`m0130-${tenant.slice(0, 8)}`}, 'Probe')`;
    for (const subject of [alice, bob, carol, dave, erin, frank]) {
      await sql`INSERT INTO core.subjects (id, tenant_id, kind, display_name) VALUES (${subject}, ${tenant}, 'person', 'Holder')`;
    }
    const wallet = (id: string, subject: string, byte: string, boundAt: string, disabled = false) => sql`
      INSERT INTO core.wallet_identities (id, tenant_id, subject_id, wallet_address, chain_id, bound_at, disabled_at)
      VALUES (${id}, ${tenant}, ${subject}, ${address(byte)}, 31337, ${boundAt}::timestamptz,
              ${disabled ? sql`now()` : null})
    `;
    await wallet(wallets.aliceOld, alice, "a", "2026-01-01");
    await wallet(wallets.aliceGovernance, alice, "b", "2026-02-01");
    await wallet(wallets.aliceNewest, alice, "c", "2026-03-01");
    await wallet(wallets.bobOld, bob, "d", "2026-01-01");
    await wallet(wallets.bobNewest, bob, "e", "2026-05-01");
    await wallet(wallets.carolOnly, carol, "f", "2026-01-01");
    await wallet(wallets.carolDisabled, carol, "1", "2025-01-01", true);
    await wallet(wallets.daveDisabledGovernance, dave, "2", "2026-06-01", true);
    await wallet(wallets.daveNewest, dave, "3", "2026-04-01");
    await wallet(wallets.daveOld, dave, "4", "2026-01-01");
    // Erin: an operator-verified key, then a later proof binding (e.g. a dev-chain wallet).
    // Frank: two proof bindings, the older at a higher assurance.
    const proofWallet = (id: string, subject: string, byte: string, boundAt: string, level: string) => sql`
      INSERT INTO core.wallet_identities (id, tenant_id, subject_id, wallet_address, chain_id, bound_at, bound_via, assurance_level)
      VALUES (${id}, ${tenant}, ${subject}, ${address(byte)}, 31337, ${boundAt}::timestamptz, 'proof',
              ${level}::core.assurance_level)
    `;
    await sql`
      INSERT INTO core.wallet_identities (id, tenant_id, subject_id, wallet_address, chain_id, bound_at, bound_via, assurance_level)
      VALUES (${wallets.erinOperator}, ${tenant}, ${erin}, ${address("6")}, 31337, '2026-01-01'::timestamptz, 'operator',
              'wallet_only')
    `;
    await proofWallet(wallets.erinDevProof, erin, "7", "2026-07-01", "high_assurance");
    await proofWallet(wallets.frankIdentityBound, frank, "8", "2026-01-01", "identity_bound");
    await proofWallet(wallets.frankNewerProof, frank, "0", "2026-07-01", "wallet_only");
    await sql`UPDATE core.subjects SET governance_wallet_id = ${wallets.aliceGovernance} WHERE id = ${alice}`;
    await sql`UPDATE core.subjects SET governance_wallet_id = ${wallets.daveDisabledGovernance} WHERE id = ${dave}`;

    // A live session of a consolidated person: consolidation must not end it.
    // An account session stands on a consumed email challenge (0113).
    const emailChallenge = randomUUID();
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO core.email_challenges (
          id, purpose, email, code_hmac, tenant_id, subject_id, created_at, expires_at, consumed_at, consumed_txid
        ) VALUES (
          ${emailChallenge}, 'sign_in', 'alice@example.test', ${Buffer.alloc(32, 1)}, ${tenant}, ${alice},
          now(), now() + interval '10 minutes', now(), pg_current_xact_id()
        )
      `;
      await tx`
        INSERT INTO core.sessions (id, token_hash, tenant_id, subject_id, first_factor, email_challenge_id, expires_at)
        VALUES (${session}, ${`0x${"c".repeat(64)}`}, ${tenant}, ${alice}, 'email_code', ${emailChallenge},
                now() + interval '1 hour')
      `;
    });

    // A snapshot vote whose weight came from Alice's governance wallet.
    await sql`
      INSERT INTO core.governance_proposals (
        id, tenant_id, space, proposal_type, title, rationale, state, proposer_subject_id,
        quorum_numerator, quorum_denominator, threshold_numerator, threshold_denominator,
        snapshot_block, snapshot_token_address, conflict_disclosure, execution_mode
      ) VALUES (
        ${proposal}, ${tenant}, 'protocol', 'fee_schedule', 'Probe', 'Probe', 'voting', ${bob},
        1, 2, 1, 2, 100, ${address("9")}, 'none known', 'record_only'
      )
    `;
    await sql`
      INSERT INTO core.governance_vote_weights (id, tenant_id, proposal_id, wallet_address, weight, block_number)
      VALUES (${randomUUID()}, ${tenant}, ${proposal}, ${address("b")}, 42, 100)
    `;
    await sql`
      INSERT INTO core.governance_votes (id, tenant_id, proposal_id, voter_subject_id, choice, weight)
      VALUES (${randomUUID()}, ${tenant}, ${proposal}, ${alice}, 'for', 42)
    `;

    const applied = await runMigrations(sql, all.slice(0, index + 1));
    expect(applied).toEqual([TARGET]);
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
  });

  const active = async (subject: string) =>
    (
      await sql<{ id: string }[]>`
        SELECT id FROM core.wallet_identities WHERE subject_id = ${subject} AND disabled_at IS NULL
      `
    ).map((row) => row.id);

  it("keeps the designated governance wallet when it is active", async () => {
    expect(await active(alice)).toEqual([wallets.aliceGovernance]);
  });

  it("otherwise keeps the most recently bound active wallet", async () => {
    expect(await active(bob)).toEqual([wallets.bobNewest]);
    // A disabled designation does not count: Dave keeps his newest active wallet.
    expect(await active(dave)).toEqual([wallets.daveNewest]);
  });

  it("prefers an operator-verified wallet over a newer proof binding, whatever their levels", async () => {
    expect(await active(erin)).toEqual([wallets.erinOperator]);
  });

  it("among proof bindings prefers the higher assurance over the newer", async () => {
    expect(await active(frank)).toEqual([wallets.frankIdentityBound]);
  });

  it("leaves a person with one wallet, and their history, untouched", async () => {
    expect(await active(carol)).toEqual([wallets.carolOnly]);
    const [events] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM core.wallet_disable_events
      WHERE wallet_identity_id IN (${wallets.carolOnly}, ${wallets.carolDisabled}, ${wallets.daveDisabledGovernance})
    `;
    expect(events!.n).toBe(0);
  });

  it("records every consolidation with the system reason, no decider, and an audit row", async () => {
    const disabled = [
      wallets.aliceOld, wallets.aliceNewest, wallets.bobOld, wallets.daveOld, wallets.erinDevProof, wallets.frankNewerProof,
    ].sort();
    const events = await sql<{ wallet_identity_id: string; reason_code: string; disabled_by_subject_id: string | null }[]>`
      SELECT wallet_identity_id, reason_code, disabled_by_subject_id FROM core.wallet_disable_events
      ORDER BY wallet_identity_id
    `;
    expect(events).toEqual(
      disabled.map((id) => ({ wallet_identity_id: id, reason_code: "consolidated_single_wallet", disabled_by_subject_id: null })),
    );
    const audits = await sql<{ resource_id: string; actor_subject_id: string | null; detail: Record<string, unknown> }[]>`
      SELECT resource_id, actor_subject_id, detail FROM audit.events
      WHERE command = 'migration.wallet.consolidated' ORDER BY resource_id
    `;
    expect(audits.map((row) => row.resource_id)).toEqual(disabled);
    expect(audits.every((row) => row.actor_subject_id === null)).toBe(true);
    expect(audits.find((row) => row.resource_id === wallets.aliceOld)!.detail).toMatchObject({
      subjectId: alice,
      keptWalletId: wallets.aliceGovernance,
      revokedSessions: 0,
    });
  });

  it("ends no session", async () => {
    const [row] = await sql<{ revoked_at: Date | null }[]>`SELECT revoked_at FROM core.sessions WHERE id = ${session}`;
    expect(row!.revoked_at).toBeNull();
  });

  it("gives the snapshot vote the wallet its weight came from", async () => {
    const [vote] = await sql<{ weight_wallet_address: string | null }[]>`
      SELECT weight_wallet_address FROM core.governance_votes WHERE proposal_id = ${proposal}
    `;
    expect(vote!.weight_wallet_address).toBe(address("b"));
  });

  it("drops the designation: the active wallet is the governance wallet", async () => {
    const [column] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'core' AND table_name = 'subjects' AND column_name = 'governance_wallet_id'
    `;
    expect(column!.n).toBe(0);
    const [fn] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'designate_governance_wallet'
    `;
    expect(fn!.n).toBe(0);
  });

  it("holds one active wallet per subject and per address, and lets a disabled address be bound again", async () => {
    await expect(sql`
      INSERT INTO core.wallet_identities (id, tenant_id, subject_id, wallet_address, chain_id, bound_at)
      VALUES (${randomUUID()}, ${tenant}, ${carol}, ${address("5")}, 31337, now())
    `).rejects.toThrow(/wallet_identities_one_active_per_subject/);
    await expect(sql`
      INSERT INTO core.wallet_identities (id, tenant_id, subject_id, wallet_address, chain_id, bound_at)
      VALUES (${randomUUID()}, ${tenant}, ${randomUUID()}, ${address("f")}, 31337, now())
    `).rejects.toThrow(/wallet_identities_active_address_key|wallet_identities_subject_same_tenant/);

    // Before 0130 a disabled address was unique for ever; now Carol's old key can be bound again.
    await sql`UPDATE core.wallet_identities SET disabled_at = now() WHERE id = ${wallets.carolOnly}`;
    await sql`
      INSERT INTO core.wallet_identities (id, tenant_id, subject_id, wallet_address, chain_id, bound_at, bound_via)
      VALUES (${randomUUID()}, ${tenant}, ${carol}, ${address("1")}, 31337, now(), 'proof')
    `;
    expect(await active(carol)).toHaveLength(1);
  });

  it("freezes disabled rows, even for the owner", async () => {
    await expect(
      sql`UPDATE core.wallet_identities SET disabled_at = NULL WHERE id = ${wallets.aliceOld}`,
    ).rejects.toThrow(/WALLET_HISTORY_FROZEN/);
    await expect(
      sql`UPDATE core.wallet_identities SET subject_id = ${bob} WHERE id = ${wallets.aliceOld}`,
    ).rejects.toThrow(/WALLET_HISTORY_FROZEN/);
  });

  it("allows a missing decider only for the system consolidation", async () => {
    await expect(sql`
      INSERT INTO core.wallet_disable_events (id, tenant_id, wallet_identity_id, reason_code, detail, disabled_by_subject_id)
      VALUES (${randomUUID()}, ${tenant}, ${wallets.bobNewest}, 'key_lost', 'x', NULL)
    `).rejects.toThrow(/wallet_disable_events_decider/);
  });
});
