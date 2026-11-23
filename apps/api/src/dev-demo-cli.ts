import postgres from "postgres";
import { createS3ObjectStore } from "@mpc/storage";
import { assertDemoEnvironment, DemoSeedError, seedDevDemo } from "./dev-demo.js";

let sql: postgres.Sql | undefined;
try {
  const environment = process.env["DEPLOY_ENVIRONMENT"] ?? "";
  const chainId = process.env["CHAIN_ID"] ?? "";
  assertDemoEnvironment(environment, chainId);
  const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new DemoSeedError(`Missing ${name}`);
    return value;
  };
  const store = createS3ObjectStore({ bucket: required("OBJECT_BUCKET"), region: required("OBJECT_REGION"), sse: "aes256" });
  sql = postgres(required("DATABASE_URL"), { onnotice: () => {}, connection: { TimeZone: "UTC" } });
  const includeDocuments = process.env["DEMO_INCLUDE_DOCUMENTS"] ?? "true";
  if (!["true", "false"].includes(includeDocuments)) throw new DemoSeedError("DEMO_INCLUDE_DOCUMENTS must be true or false");
  const scanTimeoutMs = Number(process.env["DEMO_SCAN_TIMEOUT_MS"] ?? "240000");
  if (!Number.isSafeInteger(scanTimeoutMs) || scanTimeoutMs < 1000 || scanTimeoutMs > 240000) throw new DemoSeedError("DEMO_SCAN_TIMEOUT_MS must be between 1000 and 240000");
  const result = await seedDevDemo(sql, store, {
    environment, chainId, includeStageProjects: true, includeDocumentProjects: includeDocuments === "true", scanTimeoutMs,
    ...(process.env["DEMO_OWNER_ORGANIZATION_NAME"] ? { ownerOrganizationName: process.env["DEMO_OWNER_ORGANIZATION_NAME"] } : {}),
  });
  process.stdout.write(`${JSON.stringify({ msg: "dev_demo.complete", ...result })}\n`);
} catch (error) {
  // SQL, connection and signing failures can contain secret material. Never echo them.
  const reason = error instanceof DemoSeedError ? error.message : "verify owner, database, object storage and scan worker; details omitted";
  process.stderr.write(`dev_demo.failed: ${reason}\n`);
  process.exitCode = 1;
} finally {
  try { await sql?.end(); }
  catch {
    process.stderr.write("dev_demo.cleanup_failed; connection details omitted\n");
    process.exitCode = 1;
  }
}
