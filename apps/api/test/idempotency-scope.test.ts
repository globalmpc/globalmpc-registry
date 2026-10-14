import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import {
  idempotencyKey,
  newAccount,
  setupFixture,
  signIn,
  testEnv,
  type TestFixture,
} from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * What an idempotency key covers — 07 §7.1.
 *
 * Keys are stored per tenant and the request hash used to cover the body only. The same key
 * and body sent to another resource, or by another person in the same tenant, matched the
 * stored hash and **replayed someone else's response** instead of being refused.
 */
describeDb("idempotency key scope", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let operatorAToken: string;
  /** A second operator in tenant A — same tenant, different person. */
  let operatorSecondToken: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    operatorAToken = await signIn(app, fx.operatorA);

    const second = newAccount();
    const subjectId = randomUUID();
    await fx.sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name)
      VALUES (${subjectId}, ${fx.tenantA}, 'person', 'Operator Idempotency')
    `;
    await fx.sql`
      INSERT INTO core.wallet_identities (
        id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, ${subjectId}, ${second.address},
        31337, 'high_assurance', now()
      )
    `;
    await fx.sql`
      INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
      VALUES (${randomUUID()}, ${fx.tenantA}, ${subjectId}, ${fx.orgA}, 'mpc_operator')
    `;
    operatorSecondToken = await signIn(app, second);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function post(token: string, url: string, key: string, payload: unknown) {
    return app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
      payload: payload as never,
    });
  }

  it("replays the stored response for the same request", async () => {
    const key = idempotencyKey();
    const body = { displayName: `replay ${randomUUID().slice(0, 6)}` };

    const first = await post(operatorAToken, "/api/v1/admin/subjects", key, body);
    const again = await post(operatorAToken, "/api/v1/admin/subjects", key, body);

    expect(first.statusCode).toBe(200);
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(first.json().id);
  });

  it("does not replay a response for another resource with the same key and body", async () => {
    const created = await Promise.all(
      ["path one", "path two"].map(async (displayName) =>
        (
          await post(operatorAToken, "/api/v1/admin/subjects", idempotencyKey(), { displayName })
        ).json(),
      ),
    );
    const key = idempotencyKey();
    const body = {
      walletAddress: newAccount().address,
      chainId: 31337,
      assuranceLevel: "identity_bound",
      justification: "key recovery",
    };

    const first = await post(
      operatorAToken, `/api/v1/admin/subjects/${created[0].id}/wallets`, key, body,
    );
    expect(first.statusCode).toBe(200);

    const other = await post(
      operatorAToken, `/api/v1/admin/subjects/${created[1].id}/wallets`, key, body,
    );
    // Replaying here would report the second subject as bound when nothing was written.
    expect(other.statusCode).toBe(409);
    expect(other.json().code).toBe("IDEMPOTENCY_KEY_REUSE");
  });

  it("does not replay another person's response in the same tenant", async () => {
    const key = idempotencyKey();
    const body = { displayName: `shared key ${randomUUID().slice(0, 6)}` };

    const mine = await post(operatorAToken, "/api/v1/admin/subjects", key, body);
    expect(mine.statusCode).toBe(200);

    const theirs = await post(operatorSecondToken, "/api/v1/admin/subjects", key, body);
    expect(theirs.statusCode).toBe(409);
    expect(theirs.json().code).toBe("IDEMPOTENCY_KEY_REUSE");
  });
});
