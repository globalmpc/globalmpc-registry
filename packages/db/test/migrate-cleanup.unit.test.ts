import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { runMigrations, type Migration } from "../src/migrate.js";

/**
 * What the runner does after a migration fails: the cleanup (ROLLBACK, the unlock) never replaces
 * the error that says what happened, and on a dead connection nothing more is sent and the
 * connection is not handed back — postgres.js never settles a query sent on a reserved connection
 * after it closed, and releasing it would put a closed connection among the open ones.
 *
 * A scripted stand-in for the reserved connection: a real backend killed mid-run makes postgres.js
 * 3.4.9 raise an uncaught 57P01 of its own, whoever holds the connection.
 */
function scripted(fail: (text: string) => Error | undefined) {
  const sent: string[] = [];
  let released = 0;
  const run = (text: string) => {
    sent.push(text.replace(/\s+/g, " ").trim());
    const error = fail(text);
    if (error) return Promise.reject(error);
    if (text.includes("pg_try_advisory_lock")) return Promise.resolve([{ locked: true }]);
    return Promise.resolve([]);
  };
  const session = Object.assign(
    (strings: TemplateStringsArray) => run(strings.join("$")),
    { unsafe: (text: string) => run(text), release: () => void (released += 1) },
  );
  const sql = { reserve: async () => session } as unknown as postgres.Sql;
  return { sql, sent, released: () => released };
}

const err = (props: Record<string, string>) => Object.assign(new Error(props["message"] ?? "x"), props);
const transactional: Migration = { name: "0001_probe.sql", sql: "PROBE STATEMENT;" };
const outside: Migration = { name: "0002_probe.sql", sql: "-- migrate:no-transaction\nPROBE OUTSIDE;" };

describe("runner cleanup after a failure", () => {
  it.each([
    ["the server ended the session", { code: "57P01", severity: "FATAL", message: "terminated" }],
    ["postgres.js lost the socket", { code: "CONNECTION_CLOSED", message: "closed" }],
  ])("sends nothing more and keeps the connection when %s", async (_, props) => {
    for (const migration of [transactional, outside]) {
      const original = err(props);
      const db = scripted((text) => (text.includes("PROBE") ? original : undefined));
      await expect(runMigrations(db.sql, [migration])).rejects.toBe(original);
      const after = db.sent.slice(db.sent.findIndex((text) => text.includes("PROBE")) + 1);
      expect(after).toEqual([]);
      expect(db.released()).toBe(0);
    }
  });

  it("rethrows the migration's error when the ROLLBACK after it fails, and sends nothing after a lost one", async () => {
    const original = err({ code: "42P01", message: "relation does not exist" });
    const db = scripted((text) =>
      text.includes("PROBE") ? original : text === "ROLLBACK" ? err({ code: "CONNECTION_CLOSED" }) : undefined,
    );
    await expect(runMigrations(db.sql, [transactional])).rejects.toBe(original);
    expect(db.sent.at(-1)).toBe("ROLLBACK");
    expect(db.released()).toBe(0);
  });

  it("rethrows the migration's error when the unlock fails on a live connection, and hands it back", async () => {
    const original = err({ code: "42P01", message: "relation does not exist" });
    const db = scripted((text) =>
      text.includes("PROBE") ? original : text.includes("pg_advisory_unlock") ? err({ code: "25P02" }) : undefined,
    );
    await expect(runMigrations(db.sql, [outside])).rejects.toBe(original);
    // The refused unlock is retried once after ending the failed transaction.
    expect(db.sent.slice(-3)).toEqual([
      expect.stringContaining("pg_advisory_unlock"),
      "ROLLBACK",
      expect.stringContaining("pg_advisory_unlock"),
    ]);
    expect(db.released()).toBe(1);
  });

  it("releases the lock and the connection after a success", async () => {
    const db = scripted(() => undefined);
    expect(await runMigrations(db.sql, [transactional])).toEqual([transactional.name]);
    expect(db.sent.at(-1)).toContain("pg_advisory_unlock");
    expect(db.released()).toBe(1);
  });
});
