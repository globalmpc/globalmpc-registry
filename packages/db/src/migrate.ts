import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

/**
 * 마이그레이션 러너.
 *
 * 각 파일은 하나의 트랜잭션에서 실행되고 `core.schema_migrations`에 기록된다.
 * 이미 적용된 파일은 건너뛴다. 적용 순서는 파일명 오름차순이다.
 *
 * 건너뛸 때 **이름만 보지 않는다.** 이름만 비교하면 이미 적용된 파일을 나중에
 * 고쳐도 그대로 통과하고, 환경마다 스키마가 갈린 채 아무 데도 드러나지 않는다.
 * 그래서 본문 해시를 함께 적어 두고 재실행 때 대조한다.
 */

export interface Migration {
  readonly name: string;
  readonly sql: string;
}

/** 마이그레이션 본문 해시. 적용 시점의 내용을 고정한다. */
export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

export const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

export function listMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => ({
      name: file,
      sql: readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"),
    }));
}

export async function runMigrations(
  sql: postgres.Sql,
  migrations: readonly Migration[] = listMigrations(),
): Promise<string[]> {
  await sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS core;
    CREATE TABLE IF NOT EXISTS core.schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE core.schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT;
  `);

  const applied = await sql<{ name: string; checksum: string | null }[]>`
    SELECT name, checksum FROM core.schema_migrations
  `;
  const appliedChecksums = new Map(applied.map((row) => [row.name, row.checksum]));
  const executed: string[] = [];

  for (const migration of migrations) {
    const checksum = migrationChecksum(migration.sql);

    if (appliedChecksums.has(migration.name)) {
      const recorded = appliedChecksums.get(migration.name) ?? null;

      // checksum 컬럼이 없던 시절에 적용된 행이다. 그때의 본문을 알 수 없으므로
      // 지금 것을 기준으로 삼는다 — 여기서 막으면 기존 DB가 전부 못 올라온다.
      if (recorded === null) {
        await sql`
          UPDATE core.schema_migrations SET checksum = ${checksum} WHERE name = ${migration.name}
        `;
        continue;
      }

      if (recorded !== checksum) {
        throw new Error(
          `마이그레이션 ${migration.name}의 체크섬이 적용 시점과 다르다 `
            + `(기록 ${recorded.slice(0, 12)}…, 현재 ${checksum.slice(0, 12)}…). `
            + "적용된 마이그레이션은 고치지 않는다 — 새 파일을 추가한다.",
        );
      }
      continue;
    }

    await sql.begin(async (tx) => {
      await tx.unsafe(migration.sql);
      await tx`
        INSERT INTO core.schema_migrations (name, checksum)
        VALUES (${migration.name}, ${checksum})
      `;
    });
    executed.push(migration.name);
  }

  return executed;
}

// CLI 진입점은 `cli.ts`에 있다. 이 모듈은 CJS로 로드될 수 있으므로
// (예: Playwright globalSetup) `import.meta`를 쓰지 않는다.
