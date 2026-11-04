import postgres from "postgres";
import { resolveSecret } from "@mpc/config";
import { readConnectingRole, rlsBypassProblem } from "@mpc/db";
import {
  ServiceTokenError,
  createServiceSubject,
  ensureServiceToken,
  generateServiceTokenValue,
  issueServiceToken,
  listServiceTokens,
  revokeServiceToken,
  rotateServiceToken,
} from "./service-tokens.js";

/**
 * Service token operator CLI — decision D7.
 *
 *   pnpm --filter @mpc/api service-token create-subject <tenantSlug> <displayName> <role>
 *   pnpm --filter @mpc/api service-token issue <tenantSlug> <subjectId> <label> <scope,...> [ttlDays]
 *   pnpm --filter @mpc/api service-token rotate <tokenId> [overlapHours] [ttlDays]
 *   pnpm --filter @mpc/api service-token revoke <tokenId>
 *   pnpm --filter @mpc/api service-token list <tenantSlug>
 *   pnpm --filter @mpc/api service-token generate
 *   SERVICE_TOKEN=… pnpm --filter @mpc/api service-token ensure <tenantSlug> <label> <role> <scope,...> [ttlDays] [overlapHours]
 *
 * Runs over the migration connection (`DATABASE_URL`, superuser or BYPASSRLS), like `bootstrap`:
 * tokens are tenant rows and the runner is not a session. **`issue` and `rotate` print the raw
 * token once, on stdout, as the only line of JSON with a `token` field.** Put it straight into the
 * service's secret store; it cannot be shown again.
 *
 * `generate` prints a new token — the token and a newline, nothing else — and touches no
 * database. `ensure` registers such a token, read from `SERVICE_TOKEN` (never from the command
 * line, which process listings and logs show), for the service named by tenant, label and role:
 * the deploy-time step for a token kept in the environment's secret store. It prints what it did,
 * never the token.
 */

const USAGE = [
  "Usage:",
  "  service-token create-subject <tenantSlug> <displayName> <role>",
  "  service-token issue <tenantSlug> <subjectId> <label> <scope,...> [ttlDays=90]",
  "  service-token rotate <tokenId> [overlapHours=24] [ttlDays=90]",
  "  service-token revoke <tokenId>",
  "  service-token list <tenantSlug>",
  "  service-token generate",
  "  SERVICE_TOKEN=… service-token ensure <tenantSlug> <label> <role> <scope,...> [ttlDays=365] [overlapHours=24]",
  "",
  "Roles: scan_service, cre_reporter. Scopes: scan_result, cre_report.",
  "",
].join("\n");

const DAY = 24 * 60 * 60;

function number(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!/^[0-9]+$/.test(value)) throw new ServiceTokenError(`${name} must be a whole number`);
  return Number(value);
}

async function tenantId(sql: postgres.Sql, slug: string | undefined): Promise<string> {
  if (!slug) throw new ServiceTokenError("tenant slug is required");
  const [row] = await sql<{ id: string }[]>`SELECT id FROM core.tenants WHERE slug = ${slug}`;
  if (!row) throw new ServiceTokenError(`no tenant ${slug}`);
  return row.id;
}

const [command, ...args] = process.argv.slice(2);
if (
  !command ||
  !["create-subject", "issue", "rotate", "revoke", "list", "generate", "ensure"].includes(command)
) {
  process.stderr.write(USAGE);
  process.exit(1);
}
if (command === "generate") {
  process.stdout.write(`${generateServiceTokenValue()}\n`);
  process.exit(0);
}
// Taken out of the environment before anything else runs, so nothing later can print it.
const suppliedToken = process.env["SERVICE_TOKEN"] ?? "";
delete process.env["SERVICE_TOKEN"];
if (command === "ensure" && suppliedToken === "") {
  process.stderr.write("SERVICE_TOKEN is required for ensure (the token to register)\n");
  process.exit(1);
}
if ((process.env["DATABASE_URL"] ?? "") === "") {
  process.stderr.write("DATABASE_URL is required (the migration connection)\n");
  process.exit(1);
}

const sql = postgres(
  resolveSecret("DATABASE_URL", process.env["DATABASE_URL"] as string, undefined, process.env),
  { onnotice: () => {}, max: 1 },
);
const print = (record: object) => process.stdout.write(`${JSON.stringify(record)}\n`);

try {
  // Deploy-time ensure establishes tenant scope and verifies table ownership itself.
  // Other operator commands retain their existing cross-tenant connection contract.
  if (command !== "ensure") {
    const problem = rlsBypassProblem(await readConnectingRole(sql));
    if (problem) throw new ServiceTokenError(problem);
  }

  switch (command) {
    case "create-subject": {
      const [slug, displayName, role] = args;
      const result = await createServiceSubject(sql, {
        tenantId: await tenantId(sql, slug),
        displayName: displayName ?? "",
        role: role ?? "",
      });
      print({ msg: "service_subject.created", ...result, role });
      break;
    }
    case "issue": {
      const [slug, subjectId, label, scopes, ttlDays] = args;
      if (!subjectId || !label || !scopes) throw new ServiceTokenError("subjectId, label and scopes are required");
      const issued = await issueServiceToken(sql, {
        tenantId: await tenantId(sql, slug),
        subjectId,
        label,
        scopes: scopes.split(",").map((scope) => scope.trim()).filter(Boolean),
        ttlSeconds: number(ttlDays, 90, "ttlDays") * DAY,
      });
      print({ msg: "service_token.issued", ...issued });
      break;
    }
    case "rotate": {
      const [tokenId, overlapHours, ttlDays] = args;
      if (!tokenId) throw new ServiceTokenError("tokenId is required");
      const rotated = await rotateServiceToken(sql, {
        tokenId,
        overlapSeconds: number(overlapHours, 24, "overlapHours") * 60 * 60,
        ttlSeconds: number(ttlDays, 90, "ttlDays") * DAY,
      });
      print({ msg: "service_token.rotated", previousTokenId: tokenId, ...rotated });
      break;
    }
    case "revoke": {
      const [tokenId] = args;
      if (!tokenId) throw new ServiceTokenError("tokenId is required");
      print({ msg: "service_token.revoked", tokenId, revoked: await revokeServiceToken(sql, tokenId) });
      break;
    }
    case "ensure": {
      const [slug, label, role, scopes, ttlDays, overlapHours] = args;
      if (!label || !role || !scopes) throw new ServiceTokenError("label, role and scopes are required");
      const ensured = await ensureServiceToken(sql, {
        tenantId: await tenantId(sql, slug),
        label,
        role,
        scopes: scopes.split(",").map((scope) => scope.trim()).filter(Boolean),
        token: suppliedToken,
        ttlSeconds: number(ttlDays, 365, "ttlDays") * DAY,
        overlapSeconds: number(overlapHours, 24, "overlapHours") * 60 * 60,
      });
      print({ msg: "service_token.ensured", label, ...ensured });
      if (ensured.renewalDue) {
        process.stderr.write(
          `service-token: ${label} token ${ensured.tokenId} expires at ${ensured.expiresAt}; ` +
            "generate a new value and store it before then\n",
        );
      }
      break;
    }
    case "list": {
      const [slug] = args;
      for (const token of await listServiceTokens(sql, await tenantId(sql, slug))) print(token);
      break;
    }
  }
} catch (error) {
  // A refusal is explained; anything else is reported without its message, which may quote input.
  const message = error instanceof ServiceTokenError ? error.message : "unexpected error";
  process.stderr.write(`service-token failed — ${message}\n`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
