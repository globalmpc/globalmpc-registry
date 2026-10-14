import { parseArgs } from "node:util";
import postgres from "postgres";
import { resolveSecret } from "@mpc/config";
import { buildOutboxHandlers } from "./outbox-handlers.js";
import { ReplayInputError, replayEvents } from "./outbox-replay.js";

/**
 * Outbox replay command — see `outbox-replay.ts`.
 *
 *   pnpm --filter @mpc/jobs-worker outbox:replay --event-type project.export.requested
 *   pnpm --filter @mpc/jobs-worker outbox:replay --event-id <uuid> --apply --reason "..."
 *
 * **Dry run is the default.** Writing requires `--apply`, so the command an operator pastes
 * from a runbook shows its effect before it has one.
 */

const USAGE = `Usage: outbox:replay [--event-id <uuid>]... [--event-type <type>]
                     [--include-published] [--skip-handler <name>]... [--limit <n>]
                     [--apply --reason <text>]`;

const { values } = parseArgs({
  options: {
    "event-id": { type: "string", multiple: true },
    "event-type": { type: "string" },
    "include-published": { type: "boolean", default: false },
    "skip-handler": { type: "string", multiple: true },
    limit: { type: "string", default: "100" },
    apply: { type: "boolean", default: false },
    reason: { type: "string", default: "" },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

let databaseUrl: string;
try {
  databaseUrl = resolveSecret("DATABASE_URL", process.env["DATABASE_URL"]);
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
}

const sql = postgres(databaseUrl, { onnotice: () => {}, max: 1 });
// Handlers are built only to name them and read their inbox keys; replay never calls them.
const handlers = buildOutboxHandlers(sql, () => undefined);

try {
  const result = await replayEvents(
    sql,
    handlers,
    {
      eventIds: values["event-id"] ?? [],
      ...(values["event-type"] === undefined ? {} : { eventType: values["event-type"] }),
      includePublished: values["include-published"],
      limit: Number(values.limit),
    },
    {
      dryRun: !values.apply,
      skipHandlers: values["skip-handler"] ?? [],
      reason: values.reason,
    },
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  if (error instanceof ReplayInputError) {
    process.stderr.write(`${error.message}\n${USAGE}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`outbox replay failed: ${String(error)}\n`);
    process.exitCode = 1;
  }
} finally {
  await sql.end();
}
