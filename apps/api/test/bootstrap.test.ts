import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { bootstrapOperator, BootstrapError } from "../src/bootstrap.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { bearer, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * 운영 bootstrap.
 *
 * migration은 스키마만 만든다. 그 위에 tenant·조직·주체·지갑·역할이 없으면
 * 배포된 시스템에서 아무도 아무것도 할 수 없다 — SIWE 로그인은 되지만 역할이
 * 없다. `apps/web/e2e/seed.ts`는 스키마를 드롭하고 저장소에 있는 키를 심으므로
 * 배포 환경에 쓸 수 없다.
 *
 * 이 테스트는 bootstrap이 만든 계정이 **실제 SIWE 경로로 로그인해 역할을 얻는지**
 * 까지 확인한다. 행이 들어갔는지만 보면 "넣었는데 로그인이 안 되는" 상태를
 * 잡지 못한다.
 */
describeDb("운영 bootstrap", () => {
  let fx: TestFixture;
  let app: FastifyInstance;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function newWallet() {
    const account = privateKeyToAccount(generatePrivateKey());
    return { address: account.address.toLowerCase() as `0x${string}`, account };
  }

  function input(overrides: Record<string, unknown> = {}) {
    const suffix = randomUUID().slice(0, 8);
    return {
      tenantSlug: `bs-${suffix}`,
      tenantName: `Bootstrap ${suffix}`,
      organizationName: `Bootstrap Org ${suffix}`,
      jurisdiction: "MNG",
      subjectName: "First Operator",
      walletAddress: newWallet().address,
      chainId: 97,
      role: "mpc_operator",
      assuranceLevel: "high_assurance",
      ...overrides,
    } as Parameters<typeof bootstrapOperator>[1];
  }

  it("만든 계정이 SIWE로 로그인해 역할을 얻는다", async () => {
    const wallet = newWallet();
    const result = await bootstrapOperator(fx.sql, input({ walletAddress: wallet.address }));

    expect(result.created).toBe(true);

    const token = await signIn(app, wallet);
    const session = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: bearer(token),
    });

    const body = session.json() as {
      authenticated: boolean;
      tenantId: string;
      subjectId: string;
      assuranceLevel: string;
      roleBindings: { role: string; organizationId: string | null }[];
    };

    expect(body.authenticated).toBe(true);
    expect(body.tenantId).toBe(result.tenantId);
    expect(body.subjectId).toBe(result.subjectId);
    expect(body.assuranceLevel).toBe("high_assurance");
    expect(body.roleBindings).toEqual([
      { role: "mpc_operator", organizationId: result.organizationId, projectId: null },
    ]);
  });

  it("같은 입력을 다시 돌려도 tenant와 주체가 하나로 남는다", async () => {
    const args = input();

    const first = await bootstrapOperator(fx.sql, args);
    const second = await bootstrapOperator(fx.sql, args);

    expect(second.created).toBe(false);
    expect(second.tenantId).toBe(first.tenantId);
    expect(second.organizationId).toBe(first.organizationId);
    expect(second.subjectId).toBe(first.subjectId);

    const rows = await fx.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM core.role_bindings
      WHERE subject_id = ${first.subjectId} AND revoked_at IS NULL
    `;
    expect(rows[0]?.count).toBe("1");
  });

  it("역할이 요구하는 assurance보다 낮으면 거절한다", async () => {
    // mpc_operator는 high_assurance를 요구한다. 낮은 값으로 만들어 두면 행은
    // 들어가지만 요청마다 403이 나고, 왜 그런지는 화면에 보이지 않는다.
    await expect(
      bootstrapOperator(fx.sql, input({ assuranceLevel: "wallet_only" })),
    ).rejects.toThrow(BootstrapError);
  });

  it("모르는 역할을 거절한다", async () => {
    await expect(bootstrapOperator(fx.sql, input({ role: "superuser" }))).rejects.toThrow(
      BootstrapError,
    );
  });

  it("지갑 형식이 어긋나면 거절한다", async () => {
    await expect(
      bootstrapOperator(fx.sql, input({ walletAddress: "0xNOTAWALLET" })),
    ).rejects.toThrow(BootstrapError);
  });

  it("BSC가 아닌 체인을 거절한다", async () => {
    await expect(bootstrapOperator(fx.sql, input({ chainId: 1 }))).rejects.toThrow(BootstrapError);
  });

  it("이미 다른 tenant에 묶인 지갑을 거절한다", async () => {
    const wallet = newWallet();
    await bootstrapOperator(fx.sql, input({ walletAddress: wallet.address }));

    // 같은 지갑, 다른 tenant. 허용하면 한 키가 두 tenant의 권한을 갖는다.
    await expect(
      bootstrapOperator(fx.sql, input({ walletAddress: wallet.address })),
    ).rejects.toThrow(BootstrapError);
  });

  it("같은 tenant에 두 번째 역할을 별도 주체로 추가한다", async () => {
    const args = input();
    const first = await bootstrapOperator(fx.sql, args);

    const reviewer = newWallet();
    const second = await bootstrapOperator(fx.sql, {
      ...args,
      subjectName: "First Reviewer",
      walletAddress: reviewer.address,
      role: "reviewer_cp_qp",
    });

    expect(second.tenantId).toBe(first.tenantId);
    expect(second.organizationId).toBe(first.organizationId);
    expect(second.subjectId).not.toBe(first.subjectId);

    const token = await signIn(app, reviewer);
    const session = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: bearer(token),
    });
    const body = session.json() as { roleBindings: { role: string }[] };
    expect(body.roleBindings.map((binding) => binding.role)).toEqual(["reviewer_cp_qp"]);
  });
});
