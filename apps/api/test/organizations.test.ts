import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import {
  bearer,
  newAccount,
  setupFixture,
  signIn,
  testEnv,
  type TestAccount,
  type TestFixture,
} from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Organization lookup for project registration — Q-032.
 *
 * The registration form used to find the owner organization in a table of demo tenant ids, so
 * on any other tenant it showed "No organization" and could not submit. The list must follow
 * the same rule `project.create` enforces (`OWNER_ORGANIZATION_NOT_ALLOWED`): a party role picks
 * only its own organization; a tenant operations role picks any organization in the tenant.
 * A list wider than that rule offers choices the server then refuses.
 */
describeDb("organization lookup", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let foreignOrganization: string;
  let tokens: { operatorA: string; operatorB: string; sponsor: string; steward: string; reader: string };

  async function seedSponsor(): Promise<TestAccount> {
    const account = newAccount();
    const subject = randomUUID();
    await fx.sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name)
      VALUES (${subject}, ${fx.tenantA}, 'person', 'Sponsor A')
    `;
    await fx.sql`
      INSERT INTO core.wallet_identities (
        id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, ${subject}, ${account.address}, 97, 'identity_bound', now()
      )
    `;
    await fx.sql`
      INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
      VALUES (${randomUUID()}, ${fx.tenantA}, ${subject}, ${fx.orgA}, 'project_sponsor_operator')
    `;
    return account;
  }

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);

    // A second company in tenant A. Organization isolation is a different boundary from tenant
    // isolation — RLS would hide another tenant's rows before the authorization code ran.
    foreignOrganization = randomUUID();
    await fx.sql`
      INSERT INTO core.organizations (id, tenant_id, legal_name, jurisdiction)
      VALUES (${foreignOrganization}, ${fx.tenantA}, 'Org C (other company)', 'MNG')
    `;

    tokens = {
      operatorA: await signIn(app, fx.operatorA),
      operatorB: await signIn(app, fx.operatorB),
      sponsor: await signIn(app, await seedSponsor()),
      steward: await signIn(app, fx.stewardA),
      reader: await signIn(app, fx.readerA),
    };
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  async function list(token: string) {
    return app.inject({ method: "GET", url: "/api/v1/organizations", headers: bearer(token) });
  }

  function ids(response: Awaited<ReturnType<typeof list>>): string[] {
    return (response.json() as { items: { id: string }[] }).items.map((item) => item.id);
  }

  it("a project party sees only its own organization", async () => {
    const response = await list(tokens.sponsor);

    expect(response.statusCode).toBe(200);
    expect(ids(response)).toEqual([fx.orgA]);
    const [item] = (response.json() as { items: { legalName: string; jurisdiction: string }[] }).items;
    expect(item!.legalName).toBe("Org Operator A");
    expect(item!.jurisdiction).toBe("MNG");
  });

  it("a tenant operator sees every organization in its tenant — onboarding", async () => {
    const response = await list(tokens.operatorA);

    expect(response.statusCode).toBe(200);
    expect(ids(response)).toEqual(expect.arrayContaining([fx.orgA, foreignOrganization]));
  });

  it("never returns another tenant's organizations", async () => {
    expect(ids(await list(tokens.operatorA))).not.toContain(fx.orgB);

    const other = ids(await list(tokens.operatorB));
    expect(other).toContain(fx.orgB);
    expect(other).not.toContain(fx.orgA);
    expect(other).not.toContain(foreignOrganization);
  });

  it("every organization listed is one project creation accepts", async () => {
    // The list and the create rule must agree — a listed organization the server refuses
    // is a dead end on screen.
    for (const organizationId of ids(await list(tokens.sponsor))) {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: { ...bearer(tokens.sponsor), "idempotency-key": randomUUID().replace(/-/g, "") },
        payload: {
          projectKey: `ORG-${randomUUID().slice(0, 8)}`,
          name: "Organization lookup check",
          hostCountryIso3: "MNG",
          minerals: ["copper"],
          ownerOrganizationId: organizationId,
        },
      });
      expect(created.statusCode).toBe(200);
    }
  });

  it("refuses a session without a project creation role, with the required roles", async () => {
    for (const token of [tokens.steward, tokens.reader]) {
      const response = await list(token);
      expect(response.statusCode).toBe(403);
      expect(response.json().details.reason).toBe("ROLE_ACTION_NOT_ALLOWED");
      expect(response.json().details.requiredRoles).toContain("mpc_operator");
    }
  });
});
