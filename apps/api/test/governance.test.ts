import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Governance — 04 §4.5, OD-06.
 *
 * This file centers on two points: **a vote does not create off-chain facts** (invariant 12)
 * and **an outcome cannot be declared while ignoring the votes**.
 */
describeDb("Governance", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let proposerToken: string;
  let voterToken: string;
  let stewardToken: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    proposerToken = await signIn(app, fx.proposerA);
    voterToken = await signIn(app, fx.voterA);
    stewardToken = await signIn(app, fx.stewardA);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function propose(token: string, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/v1/governance/proposals",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey() },
      payload: {
        space: "protocol",
        proposalType: "attestation_schema_approval",
        title: "schema change",
        rationale: "the current schema cannot express limitations",
        ...body,
      },
    });
  }

  function transition(id: string, version: number, toState: string, reason = "next step") {
    return app.inject({
      method: "POST",
      url: `/api/v1/governance/proposals/${id}/transitions`,
      headers: {
        authorization: `Bearer ${proposerToken}`,
        "idempotency-key": idempotencyKey(),
        "if-match": `"${version}"`,
      },
      payload: { toState, reason },
    });
  }

  function vote(token: string, id: string, choice: string, weight: string) {
    return app.inject({
      method: "POST",
      url: `/api/v1/governance/proposals/${id}/votes`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey() },
      payload: { choice, weight },
    });
  }

  /**
   * Advances draft → voting. Avoids rewriting the state machine each time.
   *
   * Sets `eligibleWeight` by default: a proposal without an on-chain token can open voting
   * only after a person sets the quorum denominator.
   */
  async function openVoting(body: Record<string, unknown> = {}) {
    const created = (await propose(proposerToken, { eligibleWeight: "100", ...body })).json();
    let version = created.version;
    for (const state of ["review", "announced", "voting"]) {
      version = (await transition(created.id, version, state)).json().version;
    }
    return { id: created.id as string, version: version as number };
  }

  it("a proposal requires a rationale", async () => {
    const response = await propose(proposerToken, { rationale: "" });
    expect(response.statusCode).toBe(400);
  });

  it("a vote-only account cannot propose", async () => {
    const response = await propose(voterToken, {});
    expect(response.statusCode).toBe(403);
    expect(response.json().details.requiredRoles).toContain("protocol_proposer");
  });

  it("cannot propose a target outside the space", async () => {
    // Protocol governance cannot decide a specific project's disposition.
    const response = await propose(proposerToken, {
      proposalType: "project_data_room_publication",
    });
    expect(response.statusCode).toBe(422);
  });

  it("rejects targets that a vote cannot decide", async () => {
    // Legal facts, personal eligibility, and review outcomes are not created by a vote.
    const response = await propose(proposerToken, {
      proposalType: "readiness_override",
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("GOVERNANCE_TARGET_FORBIDDEN");
  });

  it("every response states what it does not create", async () => {
    const response = await propose(proposerToken, {});
    const limitations = response.json().limitations as string[];

    // Reading a governance outcome as legal approval is the most dangerous misreading.
    expect(limitations.join(" ")).toContain("legal facts");
    expect(limitations.join(" ")).toContain("does not happen automatically");
  });

  it("does not accept votes outside the voting period", async () => {
    const created = (await propose(proposerToken, {})).json();
    const response = await vote(voterToken, created.id, "for", "100");

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("VOTING_NOT_OPEN");
  });

  it("tallies votes during the voting period", async () => {
    const { id } = await openVoting();

    const response = await vote(voterToken, id, "for", "100");
    expect(response.statusCode).toBe(200);
    expect(response.json().tally.forWeight).toBe("100");
  });

  it("a repeat vote from the same voter updates it", async () => {
    const { id } = await openVoting();

    await vote(voterToken, id, "for", "100");
    const changed = await vote(voterToken, id, "against", "100");

    // Keeping two votes would require deciding which one is valid.
    expect(changed.json().tally.forWeight).toBe("0");
    expect(changed.json().tally.againstWeight).toBe("100");
  });

  it("large weights keep full precision", async () => {
    // Token weight has 18 decimals. Handling it as a JSON number changes the value.
    const { id } = await openVoting();
    const huge = "1000000000000000000000000";

    const response = await vote(voterToken, id, "for", huge);
    expect(response.json().tally.forWeight).toBe(huge);
  });

  it("cannot close with an outcome that contradicts the tally", async () => {
    const { id, version } = await openVoting();
    await vote(voterToken, id, "against", "100");

    // Only "against" votes exist, yet it tries to close as succeeded.
    const response = await transition(id, version, "succeeded", "mark as passed");
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("TALLY_MISMATCH");
    expect(response.json().details.computed).toBe("defeated");
  });

  it("closes with an outcome matching the tally", async () => {
    const { id, version } = await openVoting();
    await vote(voterToken, id, "against", "100");

    const response = await transition(id, version, "defeated", "more votes against");
    expect(response.statusCode).toBe(200);
    expect(response.json().state).toBe("defeated");
  });

  it("keeps the path taken", async () => {
    const { id, version } = await openVoting();
    await vote(voterToken, id, "for", "100");
    await transition(id, version, "succeeded", "more votes for");

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/governance/proposals/${id}`,
      headers: { authorization: `Bearer ${proposerToken}` },
    });

    // A quorum failure and a cancellation cannot be told apart from the current state alone.
    const transitions = detail.json().transitions as { toState: string }[];
    expect(transitions.map((item) => item.toState)).toEqual([
      "review",
      "announced",
      "voting",
      "succeeded",
    ]);
  });

  it("state transitions require If-Match", async () => {
    const created = (await propose(proposerToken, {})).json();

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/governance/proposals/${created.id}/transitions`,
      headers: {
        authorization: `Bearer ${proposerToken}`,
        "idempotency-key": idempotencyKey(),
      },
      payload: { toState: "review", reason: "start review" },
    });
    expect(response.statusCode).toBe(428);
  });

  it("a disallowed transition tells what can be done next", async () => {
    const created = (await propose(proposerToken, {})).json();

    // draft cannot go directly to voting.
    const response = await transition(created.id, created.version, "voting");
    expect(response.statusCode).toBe(409);
    expect(response.json().details.allowedTransitions).toContain("review");
  });

  it("cannot change a vote after voting closes", async () => {
    const { id, version } = await openVoting();
    await vote(voterToken, id, "for", "100");
    await transition(id, version, "succeeded", "more votes for");

    // A DB trigger blocks it. Changing one vote after the tally contradicts the recorded outcome.
    const response = await vote(voterToken, id, "against", "100");
    expect(response.statusCode).toBe(409);
  });

  it("cannot vote without governance permission", async () => {
    const { id } = await openVoting();
    const response = await vote(stewardToken, id, "for", "100");
    expect(response.statusCode).toBe(403);
  });

  it("proposals of another tenant are not visible", async () => {
    await propose(proposerToken, {});

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/governance/proposals",
      headers: { authorization: `Bearer ${await signIn(app, fx.operatorB)}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([]);
  });

  /**
   * Quorum denominator — 09 §9.6.
   *
   * Using the sum of cast votes as the denominator makes `turnout × D >= turnout × N` always
   * true, so quorum always passes. `no_quorum` then becomes structurally unreachable and a
   * single vote closes it. "Too little turnout" and "too many against" need different next steps.
   */
  it("cannot open voting without a quorum basis", async () => {
    const created = (await propose(proposerToken, {})).json();
    let version = created.version;
    for (const state of ["review", "announced"]) {
      version = (await transition(created.id, version, state)).json().version;
    }

    const response = await transition(created.id, version, "voting");
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("ELIGIBLE_WEIGHT_REQUIRED");
  });

  it("quorum uses total voting power, not cast votes, as the denominator", async () => {
    const { id } = await openVoting({
      eligibleWeight: "1000",
      quorumNumerator: 1,
      quorumDenominator: 4,
    });

    // 1/4 of 1000 = 250 is needed, but only 100 was cast.
    const response = await vote(voterToken, id, "for", "100");
    expect(response.json().tally.quorumMet).toBe(false);
    expect(response.json().tally.provisionalOutcome).toBe("no_quorum");
  });

  it("meeting quorum yields a passing outcome", async () => {
    const { id } = await openVoting({
      eligibleWeight: "1000",
      quorumNumerator: 1,
      quorumDenominator: 4,
    });

    const response = await vote(voterToken, id, "for", "250");
    expect(response.json().tally.quorumMet).toBe(true);
    expect(response.json().tally.provisionalOutcome).toBe("succeeded");
  });

  it("the response states the source of the quorum basis", async () => {
    const { id } = await openVoting({ eligibleWeight: "1000" });

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/governance/proposals/${id}`,
      headers: { authorization: `Bearer ${proposerToken}` },
    });

    // A quorum computed from a manually entered value must not be read as on-chain evidence.
    expect(detail.json().eligibleWeight).toBe("1000");
    expect(detail.json().eligibleWeightSource).toBe("manual");
  });

  it("cannot change the quorum basis after voting opens", async () => {
    const { id } = await openVoting({ eligibleWeight: "1000" });

    // Whoever can edit the denominator can edit the outcome.
    await expect(
      fx.sql`UPDATE core.governance_proposals SET eligible_weight = 1 WHERE id = ${id}`,
    ).rejects.toThrow(/바꿀 수 없다/);
  });

  it("the audit record for opening a vote keeps the denominator source", async () => {
    const { id } = await openVoting({ eligibleWeight: "1000" });

    const [event] = await fx.sql<{ detail: Record<string, unknown> }[]>`
      SELECT detail FROM audit.events
      WHERE resource_id = ${id} AND command = 'governance.proposal.transitioned'
      ORDER BY occurred_at DESC LIMIT 1
    `;

    // Must be able to answer "where did the denominator come from at the time" later.
    expect(event!.detail).toMatchObject({
      toState: "voting",
      eligibleWeight: "1000",
      eligibleWeightSource: "manual",
    });
  });

  it("can close as no quorum", async () => {
    // While the denominator was the sum of cast votes, `no_quorum` was structurally
    // unreachable. No quorum and defeat need different next steps (09 §9.6).
    const { id, version } = await openVoting({
      eligibleWeight: "1000",
      quorumNumerator: 1,
      quorumDenominator: 4,
    });
    await vote(voterToken, id, "for", "100");

    const response = await transition(id, version, "no_quorum", "turnout too low");
    expect(response.statusCode).toBe(200);
    expect(response.json().state).toBe("no_quorum");
  });

  it("cannot create a proposal with a zero quorum denominator", async () => {
    // Not a division by zero: `turnout × D >= 0 × N` is always true, which reverts to
    // quorum always passing despite having a denominator.
    const response = await propose(proposerToken, { eligibleWeight: "0" });
    expect(response.statusCode).toBe(400);
  });
});

