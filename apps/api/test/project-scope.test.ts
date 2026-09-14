import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import {
  bearer,
  idempotencyKey,
  newAccount,
  setupFixture,
  signIn,
  testEnv,
  type TestAccount,
  type TestFixture,
} from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Project scope and read authorization — 02 §2.1.
 *
 * Of the decision formula's 7 conditions, `project_scope_matches` and the role check are
 * evaluated only if the route passes the facts. If it does not, the decision code never runs
 * even though it exists, so **these tests cross the boundary with real requests.**
 *
 * Two things are tested.
 *
 * 1. A project-level binding does not work outside that project.
 * 2. A session without a role cannot read the workspace even inside the tenant —
 *    the RLS tenant boundary does not substitute for authorization.
 */
describeDb("project scope and read authorization", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let tokens: {
    scopedSteward: string;
    steward: string;
    reader: string;
    operator: string;
    sponsor: string;
  };
  /** Another company in the same tenant and a project it owns. */
  let foreign: { organizationId: string; projectId: string };

  /**
   * Creates a second organization inside tenant A.
   *
   * Organization isolation is a different boundary from tenant isolation. Testing with another
   * tenant lets RLS block first, so it cannot show whether the authorization code checks the
   * organization.
   */
  async function seedForeignOrganization(): Promise<{ organizationId: string; projectId: string }> {
    const organizationId = randomUUID();
    const projectId = randomUUID();
    await fx.sql`
      INSERT INTO core.organizations (id, tenant_id, legal_name, jurisdiction)
      VALUES (${organizationId}, ${fx.tenantA}, 'Org C (other company)', 'MNG')
    `;
    await fx.sql`
      INSERT INTO core.projects (
        id, tenant_id, project_key, name, host_country_iso3, minerals, owner_organization_id
      ) VALUES (
        ${projectId}, ${fx.tenantA}, ${`FOREIGN-${projectId.slice(0, 8)}`}, 'Other Company Project',
        'MNG', ARRAY['copper'], ${organizationId}
      )
    `;
    await fx.sql`
      INSERT INTO core.evidence_stale_signals (
        id, tenant_id, project_id, target_type, target_id, reason
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, ${projectId}, 'registry_entry_version', ${randomUUID()},
        'foreign stale signal'
      )
    `;
    // A notification addressed to a role. The steward role name matches, but it belongs to
    // another company's project.
    await fx.sql`
      INSERT INTO core.notifications (tenant_id, kind, audience_role, project_id, summary, link)
      VALUES (${fx.tenantA}, 'evidence_stale', 'data_steward', ${projectId},
              'foreign notification', ${`/w/projects/${projectId}`})
    `;
    return { organizationId, projectId };
  }

  /** Organization-level project_sponsor_operator of orgA. A project-party role that can create projects. */
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
    // A pending role grant proposal. It must not appear in the work list of a steward without
    // decision authority (admin.role.approve).
    await fx.sql`
      INSERT INTO core.role_grant_requests (
        id, tenant_id, subject_id, organization_id, role, reason, requested_by_subject_id
      )
      SELECT ${randomUUID()}, ${fx.tenantA}, ${subject}, ${fx.orgA}, 'data_steward',
             'scope test', w.subject_id
      FROM core.wallet_identities w
      WHERE w.wallet_address = ${fx.operatorA.address}
    `;
    return account;
  }

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    foreign = await seedForeignOrganization();

    tokens = {
      scopedSteward: await signIn(app, fx.scopedStewardA),
      steward: await signIn(app, fx.stewardA),
      reader: await signIn(app, fx.readerA),
      operator: await signIn(app, fx.operatorA),
      sponsor: await signIn(app, await seedSponsor()),
    };
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function claimBody() {
    return {
      claimType: "resource_estimate",
      valueText: "1200.5",
      unit: "kt",
      sourceCoordinate: { page: "12" },
    };
  }

  function createClaim(token: string, projectId: string) {
    return app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/claims`,
      headers: { ...bearer(token), "idempotency-key": idempotencyKey() },
      payload: claimBody(),
    });
  }

  describe("writes", () => {
    it("lets a project-level binding work in its own project", async () => {
      const response = await createClaim(tokens.scopedSteward, fx.projectA);
      expect(response.statusCode).toBe(200);
    });

    it("rejects a project-level binding in another project", async () => {
      const response = await createClaim(tokens.scopedSteward, fx.otherProjectA);

      expect(response.statusCode).toBe(403);
      const body = response.json() as { code: string; details?: { reason?: string } };
      expect(body.code).toBe("AUTHORIZATION_DENIED");
      expect(body.details?.reason).toBe("PROJECT_SCOPE_MISMATCH");
    });

    it("lets an organization-level binding reach other projects of the same organization", async () => {
      const response = await createClaim(tokens.steward, fx.otherProjectA);
      expect(response.statusCode).toBe(200);
    });

    it("does not let an organization-level binding reach another organization's project in the same tenant", async () => {
      const response = await createClaim(tokens.steward, foreign.projectId);

      expect(response.statusCode).toBe(403);
      expect((response.json() as { details?: { reason?: string } }).details?.reason).toBe(
        "PROJECT_SCOPE_MISMATCH",
      );
    });

    it("lets tenant operator roles reach another organization's project", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${foreign.projectId}`,
        headers: bearer(tokens.operator),
      });
      expect(response.statusCode).toBe(200);
    });
  });

  describe("owner organization on project creation", () => {
    function createProject(token: string, ownerOrganizationId: string) {
      return app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: { ...bearer(token), "idempotency-key": idempotencyKey() },
        payload: {
          projectKey: `OWN-${randomUUID().slice(0, 8)}`,
          name: "Owner organization test",
          hostCountryIso3: "MNG",
          minerals: ["copper"],
          ownerOrganizationId,
        },
      });
    }

    it("lets a project party create projects owned only by its own organization", async () => {
      const own = await createProject(tokens.sponsor, fx.orgA);
      expect(own.statusCode).toBe(200);

      const other = await createProject(tokens.sponsor, foreign.organizationId);
      expect(other.statusCode).toBe(403);
      expect(other.json().code).toBe("OWNER_ORGANIZATION_NOT_ALLOWED");
    });

    it("lets a tenant operator register a project owned by another organization — onboarding", async () => {
      const response = await createProject(tokens.operator, foreign.organizationId);
      expect(response.statusCode).toBe(200);
    });
  });

  describe("reads", () => {
    it("does not let a session without a role read the project list", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/projects",
        headers: bearer(tokens.reader),
      });

      expect(response.statusCode).toBe(403);
      expect((response.json() as { details?: { reason?: string } }).details?.reason).toBe(
        "ROLE_ACTION_NOT_ALLOWED",
      );
    });

    it("does not let a session without a role read evidence", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${fx.projectA}/claims`,
        headers: bearer(tokens.reader),
      });

      expect(response.statusCode).toBe(403);
    });

    it("does not let a project-level binding read evidence of an out-of-scope project", async () => {
      const inScope = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${fx.projectA}/claims`,
        headers: bearer(tokens.scopedSteward),
      });
      expect(inScope.statusCode).toBe(200);

      const outOfScope = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${fx.otherProjectA}/claims`,
        headers: bearer(tokens.scopedSteward),
      });
      expect(outOfScope.statusCode).toBe(403);
    });

    it("does not let a session without a role read anchor batch status", async () => {
      // Published roots are public, but submission history and failure states are operational
      // data. Public lookup is handled separately by `/api/v1/public/*`.
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/anchor-batches",
        headers: bearer(tokens.reader),
      });

      expect(response.statusCode).toBe(403);
    });

    it("excludes out-of-scope project proposals from the governance list", async () => {
      /**
       * Writes scope by the proposal's project; if the list returned the whole tenant, titles,
       * evidence and tallies would still leak even though they cannot be acted on.
       */
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/governance/proposals",
        headers: bearer(tokens.scopedSteward),
      });

      expect(response.statusCode).toBe(200);
      const items = (response.json() as { items: { projectId: string | null }[] }).items;
      expect(items.every((item) => item.projectId !== fx.otherProjectA)).toBe(true);
    });

    it("excludes another organization's projects from the project list", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/projects",
        headers: bearer(tokens.steward),
      });

      expect(response.statusCode).toBe(200);
      const ids = (response.json() as { items: { id: string }[] }).items.map((item) => item.id);
      expect(ids).toContain(fx.projectA);
      expect(ids).not.toContain(foreign.projectId);
    });

    it("excludes records of another organization's projects from the registry list", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/registry-entries",
        headers: bearer(tokens.steward),
      });

      expect(response.statusCode).toBe(200);
      const items = (response.json() as { items: { projectId: string | null }[] }).items;
      expect(items.every((item) => item.projectId === fx.projectA || item.projectId === fx.otherProjectA)).toBe(true);
    });

    it("excludes other organizations' stale signals and undecidable role grant proposals from the work list", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/my-work",
        headers: bearer(tokens.steward),
      });

      expect(response.statusCode).toBe(200);
      const unassigned = (
        response.json() as { unassigned: { kind: string; projectId: string | null }[] }
      ).unassigned;
      expect(unassigned.some((item) => item.projectId === foreign.projectId)).toBe(false);
      expect(unassigned.some((item) => item.kind === "role_grant_decision")).toBe(false);
    });

    it("excludes another organization's projects from role-addressed notifications", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/notifications",
        headers: bearer(tokens.steward),
      });

      expect(response.statusCode).toBe(200);
      const items = (response.json() as { items: { projectId: string | null }[] }).items;
      expect(items.some((item) => item.projectId === foreign.projectId)).toBe(false);
    });

    it("excludes out-of-scope projects from the project list", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/projects",
        headers: bearer(tokens.scopedSteward),
      });

      expect(response.statusCode).toBe(200);
      const ids = (response.json() as { items: { id: string }[] }).items.map((item) => item.id);
      expect(ids).toContain(fx.projectA);
      expect(ids).not.toContain(fx.otherProjectA);
    });
  });
});
