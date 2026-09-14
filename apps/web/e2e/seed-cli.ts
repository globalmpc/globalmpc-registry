import { seedE2eDatabase } from "./seed";

/**
 * seed 실행 진입점.
 *
 * top-level await를 쓰지 않는다. `apps/web`은 Next.js 앱이라 package.json에
 * `type: module`이 없고, tsx가 이 파일을 CJS로 변환하기 때문이다.
 */
const url = process.env["DATABASE_URL"];

if (!url) {
  process.stderr.write("DATABASE_URL이 필요하다\n");
  process.exit(1);
}

seedE2eDatabase(url)
  .then(() => {
    process.stdout.write("E2E seed 완료\n");
  })
  .catch((error: unknown) => {
    process.stderr.write(`E2E seed 실패: ${String(error)}\n`);
    process.exit(1);
  });