/**
 * On-chain snapshot — 09 §9.1, 04 §4.5.
 *
 * Pins **which space reads which token** once a token is linked. Protocol-space voters are
 * MPC holders; project-space voters are holders of that project's AT (09 §9.1). Using one
 * token address for both gives MPC holders weight over another project's disposition —
 * what 02 §2.4 rules 7 and 8 forbid.
 */
describeDb("Governance — on-chain snapshot", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let proposerToken: string;

  /** Reproduces a total-supply lookup failure. Failure means "unknown", not 0. */
  let totalSupplyFails = false;

  const TOTAL_SUPPLY = 10_000_000_000n * 10n ** 18n;

  /** Reading a wrong address returns 0. 0 cannot be a denominator. */
  let totalSupplyValue = TOTAL_SUPPLY;

  const chain = {
    tokenAddress: `0x${"ab".repeat(20)}`,
    chainId: 97,
    confirmationDepth: 12,
    headBlockNumber: async () => 1000,
    readBalance: async () => 5n,
    readTotalSupply: async () => {
      if (totalSupplyFails) throw new Error("archive node required");
      return totalSupplyValue;
    },
  };

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql, { governanceChain: chain });
    proposerToken = await signIn(app, fx.proposerA);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  async function openVoting(body: Record<string, unknown>) {
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/v1/governance/proposals",
        headers: { authorization: `Bearer ${proposerToken}`, "idempotency-key": idempotencyKey() },
        payload: {
          space: "protocol",
          proposalType: "attestation_schema_approval",
          title: "schema change",
          rationale: "the current schema cannot express limitations",
          ...body,
        },
      })
    ).json();

    let version = created.version;
    let last;
    for (const state of ["review", "announced", "voting"]) {
      last = await app.inject({
        method: "POST",
        url: `/api/v1/governance/proposals/${created.id}/transitions`,
        headers: {
          authorization: `Bearer ${proposerToken}`,
          "idempotency-key": idempotencyKey(),
          "if-match": `"${version}"`,
        },
        payload: { toState: state, reason: "next step" },
      });
      if (last.statusCode !== 200) break;
      version = last.json().version;
    }
    return last!;
  }

  it("a protocol proposal pins the snapshot block and total supply", () => {
    return openVoting({}).then((response) => {
      expect(response.statusCode).toBe(200);
      const body = response.json();

      // Uses a finalized block, not head (1000 - 12).
      expect(body.snapshotBlock).toBe("988");
      expect(body.weightSource).toBe("onchain_snapshot");
      expect(body.eligibleWeight).toBe(TOTAL_SUPPLY.toString());
      expect(body.eligibleWeightSource).toBe("onchain_total_supply");
    });
  });

  it("a project proposal does not read weight from the MPC token", async () => {
    const response = await openVoting({
      space: "project",
      projectId: fx.projectA,
      proposalType: "independent_valuation_request",
      eligibleWeight: "100",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    // Project-space voters are holders of that project's AT. No AT contract exists yet, so
    // the on-chain snapshot path must stay closed.
    expect(body.snapshotBlock).toBeNull();
    expect(body.weightSource).toBe("manual");
    expect(body.eligibleWeightSource).toBe("manual");
  });

  it("cannot open voting when total supply cannot be read", async () => {
    totalSupplyFails = true;
    try {
      const response = await openVoting({});

      // Reading a lookup failure as 0 makes quorum always pass.
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("ELIGIBLE_WEIGHT_UNAVAILABLE");
    } finally {
      totalSupplyFails = false;
    }
  });

  it("cannot open voting when total supply reads as 0", async () => {
    totalSupplyValue = 0n;
    try {
      const response = await openVoting({});

      // The lookup succeeded but cannot serve as a denominator: 0 makes quorum always pass.
      // A wrong address also reads as 0, so it must not pass silently.
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("ELIGIBLE_WEIGHT_ZERO");
    } finally {
      totalSupplyValue = TOTAL_SUPPLY;
    }
  });
});
