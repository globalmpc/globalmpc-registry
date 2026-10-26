import { describe, expect, it } from "vitest";
import { loadAnchorConfig, type AnchorEnv } from "../src/anchor-config.js";

/**
 * anchor worker config checks.
 *
 * An omission not caught here surfaces only after batches pile up. The daily gas cap (O1) in
 * particular would reach production with nobody having set it if it had a default — the same reason
 * startup is refused when `OBJECT_REGION` is empty.
 */

const base: AnchorEnv = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  CHAIN_RPC_URL: "http://localhost:8545",
  CHAIN_ID: "31337",
  ANCHOR_CONTRACT_ADDRESS: `0x${"ab".repeat(20)}`,
  ANCHOR_SIGNER_PRIVATE_KEY: `0x${"11".repeat(32)}`,
  ANCHOR_DAILY_SPEND_CAP_WEI: "50000000000000000",
};

/**
 * The cap must be **the value produced by the sizing formula** — the formula and where to set it
 * are in `docs/operations/deployment.md`.
 *
 *   daily spend cap = submissions per day × gas per submission × gas price cap (gwei) × 1e9 × 1.5
 *
 * Changing one input without updating the result moves the cap off its intended multiple, and the
 * drift shows up **only after the wallet is empty**. Config is a string, so a dropped digit still
 * passes format checks. So the multiplication is repeated here, giving whoever sets the value a
 * place to double-check it.
 *
 * The numbers below are **example inputs**. Real values differ per environment and the repository
 * does not set them — submissions per day follow from the number of registered subjects.
 */
describe("daily cap sizing formula", () => {
  const GWEI = 1_000_000_000n;

  /** Expected spend × 1.5. bigint, so the fraction is written as 3/2. */
  const capWei = (submissionsPerDay: bigint, gasPerSubmission: bigint, feeCapGwei: bigint): bigint =>
    (submissionsPerDay * gasPerSubmission * feeCapGwei * GWEI * 3n) / 2n;

  /** Gas per submission is the `submitRoot` max from `forge test --gas-report` plus base cost and calldata headroom. */
  const example = capWei(50n, 170_000n, 100n);

  it("carries the value the formula produces", () => {
    expect(
      loadAnchorConfig({ ...base, ANCHOR_DAILY_SPEND_CAP_WEI: example.toString() }).dailySpendCapWei,
    ).toBe(example);
  });

  it("dropping one digit yields a different value", () => {
    expect(
      loadAnchorConfig({ ...base, ANCHOR_DAILY_SPEND_CAP_WEI: (example / 10n).toString() })
        .dailySpendCapWei,
    ).not.toBe(example);
  });
});

describe("anchor config — daily gas cap (O1)", () => {
  it("carries the given value as wei", () => {
    expect(loadAnchorConfig(base).dailySpendCapWei).toBe(50_000_000_000_000_000n);
  });

  it("refuses to start when missing", () => {
    // A default would ship with nobody having set the loss cap. O1 makes the existence of that cap
    // a deployment condition.
    const { ANCHOR_DAILY_SPEND_CAP_WEI: _omitted, ...without } = base;
    expect(() => loadAnchorConfig(without)).toThrowError(/ANCHOR_DAILY_SPEND_CAP_WEI/);
  });

  it("treats an empty string as not provided", () => {
    // Some orchestrators pass unset variables as empty values.
    expect(() => loadAnchorConfig({ ...base, ANCHOR_DAILY_SPEND_CAP_WEI: "" })).toThrowError(
      /ANCHOR_DAILY_SPEND_CAP_WEI/,
    );
  });

  it("rejects zero or negative", () => {
    // 0 means "submit nothing", not "no cap". There is no reason to configure that, so it is
    // treated as a typo.
    expect(() => loadAnchorConfig({ ...base, ANCHOR_DAILY_SPEND_CAP_WEI: "0" })).toThrowError();
    expect(() => loadAnchorConfig({ ...base, ANCHOR_DAILY_SPEND_CAP_WEI: "-1" })).toThrowError();
  });

  it("rejects a non-integer", () => {
    // wei is an integer. A decimal point means the unit was mistaken.
    expect(() => loadAnchorConfig({ ...base, ANCHOR_DAILY_SPEND_CAP_WEI: "0.05" })).toThrowError();
    expect(() => loadAnchorConfig({ ...base, ANCHOR_DAILY_SPEND_CAP_WEI: "1e17" })).toThrowError();
  });
});

