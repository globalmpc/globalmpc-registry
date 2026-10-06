import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, testEnv, type TestFixture, signIn } from "./helpers/db.js";
import rulesFixture from "../../../packages/policy/test/fixtures/registry-gate.rules.json" with { type: "json" };

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Readiness reads the jurisdiction profile from data — OD-43.
 *
 * The assessment context used to carry a fixed profile state (`approved`) and a fixed
 * environmental requirement basis for one country. A suspended profile still assessed as
 * approved, and every jurisdiction inherited one country's environmental law.
 *
 * Each test uses its own synthetic profile key, because profile versions are append-only and a
 * shared key would carry one test's history into the next.
 */
describeDb("readiness reads the jurisdiction profile (OD-43)", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let operatorToken: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    operatorToken = await signIn(app, fx.operatorA);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  /** A synthetic profile key with an effective policy set assessed under it. */
  async function newJurisdiction(tenantId = fx.tenantA) {
    const key = `ZZ-${randomUUID().slice(0, 8)}`;
    const policySetId = randomUUID();
    await fx.sql`
      INSERT INTO core.compliance_policy_sets (
        id, tenant_id, rule_set_id, rule_set_version, gate_id,
        jurisdiction_profile, effective_from, definition, state
      ) VALUES (
        ${policySetId}, ${tenantId}, ${`rules-${key}`}, '1.0.0',
        'registry_publication', ${key}, now(),
        ${fx.sql.json(rulesFixture as never)}, 'effective'
      )
    `;
    return { key, policySetId };
  }

  async function addVersion(
    key: string,
    version: number,
    state: string,
    basis: string | null,
    options: { tenantId?: string; effectiveFrom?: string } = {},
  ) {
    await fx.sql`
      INSERT INTO core.jurisdiction_profiles (
        id, tenant_id, jurisdiction, profile_version, state,
        environmental_requirement_basis, effective_from
      ) VALUES (
        ${randomUUID()}, ${options.tenantId ?? fx.tenantA}, ${key}, ${version}, ${state},
        ${basis}, ${options.effectiveFrom ?? "2026-01-01T00:00:00Z"}
      )
    `;
  }

  async function assess(policySetId: string) {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${fx.projectA}/readiness-assessments`,
      headers: { authorization: `Bearer ${operatorToken}`, "idempotency-key": idempotencyKey() },
      payload: { policySetId },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as {
      inputSnapshotHash: string;
      requirementResults: { requirementId: string; status: string; reasonCode: string }[];
    };
    const result = (id: string) => body.requirementResults.find((r) => r.requirementId === id)!;
    return { body, result };
  }

  describe("assessment", () => {
    it("without a profile there is no environmental basis — not_evaluable, not borrowed", async () => {
      const { policySetId } = await newJurisdiction();
      const { result } = await assess(policySetId);
      expect(result("environmental-baseline").status).toBe("not_evaluable");
      expect(result("environmental-baseline").reasonCode).toBe("NO_EVALUATION_BASIS");
    });

    it("uses the profile's environmental basis when one is recorded", async () => {
      const { key, policySetId } = await newJurisdiction();
      await addVersion(key, 1, "approved", "Synthetic Environmental Code");
      const { result } = await assess(policySetId);
      // The fixture project has no environmental claim: the basis exists and evidence is missing.
      expect(result("environmental-baseline").status).toBe("gap");
      expect(result("environmental-baseline").reasonCode).toBe("MISSING_REQUIRED_CLAIM_TYPE");
      expect(result("mining-right").reasonCode).toBe("MISSING_REQUIRED_CLAIM_TYPE");
    });

    it("the latest version wins — a suspension makes the rights requirement not_evaluable", async () => {
      const { key, policySetId } = await newJurisdiction();
      await addVersion(key, 1, "approved", "Synthetic Environmental Code");
      await addVersion(key, 2, "suspended", "Synthetic Environmental Code");
      const { result } = await assess(policySetId);
      expect(result("mining-right").status).toBe("not_evaluable");
      expect(result("mining-right").reasonCode).toBe("NO_EVALUATION_BASIS");
    });

    it("a version that is not effective yet is not read", async () => {
      const { key, policySetId } = await newJurisdiction();
      await addVersion(key, 1, "approved", "Synthetic Environmental Code");
      await addVersion(key, 2, "suspended", "Synthetic Environmental Code", {
        effectiveFrom: "2999-01-01T00:00:00Z",
      });
      const { result } = await assess(policySetId);
      expect(result("mining-right").reasonCode).toBe("MISSING_REQUIRED_CLAIM_TYPE");
    });

    it("AC-11: a profile change changes the input snapshot hash", async () => {
      const { key, policySetId } = await newJurisdiction();
      await addVersion(key, 1, "approved", "Synthetic Environmental Code");
      const approved = await assess(policySetId);
      await addVersion(key, 2, "suspended", "Synthetic Environmental Code");
      const suspended = await assess(policySetId);
      expect(suspended.body.inputSnapshotHash).not.toBe(approved.body.inputSnapshotHash);
    });

    it("another tenant's profile is not visible", async () => {
      const { key, policySetId } = await newJurisdiction();
      await addVersion(key, 1, "approved", "Other Tenant Basis", { tenantId: fx.tenantB });
      const { result } = await assess(policySetId);
      expect(result("environmental-baseline").reasonCode).toBe("NO_EVALUATION_BASIS");
    });
  });

  describe("the DB keeps versions honest", () => {
    it("the first version must be version 1 and approved", async () => {
      const { key } = await newJurisdiction();
      await expect(addVersion(key, 1, "suspended", null)).rejects.toThrow(/first version/);
      await expect(addVersion(key, 2, "approved", null)).rejects.toThrow(/first version/);
    });

    it("versions are consecutive", async () => {
      const { key } = await newJurisdiction();
      await addVersion(key, 1, "approved", null);
      await expect(addVersion(key, 3, "stale", null)).rejects.toThrow(/consecutive/);
    });

    it("follows the 04 §4.9 state machine — suspended cannot become stale", async () => {
      const { key } = await newJurisdiction();
      await addVersion(key, 1, "approved", null);
      await addVersion(key, 2, "suspended", null);
      await expect(addVersion(key, 3, "stale", null)).rejects.toThrow(/suspended → stale/);
      await addVersion(key, 3, "approved", null);
    });

    it("a version cannot take effect before the previous one", async () => {
      // Otherwise version order and effective order disagree, and readiness would read a
      // correction as in force over a period its predecessor covered.
      const { key } = await newJurisdiction();
      await addVersion(key, 1, "approved", null, { effectiveFrom: "2026-06-01T00:00:00Z" });
      await expect(
        addVersion(key, 2, "suspended", null, { effectiveFrom: "2026-01-01T00:00:00Z" }),
      ).rejects.toThrow(/take effect before the previous/);
    });

    it("rejects a state outside the stored states", async () => {
      const { key } = await newJurisdiction();
      await expect(addVersion(key, 1, "drafting", null)).rejects.toThrow();
    });

    it("a version cannot be changed or deleted, even by a superuser", async () => {
      const { key } = await newJurisdiction();
      await addVersion(key, 1, "approved", "Synthetic Environmental Code");
      await expect(
        fx.sql`UPDATE core.jurisdiction_profiles SET state = 'suspended' WHERE jurisdiction = ${key}`,
      ).rejects.toThrow(/cannot be modified or deleted/);
      await expect(
        fx.sql`DELETE FROM core.jurisdiction_profiles WHERE jurisdiction = ${key}`,
      ).rejects.toThrow(/cannot be modified or deleted/);
    });
  });
});
