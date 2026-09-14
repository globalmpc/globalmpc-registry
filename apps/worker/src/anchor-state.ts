/**
 * anchor 트랜잭션 상태 전이 — spec 06 §6.8, 08 §8.9.
 *
 * IO 없이 "관측한 사실 → 다음 상태"만 계산한다. RPC·DB와 섞으면 reorg처럼 재현이
 * 어려운 경우를 테스트할 수 없다.
 *
 * 핵심 규칙 세 개.
 *
 * 1. **`included`는 성공이 아니다.** 블록에 들어간 것과 확정된 것은 다르다.
 *    확정 깊이를 채워야 `confirmed`가 되고, 그때만 공개 증명이 included=true다.
 * 2. **뒤로 가는 전이가 있다.** reorg는 확정을 되돌린다. 앞으로만 가는 상태기계로
 *    모델링하면 사라진 블록을 확정으로 남겨 두게 된다.
 * 3. **revert는 재시도 대상이 아니다.** 컨트랙트가 거절한 것은 다시 보내도 같다.
 *    가스 부족·nonce 충돌 같은 제출 실패와 구분한다.
 */

export type TransactionState =
  | "created"
  /** Safe에 제안만 만든 상태. 아직 체인에 아무것도 없다. */
  | "proposed"
  | "signed"
  | "submitted"
  | "included"
  | "confirmed"
  | "replaced"
  | "reverted"
  | "reorged"
  | "dropped"
  | "failed"
  | "reconciliation_required";

/** 체인에서 관측한 사실. 없는 것과 실패한 것을 구분한다. */
export type Observation =
  | { readonly kind: "pending" }
  /** 영수증이 있다. status로 성공·실패가 갈린다. */
  | {
      readonly kind: "receipt";
      readonly status: "success" | "reverted";
      readonly blockNumber: number;
      readonly blockHash: string;
      /**
       * 실제로 태운 가스와 그때의 가스 가격.
       *
       * 선택값이 아니다 — 일일 상한(O1)이 이 둘의 곱을 합산해 판정한다. 없어도
       * 되게 두면 영수증이 와도 0으로 세고 상한이 영원히 열려 있게 된다.
       * `reverted` 영수증도 가스는 태운다. 그래서 status와 무관하게 받는다.
       */
      readonly gasUsed: bigint;
      readonly effectiveGasPrice: bigint;
    }
  /** 제출은 했는데 노드가 트랜잭션을 모른다 — mempool에서 빠졌을 수 있다. */
  | { readonly kind: "unknown" };

export interface TrackInput {
  readonly state: TransactionState;
  readonly recordedBlockNumber: number | null;
  readonly recordedBlockHash: string | null;
  readonly observation: Observation;
  readonly headBlockNumber: number;
  readonly confirmationDepth: number;
  /** 제출 후 경과 시간(ms). mempool 이탈 판정에 쓴다. */
  readonly elapsedSinceSubmitMs: number;
  readonly dropTimeoutMs: number;
}

export interface TrackResult {
  readonly nextState: TransactionState;
  readonly confirmations: number;
  readonly blockNumber: number | null;
  readonly blockHash: string | null;
  /** 상태가 뒤로 갔는가. reorg 기록을 남길지 판정한다. */
  readonly reorged: boolean;
  readonly reason: string;
}

export function confirmationsOf(blockNumber: number, headBlockNumber: number): number {
  // 자기 블록도 1 confirmation으로 센다. head == blockNumber이면 1이다.
  return Math.max(0, headBlockNumber - blockNumber + 1);
}

/**
 * 관측 결과로 다음 상태를 계산한다.
 *
 * 이미 종료 상태(`confirmed` 제외)인 트랜잭션은 건드리지 않는다. `confirmed`는
 * reorg로 뒤집힐 수 있으므로 계속 관측 대상이다.
 */
export function trackTransaction(input: TrackInput): TrackResult {
  const keep = (reason: string): TrackResult => ({
    nextState: input.state,
    confirmations: 0,
    blockNumber: input.recordedBlockNumber,
    blockHash: input.recordedBlockHash,
    reorged: false,
    reason,
  });

  if (
    input.state === "reverted" ||
    input.state === "replaced" ||
    input.state === "dropped" ||
    input.state === "failed"
  ) {
    return keep("terminal");
  }

  if (input.observation.kind === "receipt") {
    const { status, blockNumber, blockHash } = input.observation;

    if (status === "reverted") {
      // 컨트랙트가 거절했다. 같은 payload를 다시 보내면 같은 결과다.
      return {
        nextState: "reverted",
        confirmations: 0,
        blockNumber,
        blockHash,
        reorged: false,
        reason: "execution_reverted",
      };
    }

    // 같은 트랜잭션이 다른 블록에서 관측됐다면 이전에 본 블록은 사라졌다.
    const reorged =
      input.recordedBlockHash !== null && input.recordedBlockHash !== blockHash;

    const confirmations = confirmationsOf(blockNumber, input.headBlockNumber);
    const confirmed = confirmations >= input.confirmationDepth;

    return {
      // reorg 뒤 재확정이라도 상태는 다시 계산한다. 확정 깊이를 못 채웠으면
      // included로 되돌아간다 — 확정을 유지한 채 블록만 바꾸지 않는다.
      nextState: confirmed ? "confirmed" : "included",
      confirmations,
      blockNumber,
      blockHash,
      reorged,
      reason: reorged ? "reorg_reobserved" : confirmed ? "confirmed" : "included",
    };
  }

  if (input.observation.kind === "unknown") {
    // 확정으로 봤던 것이 사라졌다. 재조정이 필요하며 자동으로 되돌리지 않는다.
    if (input.state === "confirmed" || input.state === "included") {
      return {
        nextState: "reconciliation_required",
        confirmations: 0,
        blockNumber: null,
        blockHash: null,
        reorged: true,
        reason: "observed_block_disappeared",
      };
    }

    if (input.elapsedSinceSubmitMs >= input.dropTimeoutMs) {
      // mempool에서 빠진 것으로 본다. 재제출은 사람이 판단한다 — 자동 재제출은
      // 같은 root를 두 번 올릴 위험이 있다.
      return {
        nextState: "dropped",
        confirmations: 0,
        blockNumber: null,
        blockHash: null,
        reorged: false,
        reason: "not_found_after_timeout",
      };
    }

    return keep("not_found_yet");
  }

  return keep("pending");
}

