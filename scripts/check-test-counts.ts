/**
 * README 테스트 수치 드리프트 검사.
 *
 * `README.md`는 패키지·앱별 테스트 수와 합계를 적는다. 이 수치는 두 번
 * 어긋났다 — 테스트를 늘린 커밋이 README를 같이 고치지 않았기 때문이다.
 * 사람의 규율로 막히지 않는다는 것이 두 번의 재발로 확인됐으므로 검사로 고정한다.
 *
 * 세는 방법과 그 이유:
 *
 * - **vitest**: `vitest list --json`. `DATABASE_URL`이 없으면 DB 의존 테스트가
 *   collect 단계에서 빠져 수치가 작게 나온다. 그래서 이 스크립트는 그것을
 *   요구한다 — CI `verify` job이 이미 설정한다.
 * - **Playwright**: `playwright test --list`. 브라우저 설치가 필요 없다(spec을
 *   읽기만 한다).
 * - **Foundry**: `.t.sol`의 `test*`·`invariant*` 함수를 센다. `forge test`를
 *   부르지 않는 이유는 이 검사가 도는 CI job에 foundry가 없기 때문이다.
 *   실제 실행값과의 일치는 `contracts` job이 따로 확인한다.
 * - **route**: `ROUTES` 계약의 길이. `openapi.json`의 operation 수와 같아야
 *   하지만 그 대조는 `check:openapi`가 이미 한다.
 *
 * `--write`를 주면 README를 실측값으로 고친다. CI는 인자 없이 돌려 드리프트를
 * 실패로 만든다 — `check:openapi`와 같은 형태다.
 *
 * **실측일은 수치가 바뀔 때만 옮긴다.** 매번 오늘로 찍으면 수치가 맞는 날에도
 * 실패하고, 그 실패는 자기 사유를 잘못 말한다(`recordedDate` 주석 참조).
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { ROUTES } from "@mpc/api-contract";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAPP = path.join(HERE, "..");
const README = path.join(DAPP, "README.md");

const WRITE = process.argv.includes("--write");

/** README 표의 행 하나. `label`은 첫 칸의 경로, `count`는 마지막 칸의 수. */
interface Row {
  readonly label: string;
  readonly count: number;
}

function run(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/** vitest project별 테스트 수. `DATABASE_URL` 없이는 셀 수 없다. */
function vitestCounts(): ReadonlyMap<string, number> {
  if (!process.env.DATABASE_URL) {
    console.error(
      "DATABASE_URL이 없다. 없으면 DB 의존 테스트가 collect에서 빠져 수치가 작게 나온다.\n" +
        '  DATABASE_URL="postgres://postgres@localhost:5432/mpc_test" pnpm check:counts',
    );
    process.exit(2);
  }
  const listed: readonly { readonly projectName: string }[] = JSON.parse(
    run("pnpm", ["exec", "vitest", "list", "--json"], DAPP),
  );
  return listed.reduce((acc, entry) => {
    const next = new Map(acc);
    next.set(entry.projectName, (acc.get(entry.projectName) ?? 0) + 1);
    return next;
  }, new Map<string, number>());
}

/** Playwright spec 수. `--list`는 브라우저 없이 돈다. */
function playwrightCount(): number {
  const out = run("pnpm", ["exec", "playwright", "test", "--list"], path.join(DAPP, "apps/web"));
  const matched = /Total:\s+(\d+)\s+tests?/.exec(out);
  if (!matched) throw new Error(`playwright --list 출력에서 총계를 찾지 못했다:\n${out}`);
  return Number(matched[1]);
}

/** `.t.sol`의 test·invariant 함수 수. forge 없이 센다. */
function foundryCount(): number {
  const dir = path.join(DAPP, "contracts/test");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".t.sol"))
    .flatMap((name) => readFileSync(path.join(dir, name), "utf8").match(/^\s+function (?:test|invariant)[A-Za-z0-9_]*\(/gm) ?? [])
    .length;
}

const vitest = vitestCounts();
const counts = {
  vitestTotal: [...vitest.values()].reduce((sum, n) => sum + n, 0),
  playwright: playwrightCount(),
  foundry: foundryCount(),
  routes: ROUTES.length,
};

/**
 * README 표에서 세는 행.
 *
 * `apps/web`은 빼 둔다. 그 칸은 단위 테스트와 E2E **둘**을 담으므로 다른 행처럼
 * 숫자 하나로 쓸 수 없다 — 아래에서 따로 쓴다. 처음에는 web에 vitest project가
 * 아예 없었고, 뒤에 그것이 생기면서 이 구분이 필요해졌다.
 */
const ROWS: readonly Row[] = [
  ...[...vitest.entries()]
    // web의 project 이름은 `@mpc/web`이 아니라 `web`이다(자체 vitest.config).
    .filter(([project]) => project !== "web")
    .map(([project, count]) => ({
      label: project.replace("@mpc/", ""),
      count,
    })),
];

/** web의 단위 테스트. project가 없으면 0이고, 그때는 E2E만 적는다. */
const webUnitCount = vitest.get("web") ?? 0;

