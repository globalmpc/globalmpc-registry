import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import postgres from "postgres";
import { registerErrorHandler } from "../src/plugins/error-handler.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * What the driver hands the API when the database refuses — the fields our routes map.
 *
 * Routes and the error handler read `code`, `constraint_name` and the `message` prefix of a
 * refusal (`ACTOR_SUSPENDED:` under `42501`, `23505` on a named constraint, `40001`/`40P01`).
 * `error-handler.test.ts` checks the mapping with hand-built errors; this checks that a real
 * refusal from PostgreSQL, raised inside `sql.begin` as the routes raise it, still carries those
 * fields. A driver upgrade that renamed or dropped one would otherwise turn a 403/409 into a 500,
 * or let a duplicate through a route that expects to recognise it.
 */
describeDb("database refusals as the API sees them", () => {
  const schema = `err_contract_${process.pid}_${Date.now()}`;
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = postgres(process.env["DATABASE_URL"]!, { onnotice: () => {}, max: 1 });
    await sql.unsafe(`
      CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.items (
        id int,
        CONSTRAINT items_id_key UNIQUE (id)
      );
      CREATE FUNCTION ${schema}.refuse_at_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'A row requires an approved proposal' USING ERRCODE = 'raise_exception';
      END $$;
      CREATE TABLE ${schema}.guarded (id int);
      CREATE CONSTRAINT TRIGGER guarded_requires_approval AFTER INSERT ON ${schema}.guarded
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${schema}.refuse_at_commit();
    `);
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await sql.end();
  });

  async function refusal(run: (tx: postgres.TransactionSql) => Promise<unknown>): Promise<Record<string, unknown>> {
    const caught = await sql.begin(run).then(() => null, (error: unknown) => error);
    expect(caught).toBeInstanceOf(Error);
    return caught as Record<string, unknown>;
  }

  async function answer(error: unknown) {
    const app = Fastify();
    await registerErrorHandler(app);
    app.get("/", async () => {
      throw error;
    });
    try {
      const response = await app.inject({ method: "GET", url: "/" });
      return { status: response.statusCode, body: response.json() as Record<string, unknown> };
    } finally {
      await app.close();
    }
  }

  it("keeps the SQLSTATE and message of a raised insufficient_privilege, which answers 403", async () => {
    const error = await refusal((tx) => tx`
      DO $$ BEGIN
        RAISE EXCEPTION 'ACTOR_SUSPENDED: subject is suspended' USING ERRCODE = 'insufficient_privilege';
      END $$
    `);
    expect(error).toMatchObject({ code: "42501", severity: "ERROR" });
    expect(error["message"]).toMatch(/^ACTOR_SUSPENDED:/);
    expect(await answer(error)).toMatchObject({ status: 403, body: { code: "ACTOR_SUSPENDED", retryable: false } });
  });

  it("keeps any other insufficient_privilege an internal error", async () => {
    const error = await refusal((tx) => tx`
      DO $$ BEGIN RAISE EXCEPTION 'permission denied for table subjects' USING ERRCODE = 'insufficient_privilege'; END $$
    `);
    expect(error["code"]).toBe("42501");
    const { status, body } = await answer(error);
    expect(status).toBe(500);
    expect(JSON.stringify(body)).not.toMatch(/permission denied/);
  });

  it("names the violated constraint of a unique_violation", async () => {
    await sql`INSERT INTO ${sql(schema)}.items (id) VALUES (1)`;
    const error = await refusal((tx) => tx`INSERT INTO ${tx(schema)}.items (id) VALUES (1)`);
    expect(error).toMatchObject({
      code: "23505",
      constraint_name: "items_id_key",
      table_name: "items",
      schema_name: schema,
    });
    expect(error["detail"]).toMatch(/already exists/);
  });

  it("keeps serialization_failure and deadlock_detected retryable 409s", async () => {
    for (const [condition, code] of [["serialization_failure", "40001"], ["deadlock_detected", "40P01"]] as const) {
      const error = await refusal((tx) => tx.unsafe(
        `DO $$ BEGIN RAISE EXCEPTION 'conflict' USING ERRCODE = '${condition}'; END $$`,
      ));
      expect(error["code"]).toBe(code);
      expect(await answer(error)).toMatchObject({ status: 409, body: { code: "CONCURRENT_REQUEST", retryable: true } });
    }
  });

  it("rejects with the trigger's own refusal when a deferred constraint fails at COMMIT, and keeps nothing", async () => {
    const error = await refusal((tx) => tx`INSERT INTO ${tx(schema)}.guarded (id) VALUES (1)`);
    expect(error).toMatchObject({ code: "P0001", message: "A row requires an approved proposal" });
    const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(schema)}.guarded`;
    expect(row!.n).toBe(0);
  });
});
