import type { Hex } from "viem";
import { resolveSecret } from "@mpc/config";
import type { SubmitterConfig } from "./anchor-submitter.js";

/**
 * anchor worker 설정.
 *
 * 시작할 때 전부 검사한다. 누락을 런타임까지 미루면 batch가 쌓인 뒤에야 제출이
 * 안 되는 것을 알게 된다.
 *
 * **비밀은 기본값을 두지 않는다.** 기본 키가 있으면 누군가는 그것으로 운영한다.
 *
 * 서명 키와 DB URL은 값 대신 참조로 받을 수 있다(`file:`·`env:`). 배포 환경에서
 * 개인키가 프로세스 환경에 남지 않는 것이 목적이다 — `docker inspect` 한 번이면
 * anchor signer 지갑이 통째로 노출된다.
 */

export interface AnchorEnv {
  readonly DATABASE_URL?: string;
  readonly CHAIN_RPC_URL?: string;
  readonly CHAIN_ID?: string;
  readonly ANCHOR_CONTRACT_ADDRESS?: string;
  readonly ANCHOR_SIGNER_PRIVATE_KEY?: string;
  readonly ANCHOR_CONFIRMATIONS?: string;
  readonly ANCHOR_FEE_CAP_GWEI?: string;
  readonly ANCHOR_DAILY_SPEND_CAP_WEI?: string;
  readonly ANCHOR_MAX_ATTEMPTS?: string;
  readonly ANCHOR_DROP_TIMEOUT_MS?: string;
  readonly ANCHOR_POLL_MS?: string;
  readonly ANCHOR_EOA_CHAIN_IDS?: string;
  readonly ANCHOR_SAFE_ADDRESS?: string;
  readonly ANCHOR_REORG_WATCH_MS?: string;
  readonly SAFE_SERVICE_URL?: string;
  readonly ANCHOR_RECHECK_MS?: string;
}

export interface AnchorConfig extends SubmitterConfig {
  readonly databaseUrl: string;
  readonly rpcUrl: string;
  readonly signerPrivateKey: Hex;
  readonly pollIntervalMs: number;
}

function required(env: AnchorEnv, key: keyof AnchorEnv): string {
  const value = env[key];
  if (!value) throw new Error(`${key}가 필요하다`);
  return value;
}

/** 비밀 참조를 값으로 바꾼다. 실패 메시지에 값은 들어가지 않는다. */
function requiredSecret(env: AnchorEnv, key: keyof AnchorEnv): string {
  return resolveSecret(key, env[key], undefined, env as NodeJS.ProcessEnv);
}

export function loadAnchorConfig(env: AnchorEnv): AnchorConfig {
  const contractAddress = required(env, "ANCHOR_CONTRACT_ADDRESS").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(contractAddress)) {
    throw new Error("ANCHOR_CONTRACT_ADDRESS가 주소 형식이 아니다");
  }

  const signerPrivateKey = requiredSecret(env, "ANCHOR_SIGNER_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(signerPrivateKey)) {
    // 형식만 본다. 값 자체는 오류 메시지에도 넣지 않는다.
    throw new Error("ANCHOR_SIGNER_PRIVATE_KEY 형식이 올바르지 않다");
  }

  const chainId = Number(required(env, "CHAIN_ID"));
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error("CHAIN_ID가 올바르지 않다");

  const confirmationDepth = Number(env.ANCHOR_CONFIRMATIONS ?? "12");
  if (!Number.isInteger(confirmationDepth) || confirmationDepth < 1) {
    // 확정 깊이 0은 "블록에 들어가면 확정"이라는 뜻이 되어 06 §6.8을 무너뜨린다.
    throw new Error("ANCHOR_CONFIRMATIONS는 1 이상이어야 한다");
  }

  const feeCapGwei = Number(env.ANCHOR_FEE_CAP_GWEI ?? "100");
  if (!(feeCapGwei > 0)) throw new Error("ANCHOR_FEE_CAP_GWEI는 0보다 커야 한다");

  // O1 — 하루에 태울 수 있는 가스 총액. **기본값을 두지 않는다.**
  //
  // per-tx 상한과 재시도 상한은 이미 있다. 그 둘을 다 지켜도 batch가 계속 생기면
  // 지갑은 빈다. 손실 상한은 하루 총액으로만 고정되고, 그 값은 운영자가 정한다
  // (예상 소진 × 1.5). 기본값이 있으면 아무도 정하지 않은 채 배포된다 —
  // `OBJECT_REGION`을 비워 두고 거절하는 것과 같은 이유다.
  const dailySpendCapRaw = required(env, "ANCHOR_DAILY_SPEND_CAP_WEI");
  if (!/^[0-9]+$/.test(dailySpendCapRaw)) {
    // wei는 정수다. `0.05`나 `1e17`은 단위를 착각한 것이며, 조용히 반올림하면
    // 상한이 의도와 다른 자리에서 걸린다.
    throw new Error("ANCHOR_DAILY_SPEND_CAP_WEI는 wei 단위 정수여야 한다");
  }
  const dailySpendCapWei = BigInt(dailySpendCapRaw);
  if (dailySpendCapWei <= 0n) {
    // 0은 "상한 없음"이 아니라 "아무것도 제출하지 않음"이다.
    throw new Error("ANCHOR_DAILY_SPEND_CAP_WEI는 0보다 커야 한다");
  }

  // 기본값은 로컬(31337)과 BNB testnet(97)뿐이다. mainnet에서 EOA가 단독으로
  // 제출하려면 명시적으로 열어야 하며, 컨트랙트 설계상 그것은 Safe multisig의
  // 역할이다.
  const eoaAllowedChainIds = (env.ANCHOR_EOA_CHAIN_IDS ?? "31337,97")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);

  // EOA 제출이 막힌 체인에서 제안을 만들 Safe 주소. 없으면 그 체인에서는
  // 아무것도 하지 못하며, worker가 그 사실을 로그로 남긴다.
  const safeAddress = env.ANCHOR_SAFE_ADDRESS?.toLowerCase() ?? null;
  if (safeAddress && !/^0x[0-9a-f]{40}$/.test(safeAddress)) {
    throw new Error("ANCHOR_SAFE_ADDRESS가 주소 형식이 아니다");
  }

  return {
    databaseUrl: requiredSecret(env, "DATABASE_URL"),
    rpcUrl: required(env, "CHAIN_RPC_URL"),
    chainId,
    contractAddress,
    signerPrivateKey: signerPrivateKey.toLowerCase() as Hex,
    confirmationDepth,
    feeCapWei: BigInt(Math.round(feeCapGwei * 1e9)),
    dailySpendCapWei,
    maxAttempts: Number(env.ANCHOR_MAX_ATTEMPTS ?? "3"),
    dropTimeoutMs: Number(env.ANCHOR_DROP_TIMEOUT_MS ?? String(10 * 60 * 1000)),
    pollIntervalMs: Number(env.ANCHOR_POLL_MS ?? "2000"),
    eoaAllowedChainIds,
    safeAddress,
    reorgWatchMs: Number(env.ANCHOR_REORG_WATCH_MS ?? String(30 * 60 * 1000)),
    recheckIntervalMs: Number(env.ANCHOR_RECHECK_MS ?? "15000"),
  };
}
