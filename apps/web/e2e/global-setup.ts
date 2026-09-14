import { execFileSync } from "node:child_process";
import { connect } from "node:net";
import postgres from "postgres";

/**
 * 서버가 뜨기 전에 DB를 준비한다.
 *
 * seed를 직접 import하지 않고 자식 프로세스로 실행한다. Playwright는 설정 파일을
 * CJS로 로드하는데 `@mpc/db`는 마이그레이션 경로를 `import.meta.url`로 찾는
 * ESM 모듈이라 직접 import하면 깨진다. 프로세스를 분리하면 tsx가 ESM으로 실행한다.
 */

/**
 * 같은 DB에 두 실행이 겹치지 않게 한다.
 *
 * **왜 필요한가:** seed는 스키마를 **통째로 드롭하고 다시 만든다.** 두 번째 실행이
 * 시작되면 첫 번째 실행의 테이블이 그 아래에서 사라지고, 첫 번째는 자기가 만든
 * 프로젝트를 못 찾는 실패로 나타난다. 원인이 자기 자신이 아니므로 **코드 문제로
 * 오인하기 쉽다** — 실제로 그렇게 세 건을 잘못 조사했다.
 *
 * advisory lock을 쓰는 이유는 **프로세스가 죽어도 알아서 풀리기 때문**이다. 파일
 * 잠금이나 표의 행은 강제 종료된 실행의 흔적이 남아 다음 실행을 막는다.
 *
 * 잠금은 이 커넥션이 살아 있는 동안만 유지된다. globalSetup이 끝나도 커넥션을
 * 닫지 않고 teardown까지 들고 있는 것이 그래서다.
 */
const LOCK_KEY = 0x6d70_6332; // "mpc2" — 이 저장소의 E2E 실행 하나를 뜻한다.

let lockConnection: postgres.Sql | undefined;

async function acquireRunLock(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const [row] = await sql<{ locked: boolean }[]>`
    SELECT pg_try_advisory_lock(${LOCK_KEY}) AS locked
  `;

  if (!row?.locked) {
    await sql.end({ timeout: 5 });
    throw new Error(
      [
        "같은 E2E 데이터베이스에 다른 실행이 이미 붙어 있다.",
        "",
        "  seed가 스키마를 통째로 다시 만들므로 두 실행이 겹치면 먼저 시작한 쪽이",
        "  자기 데이터를 잃는다. 그 실패는 코드 문제처럼 보인다.",
        "",
        "  끝나기를 기다리거나, 다른 `E2E_DATABASE_URL`을 준다.",
      ].join("\n"),
    );
  }

  lockConnection = sql;
}

/**
 * 이미 떠 있는 서버를 재사용하는지 알린다.
 *
 * `playwright.config.ts`의 `reuseExistingServer`는 CI가 아닐 때 켜져 있다. 포트에
 * 무언가 떠 있으면 playwright는 **자기 `env`를 적용하지 않고 그것을 그대로 쓴다.**
 *
 * **그래서 설정을 고쳐도 아무 일이 일어나지 않는다.** 2026-09-09에 그 상태로
 * 12분짜리 실행을 한 번 버렸다 — `RATE_LIMIT_MAX`를 올렸는데 옛 서버가 재사용돼
 * 실패가 그대로였고, 설정이 틀린 줄 알고 다른 곳을 뒤졌다.
 *
 * 막지는 않는다. 일부러 자기 서버를 띄우고 `E2E_SKIP_SEED=1`로 도는 흐름이
 * 정상이기 때문이다. **말하지 않는 것만 고친다.**
 */
async function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function warnAboutReusedServers(): Promise<void> {
  const reused = (
    await Promise.all(
      [
        { port: 3001, name: "API" },
        { port: 3000, name: "web" },
      ].map(async (server) => ((await isListening(server.port)) ? server : null)),
    )
  ).filter((server) => server !== null);

  if (reused.length === 0) return;

  const names = reused.map((server) => `${server.name}(:${server.port})`).join(" · ");
  process.stdout.write(
    [
      `이미 떠 있는 서버를 재사용한다 — ${names}`,
      "  playwright.config.ts의 env는 그 서버에 적용되지 않는다. 설정을 바꿨다면",
      "  그 프로세스를 먼저 끝낸다.",
      "",
    ].join("\n"),
  );
}

