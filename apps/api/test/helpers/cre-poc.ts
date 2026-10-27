import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  createPublicClient, createTestClient, createWalletClient, encodeAbiParameters,
  http, keccak256, parseAbiParameters, toBytes, type Abi, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildServer } from "../../src/server.js";
import { loadConfig } from "../../src/config.js";
import { setupFixture, signIn, testEnv, idempotencyKey, type TestFixture } from "./db.js";
import { projectProjection, projectKeyOf, publishProject } from "./registry.js";

function requireIsolatedDatabase(): void {
  const value = process.env["DATABASE_URL"];
  assert(value, "DATABASE_URL must identify an isolated local cre_poc_ database");
  const url = new URL(value);
  assert(["postgres:", "postgresql:"].includes(url.protocol));
  assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert(/^\/cre_poc_[a-z0-9_]+$/.test(url.pathname));
  assert.equal(url.search, "", "Connection overrides are not allowed");
}

async function ownedAnvilPort(child: ChildProcess): Promise<number> {
  // Anvil selects port zero atomically. Trust only this child's successful bind message,
  // not an RPC response from a port another local process might have claimed.
  const output = child.stdout;
  assert(output);
  return new Promise<number>((resolve, reject) => {
    let buffer = "";
    const cleanup = () => {
      clearTimeout(timer);
      output.off("data", onData);
      child.off("error", onFailure);
      child.off("exit", onFailure);
      buffer = "";
      // Startup contains public test private keys. Never forward or retain this stream.
      output.resume();
    };
    const onFailure = () => { cleanup(); reject(new Error("Owned local Anvil startup failed")); };
    const onData = (chunk: Buffer) => {
      buffer = (buffer + chunk.toString("utf8")).slice(-8192);
      const match = /(?:^|\n)Listening on 127\.0\.0\.1:([0-9]{1,5})\s*(?:\n|$)/.exec(buffer);
      if (!match) return;
      const port = Number(match[1]);
      if (port < 1 || port > 65535 || child.exitCode !== null || child.signalCode !== null) return onFailure();
      cleanup(); resolve(port);
    };
    const timer = setTimeout(onFailure, 10_000);
    child.once("error", onFailure);
    child.once("exit", onFailure);
    output.on("data", onData);
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise<void>(resolve => child.once("exit", () => resolve())), delay(2000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

function json(response: LightMyRequestResponse): Record<string, unknown> {
  assert.equal(response.statusCode, 200, `Local API returned ${response.statusCode}`);
  return response.json() as Record<string, unknown>;
}

/** Synthetic signatures and catalog setup are fixtures, never real professional approval. */
async function seedReviewedClaim(fx: TestFixture, receiptId: string): Promise<void> {
  const catalogId = randomUUID(), proposalId = randomUUID(), claimId = randomUUID();
  const caseId = randomUUID(), assignmentId = randomUUID(), attestationId = randomUUID();
  const claimType = `cre_${randomUUID().replaceAll("-", "")}`;
  const payload = { claimType, displayName: "Synthetic CRE licence", description: null,
    definition: { fields: [{ key: "number", label: "Number", type: "string", required: true }] } };
  const hash = `0x${"ab".repeat(32)}`;
  await fx.sql.begin(async tx => {
    await tx`INSERT INTO core.registry_proposals(id,tenant_id,kind,item_key,item_version,payload,rationale,effective_from,proposed_by_subject_id)
      VALUES(${proposalId},${fx.tenantA},'claim_type',${claimType},1,${tx.json(payload)},'Synthetic local CRE fixture',now()-interval '1 day',${fx.operatorSubjectA})`;
    await tx`INSERT INTO core.claim_types(id,tenant_id,claim_type,catalog_version,display_name,definition,effective_from)
      SELECT ${catalogId},tenant_id,item_key,1,'Synthetic CRE licence',payload->'definition',effective_from
      FROM core.registry_proposals WHERE id=${proposalId}`;
    await tx`UPDATE core.registry_proposals SET state='approved',decided_by_subject_id=${fx.reviewerSubjectA},decided_at=now(),
      decision_reason='Synthetic local fixture only',materialized_id=${catalogId},version=2 WHERE id=${proposalId}`;
    await tx`INSERT INTO core.claims(id,tenant_id,project_id,claim_type,value_text,source_coordinate,grade,
      source_receipt_id,catalog_entry_id,catalog_version,structured_values,as_of)
      VALUES(${claimId},${fx.tenantA},${fx.projectA},${claimType},'Synthetic licence','{}','verified',
        ${receiptId},${catalogId},1,'{"number":"SYNTHETIC-1"}',current_date)`;
    await tx`INSERT INTO core.verification_cases(id,tenant_id,project_id,schema_id,state)
      VALUES(${caseId},${fx.tenantA},${fx.projectA},${fx.schemaA},'signed')`;
    await tx`INSERT INTO core.assignments(id,tenant_id,case_id,subject_id,credential_id)
      VALUES(${assignmentId},${fx.tenantA},${caseId},${fx.reviewerSubjectA},${fx.credentialA})`;
    await tx`INSERT INTO core.verification_attestations(id,tenant_id,case_id,assignment_id,credential_id,schema_id,
      attestation_type,claim_scope,evidence_snapshot_hash,limitations,credential_status_snapshot,method_version,
      policy_version,payload_hash,signature,signer_wallet_address,signed_at,state)
      VALUES(${attestationId},${fx.tenantA},${caseId},${assignmentId},${fx.credentialA},${fx.schemaA},
        'professional_signoff',${[claimId]}::uuid[],${hash},'Synthetic demonstration; no legal validity opinion',
        '{"status":"valid"}','1','1',${hash},${`0x${"12".repeat(65)}`},${fx.reviewerA.address},now()-interval '1 hour','signed')`;
  });
}

export async function runCreRegistryPoc(): Promise<void> {
  requireIsolatedDatabase();
  process.env["LOG_LEVEL"] = "silent";
  process.stdout.write("Local synthetic proof only: mocked source HTTP and mocked forwarder; no CRE DON execution or official-source claim.\n");
  let fx: TestFixture | undefined; let app: FastifyInstance | undefined; let child: ChildProcess | undefined;
  try {
    process.stdout.write("Stage: isolated fixtures and authenticated source collection\n");
    fx = await setupFixture();
    await fx.sql`UPDATE core.source_connections SET effective_at_field='effectiveAt' WHERE id=${fx.connectionA}`;
    let mockStatus = "valid";
    const effectiveAt = new Date(Date.now() - 3600_000).toISOString();
    app = await buildServer(loadConfig(testEnv()), fx.appSql, {
      fetchImpl: (async () => new Response(JSON.stringify({ licenseId: "SYNTHETIC-1", status: mockStatus, effectiveAt }), { status: 200 })) as typeof fetch,
      resolveHost: async () => ["203.0.113.10"],
    });
    const api = app, fixture = fx;
    const operator = await signIn(api, fx.operatorA), publisher = await signIn(api, fx.disclosureApproverA);
    const post = (url: string, payload: Record<string, unknown>, token = operator, headers: Record<string,string> = {}) => api.inject({
      method: "POST", url, payload, headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey(), ...headers },
    });
    const queryBasis = { licenceNumber: "SYNTHETIC-1" };
    const collect = async () => json(await post(`/api/v1/source-connections/${fixture.connectionA}/collect`, { projectId: fixture.projectA, queryBasis }));
    const first = await collect();
    assert.equal(first["result"], "confirmed_from_source");
    assert.equal(typeof first["receiptId"], "string");
    await seedReviewedClaim(fx, first["receiptId"] as string);

    process.stdout.write("Stage: computed ledger and independent publication through real API\n");
    const assessed = json(await post(`/api/v1/projects/${fx.projectA}/evidence-ledger`, {}));
    const publication = json(await publishProject(api, fx.sql, { drafter: operator, publisher }, fx.projectA,
      { projection: await projectProjection(fx.sql, fx.projectA, { evidenceLedger: assessed["publicProjection"] }) }));
    const [published] = await fx.sql`SELECT entry_id,content_hash,version FROM core.registry_entry_versions WHERE id=${publication["id"] as string}`;
    assert(published);
    const frozenHash = published["content_hash"] as string;
    const publicKey = await projectKeyOf(fx.sql, fx.projectA);

    process.stdout.write("Stage: isolated Anvil deployment\n");
    child = spawn(process.env["ANVIL_BIN"] ?? "anvil", ["--host", "127.0.0.1", "--port", "0", "--chain-id", "31337", "--color", "never"],
      { stdio: ["ignore", "pipe", "ignore"] });
    const port = await ownedAnvilPort(child);
    const transport = http(`http://127.0.0.1:${port}`, { retryCount: 0, timeout: 1000 });
    const client = createPublicClient({ chain: foundry, transport, pollingInterval: 50 });
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      assert(child.exitCode === null && child.signalCode === null, "Owned local Anvil exited");
      try { ready = await client.getChainId() === 31337; } catch { /* Child has not bound its port yet. */ }
      if (ready) break;
      await delay(100);
    }
    assert(ready, "Local Anvil readiness timeout");
    // Public, well-known default Anvil key. It signs only on this child process's localhost chain.
    const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
    const wallet = createWalletClient({ account, chain: foundry, transport });
    const testClient = createTestClient({ mode: "anvil", chain: foundry, transport });
    const artifact = async (relative: string): Promise<{ abi: Abi; bytecode: { object: Hex } }> =>
      JSON.parse(await readFile(new URL(`../../../../contracts/out/${relative}`, import.meta.url), "utf8")) as { abi: Abi; bytecode: { object: Hex } };
    const forwarderArtifact = await artifact("RegistryStatusReceiver.t.sol/LocalStatusForwarder.json");
    const receiverArtifact = await artifact("RegistryStatusReceiver.sol/RegistryStatusReceiver.json");
    const deploy = async (compiled: {abi: Abi; bytecode: {object: Hex}}, args: readonly unknown[]) => {
      const receipt = await client.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: compiled.abi, bytecode: compiled.bytecode.object, args }) });
      assert.equal(receipt.status, "success"); assert(receipt.contractAddress); return receipt.contractAddress;
    };
    const forwarder = await deploy(forwarderArtifact, []);
    const workflowId = keccak256(toBytes("synthetic-local-registry-workflow"));
    const receiver = await deploy(receiverArtifact, [forwarder, workflowId, account.address, 3600n]);
    const metadata = `${workflowId}${"00".repeat(10)}${account.address.slice(2)}0001` as Hex;
    const report = async () => json(await post(`/api/v1/projects/${fixture.projectA}/cre-reports`,
      { publicKey, chainId: "31337", receiver: receiver.toLowerCase(), ttlSeconds: "300" }));
    const encode = (value: Record<string,unknown>) => encodeAbiParameters(
      parseAbiParameters("uint256,address,bytes32,uint64,bytes32,uint64,uint64,uint64,uint8"),
      [BigInt(value["chainId"] as string), value["receiver"] as Address, value["recordId"] as Hex,
        BigInt(value["registryVersion"] as string), value["contentHash"] as Hex, BigInt(value["observedAt"] as string),
        BigInt(value["validUntil"] as string), BigInt(value["sequence"] as string), value["status"] as number]);
    const deliver = async (value: Record<string,unknown>) => {
      const receipt = await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: forwarder,
        abi: forwarderArtifact.abi, functionName: "deliver", args: [receiver, metadata, encode(value)] }) });
      assert.equal(receipt.status, "success");
    };
    const current = async (recordId: Hex) => client.readContract({ address: receiver, abi: receiverArtifact.abi,
      functionName: "isCurrent", args: [recordId] });

    process.stdout.write("Stage: current observation, contract delivery and exact transport expiry\n");
    const positive = await report(); assert.equal(positive["status"], 1); await deliver(positive);
    const recordId = positive["recordId"] as Hex;
    assert.equal(await current(recordId), true);
    const snapshot = await testClient.snapshot();
    await testClient.setNextBlockTimestamp({ timestamp: BigInt(positive["validUntil"] as string) });
    await testClient.mine({ blocks: 1 });
    assert.equal(await current(recordId), false);
    await testClient.revert({ id: snapshot });
    assert.equal(await current(recordId), true);

    process.stdout.write("Stage: changed synthetic source, re-review and replay rejection\n");
    mockStatus = "changed"; await collect();
    const review = await report(); assert.equal(review["status"], 2); assert.equal(review["contentHash"], frozenHash);
    await deliver(review); assert.equal(await current(recordId), false);
    await assert.rejects(() => deliver(positive));

    process.stdout.write("Stage: authorized revocation and frozen hash preservation\n");
    json(await post(`/api/v1/registry-entries/${published["entry_id"] as string}/revoke`,
      { reasonCode: "SYNTHETIC_LOCAL_POC" }, operator, { "if-match": `"${published["version"] as number}"` }));
    const revoked = await report(); assert.equal(revoked["status"], 3); assert.equal(revoked["contentHash"], frozenHash);
    await deliver(revoked); assert.equal(await current(recordId), false);
    const [unchanged] = await fx.sql`SELECT content_hash FROM core.registry_entry_versions WHERE id=${publication["id"] as string}`;
    assert.equal(unchanged?.["content_hash"], frozenHash);
    process.stdout.write("PASS: authenticated Registry API → local forwarder → consumer, current → re-review → revoked; expiry, replay and immutable hash verified.\n");
  } finally {
    try {
      if (child) await stopChild(child);
    } finally {
      try {
        if (app) await app.close();
      } finally {
        if (fx) await fx.close();
      }
    }
  }
}
