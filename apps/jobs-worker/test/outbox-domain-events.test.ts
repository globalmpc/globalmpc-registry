import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type postgres from "postgres";
import { connectIsolated } from "./helpers/isolated-db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

const hex32 = () => `0x${randomBytes(32).toString("hex")}`;

/**
 * Domain events emitted by state-change triggers (0066) — 07 §7.4.
 *
 * Each case changes the state the way the owning code does and reads what landed in the
 * outbox. The anchor cases run as the worker role, since that is the role that moves chain
 * transactions in production.
 */
describeDb("domain events from state changes", () => {
  let sql: postgres.Sql;
  const tenant = randomUUID();
  const subject = randomUUID();
  const project = randomUUID();

  beforeAll(async () => {
    sql = await connectIsolated("domain_events");
    const org = randomUUID();
    await sql`INSERT INTO core.tenants (id, slug, display_name)
              VALUES (${tenant}, ${`de-${tenant.slice(0, 8)}`}, 'domain events')`;
    await sql`INSERT INTO core.organizations (id, tenant_id, legal_name, jurisdiction)
              VALUES (${org}, ${tenant}, 'Org', 'MNG')`;
    await sql`INSERT INTO core.subjects (id, tenant_id, kind, display_name)
              VALUES (${subject}, ${tenant}, 'person', 'Holder')`;
    await sql`INSERT INTO core.projects (id, tenant_id, project_key, name, host_country_iso3, owner_organization_id)
              VALUES (${project}, ${tenant}, ${`DE-${project.slice(0, 6)}`}, 'Events', 'MNG', ${org})`;
  });

  beforeEach(async () => {
    await sql`TRUNCATE core.outbox, core.inbox`;
  });

  afterAll(async () => {
    await sql.end();
  });

  async function events() {
    return sql<
      {
        event_type: string;
        aggregate_id: string;
        project_id: string | null;
        payload: Record<string, unknown>;
        correlation_id: string;
      }[]
    >`SELECT event_type, aggregate_id, project_id, payload, correlation_id
      FROM core.outbox ORDER BY occurred_at, event_type`;
  }

  describe("anchor", () => {
    async function transaction(): Promise<{ id: string; batch: string }> {
      const batch = randomUUID();
      const id = randomUUID();
      await sql`
        INSERT INTO chain.anchor_batches (
          id, tenant_id, batch_id, merkle_root, manifest_hash, manifest_object_key,
          schema_version, record_count
        ) VALUES (${batch}, ${tenant}, ${hex32()}, ${hex32()}, ${hex32()}, 'm.json', '1', 1)
      `;
      await sql`
        INSERT INTO chain.transactions (id, tenant_id, batch_id, intent_key, chain_id, state, tx_hash)
        VALUES (${id}, ${tenant}, ${batch}, ${`anchor:${batch}`}, 31337, 'submitted', ${hex32()})
      `;
      await sql`TRUNCATE core.outbox`;
      return { id, batch };
    }

    async function asWorker(work: (tx: postgres.TransactionSql) => Promise<unknown>) {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE mpc_worker`;
        await work(tx);
      });
    }

    it("confirmation emits anchor.confirmed; included does not", async () => {
      const { id, batch } = await transaction();

      await asWorker(async (tx) => {
        await tx`UPDATE chain.transactions SET state = 'included', block_number = 10,
                   block_hash = ${hex32()} WHERE id = ${id}`;
      });
      expect(await events()).toEqual([]);

      await asWorker(async (tx) => {
        await tx`UPDATE chain.transactions SET state = 'confirmed' WHERE id = ${id}`;
      });
      const [confirmed] = await events();
      expect(confirmed).toMatchObject({
        event_type: "anchor.confirmed",
        aggregate_id: batch,
        payload: { transactionId: id, fromState: "included", toState: "confirmed", blockNumber: 10 },
      });
      expect(confirmed!.correlation_id).toMatch(/^txid:\d+$/);
    });

    it("a terminal failure emits anchor.failed naming the state", async () => {
      const { id } = await transaction();
      await asWorker(async (tx) => {
        await tx`UPDATE chain.transactions SET state = 'reverted' WHERE id = ${id}`;
      });
      expect(await events()).toMatchObject([
        { event_type: "anchor.failed", payload: { toState: "reverted" } },
      ]);
    });

    it("a recorded reorg emits anchor.reorged", async () => {
      const { id, batch } = await transaction();
      await asWorker(async (tx) => {
        await tx`
          INSERT INTO chain.reorg_events (
            id, tenant_id, transaction_id, previous_block_number, previous_block_hash, detected_state
          ) VALUES (${randomUUID()}, ${tenant}, ${id}, 10, ${hex32()}, 'submitted')
        `;
      });
      expect(await events()).toMatchObject([
        {
          event_type: "anchor.reorged",
          aggregate_id: batch,
          payload: { transactionId: id, previousBlockNumber: 10, detectedState: "submitted" },
        },
      ]);
    });
  });

  describe("credential", () => {
    it("creation emits verified; expiry and revocation emit their own; suspension emits nothing", async () => {
      const id = randomUUID();
      await sql`
        INSERT INTO core.credentials (
          id, tenant_id, subject_id, issuer_reference, credential_type, issued_at
        ) VALUES (${id}, ${tenant}, ${subject}, 'ref-1', 'competent_person', now())
      `;
      await sql`UPDATE core.credentials SET current_status = 'suspended' WHERE id = ${id}`;
      await sql`UPDATE core.credentials SET current_status = 'expired' WHERE id = ${id}`;
      await sql`UPDATE core.credentials SET current_status = 'revoked' WHERE id = ${id}`;

      const emitted = await events();
      expect(emitted.map((event) => event.event_type).sort()).toEqual([
        "credential.expired",
        "credential.revoked",
        "credential.verified",
      ]);
      expect(emitted.find((event) => event.event_type === "credential.revoked")?.payload).toEqual({
        credentialId: id,
        subjectId: subject,
        credentialType: "competent_person",
        fromStatus: "expired",
        toStatus: "revoked",
      });
    });
  });

  describe("evidence version", () => {
    async function artifact(): Promise<string> {
      const id = randomUUID();
      await sql`
        INSERT INTO core.artifacts (id, tenant_id, project_id, kind, content_hash, sensitivity)
        VALUES (${id}, ${tenant}, ${project}, 'raw_source', ${hex32()}, 'restricted')
      `;
      return id;
    }

    it("supersede and revoke each emit once, with the project", async () => {
      const old = await artifact();
      const next = await artifact();

      await sql`UPDATE core.artifacts SET superseded_by = ${next} WHERE id = ${old}`;
      // A superseded version is not revoked afterwards (artifact lifecycle guard), so the
      // revocation is on the version that replaced it.
      await sql`UPDATE core.artifacts SET revoked_at = now() WHERE id = ${next}`;
      // Touching the rows again does not repeat either event.
      await sql`UPDATE core.artifacts SET superseded_by = superseded_by WHERE id = ${old}`;
      await sql`UPDATE core.artifacts SET revoked_at = revoked_at WHERE id = ${next}`;

      expect(await events()).toMatchObject([
        {
          event_type: "evidence.version.superseded",
          aggregate_id: old,
          project_id: project,
          payload: { supersededBy: next },
        },
        { event_type: "evidence.version.revoked", aggregate_id: next, project_id: project },
      ]);
    });
  });

  describe("governance", () => {
    async function proposal(): Promise<string> {
      const id = randomUUID();
      await sql`
        INSERT INTO core.governance_proposals (
          id, tenant_id, space, project_id, proposal_type, title, rationale, proposer_subject_id,
          quorum_numerator, quorum_denominator, threshold_numerator, threshold_denominator,
          conflict_disclosure, execution_mode
        ) VALUES (
          ${id}, ${tenant}, 'project', ${project}, 'operating_change', 'Title', 'Why',
          ${subject}, 1, 10, 1, 2, 'No conflict of interest', 'offchain_required'
        )
      `;
      return id;
    }

    async function transition(id: string, from: string, to: string) {
      await sql`
        INSERT INTO core.governance_transitions (id, tenant_id, proposal_id, from_state, to_state, reason)
        VALUES (${randomUUID()}, ${tenant}, ${id}, ${from}::core.proposal_state, ${to}::core.proposal_state, 'r')
      `;
    }

    it("creation emits governance.proposal.created", async () => {
      const id = await proposal();
      expect(await events()).toMatchObject([
        {
          event_type: "governance.proposal.created",
          aggregate_id: id,
          project_id: project,
          payload: { space: "project", state: "draft" },
        },
      ]);
    });

    it("a vote result emits finalized; execution transitions emit execution.status.changed", async () => {
      const id = await proposal();
      await sql`TRUNCATE core.outbox`;

      await transition(id, "draft", "review");
      await transition(id, "voting", "succeeded");
      await transition(id, "recorded", "execution_pending");
      await transition(id, "execution_pending", "executed");

      expect((await events()).map((event) => [event.event_type, event.payload["toState"] ?? event.payload["result"]])).toEqual([
        ["governance.proposal.finalized", "succeeded"],
        ["execution.status.changed", "execution_pending"],
        ["execution.status.changed", "executed"],
      ]);
    });
  });
});
