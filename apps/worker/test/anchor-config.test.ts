import { describe, expect, it } from "vitest";
import { loadAnchorConfig, type AnchorEnv } from "../src/anchor-config.js";

/**
 * anchor worker 설정 검사.
 *
 * 여기서 막지 못한 누락은 batch가 쌓인 뒤에 드러난다. 특히 일일 가스 상한(O1)은
 * 기본값을 두면 아무도 정하지 않은 채 운영에 들어간다 — `OBJECT_REGION`을 비워
 * 두고 기동을 거절하는 것과 같은 이유다.
 */

const base: AnchorEnv = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  CHAIN_RPC_URL: "http://localhost:8545",
  CHAIN_ID: "97",
  ANCHOR_CONTRACT_ADDRESS: `0x${"ab".repeat(20)}`,
  ANCHOR_SIGNER_PRIVATE_KEY: `0x${"11".repeat(32)}`,
  ANCHOR_DAILY_SPEND_CAP_WEI: "50000000000000000",
};

/**
 * 상한은 **산정 공식에서 나온 값**이어야 한다 — 공식과 넣는 자리는 `deploy/README.md`.
 *
 *   일일 소진 상한 = 하루 제출 건수 × 건당 gas × 가스 가격 상한(gwei) × 1e9 × 1.5
 *
 * 입력 하나를 고치고 결과를 안 고치면 상한이 의도한 배수에서 벗어나는데, 그
 * 어긋남은 **지갑이 비고 나서야** 드러난다. 설정은 문자열이라 자릿수가 하나 빠져도
 * 형식 검사는 통과한다. 그래서 곱셈을 여기에 한 번 더 두고, 값을 정한 사람이
 * 검산할 자리를 만든다.
 *
 * 아래 숫자는 **예시 입력**이다. 실제 값은 운영 환경마다 다르고 저장소가 정하지
 * 않는다 — 하루 제출 건수는 등록 대상의 수에서 나온다.
 */
describe("일일 상한 산정 공식", () => {
  const GWEI = 1_000_000_000n;

  /** 예상 소진 × 1.5. bigint라 분수를 3/2로 쓴다. */
  const capWei = (submissionsPerDay: bigint, gasPerSubmission: bigint, feeCapGwei: bigint): bigint =>
    (submissionsPerDay * gasPerSubmission * feeCapGwei * GWEI * 3n) / 2n;

  /** 건당 gas는 `forge test --gas-report`의 `submitRoot` max에 기본 비용과 calldata 여유를 더한 값이다. */
  const example = capWei(50n, 170_000n, 100n);

  it("공식이 낸 값을 그대로 싣는다", () => {
    expect(
      loadAnchorConfig({ ...base, ANCHOR_DAILY_SPEND_CAP_WEI: example.toString() }).dailySpendCapWei,
    ).toBe(example);
  });

  it("자릿수를 하나 빠뜨리면 다른 값이 된다", () => {
    expect(
      loadAnchorConfig({ ...base, ANCHOR_DAILY_SPEND_CAP_WEI: (example / 10n).toString() })
        .dailySpendCapWei,
    ).not.toBe(example);
  });
});

describe("anchor 설정 — 일일 가스 상한 (O1)", () => {
  it("값을 주면 wei 그대로 싣는다", () => {
    expect(loadAnchorConfig(base).dailySpendCapWei).toBe(50_000_000_000_000_000n);
  });

  it("없으면 기동을 거절한다", () => {
    // 기본값을 두면 손실 상한을 아무도 정하지 않은 채 배포된다. O1은 그 상한이
    // 있다는 것을 배포 조건으로 삼는다.
    const { ANCHOR_DAILY_SPEND_CAP_WEI: _omitted, ...without } = base;
    expect(() => loadAnchorConfig(without)).toThrowError(/ANCHOR_DAILY_SPEND_CAP_WEI/);
  });

  it("빈 문자열은 주지 않은 것으로 본다", () => {
    // 오케스트레이터가 미설정 변수를 빈 값으로 넘기는 경우가 있다.
    expect(() => loadAnchorConfig({ ...base, ANCHOR_DAILY_SPEND_CAP_WEI: "" })).toThrowError(
      /ANCHOR_DAILY_SPEND_CAP_WEI/,
    );
  });

  it("0이나 음수는 거절한다", () => {
    // 0은 "상한 없음"이 아니라 "아무것도 제출하지 않음"이다. 그런 뜻으로 설정할
    // 이유가 없으므로 오타로 본다.
    expect(() => loadAnchorConfig({ ...base, ANCHOR_DAILY_SPEND_CAP_WEI: "0" })).toThrowError();
    expect(() => loadAnchorConfig({ ...base, ANCHOR_DAILY_SPEND_CAP_WEI: "-1" })).toThrowError();
  });

  it("정수가 아니면 거절한다", () => {
    // wei는 정수다. 소수점이 들어온 것은 단위를 착각한 것이다.
    expect(() => loadAnchorConfig({ ...base, ANCHOR_DAILY_SPEND_CAP_WEI: "0.05" })).toThrowError();
    expect(() => loadAnchorConfig({ ...base, ANCHOR_DAILY_SPEND_CAP_WEI: "1e17" })).toThrowError();
  });
});