/**
 * 제출 전 안전 점검.
 *
 * O1: 이 worker가 잃을 수 있는 것은 anchor signer 지갑의 가스뿐이다. 상한을
 * 코드로 고정해 두면 가스 급등이나 무한 재시도가 지갑을 비우지 못한다.
 *
 * **세 상한은 서로 다른 것을 막는다.**
 *
 * - `feeCapWei` — 트랜잭션 **한 건**의 가스 가격. 급등한 순간에 올리지 않는다.
 * - `maxAttempts` — **한 batch**의 재시도. 같은 root를 무한히 다시 올리지 않는다.
 * - `dailySpendCapWei` — **하루 총액**. 위 둘을 다 지켜도 서로 다른 batch가 계속
 *   생기면 지갑은 빈다. O1이 요구하는 손실 상한은 이 세 번째다.
 */
export interface SubmitGuardInput {
  readonly chainId: number;
  readonly maxFeePerGas: bigint;
  readonly feeCapWei: bigint;
  readonly attempts: number;
  readonly maxAttempts: number;
  /** EOA 단독 제출을 허용하는 체인. 그 외에는 Safe multisig가 제출한다. */
  readonly eoaAllowedChainIds: readonly number[];
  /** Safe multisig 주소. EOA가 막힌 체인에서 제안을 만들 대상이다. */
  readonly safeAddress: string | null;
  /** 하루에 태울 수 있는 가스 총액(wei). 운영자가 정하며 기본값이 없다. */
  readonly dailySpendCapWei: bigint;
  /** 오늘(UTC) 이미 태운 가스 총액(wei). 영수증이 도착한 것만 센다. */
  readonly spentTodayWei: bigint;
}

/**
 * 제출 방식.
 *
 * - `eoa` — worker가 직접 서명해 보낸다. 로컬·테스트넷 전용.
 * - `safe_proposal` — 제안만 만들고 실행하지 않는다. 서명 수집과 실행은 Safe에서
 *   사람이 한다. **제안이 만들어진 것은 제출된 것이 아니다.**
 * - `blocked` — 어느 쪽도 할 수 없다.
 */
export type SubmitGuard =
  | { readonly allow: true; readonly via: "eoa" }
  | { readonly allow: true; readonly via: "safe_proposal" }
  | { readonly allow: false; readonly reason: string };

export function checkSubmitAllowed(input: SubmitGuardInput): SubmitGuard {
  if (!input.eoaAllowedChainIds.includes(input.chainId)) {
    // 컨트랙트의 ANCHOR_SUBMITTER_ROLE은 Safe multisig가 보유한다. EOA로 직접
    // 제출하는 경로는 로컬·테스트넷 전용이며 prod에서 열리면 안 된다.
    //
    // Safe 주소가 설정돼 있으면 제안을 만든다. 없으면 아무것도 할 수 없고,
    // 그 사실을 조용히 두지 않는다.
    if (input.safeAddress) {
      return { allow: true, via: "safe_proposal" };
    }
    return {
      allow: false,
      reason: `EOA_SUBMISSION_NOT_ALLOWED_ON_CHAIN_${input.chainId}`,
    };
  }

  // 일일 상한을 가스 상한보다 먼저 본다. 둘 다 걸릴 때 남아야 하는 이유는
  // 손실 상한 쪽이다 — FEE_ABOVE_CAP은 요금이 내려가면 풀리지만 일일 상한은
  // 날짜가 바뀌어야 풀린다. 운영자가 보는 마지막 사유가 덜 심각한 쪽이면
  // "요금만 기다리면 된다"고 읽는다.
  if (input.spentTodayWei >= input.dailySpendCapWei) {
    return { allow: false, reason: "DAILY_SPEND_CAP_REACHED" };
  }

  if (input.maxFeePerGas > input.feeCapWei) {
    return { allow: false, reason: "FEE_ABOVE_CAP" };
  }

  if (input.attempts >= input.maxAttempts) {
    return { allow: false, reason: "MAX_ATTEMPTS_REACHED" };
  }

  return { allow: true, via: "eoa" };
}
