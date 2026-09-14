import { readFileSync } from "node:fs";
import postgres from "postgres";
import { resolveSecret } from "@mpc/config";
import {
  bootstrapAttestationSchema,
  bootstrapCredential,
  bootstrapPolicySet,
  BootstrapRegistryError,
} from "./bootstrap-registry.js";

/**
 * Runner that inserts the three things needed to start review.
 *
 *   pnpm --filter @mpc/api bootstrap:registry credential
 *   pnpm --filter @mpc/api bootstrap:registry schema
 *   pnpm --filter @mpc/api bootstrap:registry policy-set
 *
 * Connects the same way as `bootstrap` (bypassing RLS). It deletes nothing, so re-running with
 * the same values is safe.
 */

const KINDS = ["credential", "schema", "policy-set"] as const;
type Kind = (typeof KINDS)[number];

const kind = process.argv[2] as Kind | undefined;

function fail(lines: readonly string[]): never {
  process.stderr.write(`${lines.join("\n")}\n`);
  process.exit(1);
}

if (!kind || !KINDS.includes(kind)) {
  fail([
    `Choose what to insert — ${KINDS.join(" | ")}`,
    "",
    "  credential   reviewer credential. Without it no review assignment is created",
    "  schema       review schema. Cannot be signed while draft",
    "  policy-set   readiness rules. Evaluation does not run while draft",
  ]);
}

function required(name: string): string {
  const value = process.env[name] ?? "";
  if (value === "") fail([`Missing environment variable — ${name}`]);
  return value;
}

function list(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * Approver.
 *
 * Empty means `draft`. **That being the default is intentional** — the app has no approval
 * path yet (02 §2.8), so it becomes active only when given the name of the person stated to
 * have approved. That name is a statement, not a fact the app verified, and audit records it so.
 */
function approvedBy(): string | null {
  const value = (process.env["BOOTSTRAP_APPROVED_BY"] ?? "").trim();
  return value === "" ? null : value;
}

const databaseUrl = resolveSecret(
  "DATABASE_URL",
  required("DATABASE_URL"),
  undefined,
  process.env,
);

const tenantSlug = required("BOOTSTRAP_TENANT_SLUG");
const sql = postgres(databaseUrl, { onnotice: () => {} });

try {
  let result;

  if (kind === "credential") {
    result = await bootstrapCredential(sql, {
      tenantSlug,
      walletAddress: required("CREDENTIAL_WALLET"),
      issuerReference: required("CREDENTIAL_ISSUER_REFERENCE"),
      credentialType: required("CREDENTIAL_TYPE"),
      credentialScope: list("CREDENTIAL_SCOPE"),
      jurisdiction: list("CREDENTIAL_JURISDICTION"),
      issuedAt: required("CREDENTIAL_ISSUED_AT"),
      expiresAt: process.env["CREDENTIAL_EXPIRES_AT"] || null,
    });
  } else if (kind === "schema") {
    result = await bootstrapAttestationSchema(sql, {
      tenantSlug,
      schemaKey: required("SCHEMA_KEY"),
      schemaVersion: required("SCHEMA_VERSION"),
      attestationType: required("SCHEMA_ATTESTATION_TYPE"),
      requiredEvidence: list("SCHEMA_REQUIRED_EVIDENCE"),
      acceptedAuthorityTypes: list("SCHEMA_ACCEPTED_AUTHORITY_TYPES"),
      mandatoryLimitations: list("SCHEMA_MANDATORY_LIMITATIONS"),
      jurisdictionProfile: process.env["SCHEMA_JURISDICTION_PROFILE"] ?? "MNG",
      approvedBy: approvedBy(),
    });
  } else {
    // Rules come from a file or an environment variable.
    //
    // **Accepting only a file makes it unusable in containers.** Deployments do not mount the
    // repository, so no rule set file exists there. Hence `POLICY_SET_JSON` too —
    // in environments like Coolify, environment variables are all you can supply.
    const path = process.env["POLICY_SET_FILE"] ?? "";
    const inline = process.env["POLICY_SET_JSON"] ?? "";
    if (path === "" && inline === "") {
      fail(["POLICY_SET_FILE or POLICY_SET_JSON is required — where to read the rule set from"]);
    }

    const source = path === "" ? "POLICY_SET_JSON" : path;
    let definition: unknown;
    try {
      definition = JSON.parse(path === "" ? inline : readFileSync(path, "utf8"));
    } catch (error) {
      fail([`Could not read rule set — ${source}`, String(error)]);
    }
    result = await bootstrapPolicySet(sql, {
      tenantSlug,
      definition,
      approvedBy: approvedBy(),
    });
  }

  process.stdout.write(
    `${JSON.stringify({
      msg: result.created ? `bootstrap.${kind}.created` : `bootstrap.${kind}.exists`,
      id: result.id,
      state: result.state,
    })}\n`,
  );
} catch (error) {
  const message = error instanceof BootstrapRegistryError ? error.message : String(error);
  process.stderr.write(`bootstrap ${kind} failed — ${message}\n`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
