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
 * Production bootstrap.
 *
 * Migrations only create the schema. Without a tenant, organization, subject, wallet and role
 * on top, nobody can do anything in a deployed system — SIWE sign-in works but there is
 * no role. `apps/web/e2e/seed.ts` drops the schema and plants keys from the repo, so it
 * cannot be used in deployment.
 *
 * This test checks that accounts bootstrap creates **sign in via the real SIWE path and
 * get their roles**. Checking only that rows exist misses the "inserted but cannot
 * sign in" state.
 */
describeDb("production bootstrap", () => {
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

  it("a created account signs in with SIWE and gets its role", async () => {
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

  it("rerunning the same input keeps one tenant and one subject", async () => {
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

  it("rejects assurance below what the role requires", async () => {
    // mpc_operator requires high_assurance. With a lower value the row is inserted,
    // but every request gets 403 and the UI never shows why.
    await expect(
      bootstrapOperator(fx.sql, input({ assuranceLevel: "wallet_only" })),
    ).rejects.toThrow(BootstrapError);
  });

  it("rejects an unknown role", async () => {
    await expect(bootstrapOperator(fx.sql, input({ role: "superuser" }))).rejects.toThrow(
      BootstrapError,
    );
  });

  it("rejects a malformed wallet", async () => {
    await expect(
      bootstrapOperator(fx.sql, input({ walletAddress: "0xNOTAWALLET" })),
    ).rejects.toThrow(BootstrapError);
  });

  it("rejects a non-BSC chain", async () => {
    await expect(bootstrapOperator(fx.sql, input({ chainId: 1 }))).rejects.toThrow(BootstrapError);
  });

  it("rejects a wallet already bound to another tenant", async () => {
    const wallet = newWallet();
    await bootstrapOperator(fx.sql, input({ walletAddress: wallet.address }));

    // Same wallet, different tenant. Allowing it gives one key rights in two tenants.
    await expect(
      bootstrapOperator(fx.sql, input({ walletAddress: wallet.address })),
    ).rejects.toThrow(BootstrapError);
  });

  it("adds a second role in the same tenant as a separate subject", async () => {
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