/**
 * seed가 들어가는 DB와 앱이 붙는 DB가 같은지 본다.
 *
 * **두 URL이 따로 있다.** seed는 superuser로, 앱은 RLS가 걸린 role로 붙기
 * 때문이다. 하나만 덮어쓰면 나머지는 기본값(포트 55432)을 쓰고, 그 순간
 * **seed와 앱이 다른 데이터베이스를 본다.**
 *
 * 그 상태의 증상이 고약하다. 앱이 붙을 DB가 아예 없어도 API는 뜨고, 공개 화면은
 * 빈 상태로 정상 렌더되어 통과한다. **로그인이 필요한 것만 전부 깨진다** — 화면에는
 * "Sign-in failed"만 보이고 어디에도 DB 이야기가 없다.
 *
 * 실제로 2026-09-09에 이 상태로 42건을 코드 문제로 오인하고 세 시간을 썼다.
 * 사용자·비밀번호는 다를 수 있으므로 **호스트·포트·데이터베이스 이름만** 본다.
 */
function assertAppUrlMatchesSeed(seedUrl: string, appUrl: string | undefined): void {
  if (!appUrl) return;

  const target = (raw: string): string => {
    const parsed = new URL(raw);
    return `${parsed.hostname}:${parsed.port}${parsed.pathname}`;
  };

  const seedTarget = target(seedUrl);
  const appTarget = target(appUrl);
  if (seedTarget === appTarget) return;

  throw new Error(
    [
      "seed가 넣는 DB와 앱이 붙는 DB가 다르다.",
      "",
      `  seed  → ${seedTarget}   (E2E_DATABASE_URL)`,
      `  앱    → ${appTarget}   (E2E_APP_DATABASE_URL)`,
      "",
      "  이 상태에서는 공개 화면만 통과하고 로그인이 필요한 것이 전부 깨진다.",
      "  화면에는 원인이 보이지 않는다.",
      "",
      "  둘 다 주거나, 둘 다 기본값을 쓴다.",
    ].join("\n"),
  );
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  // `playwright.config.ts`가 이 값을 환경에 넣는다. 기본값은 그쪽 하나뿐이며 여기
  // 두지 않는다 — 예전에 두 곳의 포트가 갈려 seed는 55433, 앱은 55432를 보면서
  // 화면에는 예전 seed가 남아 있는 상태가 됐다.
  const url = process.env["E2E_DATABASE_URL"];
  if (!url) {
    throw new Error("E2E_DATABASE_URL이 없다. playwright.config.ts를 거쳐 실행한다.");
  }

  assertAppUrlMatchesSeed(url, process.env["E2E_APP_DATABASE_URL"]);
  await acquireRunLock(url);
  await warnAboutReusedServers();

  // seed는 스키마를 통째로 다시 만든다. anchor worker처럼 밖에서 붙어 있는
  // 프로세스가 있으면 그것을 실행 중에 끊는다. 그런 구성에서는 호출자가 seed를
  // 먼저 돌리고 여기서는 건너뛴다.
  //
  // **잠금은 그때도 잡는다.** seed를 건너뛰는 실행도 같은 DB를 쓰므로 겹치면
  // 서로의 데이터를 본다.
  if (process.env["E2E_SKIP_SEED"] === "1") {
    process.stdout.write("E2E seed 건너뜀 (E2E_SKIP_SEED=1)\n");
  } else {
    execFileSync("pnpm", ["exec", "tsx", "e2e/seed-cli.ts"], {
      cwd: __dirname + "/..",
      env: { ...process.env, DATABASE_URL: url },
      stdio: "inherit",
    });
  }

  return async () => {
    // 커넥션을 닫으면 잠금도 풀린다. 명시적으로 푸는 것은 실패했을 때 무엇이
    // 잘못됐는지 로그에 남기기 위해서다.
    if (!lockConnection) return;
    await lockConnection`SELECT pg_advisory_unlock(${LOCK_KEY})`.catch(() => undefined);
    await lockConnection.end({ timeout: 5 }).catch(() => undefined);
    lockConnection = undefined;
  };
}
