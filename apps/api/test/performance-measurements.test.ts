import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  buildMerkleTree,
  getMerkleProof,
  keccak256,
  verifyMerkleProof,
  type Hex,
} from "@mpc/canonical";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";
import rulesFixture from "../../../packages/policy/test/fixtures/registry-gate.rules.json" with { type: "json" };

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * The measurements 13 §13.7 lists that `throughput.test.ts` does not cover.
 *
 * **Numbers only, no pass criteria.** The targets are OD-32, which is undecided; a threshold
 * written here would become the decision. Each case prints its figures and asserts only that the
 * operation worked — a latency figure for a request that failed would measure the error path.
 * The existing `PERF_MAX_P95_MS` gate in `throughput.test.ts` is unchanged.
 *
 * Absolute values depend on the machine. They are for comparing runs on the same runner.
 *
 * Export package generation (07 §7.9) is also on the 13 §13.7 list but has no implementation in
 * this repository yet, so there is nothing to measure.
 */

interface Measurement {
  readonly label: string;
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

function summarize(label: string, durations: readonly number[]): Measurement {
  const sorted = [...durations].sort((a, b) => a - b);
  const at = (ratio: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    label,
    count: sorted.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted[sorted.length - 1] ?? 0),
  };
}

function report(measurement: Measurement): void {
  process.stdout.write(
    `  ${measurement.label}: n=${measurement.count} p50=${measurement.p50}ms ` +
      `p95=${measurement.p95}ms max=${measurement.max}ms\n`,
  );
}

async function time<T>(work: () => Promise<T> | T): Promise<{ ms: number; value: T }> {
  const start = performance.now();
  const value = await work();
  return { ms: performance.now() - start, value };
}

const leafHashes = (count: number): Hex[] =>
  Array.from({ length: count }, (_, index) => keccak256(new TextEncoder().encode(`leaf-${index}`)));

describe("Merkle batch build and proof (13 §13.7)", () => {
  for (const size of [1_000, 10_000]) {
    // Coverage instrumentation and shared CI runners can exceed Vitest's 5s default.
    // These measurements have no latency gate; correctness assertions still apply.
    it(`builds a ${size}-leaf batch and proves members`, async () => {
      const leaves = leafHashes(size);

      const builds: number[] = [];
      let tree = buildMerkleTree(leaves);
      for (let run = 0; run < 5; run += 1) {
        const measured = await time(() => buildMerkleTree(leaves));
        builds.push(measured.ms);
        tree = measured.value;
      }
      report(summarize(`Merkle build (${size} leaves)`, builds));

      const proofs: number[] = [];
      for (let index = 0; index < 200; index += 1) {
        const leaf = leaves[(index * 7919) % size]!;
        const measured = await time(() => getMerkleProof(tree, leaf));
        proofs.push(measured.ms);
        expect(verifyMerkleProof(leaf, measured.value, tree.root)).toBe(true);
      }
      report(summarize(`Merkle proof (${size} leaves)`, proofs));
    }, 30_000);
  }
});

describeDb("database-backed measurements (13 §13.7)", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let operator: string;
  let approver: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    operator = await signIn(app, fx.operatorA);
    approver = await signIn(app, fx.approverA);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  it("governance tally over 2,000 votes", async () => {
    const proposalId = randomUUID();
    const proposer = randomUUID();
    await fx.sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name)
      VALUES (${proposer}, ${fx.tenantA}, 'person', 'Perf proposer')
    `;
    await fx.sql`
      INSERT INTO core.governance_proposals (
        id, tenant_id, space, proposal_type, title, rationale, proposer_subject_id,
        quorum_numerator, quorum_denominator, threshold_numerator, threshold_denominator,
        state, voting_opens_at, conflict_disclosure, execution_mode
      ) VALUES (
        ${proposalId}, ${fx.tenantA}, 'protocol', 'fee_schedule', 'Perf tally', 'measurement',
        ${proposer}, 1, 4, 1, 2, 'voting', now(), 'No conflict of interest', 'record_only'
      )
    `;
    // Voters are subjects; the tally reads the vote rows the API would have written.
    await fx.sql`
      WITH voters AS (
        INSERT INTO core.subjects (id, tenant_id, kind, display_name)
        SELECT gen_random_uuid(), ${fx.tenantA}, 'person', 'voter ' || n
        FROM generate_series(1, 2000) AS n
        RETURNING id
      )
      INSERT INTO core.governance_votes (id, tenant_id, proposal_id, voter_subject_id, choice, weight)
      SELECT gen_random_uuid(), ${fx.tenantA}, ${proposalId}, id,
             (ARRAY['for','against','abstain'])[1 + (random() * 2)::int], (random() * 1e6)::numeric(78,0)
      FROM voters
    `;

    const durations: number[] = [];
    for (let run = 0; run < 30; run += 1) {
      const measured = await time(() =>
        app.inject({
          method: "GET",
          url: `/api/v1/governance/proposals/${proposalId}`,
          headers: { authorization: `Bearer ${operator}` },
        }),
      );
      expect(measured.value.statusCode).toBe(200);
      durations.push(measured.ms);
    }
    report(summarize("Governance tally read (2,000 votes)", durations));
  });

  it("readiness recomputation", async () => {
    const policySetId = randomUUID();
    await fx.sql`
      INSERT INTO core.compliance_policy_sets (
        id, tenant_id, rule_set_id, rule_set_version, gate_id,
        jurisdiction_profile, effective_from, definition, state
      ) VALUES (
        ${policySetId}, ${fx.tenantA}, 'registry-publication-gate', '1.0.0',
        'registry_publication', 'MNG', now(), ${fx.sql.json(rulesFixture as never)}, 'effective'
      )
    `;

    const durations: number[] = [];
    for (let run = 0; run < 20; run += 1) {
      const measured = await time(() =>
        app.inject({
          method: "POST",
          url: `/api/v1/projects/${fx.projectA}/readiness-assessments`,
          headers: { authorization: `Bearer ${approver}`, "idempotency-key": idempotencyKey() },
          payload: { policySetId },
        }),
      );
      expect(measured.value.statusCode).toBe(200);
      durations.push(measured.ms);
    }
    report(summarize("Readiness recomputation", durations));
  });
});
