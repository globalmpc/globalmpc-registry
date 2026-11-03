import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SERVICE_SCOPES } from "@mpc/api-contract";
import {
  MAX_ROTATION_OVERLAP_SECONDS,
  ServiceTokenError,
  createServiceSubject,
  issueServiceToken,
  listServiceTokens,
  revokeServiceToken,
  rotateServiceToken,
} from "../src/service-tokens.js";
import { resolveServiceToken } from "../src/plugins/session-token.js";
import { setupFixture, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

const DAY = 24 * 60 * 60;

/**
 * Service tokens — decision D7, operator side.
 *
 * A token is a bearer secret for one service subject, limited to named scopes, never longer
 * than a year, and only its hash is stored. Rotation keeps the old token alive for a bounded
 * overlap; revocation ends it at once. Every change is audited without an invented actor.
 */
describeDb("service tokens", () => {
  let fx: TestFixture;

  beforeAll(async () => {
    fx = await setupFixture();
  });

  afterAll(async () => {
    await fx.close();
  });

  const resolve = (token: string) => resolveServiceToken(fx.appSql, token);

  it("the scopes the contract names are exactly the scopes the database accepts", async () => {
    const [row] = await fx.sql<{ definition: string }[]>`
      SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid = 'core.service_tokens'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%scopes%<@%'
    `;
    const inDatabase = [...row!.definition.matchAll(/'([a-z_]+)'::text/g)].map((match) => match[1]);
    expect([...inDatabase].sort()).toEqual([...SERVICE_SCOPES].sort());
  });

  it("creates a service subject with one service role, and refuses a person role", async () => {
    const { subjectId } = await createServiceSubject(fx.sql, {
      tenantId: fx.tenantA,
      displayName: "CRE reporter",
      role: "cre_reporter",
    });
    const [subject] = await fx.sql<{ kind: string; assurance_level: string }[]>`
      SELECT kind, assurance_level FROM core.subjects WHERE id = ${subjectId}
    `;
    expect(subject).toEqual({ kind: "service", assurance_level: "high_assurance" });
    const roles = await fx.sql<{ role: string }[]>`
      SELECT role FROM core.role_bindings WHERE subject_id = ${subjectId} AND revoked_at IS NULL
    `;
    expect(roles.map((row) => row.role)).toEqual(["cre_reporter"]);

    for (const role of ["mpc_operator", "data_steward", "public_reader"]) {
      await expect(
        createServiceSubject(fx.sql, { tenantId: fx.tenantA, displayName: "x", role }),
      ).rejects.toBeInstanceOf(ServiceTokenError);
    }
    await expect(
      createServiceSubject(fx.sql, { tenantId: fx.tenantA, displayName: "  ", role: "scan_service" }),
    ).rejects.toThrow(/display name/);
  });

  it("issues a token that resolves to its subject and scopes, storing only a hash", async () => {
    const issued = await issueServiceToken(fx.sql, {
      tenantId: fx.tenantA,
      subjectId: fx.scanServiceSubjectA,
      scopes: ["scan_result"],
      label: "scan-worker.blue",
      ttlSeconds: 30 * DAY,
    });
    expect(issued.token).toMatch(/^mpcsvc_/);

    const resolved = await resolve(issued.token);
    expect(resolved).toMatchObject({
      subjectId: fx.scanServiceSubjectA,
      tenantId: fx.tenantA,
      scopes: ["scan_result"],
    });

    const [stored] = await fx.sql<{ token_hash: string }[]>`
      SELECT token_hash FROM core.service_tokens WHERE id = ${issued.tokenId}
    `;
    expect(stored!.token_hash).not.toContain(issued.token.slice("mpcsvc_".length));

    const [audit] = await fx.sql<{ actor_subject_id: string | null; effective_role: string; detail: Record<string, unknown> }[]>`
      SELECT actor_subject_id, effective_role, detail FROM audit.events
      WHERE command = 'service_token.issued' AND resource_id = ${issued.tokenId}
    `;
    expect(audit).toMatchObject({ actor_subject_id: null, effective_role: "deploy_bound" });
    expect(JSON.stringify(audit!.detail)).not.toContain(issued.token);
  });

  it("refuses unknown or empty scopes, a bad label, and a lifetime outside a minute to a year", async () => {
    const base = {
      tenantId: fx.tenantA,
      subjectId: fx.scanServiceSubjectA,
      scopes: ["scan_result"],
      label: "scan-worker",
      ttlSeconds: DAY,
    };
    for (const input of [
      { ...base, scopes: [] },
      { ...base, scopes: ["scan_result", "admin"] },
      { ...base, label: "Scan Worker" },
      { ...base, label: "" },
      { ...base, ttlSeconds: 59 },
      { ...base, ttlSeconds: 366 * DAY },
      { ...base, ttlSeconds: 1.5 },
    ]) {
      await expect(issueServiceToken(fx.sql, input), JSON.stringify(input)).rejects.toBeInstanceOf(
        ServiceTokenError,
      );
    }
  });

  it("rotation keeps the old token for the overlap only, and the successor carries its scopes", async () => {
    const first = await issueServiceToken(fx.sql, {
      tenantId: fx.tenantA,
      subjectId: fx.scanServiceSubjectA,
      scopes: ["scan_result"],
      label: "rotating",
      ttlSeconds: 90 * DAY,
    });
    const rotated = await rotateServiceToken(fx.sql, {
      tokenId: first.tokenId,
      overlapSeconds: 60 * 60,
      ttlSeconds: 90 * DAY,
    });

    const overlapEnds = new Date(rotated.previousExpiresAt).getTime() - Date.now();
    expect(overlapEnds).toBeGreaterThan(50 * 60 * 1000);
    expect(overlapEnds).toBeLessThanOrEqual(60 * 60 * 1000 + 5_000);
    expect(await resolve(first.token)).not.toBeNull();
    expect(await resolve(rotated.token)).toMatchObject({ scopes: ["scan_result"] });

    const [successor] = await fx.sql<{ rotated_from: string; label: string }[]>`
      SELECT rotated_from, label FROM core.service_tokens WHERE id = ${rotated.tokenId}
    `;
    expect(successor).toEqual({ rotated_from: first.tokenId, label: "rotating" });

    // A rotation never extends a token: an overlap longer than what remains keeps the old expiry.
    const shortLived = await issueServiceToken(fx.sql, {
      tenantId: fx.tenantA,
      subjectId: fx.scanServiceSubjectA,
      scopes: ["scan_result"],
      label: "short",
      ttlSeconds: 120,
    });
    const again = await rotateServiceToken(fx.sql, {
      tokenId: shortLived.tokenId,
      overlapSeconds: MAX_ROTATION_OVERLAP_SECONDS,
      ttlSeconds: DAY,
    });
    expect(new Date(again.previousExpiresAt).getTime() - Date.now()).toBeLessThanOrEqual(125_000);

    await expect(
      rotateServiceToken(fx.sql, { tokenId: first.tokenId, overlapSeconds: MAX_ROTATION_OVERLAP_SECONDS + 1, ttlSeconds: DAY }),
    ).rejects.toThrow(/overlap/);
    await expect(
      rotateServiceToken(fx.sql, { tokenId: first.tokenId, overlapSeconds: -1, ttlSeconds: DAY }),
    ).rejects.toThrow(/overlap/);
  });

  it("revocation ends the token at once and cannot be repeated; a revoked token cannot be rotated", async () => {
    const issued = await issueServiceToken(fx.sql, {
      tenantId: fx.tenantA,
      subjectId: fx.scanServiceSubjectA,
      scopes: ["scan_result"],
      label: "revoked",
      ttlSeconds: DAY,
    });
    expect(await revokeServiceToken(fx.sql, issued.tokenId)).toBe(true);
    expect(await resolve(issued.token)).toBeNull();
    expect(await revokeServiceToken(fx.sql, issued.tokenId)).toBe(false);
    await expect(
      rotateServiceToken(fx.sql, { tokenId: issued.tokenId, overlapSeconds: 0, ttlSeconds: DAY }),
    ).rejects.toThrow(/no live token/);
  });

  it("does not resolve a value that is not a service token", async () => {
    expect(await resolve("mpcsvc_not-a-real-token")).toBeNull();
  });

  it("lists a tenant's tokens without their hashes", async () => {
    const listed = await listServiceTokens(fx.sql, fx.tenantA);
    expect(listed.length).toBeGreaterThan(0);
    for (const token of listed) {
      expect(Object.keys(token)).not.toContain("tokenHash");
      expect(JSON.stringify(token)).not.toMatch(/token_hash/);
    }
    expect(listed.some((token) => token.rotatedFrom !== null)).toBe(true);
    expect(listed.some((token) => token.revokedAt !== null)).toBe(true);
    expect(await listServiceTokens(fx.sql, fx.tenantB)).toEqual([]);
  });
});
