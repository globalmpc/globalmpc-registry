import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { verifyMerkleProof, type Hex } from "@mpc/canonical";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, testEnv, type TestFixture, signIn } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

describeDb("Registry publication and public lookup", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let tokens: { operatorA: string; stewardA: string };

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);

    // From R1, auth is SIWE signature → session token. Tests follow the same path.
    tokens = {
      operatorA: await signIn(app, fx.operatorA),
      stewardA: await signIn(app, fx.stewardA),
    };
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function validProjection(overrides: Record<string, unknown> = {}) {
    return {
      stableId: randomUUID(),
      status: "registered",
      version: "1",
      asOf: "2026-08-01T00:00:00.000Z",
      sourceAge: "12",
      staleStatus: "fresh",
      limitations: ["Legal rights verification is outside this review scope"],
      legalEffect: "none",
      disclaimerCodes: ["VERIFICATION_IS_NOT_GUARANTEE"],
      ...overrides,
    };
  }

  function publish(wallet: string, overrides: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: "/api/v1/registry-entries",
      headers: { authorization: `Bearer ${wallet}`, "idempotency-key": idempotencyKey() },
      payload: {
        registryType: "project",
        subjectId: fx.projectA,
        publicKey: `KEY-${randomUUID().slice(0, 8)}`,
        projection: validProjection(),
        sourceSnapshotHash: `0x${"11".repeat(32)}`,
        policyVersion: "mn-core-1.0.0",
        schemaVersion: "project-registry-1",
        ...overrides,
      },
    });
  }

  /**
   * 04 §4.3 — the guard for `draft→registered` is "Project Registry minimum fields
   * and accountable party".
   *
   * The act that satisfies it is Project Registry publication. It is done by someone who
   * already holds `registry.publish`, so no new permission arises.
   * The remaining transitions (suspend, offering, closure) have no decided owner yet.
   */
  describe("project lifecycle (04 §4.3)", () => {
    async function newProject() {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: { authorization: `Bearer ${tokens.operatorA}`, "idempotency-key": idempotencyKey() },
        payload: {
          projectKey: `LC-${randomUUID().slice(0, 8)}`,
          name: "lifecycle test",
          hostCountryIso3: "MNG",
          minerals: ["copper"],
          ownerOrganizationId: fx.orgA,
        },
      });
      expect(response.statusCode).toBe(200);
      const created = response.json();
      expect(created.lifecycleState).toBe("draft");
      return created.id as string;
    }

    async function lifecycleOf(projectId: string) {
      const [row] = await fx.sql<{ lifecycle_state: string }[]>`
        SELECT lifecycle_state FROM core.projects WHERE id = ${projectId}
      `;
      return row!.lifecycle_state;
    }

    it("project registry publication moves draft to registered", async () => {
      const projectId = await newProject();

      const response = await publish(tokens.operatorA, { subjectId: projectId });
      expect(response.statusCode).toBe(200);

      expect(await lifecycleOf(projectId)).toBe("registered");
    });

    it("republishing the same project stays registered", async () => {
      // The transition happens once. Repeating it would be `registered→registered`, which is
      // not in the 04 §4.3 transition table.
      const projectId = await newProject();
      await publish(tokens.operatorA, { subjectId: projectId });
      const again = await publish(tokens.operatorA, { subjectId: projectId });

      expect(again.statusCode).toBe(200);
      expect(await lifecycleOf(projectId)).toBe("registered");
    });

    it("verification registry publication does not touch the project lifecycle", async () => {
      // The Verification Registry records review outcomes. It does not mean the project is
      // registered.
      const projectId = await newProject();

      const response = await publish(tokens.operatorA, {
        registryType: "verification",
        subjectId: projectId,
      });
      expect(response.statusCode).toBe(200);

      expect(await lifecycleOf(projectId)).toBe("draft");
    });
  });

  it("publishes when only allowlisted fields are present", async () => {
    const response = await publish(tokens.operatorA);
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.status).toBe("published");
    expect(body.version).toBe(1);
    expect(body.contentHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("AC-22: rejects fields outside the allowlist", async () => {
    const response = await publish(tokens.operatorA, {
      projection: validProjection({ rawSourceResponse: "{...}" }),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().details.offendingFields).toContain("rawSourceResponse");
  });

  it("AC-22: rejects raw-text and PII-like fields", async () => {
    for (const field of [
      "personalIdentifier",
      "contractBody",
      "preciseGeologicalCoordinates",
      "kycData",
      "whistleblowerIdentity",
    ]) {
      const response = await publish(tokens.operatorA, {
        projection: validProjection({ [field]: "leak" }),
      });
      expect(response.statusCode, field).toBe(422);
    }
  });

  it("AC-32: cannot publish natural-person identifiers without a safeguard", async () => {
    const response = await publish(tokens.operatorA, {
      containsPersonLevelIdentifier: true,
      personIdentifierSafeguards: {
        lawfulBasisRecorded: true,
        explicitPublicationApproval: true,
        purposeRecorded: true,
        retentionRecorded: true,
        irreversibilityAcknowledged: false,
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("PUBLICATION_PERSON_IDENTIFIER_GUARD");
  });

  it("AC-13: unconfirmed commercial_reuse cannot back a commercial publication", async () => {
    const response = await publish(tokens.operatorA, {
      commercialReuse: "unconfirmed",
      publishedAsCommercialBasis: true,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("PUBLICATION_SOURCE_LICENSE_UNCONFIRMED");
  });

  it("rejects a projection without limitations", async () => {
    const projection = validProjection();
    delete (projection as Record<string, unknown>)["limitations"];
    const response = await publish(tokens.operatorA, { projection });
    expect(response.statusCode).toBe(422);
  });

  it("cannot overwrite a published projection", async () => {
    const published = (await publish(tokens.operatorA)).json();
    await expect(
      fx.sql`
        UPDATE core.registry_entry_versions
        SET public_projection = '{"stableId":"changed"}'::jsonb
        WHERE id = ${published.id}
      `,
    ).rejects.toThrow(/cannot be overwritten/);
  });

  it("a new version links the previous one as superseded — does not delete it", async () => {
    const publicKey = `KEY-${randomUUID().slice(0, 8)}`;
    const first = (await publish(tokens.operatorA, { publicKey })).json();
    const second = (await publish(tokens.operatorA, { publicKey })).json();

    expect(second.version).toBe(2);

    const [previous] = await fx.sql<{ status: string; superseded_by_id: string }[]>`
      SELECT status, superseded_by_id FROM core.registry_entry_versions WHERE id = ${first.id}
    `;
    expect(previous!.status).toBe("superseded");
    expect(previous!.superseded_by_id).toBe(second.id);
  });

  it("revoke is a new state, not a deletion", async () => {
    const publicKey = `KEY-${randomUUID().slice(0, 8)}`;
    const published = (await publish(tokens.operatorA, { publicKey })).json();

    const revoked = await app.inject({
      method: "POST",
      url: `/api/v1/registry-entries/${published.entryId}/revoke`,
      headers: {
        authorization: `Bearer ${tokens.operatorA}`,
        "idempotency-key": idempotencyKey(),
        "if-match": `"${published.version}"`,
      },
      payload: { reasonCode: "SOURCE_CORRECTION" },
    });
    expect(revoked.statusCode).toBe(200);

    const [row] = await fx.sql<{ status: string; public_projection: unknown }[]>`
      SELECT status, public_projection FROM core.registry_entry_versions WHERE id = ${published.id}
    `;
    expect(row!.status).toBe("revoked");
    expect(row!.public_projection).not.toBeNull();
  });

  describe("resubmitting a stuck batch", () => {
    async function makeBatch() {
      const publicKey = `RESUB-${randomUUID().slice(0, 8)}`;
      await publish(tokens.operatorA, { publicKey });
      const batch = await app.inject({
        method: "POST",
        url: "/api/v1/anchor-batches",
        headers: {
          authorization: `Bearer ${tokens.operatorA}`,
          "idempotency-key": idempotencyKey(),
        },
        payload: {},
      });
      return batch.json().id as string;
    }

    function resubmit(batchId: string) {
      return app.inject({
        method: "POST",
        url: `/api/v1/anchor-batches/${batchId}/resubmit`,
        headers: {
          authorization: `Bearer ${tokens.operatorA}`,
          "idempotency-key": idempotencyKey(),
        },
        payload: {},
      });
    }

    it("does not resubmit an in-progress batch", async () => {
      const batchId = await makeBatch();

      // Resetting created/submitted/included would forget a transaction already on chain
      // and submit the same root again.
      const response = await resubmit(batchId);
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("ANCHOR_NOT_RESUBMITTABLE");
      expect(response.json().details.currentState).toBe("created");
    });

    it("resets the attempt count of a stuck batch and resubmits", async () => {
      const batchId = await makeBatch();
      await fx.sql`
        UPDATE chain.transactions
        SET state = 'dropped', attempts = 3, tx_hash = ${`0x${"ab".repeat(32)}`}
        WHERE batch_id = ${batchId}
      `;

      const response = await resubmit(batchId);
      expect(response.statusCode).toBe(200);
      expect(response.json().previousState).toBe("dropped");

      const [row] = await fx.sql<{ state: string; attempts: number; tx_hash: string | null }[]>`
        SELECT state, attempts, tx_hash FROM chain.transactions WHERE batch_id = ${batchId}
      `;
      // A person checked the cause and decided, so it does not inherit the previous attempt cap.
      expect(row!.state).toBe("created");
      expect(row!.attempts).toBe(0);
      expect(row!.tx_hash).toBeNull();
    });

    it("resubmission also requires anchor.submit", async () => {
      const batchId = await makeBatch();
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/anchor-batches/${batchId}/resubmit`,
        headers: {
          authorization: `Bearer ${tokens.stewardA}`,
          "idempotency-key": idempotencyKey(),
        },
        payload: {},
      });
      expect(response.statusCode).toBe(403);
    });
  });

  describe("revocation concurrency (If-Match)", () => {
    function revoke(entryId: string, version: unknown) {
      return app.inject({
        method: "POST",
        url: `/api/v1/registry-entries/${entryId}/revoke`,
        headers: {
          authorization: `Bearer ${tokens.operatorA}`,
          "idempotency-key": idempotencyKey(),
          ...(version === undefined ? {} : { "if-match": String(version) }),
        },
        payload: { reasonCode: "SOURCE_CORRECTION" },
      });
    }

    it("rejects when the version to revoke is not stated", async () => {
      const publicKey = `KEY-${randomUUID().slice(0, 8)}`;
      const published = (await publish(tokens.operatorA, { publicKey })).json();

      const response = await revoke(published.entryId, undefined);
      expect(response.statusCode).toBe(428);
    });

    it("rejects a stale revoke request when a new version was published after lookup", async () => {
      const publicKey = `KEY-${randomUUID().slice(0, 8)}`;
      const first = (await publish(tokens.operatorA, { publicKey })).json();

      // Someone published a correction. A request meant to revoke v1 would now revoke v2.
      await publish(tokens.operatorA, { publicKey });

      const response = await revoke(first.entryId, `"${first.version}"`);
      expect(response.statusCode).toBe(412);
      expect(response.json().details.currentVersion).toBe("2");
    });

    it("public lookup response exposes the current version as ETag", async () => {
      const publicKey = `KEY-${randomUUID().slice(0, 8)}`;
      await publish(tokens.operatorA, { publicKey });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/public/registries/project/${publicKey}`,
      });

      // Must equal the body version. Otherwise the client cannot tell which one goes into
      // If-Match.
      expect(response.headers["etag"]).toBe(`"${response.json().version}"`);
    });
  });

  it("an account without permission cannot publish", async () => {
    const response = await publish(tokens.stewardA);
    expect(response.statusCode).toBe(403);
    expect(response.json().details.requiredRoles).toContain("mpc_operator");
  });

  describe("public lookup (unauthenticated)", () => {
    it("reads a published projection without auth", async () => {
      const publicKey = `PUB-${randomUUID().slice(0, 8)}`;
      await publish(tokens.operatorA, { publicKey });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/public/registries/project/${publicKey}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe("published");
    });

    it("returns 404 for an unknown key", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/public/registries/project/DOES-NOT-EXIST",
      });
      expect(response.statusCode).toBe(404);
    });

    it("response includes limitations and legalEffect", async () => {
      const publicKey = `PUB-${randomUUID().slice(0, 8)}`;
      await publish(tokens.operatorA, { publicKey });

      const body = (
        await app.inject({
          method: "GET",
          url: `/api/v1/public/registries/project/${publicKey}`,
        })
      ).json();

      expect(body.limitations).toBeInstanceOf(Array);
      expect(body.legalEffect).toBe("none");
    });

    it("does not hide correction and revocation history", async () => {
      const publicKey = `PUB-${randomUUID().slice(0, 8)}`;
      await publish(tokens.operatorA, { publicKey });
      await publish(tokens.operatorA, { publicKey });

      const body = (
        await app.inject({
          method: "GET",
          url: `/api/v1/public/registries/project/${publicKey}`,
        })
      ).json();

      expect(body.version).toBe("2");
      expect(body.history.length).toBe(1);
      expect(body.history[0].status).toBe("superseded");
    });

    it("response has no information that identifies the tenant", async () => {
      const publicKey = `PUB-${randomUUID().slice(0, 8)}`;
      await publish(tokens.operatorA, { publicKey });

      const body = (
        await app.inject({
          method: "GET",
          url: `/api/v1/public/registries/project/${publicKey}`,
        })
      ).json();

      expect(JSON.stringify(body)).not.toContain(fx.tenantA);
      expect(JSON.stringify(body)).not.toContain(fx.orgA);
    });
  });

  describe("anchor and inclusion proof", () => {
    it("builds a batch from published versions", async () => {
      await publish(tokens.operatorA);

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/anchor-batches",
        headers: { authorization: `Bearer ${tokens.operatorA}`, "idempotency-key": idempotencyKey() },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.recordCount).toBeGreaterThan(0);
      expect(body.root).toMatch(/^0x[0-9a-f]{64}$/);
      // Not on chain yet.
      expect(body.confirmationState).toBe("created");
    });

    it("does not create an empty batch when nothing is pending", async () => {
      // Everything was anchored in the previous test.
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/anchor-batches",
        headers: { authorization: `Bearer ${tokens.operatorA}`, "idempotency-key": idempotencyKey() },
        payload: {},
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("ANCHOR_BATCH_EMPTY");
    });

    it("verifies the proof off-chain", async () => {
      const publicKey = `PRF-${randomUUID().slice(0, 8)}`;
      const published = (await publish(tokens.operatorA, { publicKey })).json();

      await app.inject({
        method: "POST",
        url: "/api/v1/anchor-batches",
        headers: { authorization: `Bearer ${tokens.operatorA}`, "idempotency-key": idempotencyKey() },
        payload: {},
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/public/proofs/${published.id}`,
      });

      expect(response.statusCode).toBe(200);
      const proof = response.json();
      expect(
        verifyMerkleProof(proof.leafHash as Hex, proof.proof as Hex[], proof.root as Hex),
      ).toBe(true);
      expect(proof.merkleVerified).toBe(true);
    });

    it("proof includes the spec needed to rebuild the leaf", async () => {
      // Without a spec version, a verifier does not know **which spec** to rebuild with.
      // The proof then becomes "trust me" rather than a reproducible check.
      const publicKey = `PRF-${randomUUID().slice(0, 8)}`;
      const published = (
        await publish(tokens.operatorA, {
          publicKey,
          policyVersion: "mn-core-9.9.9",
          schemaVersion: "project-registry-9",
        })
      ).json();

      await app.inject({
        method: "POST",
        url: "/api/v1/anchor-batches",
        headers: { authorization: `Bearer ${tokens.operatorA}`, "idempotency-key": idempotencyKey() },
        payload: {},
      });

      const proof = (
        await app.inject({ method: "GET", url: `/api/v1/public/proofs/${published.id}` })
      ).json();

      // Returns the value given at publication — not a hard-coded constant.
      expect(proof.policyVersion).toBe("mn-core-9.9.9");
      expect(proof.schemaVersion).toBe("project-registry-9");
      expect(proof.serializationVersion).toBe("1");

      // Carries no subject. Only the spec name.
      expect(proof.subjectId).toBeUndefined();
    });

    it("AC-23: included is false unless confirmed", async () => {
      const publicKey = `PRF-${randomUUID().slice(0, 8)}`;
      const published = (await publish(tokens.operatorA, { publicKey })).json();
      await app.inject({
        method: "POST",
        url: "/api/v1/anchor-batches",
        headers: { authorization: `Bearer ${tokens.operatorA}`, "idempotency-key": idempotencyKey() },
        payload: {},
      });

      const proof = (
        await app.inject({ method: "GET", url: `/api/v1/public/proofs/${published.id}` })
      ).json();

      expect(proof.confirmationState).toBe("created");
      // The Merkle proof holds, but the chain has not finalized, so it is not marked included.
      expect(proof.merkleVerified).toBe(true);
      expect(proof.included).toBe(false);
    });

    it("AC-23: states what the proof does not prove", async () => {
      const publicKey = `PRF-${randomUUID().slice(0, 8)}`;
      const published = (await publish(tokens.operatorA, { publicKey })).json();
      await app.inject({
        method: "POST",
        url: "/api/v1/anchor-batches",
        headers: { authorization: `Bearer ${tokens.operatorA}`, "idempotency-key": idempotencyKey() },
        payload: {},
      });

      const proof = (
        await app.inject({ method: "GET", url: `/api/v1/public/proofs/${published.id}` })
      ).json();

      const doesNotProve = (proof.doesNotProve as string[]).join(" ");
      expect(doesNotProve).toContain("Factual accuracy");
      expect(doesNotProve).toContain("Legal effect");
      expect(doesNotProve).toContain("Investment suitability");
      expect((proof.proves as string[]).join(" ")).toContain("included");
    });

    it("an unanchored version has no proof", async () => {
      const published = (await publish(tokens.operatorA)).json();
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/public/proofs/${published.id}`,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().retryable).toBe(true);
    });

    it("cannot modify an anchor batch", async () => {
      await publish(tokens.operatorA);
      const batch = (
        await app.inject({
          method: "POST",
          url: "/api/v1/anchor-batches",
          headers: {
            authorization: `Bearer ${tokens.operatorA}`,
            "idempotency-key": idempotencyKey(),
          },
          payload: {},
        })
      ).json();

      await expect(
        fx.sql`
          UPDATE chain.anchor_batches SET merkle_root = ${"0x" + "99".repeat(32)}
          WHERE id = ${batch.id}
        `,
      ).rejects.toThrow(/cannot be modified or deleted/);
    });
  });
});
