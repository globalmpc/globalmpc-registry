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
 * Project Registry content — 04 §4.2, 05 §5.6/§5.10, 07 §7.2, 11 §11.3/§11.5, 12 §12.7.
 *
 * The rule under test throughout: **nothing becomes confirmed without evidence that exists in the
 * same project and can carry that status**, and every change leaves a version naming who made it.
 */
describeDb("project registry content", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let operator: string;
  let steward: string;
  let scopedSteward: string;
  let sponsor: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    operator = await signIn(app, fx.operatorA);
    steward = await signIn(app, fx.stewardA);
    scopedSteward = await signIn(app, fx.scopedStewardA);

    // The sponsor submits relationship and consent material (02 §2.2). Not in the shared fixture.
    const account = newAccount();
    const subject = randomUUID();
    await fx.sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name)
      VALUES (${subject}, ${fx.tenantA}, 'person', 'Sponsor A')
    `;
    await fx.sql`
      INSERT INTO core.wallet_identities (
        id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at
      ) VALUES (${randomUUID()}, ${fx.tenantA}, ${subject}, ${account.address}, 31337, 'high_assurance', now())
    `;
    await fx.sql`
      INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
      VALUES (${randomUUID()}, ${fx.tenantA}, ${subject}, ${fx.orgA}, 'project_sponsor_operator')
    `;
    sponsor = await signIn(app, account);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function call(
    method: "GET" | "POST" | "PATCH",
    url: string,
    token: string,
    payload?: unknown,
    ifMatch?: number,
  ) {
    return app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(method === "GET" ? {} : { "idempotency-key": idempotencyKey() }),
        ...(ifMatch === undefined ? {} : { "if-match": `"${ifMatch}"` }),
      },
      ...(payload === undefined ? {} : { payload: payload as never }),
    });
  }

  async function newProject(extra: Record<string, unknown> = {}): Promise<string> {
    const created = await call("POST", "/api/v1/projects", operator, {
      projectKey: `PR-${randomUUID().slice(0, 8)}`,
      name: "Synthetic registry check",
      hostCountryIso3: "MNG",
      minerals: ["copper"],
      ownerOrganizationId: fx.orgA,
      ...extra,
    });
    expect(created.statusCode).toBe(200);
    return created.json().id;
  }

  async function receipt(projectId: string, result: string): Promise<string> {
    const id = randomUUID();
    await fx.sql`
      INSERT INTO core.source_receipts (
        id, tenant_id, project_id, connection_id, authority_id, collection_method,
        result, query_basis, endpoint_or_document_ref, authentication_method,
        raw_hash, source_schema_version, adapter_version, terms_license,
        commercial_reuse, disclosure_permission, received_at, as_of,
        freshness_status, correlation_id, first_confirmed_by, second_confirmed_by
      ) VALUES (
        ${id}, ${fx.tenantA}, ${projectId}, ${fx.connectionA}, ${fx.authorityA},
        -- A manual official-registry confirmation by two different people: the one channel on
        -- which the database accepts a confirmed result without a server-side collection.
        'manual_official_registry_confirmation', ${result}, '{}'::jsonb, 'synthetic', 'none',
        ${`0x${"ab".repeat(32)}`}, '1', '1', 'synthetic', 'unconfirmed', 'restricted',
        now(), now(), 'fresh', 'test', ${fx.reviewerSubjectA}, ${fx.operatorSubjectA}
      )
    `;
    return id;
  }

  async function claim(projectId: string): Promise<string> {
    const id = randomUUID();
    await fx.sql`
      INSERT INTO core.claims (id, tenant_id, project_id, claim_type, value_text, unit, source_coordinate)
      VALUES (${id}, ${fx.tenantA}, ${projectId}, 'synthetic_tonnage', '12.5', 'Mt',
              ${fx.sql.json({ document: "synthetic-report", page: "4" })})
    `;
    return id;
  }

  describe("reference label (05 §5.10)", () => {
    it("labels a synthetic test project at creation", async () => {
      const id = await newProject({ referenceStatus: "synthetic_test_project" });
      const project = await call("GET", `/api/v1/projects/${id}`, operator);
      expect(project.json().referenceStatus).toBe("synthetic_test_project");
    });

    it("does not let creation claim official_reference", async () => {
      const response = await call("POST", "/api/v1/projects", operator, {
        projectKey: `PR-${randomUUID().slice(0, 8)}`,
        name: "x",
        hostCountryIso3: "MNG",
        minerals: [],
        ownerOrganizationId: fx.orgA,
        referenceStatus: "official_reference",
      });
      expect(response.statusCode).toBe(400);
    });

    it("keeps a synthetic label fixed in the database", async () => {
      const id = await newProject({ referenceStatus: "synthetic_test_project" });
      await expect(
        fx.sql`UPDATE core.projects SET reference_status = 'official_reference' WHERE id = ${id}`,
      ).rejects.toThrow(/fixed at creation/);
    });
  });

  describe("PATCH /projects/{id}", () => {
    it("requires If-Match", async () => {
      const id = await newProject();
      const response = await call("PATCH", `/api/v1/projects/${id}`, operator, {
        name: "Renamed",
        reason: "typo",
      });
      expect(response.statusCode).toBe(428);
    });

    it("changes the name, bumps the version and records who and why", async () => {
      const id = await newProject();
      const response = await call(
        "PATCH",
        `/api/v1/projects/${id}`,
        operator,
        { name: "Renamed synthetic", reason: "name correction" },
        1,
      );
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ name: "Renamed synthetic", version: 2 });
      const [audit] = await fx.sql<{ reason: string; before_version: number }[]>`
        SELECT reason, before_version FROM audit.events
        WHERE resource_id = ${id} AND command = 'project.updated'
      `;
      expect(audit).toMatchObject({ reason: "name correction", before_version: 1 });
    });

    it("refuses a stale version", async () => {
      const id = await newProject();
      const response = await call(
        "PATCH",
        `/api/v1/projects/${id}`,
        operator,
        { name: "x", reason: "r" },
        7,
      );
      expect(response.statusCode).toBe(412);
    });

    it("is not open to a data steward", async () => {
      const id = await newProject();
      const response = await call(
        "PATCH",
        `/api/v1/projects/${id}`,
        steward,
        { name: "x", reason: "r" },
        1,
      );
      expect(response.statusCode).toBe(403);
    });
  });

  describe("project list (11 §11.3)", () => {
    it("returns the list columns — owner, relationship, registry state, readiness not assessed", async () => {
      const id = await newProject();
      const list = await call("GET", "/api/v1/projects", operator);
      const item = list.json().items.find((row: { id: string }) => row.id === id);
      expect(item).toMatchObject({
        ownerOrganizationId: fx.orgA,
        relationshipStatus: "pending",
        projectRegistryStatus: "none",
        readinessSummary: null,
        openStaleSignals: 0,
      });
      expect(item.ownerOrganizationName).toEqual(expect.any(String));
    });

    it("filters by reference label", async () => {
      const synthetic = await newProject({ referenceStatus: "synthetic_test_project" });
      const plain = await newProject();
      const list = await call("GET", "/api/v1/projects?referenceStatus=synthetic_test_project", operator);
      const ids = list.json().items.map((row: { id: string }) => row.id);
      expect(ids).toContain(synthetic);
      expect(ids).not.toContain(plain);
    });

    it("refuses an unknown filter instead of ignoring it", async () => {
      const list = await call("GET", "/api/v1/projects?owner=anyone", operator);
      expect(list.statusCode).toBe(400);
    });
  });

  describe("confirmed/pending matrix (04 §4.2, 11 §11.5)", () => {
    it("lists every row as pending and unrecorded before anything is recorded", async () => {
      const id = await newProject();
      const facts = await call("GET", `/api/v1/projects/${id}/facts`, operator);
      expect(facts.json().items).toHaveLength(7);
      expect(
        facts.json().items.every((row: { status: string; recorded: boolean }) =>
          row.status === "pending" && !row.recorded,
        ),
      ).toBe(true);
    });

    it("shows a fact written before version history with the status the offering gate counts", async () => {
      const id = await newProject();
      const factKey = (await call("GET", `/api/v1/projects/${id}/facts`, operator)).json().items[0]
        .factKey as string;
      await fx.sql`
        INSERT INTO core.project_facts (
          id, tenant_id, project_id, fact_key, status, evidence_ref, evidence_kind
        ) VALUES (
          ${randomUUID()}, ${fx.tenantA}, ${id}, ${factKey}, 'confirmed', ${randomUUID()}, 'upload'
        )
      `;

      const row = (await call("GET", `/api/v1/projects/${id}/facts`, operator))
        .json()
        .items.find((item: { factKey: string }) => item.factKey === factKey);
      expect(row).toMatchObject({ status: "confirmed", recorded: false });
    });

    it("refuses confirmed without evidence", async () => {
      const id = await newProject();
      const response = await call(
        "POST",
        `/api/v1/projects/${id}/facts/rights/confirmations`,
        steward,
        { status: "confirmed", reason: "looks fine" },
        0,
      );
      expect(response.statusCode).toBe(400);
    });

    it("refuses evidence that is not in this project", async () => {
      const id = await newProject();
      const elsewhere = await receipt(fx.otherProjectA, "confirmed_from_source");
      const response = await call(
        "POST",
        `/api/v1/projects/${id}/facts/rights/confirmations`,
        steward,
        { status: "confirmed", evidence: { kind: "source_receipt", id: elsewhere }, reason: "r" },
        0,
      );
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("EVIDENCE_NOT_IN_PROJECT");
    });

    it("refuses a source result that does not permit acceptance as confirmation", async () => {
      const id = await newProject();
      const noRecord = await receipt(id, "source_returned_no_record");
      const response = await call(
        "POST",
        `/api/v1/projects/${id}/facts/rights/confirmations`,
        steward,
        { status: "confirmed", evidence: { kind: "source_receipt", id: noRecord }, reason: "r" },
        0,
      );
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("EVIDENCE_NOT_USABLE");
    });

    it("records a confirmation as a version with evidence, reason and recorder", async () => {
      const id = await newProject();
      const evidence = await receipt(id, "confirmed_from_source");
      const response = await call(
        "POST",
        `/api/v1/projects/${id}/facts/rights/confirmations`,
        steward,
        {
          status: "confirmed",
          evidence: { kind: "source_receipt", id: evidence },
          asOf: "2026-08-01",
          reason: "registry lookup matched",
        },
        0,
      );
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        factKey: "rights",
        status: "confirmed",
        recorded: true,
        version: 1,
        asOf: "2026-08-01",
        evidence: { kind: "source_receipt", id: evidence },
      });
      expect(response.json().history[0].reason).toBe("registry lookup matched");
    });

    it("keeps the earlier version when a row changes", async () => {
      const id = await newProject();
      await call(
        "POST",
        `/api/v1/projects/${id}/facts/consent/confirmations`,
        steward,
        { status: "pending", reason: "requested" },
        0,
      );
      const second = await call(
        "POST",
        `/api/v1/projects/${id}/facts/consent/confirmations`,
        steward,
        { status: "not_applicable", reason: "no consent required under the synthetic scenario" },
        1,
      );
      expect(second.json().version).toBe(2);
      expect(second.json().history.map((row: { status: string }) => row.status)).toEqual([
        "not_applicable",
        "pending",
      ]);
    });

    it("refuses a stale row version", async () => {
      const id = await newProject();
      await call(
        "POST",
        `/api/v1/projects/${id}/facts/spv/confirmations`,
        steward,
        { status: "pending", reason: "first" },
        0,
      );
      const stale = await call(
        "POST",
        `/api/v1/projects/${id}/facts/spv/confirmations`,
        steward,
        { status: "pending", reason: "second" },
        0,
      );
      expect(stale.statusCode).toBe(412);
    });

    it("is not open to the operator — curation belongs to the steward", async () => {
      const id = await newProject();
      const response = await call(
        "POST",
        `/api/v1/projects/${id}/facts/rights/confirmations`,
        operator,
        { status: "pending", reason: "r" },
        0,
      );
      expect(response.statusCode).toBe(403);
    });

    it("the database refuses a confirmed version without evidence and any rewrite", async () => {
      const id = await newProject();
      await expect(
        fx.sql`
          INSERT INTO core.project_fact_versions (
            id, tenant_id, project_id, fact_key, version, status, reason, recorded_by_subject_id
          ) VALUES (${randomUUID()}, ${fx.tenantA}, ${id}, 'rights', 1, 'confirmed', 'r', ${fx.operatorSubjectA})
        `,
      ).rejects.toThrow(/confirmed_requires_evidence/);

      await call(
        "POST",
        `/api/v1/projects/${id}/facts/issuer/confirmations`,
        steward,
        { status: "pending", reason: "r" },
        0,
      );
      await expect(
        fx.sql`UPDATE core.project_fact_versions SET status = 'rejected' WHERE project_id = ${id}`,
      ).rejects.toThrow(/append-only/);
    });
  });

  describe("parties (04 §4.2, 07 §7.2)", () => {
    it("a submitted party starts pending", async () => {
      const id = await newProject();
      const response = await call("POST", `/api/v1/projects/${id}/parties`, sponsor, {
        partyRole: "sponsor_operator",
        legalName: "Synthetic Sponsor LLC",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: "pending", version: 1, history: [] });
    });

    it("a party role cannot confirm a party; the steward can with evidence", async () => {
      const id = await newProject();
      const party = (
        await call("POST", `/api/v1/projects/${id}/parties`, sponsor, {
          partyRole: "host_country_spv",
          legalName: "Synthetic SPV LLC",
        })
      ).json();
      const evidence = await receipt(id, "confirmed_from_source");
      const body = {
        status: "confirmed",
        evidence: { kind: "source_receipt", id: evidence },
        reason: "company registry lookup",
      };

      const bySponsor = await call(
        "POST",
        `/api/v1/projects/${id}/parties/${party.id}/confirmations`,
        sponsor,
        body,
        1,
      );
      expect(bySponsor.statusCode).toBe(403);

      const bySteward = await call(
        "POST",
        `/api/v1/projects/${id}/parties/${party.id}/confirmations`,
        steward,
        body,
        1,
      );
      expect(bySteward.statusCode).toBe(200);
      expect(bySteward.json()).toMatchObject({ status: "confirmed", version: 2 });
      expect(bySteward.json().history).toHaveLength(1);
    });
  });

  describe("registration requests (07 §7.2)", () => {
    it("a sponsor asks; the request is not an answer until the registry publishes", async () => {
      const id = await newProject();
      const response = await call("POST", `/api/v1/projects/${id}/registration-requests`, sponsor, {
        note: "Please start the Project Registry workflow",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().answeredByPublication).toBe(false);
    });

    it("is not open to a steward", async () => {
      const id = await newProject();
      const response = await call("POST", `/api/v1/projects/${id}/registration-requests`, steward, {
        note: "x",
      });
      expect(response.statusCode).toBe(403);
    });
  });

  describe("stakeholder/obligation history (12 §12.7)", () => {
    it("a sponsor records a pending event but cannot record it as confirmed", async () => {
      const id = await newProject();
      const evidence = await receipt(id, "confirmed_from_source");
      const pending = await call("POST", `/api/v1/projects/${id}/stakeholder-events`, sponsor, {
        category: "consent",
        summary: "Synthetic consultation held",
        occurredOn: "2026-08-10",
        status: "pending",
      });
      expect(pending.statusCode).toBe(200);

      const confirmed = await call("POST", `/api/v1/projects/${id}/stakeholder-events`, sponsor, {
        category: "consent",
        summary: "Synthetic consultation held",
        occurredOn: "2026-08-10",
        status: "confirmed",
        evidence: { kind: "source_receipt", id: evidence },
      });
      expect(confirmed.statusCode).toBe(403);
    });

    it("two corrections of the same event at once: one lands, the other is told why", async () => {
      const id = await newProject();
      const first = (
        await call("POST", `/api/v1/projects/${id}/stakeholder-events`, steward, {
          category: "obligation",
          summary: "Synthetic obligation recorded",
          occurredOn: "2026-08-11",
          status: "pending",
        })
      ).json();
      const correct = (summary: string) =>
        call("POST", `/api/v1/projects/${id}/stakeholder-events`, steward, {
          category: "obligation",
          summary,
          occurredOn: "2026-08-12",
          status: "pending",
          supersedesId: first.id,
        });

      const results = await Promise.all([correct("Correction A"), correct("Correction B")]);
      expect(results.map((response) => response.statusCode).sort()).toEqual([200, 422]);
      const refused = results.find((response) => response.statusCode === 422)!;
      expect(refused.json().code).toBe("EVENT_ALREADY_SUPERSEDED");
    });

    it("a correction supersedes once and keeps the original", async () => {
      const id = await newProject();
      const first = (
        await call("POST", `/api/v1/projects/${id}/stakeholder-events`, steward, {
          category: "obligation",
          summary: "Synthetic obligation recorded",
          occurredOn: "2026-08-11",
          status: "pending",
        })
      ).json();
      const correction = await call("POST", `/api/v1/projects/${id}/stakeholder-events`, steward, {
        category: "obligation",
        summary: "Synthetic obligation recorded (date corrected)",
        occurredOn: "2026-08-12",
        status: "pending",
        supersedesId: first.id,
      });
      expect(correction.statusCode).toBe(200);

      const again = await call("POST", `/api/v1/projects/${id}/stakeholder-events`, steward, {
        category: "obligation",
        summary: "Another correction of the old version",
        occurredOn: "2026-08-12",
        status: "pending",
        supersedesId: first.id,
      });
      expect(again.statusCode).toBe(422);

      const list = await call("GET", `/api/v1/projects/${id}/stakeholder-events`, operator);
      const original = list.json().items.find((row: { id: string }) => row.id === first.id);
      expect(original.supersededById).toBe(correction.json().id);
    });
  });

  describe("overview (11 §11.3)", () => {
    it("lists three registries, separates readiness from decisions and states what is unconfirmed", async () => {
      const id = await newProject();
      await call(
        "POST",
        `/api/v1/projects/${id}/facts/relationship/confirmations`,
        steward,
        { status: "pending", reason: "agreement in negotiation" },
        0,
      );
      const overview = await call("GET", `/api/v1/projects/${id}/overview`, operator);
      expect(overview.statusCode).toBe(200);
      const body = overview.json();
      expect(body.registries.map((row: { registryType: string; status: string }) => [row.registryType, row.status])).toEqual([
        ["project", "none"],
        ["verification", "none"],
        ["asset", "none"],
      ]);
      expect(body.readiness).toEqual([]);
      expect(body.decisions).toEqual([]);
      expect(body.limitations.join(" ")).toMatch(/No readiness assessment has run/);
      expect(body.limitations.join(" ")).toMatch(/Not confirmed: relationship/);
      expect(body.activity.map((row: { command: string }) => row.command)).toContain(
        "project.fact.recorded",
      );
      // The activity summary carries no wallet or IP.
      expect(JSON.stringify(body.activity)).not.toMatch(/0x[0-9a-f]{40}/);
    });

    it("is outside a project-scoped steward's other projects", async () => {
      const overview = await call("GET", `/api/v1/projects/${fx.otherProjectA}/overview`, scopedSteward);
      expect(overview.statusCode).toBe(403);
    });
  });

  describe("claim detail (11 §11.3)", () => {
    it("returns the source coordinate and empty sections as empty, not missing", async () => {
      const id = await newProject();
      const claimId = await claim(id);
      const detail = await call("GET", `/api/v1/claims/${claimId}`, steward);
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({
        sourceCoordinate: { document: "synthetic-report", page: "4" },
        attestations: [],
        conflicts: [],
        derivation: null,
        anchors: [],
      });
    });

    it("records a derivation with formula and inputs, and links the inputs in lineage", async () => {
      const id = await newProject();
      const derived = await claim(id);
      const input = await claim(id);
      const response = await call("POST", `/api/v1/claims/${derived}/derivations`, steward, {
        formula: "input * 1.0",
        inputClaimIds: [input],
        unit: "Mt",
        asOf: "2026-08-01",
      });
      expect(response.statusCode).toBe(200);

      const detail = (await call("GET", `/api/v1/claims/${derived}`, steward)).json();
      expect(detail.derivation).toMatchObject({ formula: "input * 1.0", inputClaimIds: [input] });
      expect(detail.lineage).toContainEqual(
        expect.objectContaining({ relationType: "derived_from", fromId: derived, toId: input }),
      );

      const again = await call("POST", `/api/v1/claims/${derived}/derivations`, steward, {
        formula: "input * 2",
        inputClaimIds: [input],
      });
      expect(again.statusCode).toBe(409);
    });

    it("does not replay a stored derivation to someone without claim.curate", async () => {
      const id = await newProject();
      const derived = await claim(id);
      const input = await claim(id);
      const key = idempotencyKey();
      const send = async (token: string) =>
        app.inject({
          method: "POST",
          url: `/api/v1/claims/${derived}/derivations`,
          headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
          payload: { formula: "input * 1.0", inputClaimIds: [input] },
        });

      expect((await send(steward)).statusCode).toBe(200);
      expect((await send(await signIn(app, fx.readerA))).statusCode).toBe(403);
    });

    it("refuses inputs from another project", async () => {
      const id = await newProject();
      const derived = await claim(id);
      const foreign = await claim(fx.otherProjectA);
      const response = await call("POST", `/api/v1/claims/${derived}/derivations`, steward, {
        formula: "x",
        inputClaimIds: [foreign],
      });
      expect(response.statusCode).toBe(422);
    });

    it("is not readable outside the caller's project scope", async () => {
      const foreign = await claim(fx.otherProjectA);
      const detail = await call("GET", `/api/v1/claims/${foreign}`, scopedSteward);
      expect(detail.statusCode).toBe(403);
    });
  });
});
