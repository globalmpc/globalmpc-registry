import postgres from "postgres";
import { resolveSecret } from "@mpc/config";
import { bootstrapOperator, BootstrapError } from "./bootstrap.js";
import type { BootstrapInput } from "./bootstrap.js";

/**
 * Operational bootstrap runner.
 *
 * Run once right after deployment, or whenever adding a person. It deletes nothing, so
 * re-running with the same values is safe.
 *
 * **Connects with an RLS-bypassing connection.** What it creates is the tenant itself, so a
 * tenant context cannot be established first. Pass the same connection string used to run
 * migrations, not `mpc_app_login`.
 */

const REQUIRED = [
  "DATABASE_URL",
  "BOOTSTRAP_TENANT_SLUG",
  "BOOTSTRAP_TENANT_NAME",
  "BOOTSTRAP_ORG_NAME",
  "BOOTSTRAP_SUBJECT_NAME",
  "BOOTSTRAP_WALLET",
] as const;

const missing = REQUIRED.filter((name) => (process.env[name] ?? "") === "");
if (missing.length > 0) {
  process.stderr.write(
    [
      `Missing environment variables — ${missing.join(", ")}`,
      "",
      "Required:",
      "  DATABASE_URL              same connection used for migrations (bypasses RLS)",
      "  BOOTSTRAP_TENANT_SLUG     tenant identifier. Reused if it already exists",
      "  BOOTSTRAP_TENANT_NAME     tenant display name",
      "  BOOTSTRAP_ORG_NAME        organization legal name",
      "  BOOTSTRAP_SUBJECT_NAME    person display name",
      "  BOOTSTRAP_WALLET          40-hex-digit address starting with 0x",
      "",
      "Optional:",
      "  BOOTSTRAP_JURISDICTION    3 uppercase ISO3 letters (default MNG)",
      "  BOOTSTRAP_CHAIN_ID        56 or 97 (default 97)",
      "  BOOTSTRAP_ROLE            role (default mpc_operator)",
      "  BOOTSTRAP_ASSURANCE       wallet_only·identity_bound·high_assurance",
      "                            (default high_assurance)",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

// DATABASE_URL may also be given as a `file:`·`env:` reference. Going through the same path as
// the API and worker avoids any section that "behaves differently only in deployment".
const databaseUrl = resolveSecret(
  "DATABASE_URL",
  process.env["DATABASE_URL"] as string,
  undefined,
  process.env,
);

const input: BootstrapInput = {
  tenantSlug: process.env["BOOTSTRAP_TENANT_SLUG"] as string,
  tenantName: process.env["BOOTSTRAP_TENANT_NAME"] as string,
  organizationName: process.env["BOOTSTRAP_ORG_NAME"] as string,
  jurisdiction: process.env["BOOTSTRAP_JURISDICTION"] ?? "MNG",
  subjectName: process.env["BOOTSTRAP_SUBJECT_NAME"] as string,
  walletAddress: process.env["BOOTSTRAP_WALLET"] as string,
  chainId: Number(process.env["BOOTSTRAP_CHAIN_ID"] ?? "97"),
  role: process.env["BOOTSTRAP_ROLE"] ?? "mpc_operator",
  assuranceLevel: (process.env["BOOTSTRAP_ASSURANCE"] ??
    "high_assurance") as BootstrapInput["assuranceLevel"],
};

const sql = postgres(databaseUrl, { onnotice: () => {} });

try {
  const result = await bootstrapOperator(sql, input);
  // Wallet addresses are public. No other value here is secret.
  process.stdout.write(
    `${JSON.stringify({
      msg: result.created ? "bootstrap.created" : "bootstrap.exists",
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      subjectId: result.subjectId,
      wallet: input.walletAddress.toLowerCase(),
      role: input.role,
      roleGranted: result.roleGranted,
    })}\n`,
  );
} catch (error) {
  // Leave a human-readable account of what went wrong. A stack trace hides the cause.
  const message = error instanceof BootstrapError ? error.message : String(error);
  process.stderr.write(`bootstrap failed — ${message}\n`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