/** `@mpc/api` → `apps/api`, `@mpc/canonical` → `packages/canonical`. */
const APPS = new Set(["api", "web", "worker"]);
const pathFor = (label: string): string => `${APPS.has(label) ? "apps" : "packages"}/${label}`;

const original = readFileSync(README, "utf8");
const today = new Date().toISOString().slice(0, 10);

/** 표의 마지막 칸(테스트 수)만 바꾼다. 설명 칸은 건드리지 않는다. */
function withRowCount(text: string, cell: string, count: number, prefix = ""): string {
  const pattern = new RegExp(`(^\\| \`${cell.replace("/", "\\/")}\` \\|[^|]*\\| )${prefix}\\d+( \\|$)`, "m");
  if (!pattern.test(text)) throw new Error(`README에서 \`${cell}\` 행을 찾지 못했다`);
  return text.replace(pattern, `$1${prefix}${count}$2`);
}

/** 수치만 바꾸는 치환들. 합계 줄의 **날짜는 건드리지 않는다.** */
const numericFixes = [
  ...ROWS.map((row) => (text: string) => withRowCount(text, pathFor(row.label), row.count)),
  // web 칸은 `단위 N · E2E M` 또는 `E2E M`이다. 다른 행과 형태가 다르므로
  // 셀 전체를 바꾼다.
  (text: string) => {
    const cell = webUnitCount > 0 ? `단위 ${webUnitCount} · E2E ${counts.playwright}` : `E2E ${counts.playwright}`;
    const pattern = /(^\| `apps\/web` \|[^|]*\| )(?:단위 \d+ · )?E2E \d+( \|$)/m;
    if (!pattern.test(text)) throw new Error("README에서 `apps/web` 행을 찾지 못했다");
    return text.replace(pattern, `$1${cell}$2`);
  },
  (text: string) => text.replace(/(\| `apps\/api` \|[^|]*?)\d+개 route/, `$1${counts.routes}개 route`),
  /**
   * 표 밖의 route 수치 — 2026-09-10 실사.
   *
   * 위 치환은 `| \`apps/api\` |` 행만 잡는다. 그래서 §아직 없는 것의 산문에
   * 있던 "59개 route"는 route가 79개가 된 뒤에도 그대로 남았고, 게이트는
   * 초록이었다. **한 곳만 검사하는 게이트는 나머지를 보증하지 않는다.**
   */
  (text: string) =>
    text.replace(/`ROUTES`\)의 \d+개 route/g, `\`ROUTES\`)의 ${counts.routes}개 route`),
  (text: string) => text.replace(/Foundry 테스트 \d+개/, `Foundry 테스트 ${counts.foundry}개`),
];

const SUMMARY = /^합계: vitest \d+ \+ Playwright \d+ \+ Foundry \d+(?: \+ route \d+)?\. \((\d{4}-\d{2}-\d{2}) .*?\)$/m;

/** 합계 줄을 실측값으로 바꾼다. 날짜는 호출자가 정한다. */
const withSummary =
  (date: string) =>
  (text: string): string =>
    text.replace(
      SUMMARY,
      `합계: vitest ${counts.vitestTotal} + Playwright ${counts.playwright} + Foundry ${counts.foundry} + route ${counts.routes}. (${date} 실측)`,
    );

/**
 * README에 적힌 실측일.
 *
 * **날짜를 무조건 오늘로 다시 찍으면 안 된다.** 그렇게 하면 수치가 전부 맞는
 * 날에도 `updated !== original`이 되어 CI가 "수치가 실측과 다르다"로 실패한다.
 * 실패 사유가 사실과 다르므로 보는 사람은 `--write`를 반사적으로 돌리게 되고,
 * 그러면 이 게이트는 드리프트를 잡는 장치가 아니라 통과 의식이 된다.
 *
 * 날짜는 **수치가 실제로 바뀔 때만** 옮긴다 — 그때가 다시 측정한 때다.
 */
const recordedDate = SUMMARY.exec(original)?.[1] ?? today;

/** 날짜를 그대로 둔 채 수치만 맞춘 것. original과 같으면 드리프트가 없다. */
const withRecordedDate = [...numericFixes, withSummary(recordedDate)].reduce(
  (text, apply) => apply(text),
  original,
);

const updated = [...numericFixes, withSummary(today)].reduce((text, apply) => apply(text), original);

if (withRecordedDate === original) {
  console.log(
    `README 수치 일치 — vitest ${counts.vitestTotal} · Playwright ${counts.playwright} · Foundry ${counts.foundry} · route ${counts.routes}`,
  );
  process.exit(0);
}

if (WRITE) {
  writeFileSync(README, updated);
  console.log(`README를 실측값으로 갱신했다 (${today}).`);
  process.exit(0);
}

console.error("README의 테스트 수치가 실측과 다르다.\n");
const originalLines = original.split("\n");
updated.split("\n").forEach((line, index) => {
  if (line !== originalLines[index]) {
    console.error(`  ${README}:${index + 1}`);
    console.error(`  - ${originalLines[index]}`);
    console.error(`  + ${line}\n`);
  }
});
console.error("고치려면: pnpm check:counts --write");
process.exit(1);
