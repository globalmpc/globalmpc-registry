import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { verifyMerkleProof, type Hex } from "@mpc/canonical";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, testEnv, type TestFixture, signIn } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

describeDb("Registry 게시와 공개 조회", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let tokens: { operatorA: string; stewardA: string };

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);

    // R1부터 인증은 SIWE 서명 → 세션 토큰이다. 테스트도 같은 경로를 지난다.
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
      limitations: ["법률 권리 확인은 이 검토 범위 밖이다"],
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
   * 04 §4.3 — `draft→registered`의 guard는 "Project Registry 최소 필드와 책임 주체"다.
   *
   * 그 조건을 만족시키는 행위가 바로 Project Registry 게시다. 게시 권한
   * (`registry.publish`)을 이미 가진 사람이 하는 일이므로 새로운 권한이 생기지 않는다.
   * 나머지 전이(suspend·offering·closure)는 결정 주체가 미정이다.
   */
  describe("프로젝트 lifecycle (04 §4.3)", () => {
    async function newProject() {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: { authorization: `Bearer ${tokens.operatorA}`, "idempotency-key": idempotencyKey() },
        payload: {
          projectKey: `LC-${randomUUID().slice(0, 8)}`,
          name: "lifecycle 테스트",
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

    it("project registry 게시가 draft를 registered로 옮긴다", async () => {
      const projectId = await newProject();

      const response = await publish(tokens.operatorA, { subjectId: projectId });
      expect(response.statusCode).toBe(200);

      expect(await lifecycleOf(projectId)).toBe("registered");
    });

    it("같은 프로젝트를 다시 게시해도 registered에 머문다", async () => {
      // 전이는 한 번만 일어난다. 다시 밀면 `registered→registered`가 되고 04 §4.3의
      // 전이표에 없는 전이가 된다.
      const projectId = await newProject();
      await publish(tokens.operatorA, { subjectId: projectId });
      const again = await publish(tokens.operatorA, { subjectId: projectId });

      expect(again.statusCode).toBe(200);
      expect(await lifecycleOf(projectId)).toBe("registered");
    });

    it("verification registry 게시는 프로젝트 lifecycle을 건드리지 않는다", async () => {
      // Verification Registry는 검토 결과의 등록부다. 프로젝트가 등록됐다는 뜻이
      // 아니다.
      const projectId = await newProject();

      const response = await publish(tokens.operatorA, {
        registryType: "verification",
        subjectId: projectId,
      });
      expect(response.statusCode).toBe(200);

      expect(await lifecycleOf(projectId)).toBe("draft");
    });
  });

  it("allowlist 필드만 있으면 게시된다", async () => {
    const response = await publish(tokens.operatorA);
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.status).toBe("published");
    expect(body.version).toBe(1);
    expect(body.contentHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("AC-22: allowlist 밖 필드가 있으면 거절한다", async () => {
    const response = await publish(tokens.operatorA, {
      projection: validProjection({ rawSourceResponse: "{...}" }),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().details.offendingFields).toContain("rawSourceResponse");
  });

  it("AC-22: 원문·PII 성격 필드를 거절한다", async () => {
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

  it("AC-32: 자연인 식별자는 safeguard 없이 공개할 수 없다", async () => {
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

  it("AC-13: commercial_reuse가 unconfirmed면 상업적 근거로 게시할 수 없다", async () => {
    const response = await publish(tokens.operatorA, {
      commercialReuse: "unconfirmed",
      publishedAsCommercialBasis: true,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("PUBLICATION_SOURCE_LICENSE_UNCONFIRMED");
  });

  it("limitations 없는 projection을 거절한다", async () => {
    const projection = validProjection();
    delete (projection as Record<string, unknown>)["limitations"];
    const response = await publish(tokens.operatorA, { projection });
    expect(response.statusCode).toBe(422);
  });

  it("게시된 projection을 덮어쓸 수 없다", async () => {
    const published = (await publish(tokens.operatorA)).json();
    await expect(
      fx.sql`
        UPDATE core.registry_entry_versions
        SET public_projection = '{"stableId":"changed"}'::jsonb
        WHERE id = ${published.id}
      `,
    ).rejects.toThrow(/덮어쓸 수 없다/);
  });

  it("새 version이 이전 것을 superseded로 연결한다 — 삭제하지 않는다", async () => {
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

  it("revoke는 삭제가 아니라 새 상태다", async () => {
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

  describe("멈춘 batch 재제출", () => {
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

    it("진행 중인 batch는 재제출하지 않는다", async () => {
      const batchId = await makeBatch();

      // created·submitted·included를 되돌리면 이미 체인에 있는 트랜잭션을 잊고
      // 같은 root를 다시 올린다.
      const response = await resubmit(batchId);
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("ANCHOR_NOT_RESUBMITTABLE");
      expect(response.json().details.currentState).toBe("created");
    });

    it("멈춘 batch는 시도 횟수를 되돌려 다시 올린다", async () => {
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
      // 사람이 원인을 확인하고 결정한 것이므로 이전 시도의 상한을 물려받지 않는다.
      expect(row!.state).toBe("created");
      expect(row!.attempts).toBe(0);
      expect(row!.tx_hash).toBeNull();
    });

    it("재제출에도 anchor.submit 권한이 필요하다", async () => {
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

  describe("철회의 동시성 (If-Match)", () => {
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

    it("어느 version을 철회하는지 밝히지 않으면 거절한다", async () => {
      const publicKey = `KEY-${randomUUID().slice(0, 8)}`;
      const published = (await publish(tokens.operatorA, { publicKey })).json();

      const response = await revoke(published.entryId, undefined);
      expect(response.statusCode).toBe(428);
    });

    it("조회 이후 새 version이 게시되면 낡은 철회 요청을 거절한다", async () => {
      const publicKey = `KEY-${randomUUID().slice(0, 8)}`;
      const first = (await publish(tokens.operatorA, { publicKey })).json();

      // 누군가 정정본을 게시했다. v1을 철회하려던 요청은 이제 v2를 철회하게 된다.
      await publish(tokens.operatorA, { publicKey });

      const response = await revoke(first.entryId, `"${first.version}"`);
      expect(response.statusCode).toBe(412);
      expect(response.json().details.currentVersion).toBe("2");
    });

    it("공개 조회 응답이 ETag로 현재 version을 알려준다", async () => {
      const publicKey = `KEY-${randomUUID().slice(0, 8)}`;
      await publish(tokens.operatorA, { publicKey });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/public/registries/project/${publicKey}`,
      });

      // 본문의 version과 같은 값이어야 한다. 다르면 클라이언트가 어느 쪽을
      // If-Match에 넣어야 하는지 알 수 없다.
      expect(response.headers["etag"]).toBe(`"${response.json().version}"`);
    });
  });

  it("권한 없는 계정은 게시할 수 없다", async () => {
    const response = await publish(tokens.stewardA);
    expect(response.statusCode).toBe(403);
    expect(response.json().details.requiredRoles).toContain("mpc_operator");
  });

  describe("공개 조회 (무인증)", () => {
    it("인증 없이 게시된 projection을 조회한다", async () => {
      const publicKey = `PUB-${randomUUID().slice(0, 8)}`;
      await publish(tokens.operatorA, { publicKey });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/public/registries/project/${publicKey}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe("published");
    });

    it("없는 키는 404다", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/public/registries/project/DOES-NOT-EXIST",
      });
      expect(response.statusCode).toBe(404);
    });

    it("응답에 limitations와 legalEffect가 있다", async () => {
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

    it("정정·철회 이력을 감추지 않는다", async () => {
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

    it("tenant를 특정할 수 있는 정보가 응답에 없다", async () => {
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

  describe("anchor와 inclusion proof", () => {
    it("게시된 version으로 batch를 만든다", async () => {
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
      // 아직 체인에 올라가지 않았다.
      expect(body.confirmationState).toBe("created");
    });

    it("anchor할 것이 없으면 빈 batch를 만들지 않는다", async () => {
      // 앞 테스트에서 모두 anchor됐다.
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/anchor-batches",
        headers: { authorization: `Bearer ${tokens.operatorA}`, "idempotency-key": idempotencyKey() },
        payload: {},
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("ANCHOR_BATCH_EMPTY");
    });

    it("proof가 오프체인에서 검증된다", async () => {
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

    it("proof가 leaf를 다시 만들 규격을 함께 준다", async () => {
      // 규격 버전이 없으면 검증자가 **어떤 규격으로** 재구성해야 하는지 모른다.
      // 그러면 proof는 재현 가능한 확인이 아니라 "믿어라"가 된다.
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

      // 게시할 때 준 값이 그대로 나온다 — 상수로 고정돼 있지 않다.
      expect(proof.policyVersion).toBe("mn-core-9.9.9");
      expect(proof.schemaVersion).toBe("project-registry-9");
      expect(proof.serializationVersion).toBe("1");

      // 주체는 담지 않는다. 규격 이름만 담는다.
      expect(proof.subjectId).toBeUndefined();
    });

    it("AC-23: confirmed가 아니면 included가 false다", async () => {
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
      // Merkle은 맞지만 체인 확정 전이므로 포함으로 표시하지 않는다.
      expect(proof.merkleVerified).toBe(true);
      expect(proof.included).toBe(false);
    });

    it("AC-23: proof가 무엇을 증명하지 않는지 명시한다", async () => {
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
      expect(doesNotProve).toContain("사실성");
      expect(doesNotProve).toContain("법률 효력");
      expect(doesNotProve).toContain("투자 적합성");
      expect((proof.proves as string[]).join(" ")).toContain("포함");
    });

    it("anchor되지 않은 version은 proof가 없다", async () => {
      const published = (await publish(tokens.operatorA)).json();
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/public/proofs/${published.id}`,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().retryable).toBe(true);
    });

    it("anchor batch는 수정할 수 없다", async () => {
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
      ).rejects.toThrow(/수정·삭제할 수 없다/);
    });
  });
});
