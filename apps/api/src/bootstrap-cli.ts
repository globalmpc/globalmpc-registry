import postgres from "postgres";
import { resolveSecret } from "@mpc/config";
import { bootstrapOperator, BootstrapError } from "./bootstrap.js";
import type { BootstrapInput } from "./bootstrap.js";

/**
 * Operational bootstrap runner.
 *
 * The deploy's migration task runs it after migrating whenever `BOOTSTRAP_EMAIL` is set
 * (`docker/migrate-task.sh`); it also runs by hand. It deletes nothing, so re-running with the
 * same values is safe, and it refuses to re-grant a revoked role, to act for a suspended person, or
 * to create a second holder of the role (an operator's old address after an email change, say)
 * (`bootstrap.ts`). Optional `BOOTSTRAP_SUBJECT_ID` explicitly selects a legacy person for their
 * first email, preserving identity and existing authority. It never grants roles or upgrades
 * assurance, and an unchanged subject/email rerun is a no-op. A refusal exits 1, stopping deploy.
 *
 * Connect as the migration table owner, not an application/worker login. Bootstrap establishes
 * the tenant scope before account access and does not require BYPASSRLS.
 */

const REQUIRED = [
  "DATABASE_URL",
  "BOOTSTRAP_TENANT_SLUG",
  "BOOTSTRAP_TENANT_NAME",
  "BOOTSTRAP_ORG_NAME",
  "BOOTSTRAP_SUBJECT_NAME",
  "BOOTSTRAP_EMAIL",
] as const;

// Wallet sign-in is gone (WP7) and bootstrap binds no wallet: a signing key is bound by its holder
// from Settings. A pipeline still passing one is told so, rather than having the value dropped.
if ((process.env["BOOTSTRAP_WALLET"] ?? "") !== "") {
  process.stderr.write(
    "BOOTSTRAP_WALLET is no longer accepted — the person signs in with BOOTSTRAP_EMAIL and binds a signing wallet from Settings\n",
  );
  process.exit(1);
}

const missing: string[] = REQUIRED.filter((name) => (process.env[name] ?? "") === "");
if (missing.length > 0) {
  process.stderr.write(
    [
      `Missing environment variables — ${missing.join(", ")}`,
      "",
      "Required:",
      "  DATABASE_URL              same table-owner connection used for migrations",
      "  BOOTSTRAP_TENANT_SLUG     tenant identifier. Reused if it already exists",
      "  BOOTSTRAP_TENANT_NAME     tenant display name",
      "  BOOTSTRAP_ORG_NAME        organization legal name",
      "  BOOTSTRAP_SUBJECT_NAME    person display name",
      "  BOOTSTRAP_EMAIL           sign-in email address (emailed codes)",
      "",
      "Optional:",
      "  BOOTSTRAP_SUBJECT_ID      exact existing legacy subject UUID (migration-only email initialization)",
      "                            never grants a role or upgrades stored assurance",
      "  BOOTSTRAP_JURISDICTION    3 uppercase ISO3 letters (default MNG)",
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
  email: process.env["BOOTSTRAP_EMAIL"] as string,
  ...(process.env["BOOTSTRAP_SUBJECT_ID"] === undefined ? {} : { subjectId: process.env["BOOTSTRAP_SUBJECT_ID"] }),
  role: process.env["BOOTSTRAP_ROLE"] ?? "mpc_operator",
  assuranceLevel: (process.env["BOOTSTRAP_ASSURANCE"] ??
    "high_assurance") as BootstrapInput["assuranceLevel"],
};

const sql = postgres(databaseUrl, { onnotice: () => {} });

try {
  const result = await bootstrapOperator(sql, input);
  // The email address is personal data, so only whether one was bound is printed.
  process.stdout.write(
    `${JSON.stringify({
      msg: result.created ? "bootstrap.created" : "bootstrap.exists",
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      subjectId: result.subjectId,
      emailBound: result.emailBound,
      role: input.role,
      roleGranted: result.roleGranted,
      // Null: the person already holds a passkey or TOTP, and a re-run opens nothing.
      enrolmentWindowUntil: result.enrolmentWindowUntil?.toISOString() ?? null,
      enrolmentWindowOpened: result.enrolmentWindowOpened,
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
