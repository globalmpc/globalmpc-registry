import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { withTenant } from "@mpc/db";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { recordSourceObservation } from "../src/services/source-observations.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

describeDb("official source observations", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let token: string;
  let responseBody = { licenseId: "MN-1", status: "valid" };
  let status = 200;
  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql, {
      fetchImpl: (async () => new Response(JSON.stringify(responseBody), { status })) as typeof fetch,
      resolveHost: async () => ["203.0.113.10"],
    });
    token = await signIn(app, fx.stewardA);
  });
  afterAll(async () => { await app?.close(); await fx?.close(); });

  async function collect(queryBasis: Record<string,string>, key = idempotencyKey(), projectId = fx.projectA, connectionId = fx.connectionA) {
    const response = await app.inject({
      method: "POST", url: `/api/v1/source-connections/${connectionId}/collect`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
      payload: { projectId, queryBasis },
    });
    expect(response.statusCode).toBe(200);
    return response.json().receiptId as string;
  }
  async function claim(receiptId: string, projectId = fx.projectA) {
    const id = randomUUID();
    await fx.sql`INSERT INTO core.claims
      (id,tenant_id,project_id,claim_type,value_text,source_coordinate,evidence_tier,
       verification_state,grade,source_receipt_id)
      VALUES (${id},${fx.tenantA},${projectId},'mining_right','MN-1','{"page":"1"}',
        'P1','analyst_checked','verified',${receiptId})`;
    return id;
  }

  it("compares all old receipts, scopes changes and replays once", async () => {
    const scope = { licenseNumber: randomUUID(), jurisdiction: "MN" };
    const first = await collect(scope);
    const firstClaim = await claim(first);
    const same = await collect({ jurisdiction: "MN", licenseNumber: scope.licenseNumber });
    const sameClaim = await claim(same);
    const unrelated = await collect({ licenseNumber: randomUUID() });
    const unrelatedClaim = await claim(unrelated);
    responseBody = { licenseId: "MN-1", status: "revised" };
    const key = idempotencyKey();
    const changed = await collect(scope,key);
    expect(await collect(scope,key)).toBe(changed);
    const [observation] = await fx.sql`SELECT outcome,previous_receipt_id,affected_claim_ids FROM core.source_observations WHERE receipt_id=${changed}`;
    expect(observation?.outcome).toBe("changed");
    expect(observation?.previous_receipt_id).toBe(same);
    expect(new Set(observation?.affected_claim_ids)).toEqual(new Set([firstClaim,sameClaim]));
    const rows = await fx.sql`SELECT id,stale_since,stale_reason FROM core.claims WHERE id IN (${firstClaim},${sameClaim},${unrelatedClaim})`;
    expect(rows.find(row => row.id === unrelatedClaim)?.stale_since).toBeNull();
    for (const id of [firstClaim,sameClaim]) {
      expect(rows.find(row => row.id === id)?.stale_since).not.toBeNull();
      expect(rows.find(row => row.id === id)?.stale_reason).toContain(changed);
    }
    expect((await fx.sql`SELECT id FROM core.source_observations WHERE receipt_id=${changed}`)).toHaveLength(1);
  });

  it("accepts large query identifiers without putting their full JSON into index keys", async () => {
    const scope = {licenseNumber:randomUUID(),reference:randomBytes(9000).toString("base64")};
    const first = await collect(scope);
    const id = await claim(first);
    const unchanged = await collect({reference:scope.reference,licenseNumber:scope.licenseNumber});
    const [same] = await fx.sql`SELECT outcome FROM core.source_observations WHERE receipt_id=${unchanged}`;
    expect(same?.outcome).toBe("unchanged");
    responseBody = {licenseId:"MN-1",status:randomUUID()};
    const changed = await collect(scope);
    const [observation] = await fx.sql`SELECT outcome,affected_claim_ids FROM core.source_observations WHERE receipt_id=${changed}`;
    expect(observation?.outcome).toBe("changed");
    expect(observation?.affected_claim_ids).toEqual([id]);
  });

  it("isolates the same query across projects and connections", async () => {
    const scope = { licenseNumber: randomUUID() };
    const connection = randomUUID();
    await fx.sql`INSERT INTO core.source_connections
      SELECT (jsonb_populate_record(NULL::core.source_connections,to_jsonb(c) ||
        jsonb_build_object('id',${connection}::text,'connection_key',${connection}::text))).*
      FROM core.source_connections c WHERE id=${fx.connectionA}`;
    const baseline = await collect(scope);
    const own = await claim(baseline);
    const otherProject = await collect(scope,idempotencyKey(),fx.otherProjectA);
    const otherProjectClaim = await claim(otherProject,fx.otherProjectA);
    const otherConnection = await collect(scope,idempotencyKey(),fx.projectA,connection);
    const otherConnectionClaim = await claim(otherConnection);
    responseBody = { licenseId: "MN-1", status: randomUUID() };
    await collect(scope);
    const rows = await fx.sql`SELECT id,stale_since FROM core.claims
      WHERE id IN (${own},${otherProjectClaim},${otherConnectionClaim})`;
    expect(rows.find(row => row.id === own)?.stale_since).not.toBeNull();
    expect(rows.find(row => row.id === otherProjectClaim)?.stale_since).toBeNull();
    expect(rows.find(row => row.id === otherConnectionClaim)?.stale_since).toBeNull();
  });

  it("serializes concurrent collections without duplicate baseline or review", async () => {
    const scope = { licenseNumber: randomUUID() };
    const first = await collect(scope);
    const id = await claim(first);
    responseBody = { licenseId: "MN-1", status: randomUUID() };
    const receipts = await Promise.all([collect(scope),collect(scope)]);
    const rows = await fx.sql`SELECT outcome,affected_claim_ids FROM core.source_observations
      WHERE receipt_id IN (${receipts[0]!},${receipts[1]!})`;
    expect(rows.filter(row => row.outcome === "changed")).toHaveLength(1);
    expect(rows.filter(row => row.outcome === "unchanged" || row.outcome === "out_of_order")).toHaveLength(1);
    expect(rows.flatMap(row => row.affected_claim_ids)).toEqual([id]);
  });

  it("signals scoped no-record for review without replacing baseline or revoking", async () => {
    const scope = { licenseNumber: randomUUID() };
    const first = await collect(scope);
    const id = await claim(first);
    status = 404;
    const absent = await collect(scope);
    status = 200;
    const [observation] = await fx.sql`SELECT outcome,previous_receipt_id,affected_claim_ids
      FROM core.source_observations WHERE receipt_id=${absent}`;
    expect(observation?.outcome).toBe("no_record");
    expect(observation?.previous_receipt_id).toBe(first);
    expect(observation?.affected_claim_ids).toEqual([id]);
    const [row] = await fx.sql`SELECT stale_since,stale_reason,verification_state FROM core.claims WHERE id=${id}`;
    expect(row?.stale_since).not.toBeNull();
    expect(row?.stale_reason).toContain("no record");
    expect(row?.verification_state).toBe("analyst_checked");
    const recovered = await collect(scope);
    const [recovery] = await fx.sql`SELECT outcome,previous_receipt_id FROM core.source_observations WHERE receipt_id=${recovered}`;
    expect(recovery?.outcome).toBe("unchanged");
    expect(recovery?.previous_receipt_id).toBe(first);
  });

  it("detects changes to receipts created before observation tracking existed", async () => {
    const seed = await collect({ licenseNumber: randomUUID() });
    const historical = randomUUID();
    const scope = { licenseNumber: randomUUID() };
    await fx.sql`WITH cloned_receipts AS (
      SELECT (jsonb_populate_record(NULL::core.source_receipts,to_jsonb(r) ||
        jsonb_build_object('id',${historical}::text,'query_basis',${fx.sql.json(scope)}::jsonb,
          'received_at','2025-01-01T00:00:00Z'))).*
      FROM core.source_receipts r WHERE id=${seed}
      )
      INSERT INTO core.source_receipts (
        id, tenant_id, project_id, connection_id,
        authority_id, collection_method, result, query_basis,
        endpoint_or_document_ref, authentication_method, raw_hash, raw_object_key,
        source_schema_version, adapter_version, normalization_version, terms_license,
        commercial_reuse, disclosure_permission, received_at, as_of,
        effective_at, freshness_status, correlation_id, limitations,
        created_at, channel_evidence, first_confirmed_by, second_confirmed_by,
        second_confirmed_at, supersedes_receipt_id, processing_state
      )
      SELECT
        id, tenant_id, project_id, connection_id,
        authority_id, collection_method, result, query_basis,
        endpoint_or_document_ref, authentication_method, raw_hash, raw_object_key,
        source_schema_version, adapter_version, normalization_version, terms_license,
        commercial_reuse, disclosure_permission, received_at, as_of,
        effective_at, freshness_status, correlation_id, limitations,
        created_at, channel_evidence, first_confirmed_by, second_confirmed_by,
        second_confirmed_at, supersedes_receipt_id, processing_state
      FROM cloned_receipts`;
    const id = await claim(historical);
    responseBody = { licenseId: "MN-1", status: randomUUID() };
    const current = await collect(scope);
    const [observation] = await fx.sql`SELECT outcome,previous_receipt_id,affected_claim_ids
      FROM core.source_observations WHERE receipt_id=${current}`;
    expect(observation?.outcome).toBe("changed");
    expect(observation?.previous_receipt_id).toBe(historical);
    expect(observation?.affected_claim_ids).toEqual([id]);
  });

  it("rejects mutation and hides observations from another tenant", async () => {
    const receipt = await collect({ licenseNumber: randomUUID() });
    await expect(fx.sql`UPDATE core.source_observations SET outcome='changed' WHERE receipt_id=${receipt}`).rejects.toThrow("append-only");
    await expect(fx.sql`DELETE FROM core.source_observations WHERE receipt_id=${receipt}`).rejects.toThrow("append-only");
    await expect(fx.sql`TRUNCATE core.source_observations`).rejects.toThrow("append-only");
    await expect(fx.sql`INSERT INTO core.source_observations
      (tenant_id,project_id,connection_id,receipt_id,query_basis,observed_at,outcome)
      SELECT tenant_id,${fx.otherProjectA},connection_id,receipt_id,query_basis,observed_at,'baseline'
      FROM core.source_observations WHERE receipt_id=${receipt}`)
      .rejects.toThrow("Observation must match its server-collected receipt scope");
    const rows = await withTenant(fx.appSql,{ tenantId: fx.tenantB },tx => tx`SELECT id FROM core.source_observations WHERE receipt_id=${receipt}`);
    expect(rows).toHaveLength(0);
  });

  it("includes direct observation inserts in the project publication barrier", async () => {
    const receipt = await collect({licenseNumber:randomUUID()});
    await withTenant(fx.appSql,{tenantId:fx.tenantA},async publication => {
      await publication`SELECT core.lock_ledger_publication_inputs(${fx.projectA}::uuid)`;
      await expect(withTenant(fx.appSql,{tenantId:fx.tenantA},async writer => {
        await writer`SET LOCAL lock_timeout = '100ms'`;
        // The lock must reject this before later duplicate-receipt checks run. Without the
        // DB trigger a direct writer bypasses the barrier and fails with23505 instead.
        await writer`INSERT INTO core.source_observations
          (tenant_id,project_id,connection_id,receipt_id,query_basis,observed_at,outcome)
          SELECT tenant_id,project_id,connection_id,receipt_id,query_basis,observed_at,outcome
          FROM core.source_observations WHERE receipt_id=${receipt}`;
      })).rejects.toMatchObject({code:"55P03"});
    });
  });

  it("records late results without rolling the successful baseline backward", async () => {
    const scope = { licenseNumber: randomUUID() };
    const first = await collect(scope);
    const second = await collect({ licenseNumber: randomUUID() });
    // Direct service exercise models a response captured before the accepted baseline but
    // committed later. Receipt payload remains immutable; only observation scheduling differs.
    await withTenant(fx.appSql,{ tenantId:fx.tenantA },async tx => {
      const [receipt] = await tx<{ raw_hash:string }[]>`SELECT raw_hash FROM core.source_receipts WHERE id=${second}`;
      // A separate receipt already owns its observation; a new receipt is required.
      const id = randomUUID();
      await tx`INSERT INTO core.source_receipts
        (id,tenant_id,project_id,connection_id,authority_id,collection_method,result,query_basis,
         endpoint_or_document_ref,authentication_method,raw_hash,source_schema_version,adapter_version,
         terms_license,commercial_reuse,disclosure_permission,received_at,as_of,freshness_status,
         correlation_id,channel_evidence)
        SELECT ${id},tenant_id,project_id,connection_id,authority_id,collection_method,result,${tx.json(scope)},
          endpoint_or_document_ref,authentication_method,raw_hash,source_schema_version,adapter_version,
          terms_license,commercial_reuse,disclosure_permission,received_at,as_of,freshness_status,
          correlation_id,channel_evidence FROM core.source_receipts WHERE id=${second}`;
      await recordSourceObservation(tx,{tenantId:fx.tenantA,projectId:fx.projectA,
        connectionId:fx.connectionA,receiptId:id,queryBasis:scope,observedAt:new Date("2020-01-01"),
        result:"confirmed_from_source",rawHash:receipt!.raw_hash});
      const [observation] = await tx`SELECT outcome,previous_receipt_id FROM core.source_observations WHERE receipt_id=${id}`;
      expect(observation?.outcome).toBe("out_of_order");
      expect(observation?.previous_receipt_id).toBe(first);
    });
    const latest = await collect(scope);
    const [row] = await fx.sql`SELECT outcome,previous_receipt_id FROM core.source_observations WHERE receipt_id=${latest}`;
    expect(row?.outcome).toBe("unchanged");
    expect(row?.previous_receipt_id).toBe(first);
  });
  it("keeps late no-record from overriding newer recovery or marking fresh evidence", async () => {
    const scope = { licenseNumber: randomUUID() };
    const baseline = await collect(scope);
    const id = await claim(baseline);
    const lateReceipt = randomUUID();
    await withTenant(fx.appSql,{tenantId:fx.tenantA},async tx => {
      await tx`WITH cloned_receipts AS (
      SELECT (jsonb_populate_record(NULL::core.source_receipts,to_jsonb(r) ||
          jsonb_build_object('id',${lateReceipt}::text,'result','source_returned_no_record',
            'raw_hash',NULL))).* FROM core.source_receipts r WHERE id=${baseline}
      )
      INSERT INTO core.source_receipts (
        id, tenant_id, project_id, connection_id,
        authority_id, collection_method, result, query_basis,
        endpoint_or_document_ref, authentication_method, raw_hash, raw_object_key,
        source_schema_version, adapter_version, normalization_version, terms_license,
        commercial_reuse, disclosure_permission, received_at, as_of,
        effective_at, freshness_status, correlation_id, limitations,
        created_at, channel_evidence, first_confirmed_by, second_confirmed_by,
        second_confirmed_at, supersedes_receipt_id, processing_state
      )
      SELECT
        id, tenant_id, project_id, connection_id,
        authority_id, collection_method, result, query_basis,
        endpoint_or_document_ref, authentication_method, raw_hash, raw_object_key,
        source_schema_version, adapter_version, normalization_version, terms_license,
        commercial_reuse, disclosure_permission, received_at, as_of,
        effective_at, freshness_status, correlation_id, limitations,
        created_at, channel_evidence, first_confirmed_by, second_confirmed_by,
        second_confirmed_at, supersedes_receipt_id, processing_state
      FROM cloned_receipts`;
      await recordSourceObservation(tx,{tenantId:fx.tenantA,projectId:fx.projectA,
        connectionId:fx.connectionA,receiptId:lateReceipt,queryBasis:scope,
        observedAt:new Date("2020-01-01"),result:"source_returned_no_record",rawHash:null});
    });
    const [late] = await fx.sql`SELECT outcome,affected_claim_ids FROM core.source_observations WHERE receipt_id=${lateReceipt}`;
    expect(late?.outcome).toBe("out_of_order");
    expect(late?.affected_claim_ids).toEqual([]);
    const [latest] = await fx.sql`SELECT receipt_id FROM core.source_observations
      WHERE tenant_id=${fx.tenantA} AND project_id=${fx.projectA}
        AND connection_id=${fx.connectionA} AND query_basis=${fx.sql.json(scope)}::jsonb
        AND outcome <> 'out_of_order' ORDER BY observation_sequence DESC LIMIT 1`;
    expect(latest?.receipt_id).toBe(baseline);
    const [row] = await fx.sql`SELECT stale_since FROM core.claims WHERE id=${id}`;
    expect(row?.stale_since).toBeNull();
  });

  it("records outages separately without inventing no-record or replacing the baseline", async () => {
    const scope = { licenseNumber: randomUUID() };
    const baseline = await collect(scope);
    status = 503;
    const failed = await collect(scope);
    status = 200;
    const [observation] = await fx.sql`SELECT o.outcome,o.previous_receipt_id,r.result,r.raw_hash,r.query_basis
      FROM core.source_observations o JOIN core.source_receipts r ON r.id=o.receipt_id WHERE o.receipt_id=${failed}`;
    expect(observation?.outcome).toBe("unavailable");
    expect(observation?.result).toBe("source_unavailable");
    expect(observation?.raw_hash).toBeNull();
    expect(observation?.query_basis).toEqual(scope);
    expect(observation?.previous_receipt_id).toBe(baseline);
    // Existing health policy deliberately pauses an unavailable connection. Recovery remains
    // an explicit operator decision and is not bypassed by observation tracking.
    await fx.sql`UPDATE core.source_reconciliation_tasks SET state='resolved',resolved_at=now(),
      resolved_by=${fx.operatorSubjectA},resolution='fixture source recovered'
      WHERE connection_id=${fx.connectionA} AND state='open'`;
    await fx.sql`UPDATE core.source_connections SET state='active' WHERE id=${fx.connectionA}`;
    const recovered = await collect(scope);
    const [recovery] = await fx.sql`SELECT outcome,previous_receipt_id FROM core.source_observations WHERE receipt_id=${recovered}`;
    expect(recovery?.outcome).toBe("unchanged");
    expect(recovery?.previous_receipt_id).toBe(baseline);
  });

});