describe("chains where the worker may submit as an EOA", () => {
  it("defaults to the local chain only", () => {
    expect(loadAnchorConfig(base).eoaAllowedChainIds).toEqual([31337]);
  });

  it("refuses to start when a non-local chain is listed", () => {
    // Solo EOA anchoring on mainnet bypasses the Safe multisig that holds the submitter role. A
    // setting must not be able to open it — the default alone is not a guard.
    for (const value of ["56", "31337,56", "1", "97"]) {
      expect(
        () => loadAnchorConfig({ ...base, ANCHOR_EOA_CHAIN_IDS: value }),
        value,
      ).toThrowError(/ANCHOR_EOA_CHAIN_IDS/);
    }
  });

  it("refuses to start on an entry that is not a chain id", () => {
    // Dropping a bad entry silently would leave the operator believing it was applied.
    expect(() => loadAnchorConfig({ ...base, ANCHOR_EOA_CHAIN_IDS: "31337,abc" })).toThrowError(
      /ANCHOR_EOA_CHAIN_IDS/,
    );
  });

  it("accepts the local chain listed explicitly, or none at all", () => {
    expect(loadAnchorConfig({ ...base, ANCHOR_EOA_CHAIN_IDS: " 31337 " }).eoaAllowedChainIds).toEqual([
      31337,
    ]);
    // Empty: no chain allows EOA; every chain goes through the Safe proposal path.
    expect(loadAnchorConfig({ ...base, ANCHOR_EOA_CHAIN_IDS: "" }).eoaAllowedChainIds).toEqual([]);
  });
});

describe("numeric settings are validated at startup", () => {
  // `Number("abc")` is NaN, and NaN fails every comparison: `attempts >= NaN` is never true, so
  // the retry cap disappears, and `elapsed >= NaN` is never true, so nothing is ever dropped.
  const keys = [
    "ANCHOR_MAX_ATTEMPTS",
    "ANCHOR_DROP_TIMEOUT_MS",
    "ANCHOR_POLL_MS",
    "ANCHOR_REORG_WATCH_MS",
    "ANCHOR_RECHECK_MS",
    "ANCHOR_GAS_LIMIT",
  ] as const;

  for (const key of keys) {
    it(`refuses to start when ${key} is not a positive integer`, () => {
      for (const value of ["abc", "0", "-1", "1.5", "1e3", " "]) {
        expect(() => loadAnchorConfig({ ...base, [key]: value }), `${key}=${value}`).toThrowError(
          new RegExp(key),
        );
      }
    });
  }

  it("carries valid values as numbers", () => {
    const config = loadAnchorConfig({
      ...base,
      ANCHOR_MAX_ATTEMPTS: "5",
      ANCHOR_DROP_TIMEOUT_MS: "120000",
      ANCHOR_POLL_MS: "1000",
      ANCHOR_REORG_WATCH_MS: "600000",
      ANCHOR_RECHECK_MS: "5000",
    });
    expect(config.maxAttempts).toBe(5);
    expect(config.dropTimeoutMs).toBe(120_000);
    expect(config.pollIntervalMs).toBe(1000);
    expect(config.reorgWatchMs).toBe(600_000);
    expect(config.recheckIntervalMs).toBe(5000);
  });

  it("keeps the defaults when unset", () => {
    const config = loadAnchorConfig(base);
    expect(config.maxAttempts).toBe(3);
    expect(config.dropTimeoutMs).toBe(10 * 60 * 1000);
    expect(config.gasLimit).toBe(200_000n);
  });

  it("carries the gas limit as bigint", () => {
    // Multiplied by wei prices for the daily cap; a number would lose precision.
    expect(loadAnchorConfig({ ...base, ANCHOR_GAS_LIMIT: "250000" }).gasLimit).toBe(250_000n);
  });
});

describe("the daily cap must fit two sends at the fee cap", () => {
  // A broadcast that failed stays reserved until the next send reuses its nonce. With room for
  // only one send at the fee cap, that next send never fits and anchoring stops for good.
  const twoSends = (gasLimit: bigint, feeCapGwei: bigint) => 2n * gasLimit * feeCapGwei * 1_000_000_000n;

  it("refuses to start below 2 × gas limit × fee cap", () => {
    const floor = twoSends(200_000n, 100n);
    expect(() =>
      loadAnchorConfig({ ...base, ANCHOR_DAILY_SPEND_CAP_WEI: (floor - 1n).toString() }),
    ).toThrowError(/ANCHOR_DAILY_SPEND_CAP_WEI/);
  });

  it("accepts exactly 2 × gas limit × fee cap", () => {
    const floor = twoSends(250_000n, 50n);
    expect(
      loadAnchorConfig({
        ...base,
        ANCHOR_GAS_LIMIT: "250000",
        ANCHOR_FEE_CAP_GWEI: "50",
        ANCHOR_DAILY_SPEND_CAP_WEI: floor.toString(),
      }).dailySpendCapWei,
    ).toBe(floor);
  });
});
