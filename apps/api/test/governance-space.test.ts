import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";
import { addGovernanceAccount } from "./helpers/governance-accounts.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Governance spaces, execution records and disclosures — 02 §2.2·§2.3, 09 §9.4·§9.7·§9.11,
 * 12 §12.6, REQ-DAPP-020 to 023.
 *
 * The role that acts must belong to the proposal's space; a vote result is not an execution;
 * a proposal says who may gain from it; and who still holds which power is public.
 */
describeDb("Governance spaces and execution", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  const tokens: Record<string, string> = {};

  const EVIDENCE_HASH = `0x${"ab".repeat(32)}`;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    tokens["protocolProposer"] = await signIn(app, fx.proposerA);
    tokens["protocolVoter"] = await signIn(app, fx.voterA);
    tokens["operator"] = await signIn(app, fx.operatorA);
    tokens["projectProposer"] = await signIn(app, await addGovernanceAccount(fx, "project_proposer"));
    // An AT voter of projectA only — the binding names the project whose snapshot it votes on.
    tokens["atVoter"] = await signIn(
      app,
      await addGovernanceAccount(fx, "project_voter", {
        projectId: fx.projectA,
        assurance: "wallet_only",
      }),
    );
    // Organization-level project voter: names no project, so no AT snapshot.
    tokens["unboundProjectVoter"] = await signIn(
      app,
      await addGovernanceAccount(fx, "project_voter", { assurance: "wallet_only" }),
    );
    tokens["recorder"] = await signIn(app, await addGovernanceAccount(fx, "execution_recorder"));
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function propose(token: string, body: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: "/api/v1/governance/proposals",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey() },
      payload: {
        space: "project",
        projectId: fx.projectA,
        proposalType: "project_disposition",
        title: "Sell the project",
        rationale: "An offer was received for the project",
        eligibleWeight: "100",
        conflictDisclosure: "The operator receives a fee on sale; the proposer holds no AT",
        executionMode: "offchain_required",
        ...body,
      },
    });
  }

  function transition(token: string, id: string, version: number, toState: string) {
    return app.inject({
      method: "POST",
      url: `/api/v1/governance/proposals/${id}/transitions`,
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": idempotencyKey(),
        "if-match": `"${version}"`,
      },
      payload: { toState, reason: "next step" },
    });
  }

  function vote(token: string, id: string, choice = "for", weight = "100") {
    return app.inject({
      method: "POST",
      url: `/api/v1/governance/proposals/${id}/votes`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey() },
      payload: { choice, weight },
    });
  }

  function recordExecution(
    token: string,
    id: string,
    version: number,
    body: Record<string, unknown> = {},
  ) {
    return app.inject({
      method: "POST",
      url: `/api/v1/governance/proposals/${id}/execution-records`,
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": idempotencyKey(),
        "if-match": `"${version}"`,
      },
      payload: {
        outcome: "executed",
        executor: "SPV board",
        authority: "Shareholder agreement, drag-along clause",
        executedAction: "Transfer of the SPV shares to the buyer",
        evidenceReference: "dataroom://contracts/share-transfer-signed.pdf",
        evidenceHash: EVIDENCE_HASH,
        limitations: ["This record does not establish the legal validity of the transfer"],
        ...body,
      },
    });
  }

  /** Walks a proposal from draft to the given state with the given administrator. */
  async function advance(token: string, id: string, version: number, states: readonly string[]) {
    let current = version;
    for (const state of states) {
      const response = await transition(token, id, current, state);
      expect(response.statusCode, `${state}: ${response.body}`).toBe(200);
      current = response.json().version;
    }
    return current;
  }

  async function openProjectVoting(body: Record<string, unknown> = {}) {
    const created = await propose(tokens["projectProposer"]!, body);
    expect(created.statusCode, created.body).toBe(200);
    const version = await advance(tokens["projectProposer"]!, created.json().id, created.json().version, [
      "review",
      "announced",
      "voting",
    ]);
    return { id: created.json().id as string, version };
  }

  /** Voted, closed as succeeded and carried to execution_pending. */
  async function pendingExecution() {
    const { id, version } = await openProjectVoting();
    expect((await vote(tokens["atVoter"]!, id)).statusCode).toBe(200);
    const pending = await advance(tokens["projectProposer"]!, id, version, [
      "succeeded",
      "timelocked",
      "recorded",
      "execution_pending",
    ]);
    return { id, version: pending };
  }

  describe("roles stay inside their space — REQ-DAPP-021", () => {
    it("a protocol proposer cannot create a project-space proposal", async () => {
      const response = await propose(tokens["protocolProposer"]!);
      expect(response.statusCode).toBe(403);
      expect(response.json().details.requiredRoles).toEqual(["project_proposer"]);
    });

    it("a project proposer cannot create a protocol proposal", async () => {
      const response = await propose(tokens["projectProposer"]!, {
        space: "protocol",
        projectId: null,
        proposalType: "fee_schedule",
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().details.requiredRoles).toEqual(["protocol_proposer"]);
    });

    it("a protocol voter voting on a project proposal is refused", async () => {
      const { id } = await openProjectVoting();

      const response = await vote(tokens["protocolVoter"]!, id);
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe("GOVERNANCE_SPACE_MISMATCH");
    });

    it("a project voter votes only on the project its binding names", async () => {
      const own = await openProjectVoting();
      expect((await vote(tokens["atVoter"]!, own.id)).statusCode).toBe(200);

      const other = await openProjectVoting({ projectId: fx.otherProjectA });
      const response = await vote(tokens["atVoter"]!, other.id);
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe("GOVERNANCE_PROJECT_SCOPE_MISMATCH");
    });

    it("a project voter binding without a project cannot vote", async () => {
      // It names no AT snapshot; treating it as "every project" would let it vote on all.
      const { id } = await openProjectVoting();
      const response = await vote(tokens["unboundProjectVoter"]!, id);
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe("GOVERNANCE_PROJECT_SCOPE_MISMATCH");
    });

    it("a project voter cannot vote on a protocol proposal", async () => {
      const created = (
        await propose(tokens["protocolProposer"]!, {
          space: "protocol",
          projectId: null,
          proposalType: "fee_schedule",
        })
      ).json();
      await advance(tokens["protocolProposer"]!, created.id, created.version, [
        "review",
        "announced",
        "voting",
      ]);

      const response = await vote(tokens["atVoter"]!, created.id);
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe("GOVERNANCE_SPACE_MISMATCH");
    });

    it("the MPC operator neither proposes nor votes", async () => {
      // 02 §2.3: "administer", not C/V. 02 §2.2: no project asset decisions.
      expect((await propose(tokens["operator"]!)).statusCode).toBe(403);
      expect(
        (
          await propose(tokens["operator"]!, {
            space: "protocol",
            projectId: null,
            proposalType: "fee_schedule",
          })
        ).statusCode,
      ).toBe(403);

      const { id } = await openProjectVoting();
      expect((await vote(tokens["operator"]!, id)).statusCode).toBe(403);
    });

    it("the MPC operator still administers a proposal", async () => {
      const created = (await propose(tokens["projectProposer"]!)).json();
      const response = await transition(tokens["operator"]!, created.id, created.version, "review");
      expect(response.statusCode).toBe(200);
    });

    it("a protocol proposer cannot move a project proposal", async () => {
      const created = (await propose(tokens["projectProposer"]!)).json();
      const response = await transition(
        tokens["protocolProposer"]!,
        created.id,
        created.version,
        "review",
      );
      expect(response.statusCode).toBe(403);
    });
  });

  /**
   * 12 §12.6 R4 demo: "a protocol voter's project sale attempt fails, and the AT voter's branch
   * result is recorded as execution_pending."
   */
  it("R4 demo — a protocol voter's project sale attempt fails; the AT vote stays execution_pending", async () => {
    // The protocol voter cannot put a sale on the table…
    const attempt = await propose(tokens["protocolVoter"]!);
    expect(attempt.statusCode).toBe(403);

    // …nor vote on the sale the project put there.
    const { id, version } = await openProjectVoting();
    expect((await vote(tokens["protocolVoter"]!, id)).statusCode).toBe(403);

    // The AT voter's vote decides it.
    const voted = await vote(tokens["atVoter"]!, id);
    expect(voted.json().tally.provisionalOutcome).toBe("succeeded");

    const pending = await advance(tokens["projectProposer"]!, id, version, [
      "succeeded",
      "timelocked",
      "recorded",
      "execution_pending",
    ]);

    // A passed vote is recorded, not executed. Nothing moves it on without an execution record.
    const stuck = await transition(tokens["projectProposer"]!, id, pending, "executed");
    expect(stuck.statusCode).toBe(409);
    expect(stuck.json().code).toBe("EXECUTION_RECORD_REQUIRED");

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/governance/proposals/${id}`,
      headers: { authorization: `Bearer ${tokens["projectProposer"]}` },
    });
    expect(detail.json().state).toBe("execution_pending");
    expect(detail.json().execution).toEqual({ state: "execution_pending", records: [] });
  });

  describe("execution records — REQ-DAPP-020", () => {
    it("only the execution recorder records execution", async () => {
      const { id, version } = await pendingExecution();
      for (const token of [tokens["operator"]!, tokens["projectProposer"]!, tokens["atVoter"]!]) {
        expect((await recordExecution(token, id, version)).statusCode).toBe(403);
      }
    });

    it("recording execution moves the state and keeps the tally apart", async () => {
      const { id, version } = await pendingExecution();
      const before = await app.inject({
        method: "GET",
        url: `/api/v1/governance/proposals/${id}`,
        headers: { authorization: `Bearer ${tokens["recorder"]}` },
      });

      const response = await recordExecution(tokens["recorder"]!, id, version);
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json();

      expect(body.state).toBe("executed");
      expect(body.execution.state).toBe("executed");
      expect(body.execution.records).toHaveLength(1);
      expect(body.execution.records[0]).toMatchObject({
        fromState: "execution_pending",
        outcome: "executed",
        executor: "SPV board",
        executedAction: "Transfer of the SPV shares to the buyer",
        evidenceHash: EVIDENCE_HASH,
      });
      // The vote result is what it was. The recorder cannot change it (02 §2.4 rule 9).
      expect(body.tally).toEqual(before.json().tally);
    });

    it("a failed execution needs a record too", async () => {
      const { id, version } = await pendingExecution();
      const response = await recordExecution(tokens["recorder"]!, id, version, {
        outcome: "failed",
        executedAction: "Share transfer was not completed; buyer withdrew",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().state).toBe("failed");
    });

    it("cannot record execution before the proposal is pending execution", async () => {
      const { id, version } = await openProjectVoting();
      const response = await recordExecution(tokens["recorder"]!, id, version);
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("EXECUTION_NOT_PENDING");
    });

    it("rejects a record without evidence hash or limitations", async () => {
      const { id, version } = await pendingExecution();
      expect(
        (await recordExecution(tokens["recorder"]!, id, version, { evidenceHash: "abc" })).statusCode,
      ).toBe(400);
      expect(
        (await recordExecution(tokens["recorder"]!, id, version, { limitations: [] })).statusCode,
      ).toBe(400);
    });

    it("the database refuses executed without a record", async () => {
      const { id } = await pendingExecution();
      await expect(
        fx.sql`UPDATE core.governance_proposals SET state = 'executed' WHERE id = ${id}`,
      ).rejects.toThrow(/requires an execution record/);
    });

    it("execution records cannot be edited", async () => {
      const { id, version } = await pendingExecution();
      await recordExecution(tokens["recorder"]!, id, version);
      await expect(
        fx.appSql`UPDATE core.governance_execution_records SET executor = 'someone else'
                  WHERE proposal_id = ${id}`,
      ).rejects.toThrow();
    });
  });

  describe("conflict-of-interest disclosure — REQ-DAPP-022", () => {
    it("a proposal without a disclosure is refused", async () => {
      const response = await propose(tokens["projectProposer"]!, { conflictDisclosure: " " });
      expect(response.statusCode).toBe(400);
    });

    it("stores and returns the disclosure and execution mode", async () => {
      const response = await propose(tokens["projectProposer"]!);
      expect(response.json().conflictDisclosure).toBe(
        "The operator receives a fee on sale; the proposer holds no AT",
      );
      expect(response.json().executionMode).toBe("offchain_required");
    });

    it("the disclosure cannot change after creation", async () => {
      const created = (await propose(tokens["projectProposer"]!)).json();
      await expect(
        fx.sql`UPDATE core.governance_proposals SET conflict_disclosure = 'none'
               WHERE id = ${created.id}`,
      ).rejects.toThrow(/cannot be changed/);
    });

    it("a public protocol proposal shows its disclosure", async () => {
      const created = (
        await propose(tokens["protocolProposer"]!, {
          space: "protocol",
          projectId: null,
          proposalType: "fee_schedule",
          conflictDisclosure: "The proposer is paid from protocol fees",
          executionMode: "record_only",
        })
      ).json();
      await advance(tokens["protocolProposer"]!, created.id, created.version, ["review"]);

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/public/governance/proposals/${created.id}`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().conflictDisclosure).toBe("The proposer is paid from protocol fees");
      expect(response.json().executionMode).toBe("record_only");
    });
  });

  describe("centralization disclosure — REQ-DAPP-023", () => {
    function centralization() {
      return app.inject({ method: "GET", url: "/api/v1/public/governance/centralization" });
    }

    it("is readable without signing in and states the current stage", async () => {
      const response = await centralization();
      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body.currentStage).toBe("founder_operated");
      expect(body.stages.map((stage: { stage: string }) => stage.stage)).toEqual([
        "founder_operated",
        "parameter_delegated",
        "policy_delegated",
        "treasury_delegated",
      ]);
      expect(body.stages.filter((stage: { current: boolean }) => stage.current)).toHaveLength(1);
      // Nothing is delegated yet, so every later stage's power is still centralized.
      expect(body.centralizedPowers).toEqual([
        "bounded_parameters",
        "listing_and_reviewer_criteria",
        "treasury",
      ]);
      // The spec gives candidates, not values.
      expect(body.transitionCriteria.decided).toBe(false);
    });

    it("counts current role holders from role bindings", async () => {
      const body = (await centralization()).json();
      const holders = Object.fromEntries(
        body.governanceRoles.map((entry: { role: string; activeHolders: number }) => [
          entry.role,
          entry.activeHolders,
        ]),
      );

      // This file added one recorder and one project proposer; other files add more.
      expect(holders["mpc_operator"]).toBeGreaterThanOrEqual(1);
      expect(holders["execution_recorder"]).toBeGreaterThanOrEqual(1);
      expect(holders["project_proposer"]).toBeGreaterThanOrEqual(1);
    });

    it("names no person", async () => {
      const response = await centralization();
      // Counts, not people: no wallet of a role holder and no tenant appears.
      expect(response.body).not.toContain(fx.operatorA.address);
      expect(response.body).not.toContain(fx.voterA.address);
      expect(response.body).not.toContain(fx.tenantA);
    });
  });
});
