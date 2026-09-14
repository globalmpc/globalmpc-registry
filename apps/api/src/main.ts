import { loadConfig } from "./config.js";
import { createDb } from "./db.js";
import { buildServer } from "./server.js";

const config = loadConfig(process.env);
const sql = createDb(config);
const app = await buildServer(config, sql);

// 어떤 비밀을 어떤 경로로 읽었는지 시작 시 한 번 남긴다. 값이 아니라 scheme과
// 지문이다 — 운영에서 "지금 어떤 키를 쓰고 있나"를 묻는 순간 그 답이 로그에
// 있어야 하고, 동시에 로그가 유출 경로가 되어서는 안 된다.
app.log.info({ secrets: config.secretAudit }, "secret sources resolved");

await app.listen({ port: config.port, host: "0.0.0.0" });

/**
 * 종료 처리.
 *
 * 컨테이너 오케스트레이터는 SIGTERM을 보내고 정해진 시간 뒤에 SIGKILL한다.
 * 진행 중인 요청을 마치지 못하면 클라이언트는 응답 없이 끊긴 것을 재시도로
 * 오인한다 — mutation에 Idempotency-Key가 있어 중복은 막지만, 그 전에 정상
 * 종료를 시도하는 것이 맞다.
 */
let shuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // 두 번째 신호는 무시한다. 종료 중에 다시 close()를 부르면 예외가 난다.
    if (shuttingDown) return;
    shuttingDown = true;

    void (async () => {
      try {
        await app.close();
        await sql.end({ timeout: 5 });
        process.exit(0);
      } catch (error) {
        app.log.error({ err: error }, "graceful shutdown failed");
        process.exit(1);
      }
    })();
  });
}
