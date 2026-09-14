import { describe, expect, it } from "vitest";
import { listMigrations } from "../src/migrate.js";

/**
 * Migration file naming rules — runs without a database.
 *
 * **Why this file exists:** two people wrote a migration with the same number (`0026`), and
 * that **did not surface until merge.** Each branch had only one of the files, so nothing was
 * wrong there.
 *
 * The danger is not that the files collide — the names differ, so both are applied. The danger
 * is **order**. The number is the application order, so two files with the same number leave
 * the order to the accident of alphabetical sorting, and if one depends on the other's table,
 * success and failure differ per environment.
 *
 * `runMigrations` compares checksums, so it catches an **edited** migration. It does not catch
 * a duplicated number — the names differ. This file covers that.
 */

const NAME_PATTERN = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

describe("migration file names", () => {
  const migrations = listMigrations();

  it("there is something to apply", () => {
    // With an empty list every check below passes silently.
    expect(migrations.length).toBeGreaterThan(0);
  });

  it("follow the `NNNN_snake_case.sql` format", () => {
    const wrong = migrations.map((m) => m.name).filter((name) => !NAME_PATTERN.test(name));
    expect(wrong).toEqual([]);
  });

  it("numbers do not collide", () => {
    const byNumber = new Map<string, string[]>();
    for (const { name } of migrations) {
      const number = NAME_PATTERN.exec(name)?.[1];
      if (!number) continue;
      byNumber.set(number, [...(byNumber.get(number) ?? []), name]);
    }

    const collisions = [...byNumber.entries()]
      .filter(([, names]) => names.length > 1)
      .map(([number, names]) => `${number}: ${names.join(", ")}`);

    // A collision leaves the order to alphabetical accident. The later author moves the number.
    expect(collisions).toEqual([]);
  });

  it("numbers run from 1 without gaps", () => {
    const numbers = migrations
      .map((m) => NAME_PATTERN.exec(m.name)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number)
      .sort((a, b) => a - b);

    /**
     * Why gaps are rejected: a missing number could be **not yet merged** or **deleted**. In
     * the first case the order flips after merge; in the second, environments that already
     * applied it and new ones diverge.
     */
    const gaps = numbers.filter((n, index) => n !== index + 1);
    expect(gaps).toEqual([]);
  });

  it("file-name order equals number order", () => {
    // `runMigrations` applies in ascending file-name order. If the two differ, the order a
    // reader sees is not the order that runs.
    const byName = migrations.map((m) => m.name);
    const byNumber = [...byName].sort(
      (a, b) => Number(NAME_PATTERN.exec(a)?.[1]) - Number(NAME_PATTERN.exec(b)?.[1]),
    );
    expect(byName).toEqual(byNumber);
  });
});
