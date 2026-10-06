import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@mpc/db";
import {
  releaseIdempotency,
  releaseIdempotencyAfterFailure,
  reserveIdempotency,
} from "../src/plugins/idempotency.js";
import { idempotencyKey, setupFixture, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Releasing a reservation — 07 §7.1.
 *
 * The release runs on the failure path, as the application role. If it cannot run there, the
 * original failure is replaced by a permission error and the key stays in flight forever, so
 * the client can neither see what went wrong nor retry.
 */
describeDb("idempotency reservation release", () => {
  let fx: TestFixture;

  beforeAll(async () => {
    fx = await setupFixture();
  });

  afterAll(async () => {
    await fx.close();
  });

  function reserve(key: string) {
    return withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) =>
      reserveIdempotency(tx, fx.tenantA, key, "hash"),
    );
  }

  it("lets the application role release an unsettled reservation so a retry can proceed", async () => {
    const key = idempotencyKey();
    await reserve(key);

    await expect(releaseIdempotency(fx.appSql, fx.tenantA, key)).resolves.toBeUndefined();

    // Released: the same key reserves afresh instead of answering "in progress".
    await expect(reserve(key)).resolves.toEqual({ replay: null });
  });

  it("never deletes a settled response, even when asked to", async () => {
    const key = idempotencyKey();
    await reserve(key);
    await withTenant(fx.appSql, { tenantId: fx.tenantA }, async (tx) => {
      await tx`
        UPDATE core.idempotency_keys
        SET response_status = 200, response_snapshot = ${tx.json({ done: true })}
        WHERE key = ${key} AND tenant_id = ${fx.tenantA}
      `;
    });

    await withTenant(fx.appSql, { tenantId: fx.tenantA }, async (tx) => {
      await tx`DELETE FROM core.idempotency_keys WHERE key = ${key}`;
    });

    await expect(reserve(key)).resolves.toEqual({ replay: { done: true } });
  });

  it("a failing release is logged, not thrown over the original error", async () => {
    const logged: string[] = [];
    const broken = (() => Promise.reject(new Error("connection lost"))) as unknown as Parameters<
      typeof releaseIdempotencyAfterFailure
    >[0];
    broken.begin = (() => Promise.reject(new Error("connection lost"))) as never;

    await expect(
      releaseIdempotencyAfterFailure(broken, fx.tenantA, idempotencyKey(), {
        error: (_detail, message) => logged.push(message),
      }),
    ).resolves.toBeUndefined();
    expect(logged).toHaveLength(1);
  });
});
