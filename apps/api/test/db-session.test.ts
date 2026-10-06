import { describe, expect, it } from "vitest";
import { createDb } from "../src/db.js";
import type { AppConfig } from "../src/config.js";

/** The API's pool opens every session in UTC, so expiry reads the UTC day (`@mpc/db` session.ts). */
const DATABASE_URL = process.env["DATABASE_URL"];
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb("API connection pool", () => {
  it("opens sessions in UTC", async () => {
    const sql = createDb({ databaseUrl: DATABASE_URL! } as AppConfig);
    try {
      const [row] = await sql<{ zone: string }[]>`SELECT current_setting('TimeZone') AS zone`;
      expect(row?.zone).toBe("UTC");
    } finally {
      await sql.end();
    }
  });
});
