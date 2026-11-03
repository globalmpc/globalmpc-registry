import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import {
  SERVICE_TOKEN_PATTERN,
  ServiceTokenError,
  ensureServiceToken,
  generateServiceTokenValue,
  revokeServiceToken,
  rotateServiceToken,
} from "../src/service-tokens.js";
import { resolveServiceToken } from "../src/plugins/session-token.js";
import {
  bearer,
  idempotencyKey,
  setupFixture,
  signIn,
  testEnv,
  type TestFixture,
} from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

const DAY = 24 * 60 * 60;
const HOUR = 60 * 60;

/**
 * Deploy-time registration of a service token generated ahead of time (the scan worker's path).
 *
 * The value is generated once (`service-token generate`), kept in the environment's secret
 * store, and registered by every deploy: changing nothing while it is unchanged, rotating when it
 * changes, and never undoing a revocation. Only the hash reaches the database.
 */
describeDb("service token ensure", () => {
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

  const ensure = (token: string, overrides: Partial<Parameters<typeof ensureServiceToken>[1]> = {}) =>
    ensureServiceToken(fx.sql, {
      tenantId: fx.tenantA,
      label: "scan-worker",
      role: "scan_service",
      scopes: ["scan_result"],
      token,
      ttlSeconds: 365 * DAY,
      overlapSeconds: 24 * HOUR,
      ...overrides,
    });

  const tokensOf = (subjectId: string, label: string) =>
    fx.sql<{ id: string; expires_at: Date; rotated_from: string | null; token_hash: string }[]>`
      SELECT id, expires_at, rotated_from, token_hash FROM core.service_tokens
      WHERE subject_id = ${subjectId} AND label = ${label} ORDER BY issued_at
    `;

  async function reportClean(token: string): Promise<number> {
    const steward = await signIn(app, fx.stewardA);
    const upload = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${fx.projectA}/uploads`,
      headers: { ...bearer(steward), "idempotency-key": idempotencyKey() },
      payload: {
        contentBase64: Buffer.from(`ensure ${randomUUID()}`).toString("base64"),
        contentType: "application/pdf",
        originalFilename: "license.pdf",
      },
    });
    expect(upload.statusCode).toBe(200);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/uploads/${upload.json().id as string}/scan-result`,
      headers: { ...bearer(token), "idempotency-key": idempotencyKey(), "if-match": '"1"' },
      payload: { result: "clean" },
    });
    return response.statusCode;
  }

  it("generates tokens of the one accepted shape, each different", () => {
    const tokens = new Set(Array.from({ length: 20 }, () => generateServiceTokenValue()));
    expect(tokens.size).toBe(20);
    for (const token of tokens) expect(token).toMatch(SERVICE_TOKEN_PATTERN);
  });

  it("creates the service on first use, registers only the hash, and the token reports scans", async () => {
    const token = generateServiceTokenValue();
    const first = await ensure(token);
    expect(first).toMatchObject({ outcome: "registered", subjectCreated: true, retired: [], renewalDue: false });

    const [subject] = await fx.sql<{ kind: string; display_name: string }[]>`
      SELECT kind, display_name FROM core.subjects WHERE id = ${first.subjectId}
    `;
    expect(subject).toEqual({ kind: "service", display_name: "scan-worker" });
    const roles = await fx.sql<{ role: string }[]>`
      SELECT role FROM core.role_bindings WHERE subject_id = ${first.subjectId} AND revoked_at IS NULL
    `;
    expect(roles.map((row) => row.role)).toEqual(["scan_service"]);

    const [stored] = await tokensOf(first.subjectId, "scan-worker");
    expect(stored!.token_hash).toMatch(/^0x[0-9a-f]{64}$/);
    const everything = JSON.stringify(
      await fx.sql`SELECT * FROM core.service_tokens WHERE subject_id = ${first.subjectId}`,
    ) + JSON.stringify(await fx.sql`SELECT detail FROM audit.events WHERE resource_id = ${first.tokenId}`);
    expect(everything).not.toContain(token.slice("mpcsvc_".length));

    expect(await resolveServiceToken(fx.appSql, token)).toMatchObject({
      subjectId: first.subjectId,
      scopes: ["scan_result"],
    });
    expect(await reportClean(token)).toBe(200);
  });

  it("is idempotent: the same value on the next deploy changes nothing", async () => {
    const token = generateServiceTokenValue();
    const label = "idempotent-scan";
    const first = await ensure(token, { label });
    const again = await ensure(token, { label });
    const third = await ensure(token, { label });

    for (const result of [again, third]) {
      expect(result).toMatchObject({
        outcome: "unchanged",
        subjectId: first.subjectId,
        subjectCreated: false,
        tokenId: first.tokenId,
        expiresAt: first.expiresAt,
        retired: [],
      });
    }
    expect(await tokensOf(first.subjectId, label)).toHaveLength(1);
    const subjects = await fx.sql`
      SELECT 1 FROM core.subjects WHERE tenant_id = ${fx.tenantA} AND display_name = ${label}
    `;
    expect(subjects).toHaveLength(1);
  });

  it("two deploys registering the same new value at once register it once", async () => {
    const token = generateServiceTokenValue();
    const label = "concurrent-scan";
    const results = await Promise.all([ensure(token, { label }), ensure(token, { label })]);
    expect(results.map((result) => result.outcome).sort()).toEqual(["registered", "unchanged"]);
    expect(await tokensOf(results[0].subjectId, label)).toHaveLength(1);
  });

  it("a new value rotates: it is added, and the old one ends after the overlap", async () => {
    const label = "rotating-scan";
    const old = generateServiceTokenValue();
    const first = await ensure(old, { label });

    const next = generateServiceTokenValue();
    const before = Date.now();
    const rotated = await ensure(next, { label, overlapSeconds: 2 * HOUR });
    expect(rotated).toMatchObject({ outcome: "rotated", subjectId: first.subjectId, subjectCreated: false });
    expect(rotated.retired).toHaveLength(1);
    expect(rotated.retired[0]!.tokenId).toBe(first.tokenId);
    const oldExpiry = new Date(rotated.retired[0]!.expiresAt).getTime();
    expect(oldExpiry).toBeGreaterThan(before);
    expect(oldExpiry).toBeLessThanOrEqual(Date.now() + 2 * HOUR * 1000);

    const rows = await tokensOf(first.subjectId, label);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.rotated_from).toBe(first.tokenId);
    // Both work during the overlap, so the worker can be rolled after the deploy.
    expect(await resolveServiceToken(fx.appSql, old)).not.toBeNull();
    expect(await resolveServiceToken(fx.appSql, next)).not.toBeNull();

    // The next deploy with the new value changes nothing, and does not revive the old one.
    expect((await ensure(next, { label })).outcome).toBe("unchanged");
    const [stillOld] = await fx.sql<{ expires_at: Date }[]>`
      SELECT expires_at FROM core.service_tokens WHERE id = ${first.tokenId}
    `;
    expect(stillOld!.expires_at.getTime()).toBe(oldExpiry);

    // With no overlap the old one ends at once.
    const third = generateServiceTokenValue();
    await ensure(third, { label, overlapSeconds: 0 });
    expect(await resolveServiceToken(fx.appSql, next)).toBeNull();
    expect(await resolveServiceToken(fx.appSql, third)).not.toBeNull();
  });

  it("refuses a value a rotation already retired, instead of calling it unchanged", async () => {
    const label = "rolled-back-scan";
    const old = generateServiceTokenValue();
    const first = await ensure(old, { label });
    const next = generateServiceTokenValue();
    await ensure(next, { label, overlapSeconds: 2 * HOUR });
    const before = await tokensOf(first.subjectId, label);

    // A deploy that went back to the old value (a rolled-back or stale secret) would otherwise
    // pass on a token that ends with the overlap, and the worker would start failing then.
    const attempt = ensure(old, { label });
    await expect(attempt).rejects.toBeInstanceOf(ServiceTokenError);
    await expect(attempt).rejects.toThrow(
      new RegExp(`token ${first.tokenId} was replaced by a later token of this service .*out of date`),
    );
    await attempt.catch((error: Error) => expect(error.message).not.toContain(old));
    // Nothing changed: the old one still ends with the overlap, the new one is still current.
    expect(await tokensOf(first.subjectId, label)).toEqual(before);
    expect((await ensure(next, { label })).outcome).toBe("unchanged");
  });

  it("refuses a value replaced by a CLI rotation, which names it as rotated_from", async () => {
    const label = "cli-rotated-scan";
    const old = generateServiceTokenValue();
    const first = await ensure(old, { label });
    const rotated = await rotateServiceToken(fx.sql, { tokenId: first.tokenId, overlapSeconds: HOUR, ttlSeconds: 24 * HOUR });
    expect(rotated.tokenId).not.toBe(first.tokenId);
    await expect(ensure(old, { label })).rejects.toThrow(/was replaced by a later token/);
  });

  it("refuses a malformed value before touching the database, without quoting it", async () => {
    const label = "malformed-scan";
    for (const token of [
      "",
      "mpcsvc_",
      "mpcsvc_dGVzdC1zY2FuLXRva2Vu", // the CDK test fixture's value: right prefix, too short
      `mpcsvc_${"a".repeat(42)}`,
      `mpcsvc_${"a".repeat(44)}`,
      `mpcsvc_${"a".repeat(42)}=`,
      `mpcses_${"a".repeat(43)}`,
      `MPCSVC_${"a".repeat(43)}`,
      ` ${generateServiceTokenValue()}`,
    ]) {
      const attempt = ensure(token, { label });
      await expect(attempt, token).rejects.toBeInstanceOf(ServiceTokenError);
      await attempt.catch((error: Error) => {
        if (token.length > 8) expect(error.message).not.toContain(token);
      });
    }
    const subjects = await fx.sql`
      SELECT 1 FROM core.subjects WHERE tenant_id = ${fx.tenantA} AND display_name = ${label}
    `;
    expect(subjects).toHaveLength(0);
  });

  it("a revoked value stays revoked: the next deploy refuses it instead of registering it again", async () => {
    const label = "revoked-scan";
    const token = generateServiceTokenValue();
    const first = await ensure(token, { label });
    expect(await revokeServiceToken(fx.sql, first.tokenId)).toBe(true);

    await expect(ensure(token, { label })).rejects.toThrow(/revoked; generate a new one/);
    expect(await resolveServiceToken(fx.appSql, token)).toBeNull();

    // Recovery is a new value.
    const replacement = await ensure(generateServiceTokenValue(), { label });
    expect(replacement.outcome).toBe("registered");
  });

  it("refuses a value registered for another service, or with other scopes", async () => {
    const token = generateServiceTokenValue();
    await ensure(token, { label: "owner-scan" });
    await expect(ensure(token, { label: "other-scan" })).rejects.toThrow(/another service/);
    await expect(
      ensure(token, { label: "owner-scan", scopes: ["scan_result", "cre_report"] }),
    ).rejects.toThrow(/scopes/);
    await expect(ensure(token, { label: "owner-scan", tenantId: fx.tenantB })).rejects.toThrow(
      /another service/,
    );
  });

  it("refuses a person role, and says when the value is due for renewal", async () => {
    await expect(
      ensure(generateServiceTokenValue(), { label: "person-role", role: "mpc_operator" }),
    ).rejects.toBeInstanceOf(ServiceTokenError);

    const short = await ensure(generateServiceTokenValue(), { label: "short-lived", ttlSeconds: 10 * DAY });
    expect(short.renewalDue).toBe(true);
  });

  it("never writes the token to the console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    const out = vi.spyOn(process.stdout, "write");
    const err = vi.spyOn(process.stderr, "write");
    try {
      const token = generateServiceTokenValue();
      await ensure(token, { label: "quiet-scan" });
      await ensure(token, { label: "quiet-scan" });
      await ensure(generateServiceTokenValue(), { label: "quiet-scan" });
      const written = [...spies, out, err]
        .flatMap((spy) => spy.mock.calls)
        .map((call) => call.map(String).join(" "))
        .join("\n");
      expect(written).not.toContain(token);
      expect(written).not.toContain("mpcsvc_");
    } finally {
      for (const spy of [...spies, out, err]) spy.mockRestore();
    }
  });
});
