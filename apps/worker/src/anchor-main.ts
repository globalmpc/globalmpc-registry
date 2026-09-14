import postgres from "postgres";
import { loadAnchorConfig } from "./anchor-config.js";
import { createHeartbeat } from "./heartbeat.js";
import { chainBacklog, stepOnce } from "./anchor-submitter.js";
import { createViemChainClient, signerAddress } from "./viem-chain-client.js";
import { createSafeClient } from "./safe-client.js";

/**
 * anchor 제출 루프.
 *
 * 한 번에 트랜잭션 하나씩 전진시킨다. 배치로 묶으면 하나의 RPC 실패가 나머지의
 * 진행을 되돌린다.
 *
 * 이 프로세스는 **여러 tenant를 가로질러** 동작하므로 `mpc_worker` role로 붙는다
 * (0012). superuser로 붙이면 필요 이상의 권한을 갖게 된다.
 */

function emit(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

let config;
try {
  config = loadAnchorConfig(process.env);
} catch (error) {
  process.stderr.write(`${String(error instanceof Error ? error.message : error)}\n`);
  process.exit(1);
}

// prepared statement를 쓰지 않는다. worker는 오래 붙어 있는 프로세스라 그 사이에
// migration이 돌면 캐시된 계획의 결과 형식이 어긋나 루프가 죽는다. anchor 제출은
// 초당 수천 건이 아니므로 준비된 계획의 이득보다 중단 위험이 크다.
const sql = postgres(config.databaseUrl, { onnotice: () => {}, prepare: false });
const chain = createViemChainClient({
  rpcUrl: config.rpcUrl,
  chainId: config.chainId,
  contractAddress: config.contractAddress as `0x${string}`,
  signerPrivateKey: config.signerPrivateKey,
});

/**
 * Safe 연동.
 *
 * 주소만 있고 서비스 URL이 없으면 제안을 DB에만 남긴다 — 그러면 아무도 서명할
 * 수 없으므로, 그 구성은 "제안 경로가 준비되지 않았다"는 표시로 남는다.
 */
const safe =
  config.safeAddress && process.env["SAFE_SERVICE_URL"]
    ? createSafeClient({
        serviceUrl: process.env["SAFE_SERVICE_URL"],
        chainId: config.chainId,
        proposerPrivateKey: config.signerPrivateKey,
      })
    : undefined;

let running = true;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    running = false;
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

emit({
  level: "info",
  msg: "anchor.worker.started",
  chainId: config.chainId,
  contractAddress: config.contractAddress,
  // 주소는 공개 정보다. 개인키는 어디에도 찍지 않는다.
  signer: signerAddress(config.signerPrivateKey),
  confirmationDepth: config.confirmationDepth,
  // 이 체인에서 EOA로 직접 올릴 수 있는지. 아니면 Safe 제안만 만든다.
  submissionMode: config.eoaAllowedChainIds.includes(config.chainId)
    ? "eoa"
    : config.safeAddress
      ? "safe_proposal"
      : "blocked",
  safeAddress: config.safeAddress,
  safeService: process.env["SAFE_SERVICE_URL"] ?? null,
});

const heartbeat = createHeartbeat(sql, "anchor");

while (running) {
  try {
    const result = await stepOnce(sql, chain, config, emit, safe);

    // 큐가 비어 있어도 신호를 남긴다 — 제출할 것이 없는 것과 worker가 죽은
    // 것을 구분하는 것이 이 신호의 목적이다.
    await heartbeat({ handled: result.handled });

    if (!result.handled) {
      const backlog = await chainBacklog(sql, config.chainId);
      if (backlog.needsAttention > 0) {
        // 사람이 봐야 하는 것을 조용히 두지 않는다. reverted·dropped·재조정
        // 필요는 자동으로 풀리지 않는다.
        emit({ level: "warn", msg: "anchor.needs_attention", ...backlog });
      }
      await sleep(config.pollIntervalMs);
    }
  } catch (error) {
    emit({ level: "error", msg: "anchor.loop.failed", error: String(error) });
    await sleep(config.pollIntervalMs);
  }
}

emit({ level: "info", msg: "anchor.worker.stopped" });
await sql.end();
