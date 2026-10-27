import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { keccak256, toBytes } from "viem";
import { withTenant } from "@mpc/db";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { setupFixture, signIn, testEnv, idempotencyKey, type TestFixture } from "./helpers/db.js";
import { publishProject, projectProjection, projectKeyOf } from "./helpers/registry.js";

/** Delay the actual health function in this isolated test DB; always restore its original OID. */
async function delayedHealth(sql: TestFixture["sql"], delaySql: string, run: () => Promise<void>): Promise<void> {
  await sql`ALTER FUNCTION core.public_evidence_ledger_current(UUID,TIMESTAMPTZ) RENAME TO public_evidence_ledger_clock_test_original`;
  try {
    await sql.unsafe(`CREATE FUNCTION core.public_evidence_ledger_current(p_version UUID,p_evaluated_at TIMESTAMPTZ)
      RETURNS JSONB LANGUAGE plpgsql STABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $$
      BEGIN ${delaySql}; RETURN core.public_evidence_ledger_clock_test_original(p_version,p_evaluated_at); END $$`);
    await sql`REVOKE ALL ON FUNCTION core.public_evidence_ledger_current(UUID,TIMESTAMPTZ) FROM PUBLIC`;
    await sql`GRANT EXECUTE ON FUNCTION core.public_evidence_ledger_current(UUID,TIMESTAMPTZ) TO mpc_app`;
    await run();
  } finally {
    await sql`DROP FUNCTION IF EXISTS core.public_evidence_ledger_current(UUID,TIMESTAMPTZ)`;
    await sql`ALTER FUNCTION core.public_evidence_ledger_clock_test_original(UUID,TIMESTAMPTZ) RENAME TO public_evidence_ledger_current`;
  }
}

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;
describeDb("destination-bound CRE report observations", () => {
  let fx: TestFixture; let app: FastifyInstance; let token: string; let other: string; let publisher: string; let scoped: string;
  let publicKey: string; let versionId: string;
  const receiver = `0x${"12".repeat(20)}`;
  beforeAll(async () => {
    fx = await setupFixture(); app = await buildServer(loadConfig(testEnv()), fx.appSql);
    token = await signIn(app, fx.operatorA); other = await signIn(app, fx.operatorB);
    publisher = await signIn(app, fx.disclosureApproverA); scoped = await signIn(app, fx.scopedStewardA);
    publicKey = await projectKeyOf(fx.sql, fx.projectA);
    const published = await publishProject(app, fx.sql, { drafter: token, publisher }, fx.projectA);
    expect(published.statusCode, published.body).toBe(200); versionId = published.json().id;
  });
  afterAll(async () => { await app.close(); await fx.close(); });
  const report = (payload: Record<string, unknown> = {}, auth = token, projectId = fx.projectA, key = idempotencyKey()) => app.inject({
    method: "POST", url: `/api/v1/projects/${projectId}/cre-reports`,
    headers: { authorization: `Bearer ${auth}`, "idempotency-key": key },
    payload: { publicKey, chainId: String(loadConfig(testEnv()).chainId), receiver, ttlSeconds: "300", ...payload },
  });

  it("persists only public ABI fields and fails closed without an approved ledger", async () => {
    const response = await report(); expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.status).toBe(5);
    expect(body.recordId).toBe(keccak256(toBytes(`mpc-registry:project:${publicKey}`)));
    expect(body.receiver).toBe(receiver);
    expect(BigInt(body.validUntil) - BigInt(body.observedAt)).toBe(300n);
    expect(Object.keys(body).sort()).toEqual(["chainId", "receiver", "recordId", "registryVersion", "contentHash", "observedAt", "validUntil", "sequence", "status"].sort());
    const [stored] = await fx.sql`SELECT report FROM core.cre_reports WHERE project_id=${fx.projectA} AND report ->> 'sequence'=${body.sequence}`;
    expect(stored!.report).toEqual(body);
    const [audit] = await fx.sql`SELECT count(*)::int n FROM audit.events WHERE command='cre_report.observed' AND project_id=${fx.projectA}`;
    expect(audit!.n).toBeGreaterThan(0);
  });

  it("allocates the next public sequence by numeric rather than lexical history order", async () => {
    const initial = await report();
    expect(initial.statusCode, initial.body).toBe(200);
    for (const sequence of ["9", "10"]) {
      await fx.sql`INSERT INTO core.cre_reports(tenant_id,project_id,registry_version_id,report)
        VALUES(${fx.tenantA},${fx.projectA},${versionId},${fx.sql.json({...initial.json<Record<string, unknown>>(),sequence})})`;
    }
    const next = await report();
    expect(next.statusCode, next.body).toBe(200);
    expect(next.json().sequence).toBe("11");
  });

  it("returns stable observations for retries and rejects key reuse with a different destination", async () => {
    const key = idempotencyKey(); const initial = await report({}, token, fx.projectA, key);
    const repeated = await report({}, token, fx.projectA, key);
    expect(repeated.statusCode, repeated.body).toBe(200); expect(repeated.json()).toEqual(initial.json());
    const conflict = await report({ ttlSeconds: "301" }, token, fx.projectA, key);
    expect(conflict.statusCode).toBe(409);
    const [stored] = await fx.sql`SELECT count(*)::int n FROM core.cre_reports WHERE project_id=${fx.projectA} AND report ->> 'sequence'=${initial.json().sequence}`;
    expect(stored!.n).toBe(1);
  });

  it("starts a one-second TTL after waiting for a concurrent report reservation", async () => {
    const key = idempotencyKey();
    let pending: ReturnType<typeof report> | undefined;
    let releasedAt = 0n;
    await fx.sql.begin(async blocker => {
      const [owner] = await blocker<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      await blocker`SELECT pg_advisory_xact_lock(hashtextextended(${'cre-report-key:' + fx.tenantA + ':' + key},0))`;
      pending = report({ ttlSeconds: "1" }, token, fx.projectA, key).then(response => response);
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const [blocked] = await fx.sql<{ waiting: boolean }[]>`
          SELECT EXISTS(SELECT 1 FROM pg_stat_activity
            WHERE ${owner!.pid} = ANY(pg_blocking_pids(pid))) AS waiting
        `;
        if (blocked?.waiting) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await blocker`SELECT pg_sleep(1.2)`;
      const [clock] = await blocker<{ epoch: string }[]>`
        SELECT floor(extract(epoch FROM clock_timestamp()))::bigint::text AS epoch
      `;
      releasedAt = BigInt(clock!.epoch);
    });
    const response = await pending!;
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{ observedAt: string; validUntil: string }>();
    expect(BigInt(body.observedAt)).toBeGreaterThanOrEqual(releasedAt);
    expect(BigInt(body.validUntil) - BigInt(body.observedAt)).toBe(1n);
    expect(BigInt(body.validUntil)).toBeGreaterThan(releasedAt);
  });

  it("rolls back an observation and its reservation when health evaluation spends its TTL", async () => {
    const key = idempotencyKey();
    const before = await fx.sql`SELECT id FROM core.cre_reports WHERE tenant_id=${fx.tenantA} AND project_id=${fx.projectA}`;
    await delayedHealth(fx.sql,"PERFORM pg_sleep(1.1)",async () => {
      const expired = await report({ttlSeconds:"1"},token,fx.projectA,key);
      expect(expired.statusCode,expired.body).toBe(503);
      expect(expired.json()).toMatchObject({code:"CRE_OBSERVATION_EXPIRED",retryable:true});
      expect(await fx.sql`SELECT id FROM core.cre_reports WHERE tenant_id=${fx.tenantA} AND project_id=${fx.projectA}`).toEqual(before);
      expect(await fx.sql`SELECT key FROM core.idempotency_keys WHERE tenant_id=${fx.tenantA} AND key=${key}`).toHaveLength(0);
    });
    const retry = await report({ttlSeconds:"1"},token,fx.projectA,key);
    expect(retry.statusCode,retry.body).toBe(200);
  });

  it("detects a review credential expiring during the lock wait without changing approved bytes", async () => {
    const isolated = await setupFixture();
    const server = await buildServer(loadConfig(testEnv()), isolated.appSql);
    try {
      const operator = await signIn(server, isolated.operatorA);
      const approver = await signIn(server, isolated.disclosureApproverA);
      const catalogId = randomUUID(), proposalId = randomUUID(), claimId = randomUUID();
      const artifactId = randomUUID(), uploadId = randomUUID(), caseId = randomUUID();
      const assignmentId = randomUUID(), attestationId = randomUUID();
      const claimType = `clock_${randomUUID().replaceAll("-", "")}`;
      const hash = `0x${"ab".repeat(32)}`;
      const catalog = { claimType, displayName: "Clock boundary fixture", description: null,
        definition: { fields: [{ key: "number", label: "Number", type: "string", required: true }] } };
      await isolated.sql.begin(async tx => {
        await tx`INSERT INTO core.registry_proposals(id,tenant_id,kind,item_key,item_version,payload,rationale,effective_from,proposed_by_subject_id)
          VALUES(${proposalId},${isolated.tenantA},'claim_type',${claimType},1,${tx.json(catalog)},'Synthetic clock test',now()-interval '1 day',${isolated.operatorSubjectA})`;
        await tx`INSERT INTO core.claim_types(id,tenant_id,claim_type,catalog_version,display_name,definition,effective_from)
          SELECT ${catalogId},tenant_id,item_key,1,'Clock boundary fixture',payload->'definition',effective_from
          FROM core.registry_proposals WHERE id=${proposalId}`;
        await tx`UPDATE core.registry_proposals SET state='approved',decided_by_subject_id=${isolated.reviewerSubjectA},decided_at=now(),
          decision_reason='Synthetic test only',materialized_id=${catalogId},version=2 WHERE id=${proposalId}`;
        await tx`INSERT INTO core.artifacts(id,tenant_id,project_id,kind,content_hash,sensitivity)
          VALUES(${artifactId},${isolated.tenantA},${isolated.projectA},'raw_source',${hash},'restricted')`;
        await tx`INSERT INTO core.object_uploads(id,tenant_id,project_id,object_key,content_hash,byte_size,content_type,sensitivity,state,promoted_artifact_id)
          VALUES(${uploadId},${isolated.tenantA},${isolated.projectA},${uploadId},${hash},123,'application/pdf','restricted','promoted',${artifactId})`;
        await tx`INSERT INTO core.claims(id,tenant_id,project_id,claim_type,value_text,source_coordinate,grade,catalog_entry_id,catalog_version,structured_values,document_upload_ids,as_of)
          VALUES(${claimId},${isolated.tenantA},${isolated.projectA},${claimType},'Synthetic licence','{}','verified',
            ${catalogId},1,'{"number":"SYNTHETIC-1"}',${[uploadId]}::uuid[],current_date)`;
        await tx`INSERT INTO core.verification_cases(id,tenant_id,project_id,schema_id,state)
          VALUES(${caseId},${isolated.tenantA},${isolated.projectA},${isolated.schemaA},'signed')`;
        await tx`INSERT INTO core.assignments(id,tenant_id,case_id,subject_id,credential_id)
          VALUES(${assignmentId},${isolated.tenantA},${caseId},${isolated.reviewerSubjectA},${isolated.credentialA})`;
        await tx`INSERT INTO core.verification_attestations(id,tenant_id,case_id,assignment_id,credential_id,schema_id,
          attestation_type,claim_scope,evidence_snapshot_hash,limitations,credential_status_snapshot,method_version,
          policy_version,payload_hash,signature,signer_wallet_address,signed_at,state)
          VALUES(${attestationId},${isolated.tenantA},${caseId},${assignmentId},${isolated.credentialA},${isolated.schemaA},
            'professional_signoff',${[claimId]}::uuid[],${hash},'Synthetic clock fixture only',
            '{"status":"valid"}','1','1',${hash},${`0x${"12".repeat(65)}`},${isolated.reviewerA.address},now()-interval '1 hour','signed')`;
      });
      const assessed = await server.inject({ method: "POST", url: `/api/v1/projects/${isolated.projectA}/evidence-ledger`,
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": idempotencyKey() }, payload: {} });
      expect(assessed.statusCode, assessed.body).toBe(200);
      const published = await publishProject(server, isolated.sql, { drafter: operator, publisher: approver }, isolated.projectA,
        { projection: await projectProjection(isolated.sql, isolated.projectA, { evidenceLedger: assessed.json().publicProjection }) });
      expect(published.statusCode, published.body).toBe(200);
      const approvedId = published.json().id as string;
      const before = await isolated.sql`SELECT content_hash,public_projection FROM core.registry_entry_versions WHERE id=${approvedId}`;
      const keyOf = await projectKeyOf(isolated.sql, isolated.projectA);
      const observe = (key: string, ttlSeconds = "1") => server.inject({ method: "POST", url: `/api/v1/projects/${isolated.projectA}/cre-reports`,
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": key },
        payload: { publicKey: keyOf, chainId: String(loadConfig(testEnv()).chainId), receiver, ttlSeconds } });
      const current = await observe(idempotencyKey());
      expect(current.statusCode, current.body).toBe(200);
      expect(current.json().status).toBe(1);
      const key = idempotencyKey();
      let pending: ReturnType<typeof observe> | undefined;
      await isolated.sql.begin(async blocker => {
        const [owner] = await blocker<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        await blocker`SELECT pg_advisory_xact_lock(hashtextextended(${'cre-report-key:' + isolated.tenantA + ':' + key},0))`;
        await blocker`UPDATE core.credentials SET expires_at=clock_timestamp()+interval '1 second' WHERE id=${isolated.credentialA}`;
        pending = observe(key).then(response => response);
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const [blocked] = await isolated.sql<{ waiting: boolean }[]>`
            SELECT EXISTS(SELECT 1 FROM pg_stat_activity
              WHERE ${owner!.pid} = ANY(pg_blocking_pids(pid))) AS waiting
          `;
          if (blocked?.waiting) { waiting = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        await blocker`SELECT pg_sleep(1.2)`;
      });
      const expired = await pending!;
      expect(expired.statusCode, expired.body).toBe(200);
      expect(expired.json().status).toBe(2);
      expect(expired.json().contentHash).toBe(current.json().contentHash);
      expect(await isolated.sql`SELECT content_hash,public_projection FROM core.registry_entry_versions WHERE id=${approvedId}`).toEqual(before);

      // A health query can itself wait after its evaluation timestamp has already been bound.
      // Its positive result must retain that earlier observation time, not claim post-expiry health.
      await isolated.sql`UPDATE core.credentials SET expires_at=date_trunc('second',clock_timestamp())+interval '2 seconds'
        WHERE id=${isolated.credentialA}`;
      const [expiry] = await isolated.sql<{epoch:string}[]>`SELECT extract(epoch FROM expires_at)::bigint::text AS epoch
        FROM core.credentials WHERE id=${isolated.credentialA}`;
      await delayedHealth(isolated.sql,"PERFORM pg_advisory_xact_lock(hashtextextended('cre-health-delay-test',0))",async () => {
        let delayed: ReturnType<typeof observe> | undefined;
        await isolated.sql.begin(async blocker => {
          const [owner] = await blocker<{pid:number}[]>`SELECT pg_backend_pid() AS pid`;
          await blocker`SELECT pg_advisory_xact_lock(hashtextextended('cre-health-delay-test',0))`;
          delayed = observe(idempotencyKey(),"300").then(response => response);
          let waiting = false;
          for(let attempt=0;attempt<100;attempt++) {
            const [blocked] = await isolated.sql<{waiting:boolean}[]>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
              WHERE ${owner!.pid}=ANY(pg_blocking_pids(pid))) AS waiting`;
            if(blocked?.waiting) {waiting=true;break;}
            await new Promise(resolve => setTimeout(resolve,10));
          }
          expect(waiting).toBe(true);
          await blocker`SELECT pg_sleep(GREATEST(0,${expiry!.epoch}::numeric+0.1-extract(epoch FROM clock_timestamp())))`;
        });
        const historical = await delayed!;
        expect(historical.statusCode,historical.body).toBe(200);
        expect(historical.json().status).toBe(1);
        expect(BigInt(historical.json().observedAt)).toBeLessThan(BigInt(expiry!.epoch));
        expect(BigInt(historical.json().validUntil)-BigInt(historical.json().observedAt)).toBe(300n);
        const fresh = await observe(idempotencyKey(),"300");
        expect(fresh.statusCode,fresh.body).toBe(200);
        expect(fresh.json().status).toBe(2);
        expect(fresh.json().contentHash).toBe(historical.json().contentHash);
      });
      expect(await isolated.sql`SELECT content_hash,public_projection FROM core.registry_entry_versions WHERE id=${approvedId}`).toEqual(before);
    } finally {
      await server.close();
      await isolated.close();
    }
  });

  it("serializes concurrent DON requests into one byte-identical observation", async () => {
    const key = idempotencyKey();
    const responses = await Promise.all(Array.from({length: 4}, () => report({}, token, fx.projectA, key)));
    for (const response of responses) {
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).toBe(responses[0]!.body);
    }
    const [stored] = await fx.sql`SELECT count(*)::int n FROM core.cre_reports
      WHERE project_id=${fx.projectA} AND report ->> 'sequence'=${responses[0]!.json().sequence}`;
    expect(stored!.n).toBe(1);
  });

  it("enforces authorization, tenant and published identity before issuing a report", async () => {
    expect((await report({}, other)).statusCode).toBe(404);
    expect((await report({}, publisher)).statusCode).toBe(403);
    expect([403, 404]).toContain((await report({}, scoped, fx.otherProjectA)).statusCode);
    expect((await report({ publicKey: "not-the-published-key" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/v1/projects/${fx.projectA}/cre-reports`, payload: {} })).statusCode).toBe(401);
  });

  it("uses a record-local sequence without exposing other project report volume", async () => {
    const published = await publishProject(app, fx.sql, { drafter: token, publisher }, fx.otherProjectA);
    expect(published.statusCode, published.body).toBe(200);
    const otherKey = await projectKeyOf(fx.sql, fx.otherProjectA);
    const response = await report({publicKey: otherKey}, token, fx.otherProjectA);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().sequence).toBe("1");
  });

  it("rejects caller-supplied status, wrong chain, zero address and invalid TTLs", async () => {
    for (const payload of [{ status: 1 }, { chainId: "99999999" }, { receiver: `0x${"0".repeat(40)}` },
      { ttlSeconds: "0" }, { ttlSeconds: "3601" }, { ttlSeconds: 300 }, { ttlSeconds: "1.5" },
      { chainId: "1.5" }, { chainId: "Infinity" }, { ttlSeconds: "NaN" }, { publicKey: "" }]) {
      const response = await report(payload); expect(response.statusCode, response.body).toBe(400);
    }
  });

  it("approved ledger health ignores unrelated targets and only its own open review signal blocks it", async () => {
    const previousVersionId = versionId;
    const assessed = await app.inject({ method: "POST", url: `/api/v1/projects/${fx.projectA}/evidence-ledger`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey() }, payload: {} });
    expect(assessed.statusCode, assessed.body).toBe(200);
    const published = await publishProject(app, fx.sql, { drafter: token, publisher }, fx.projectA,
      { projection: await projectProjection(fx.sql, fx.projectA, { evidenceLedger: assessed.json().publicProjection }) });
    expect(published.statusCode, published.body).toBe(200); versionId = published.json().id;
    await fx.sql`INSERT INTO core.evidence_stale_signals(id,tenant_id,project_id,target_type,target_id,reason)
      VALUES(${randomUUID()},${fx.tenantA},${fx.otherProjectA},'registry_entry_version',${randomUUID()},'Unrelated project warning')`;
    await fx.sql`INSERT INTO core.evidence_stale_signals(id,tenant_id,project_id,target_type,target_id,reason)
      VALUES(${randomUUID()},${fx.tenantA},${fx.projectA},'registry_entry_version',${previousVersionId},'Old version warning')`;
    await fx.sql`INSERT INTO core.evidence_stale_signals(id,tenant_id,project_id,target_type,target_id,reason)
      VALUES(${randomUUID()},${fx.tenantA},${fx.projectA},'compliance_assessment',${versionId},'Different target namespace')`;
    const current = await report(); expect(current.statusCode, current.body).toBe(200); expect(current.json().status).toBe(1);
    await fx.sql`INSERT INTO core.evidence_stale_signals(id,tenant_id,project_id,target_type,target_id,reason)
      VALUES(${randomUUID()},${fx.tenantA},${fx.projectA},'registry_entry_version',${versionId},'Synthetic source change')`;
    const stale = await report(); expect(stale.statusCode, stale.body).toBe(200); expect(stale.json().status).toBe(2);
    expect(BigInt(stale.json().sequence)).toBeGreaterThan(BigInt(current.json().sequence));
    expect(stale.json().contentHash).toBe(current.json().contentHash);
  });

  it("revocation outranks open review warnings and immutable reports remain tenant isolated", async () => {
    await fx.sql`UPDATE core.registry_entry_versions SET status='revoked',revoked_at=now() WHERE id=${versionId}`;
    const revoked = await report(); expect(revoked.statusCode, revoked.body).toBe(200); expect(revoked.json().status).toBe(3);
    const foreignRows = await withTenant(fx.appSql, { tenantId: fx.tenantB }, tx => tx`SELECT id FROM core.cre_reports WHERE project_id=${fx.projectA}`);
    expect(foreignRows).toHaveLength(0);
    const [stored] = await fx.sql`SELECT id FROM core.cre_reports WHERE project_id=${fx.projectA} AND report ->> 'sequence'=${revoked.json().sequence}`;
    await expect(fx.sql`UPDATE core.cre_reports SET report='{}' WHERE id=${stored!.id}`).rejects.toThrow();
    await expect(fx.sql`DELETE FROM core.cre_reports WHERE id=${stored!.id}`).rejects.toThrow();
    await expect(fx.sql`TRUNCATE core.cre_reports`).rejects.toThrow();
    const mismatched = { ...revoked.json(), sequence: "99999999" };
    await expect(withTenant(fx.appSql, { tenantId: fx.tenantA }, tx => tx`
      INSERT INTO core.cre_reports(sequence,tenant_id,project_id,registry_version_id,report) OVERRIDING SYSTEM VALUE
      VALUES(99999999,${fx.tenantA},${fx.otherProjectA},${versionId},${tx.json(mismatched)})
    `)).rejects.toThrow("CRE report must reference its approved project version");
  });
});
