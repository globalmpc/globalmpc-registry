import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { SESSION_CONNECTION } from "../src/session.js";

/**
 * Which calendar day "today" is.
 *
 * Expiry is judged against `current_date` (the expiry sweep, the document graph, detection after
 * an upload). `current_date` follows the session time zone, and without a setting that is
 * whatever the server or database was configured with. These tests stand up a database whose
 * default is not UTC and check that a session opened with `SESSION_CONNECTION` still reads UTC.
 */
const DATABASE_URL = process.env["DATABASE_URL"];
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb("session time zone", () => {
  const dbName = `tz_probe_${process.pid}_${Date.now()}`;
  let admin: postgres.Sql;
  let probeUrl: string;

  beforeAll(async () => {
    admin = postgres(DATABASE_URL!, { onnotice: () => {}, max: 1 });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    // A deployment whose database default is Ulaanbaatar time (UTC+8).
    await admin.unsafe(`ALTER DATABASE ${dbName} SET TimeZone = 'Asia/Ulaanbaatar'`);
    const url = new URL(DATABASE_URL!);
    url.pathname = `/${dbName}`;
    probeUrl = url.toString();
  });

  afterAll(async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  async function read(options: postgres.Options<Record<string, never>>) {
    const sql = postgres(probeUrl, { onnotice: () => {}, max: 1, ...options });
    try {
      const [row] = await sql<{ zone: string; utc_today: boolean }[]>`
        SELECT current_setting('TimeZone') AS zone,
               current_date = (now() AT TIME ZONE 'UTC')::date AS utc_today
      `;
      return row!;
    } finally {
      await sql.end();
    }
  }

  it("inherits the database default when nothing is set", async () => {
    expect((await read({})).zone).toBe("Asia/Ulaanbaatar");
  });

  it("reads UTC, and today is the UTC day, when opened with SESSION_CONNECTION", async () => {
    const row = await read({ connection: SESSION_CONNECTION });
    expect(row.zone).toBe("UTC");
    expect(row.utc_today).toBe(true);
  });
});
