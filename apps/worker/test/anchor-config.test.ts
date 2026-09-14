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
  CHAIN_ID: "97",
  ANCHOR_CONTRACT_ADDRESS: `0x${"ab".repeat(20)}`,
  ANCHOR_SIGNER_PRIVATE_KEY: `0x${"11".repeat(32)}`,
  ANCHOR_DAILY_SPEND_CAP_WEI: "50000000000000000",
};

/**
 * The cap must be **the value produced by the sizing formula** — the formula and where to set it
 * are in `deploy/README.md`.
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
