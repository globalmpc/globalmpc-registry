import { describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import {
  loadAnchorConfig,
  missingContractCode,
  rpcChainMismatch,
  type AnchorEnv,
} from "../src/anchor-config.js";
import { checkSubmitAllowed } from "../src/anchor-state.js";

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

describe("chain the worker anchors on", () => {
  it("accepts the chains the API runs on", () => {
    for (const value of ["56", "5611", "31337"]) {
      expect(loadAnchorConfig({ ...base, CHAIN_ID: value }).chainId, value).toBe(Number(value));
    }
  });

  it("refuses startup on any other chain, naming the allowed ones", () => {
    // 97 (BSC testnet) and 204 (opBNB mainnet) are near misses; roots there are never looked up.
    for (const value of ["97", "204", "1", "0", "56.0", "0x38", "-56", "abc"]) {
      expect(() => loadAnchorConfig({ ...base, CHAIN_ID: value }), value).toThrowError(
        "CHAIN_ID must be one of 56 (BSC mainnet), 5611 (opBNB testnet), 31337 (local chain)",
      );
    }
  });

  it("refuses startup without a chain", () => {
    const { CHAIN_ID: _omitted, ...without } = base;
    expect(() => loadAnchorConfig(without)).toThrowError("CHAIN_ID is required");
  });
});

describe("public development keys", () => {
  // anvil/hardhat account 0 — printed by every local node.
  const anvil0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

  it("are accepted on the local chain", () => {
    expect(loadAnchorConfig({ ...base, ANCHOR_SIGNER_PRIVATE_KEY: anvil0 }).chainId).toBe(31337);
  });

  it("are refused on any shared chain, without echoing the key", () => {
    for (const chainId of ["5611", "56"]) {
      let message = "";
      try {
        loadAnchorConfig({ ...base, CHAIN_ID: chainId, ANCHOR_SIGNER_PRIVATE_KEY: anvil0 });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, chainId).toMatch(/ANCHOR_SIGNER_PRIVATE_KEY is a public development key \(anvil\/hardhat or a committed fixture\)/);
      expect(message).not.toContain(anvil0.slice(2, 18));
    }
  });

  it("do not block a freshly generated key on the testnet", () => {
    const fresh = generatePrivateKey();
    expect(loadAnchorConfig({ ...base, CHAIN_ID: "5611", ANCHOR_SIGNER_PRIVATE_KEY: fresh }).chainId).toBe(5611);
  });

  it("refuse a key outside the curve's range without quoting it", () => {
    const outOfRange = `0x${"ff".repeat(32)}`;
    expect(() => loadAnchorConfig({ ...base, ANCHOR_SIGNER_PRIVATE_KEY: outOfRange })).toThrowError(
      "ANCHOR_SIGNER_PRIVATE_KEY is not a valid secp256k1 key",
    );
  });
});

describe("RPC endpoint chain", () => {
  it("passes when the endpoint serves CHAIN_ID", () => {
    expect(rpcChainMismatch(5611, 5611)).toBeNull();
  });

  it("names both chains on a mismatch", () => {
    // An opBNB mainnet or BSC testnet URL behind CHAIN_ID=5611 is the likely slip.
    expect(rpcChainMismatch(5611, 204)).toBe(
      "CHAIN_RPC_URL serves chain 204, but CHAIN_ID is 5611; refusing to start",
    );
  });
});

describe("chains where the worker may submit as an EOA", () => {
  it("defaults to the local chain only", () => {
    expect(loadAnchorConfig(base).eoaAllowedChainIds).toEqual([31337]);
  });

  it("refuses to start when mainnet or a chain outside the testnet set is listed", () => {
    // Solo EOA anchoring on mainnet bypasses the Safe multisig that holds the submitter role. A
    // setting must not be able to open it — the default alone is not a guard.
    for (const value of ["56", "31337,56", "56,5611", "1", "97", "204"]) {
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

  it("accepts the opBNB testnet only when listed explicitly", () => {
    const testnet = { ...base, CHAIN_ID: "5611" };
    expect(loadAnchorConfig({ ...testnet, ANCHOR_EOA_CHAIN_IDS: "5611" }).eoaAllowedChainIds).toEqual([
      5611,
    ]);
    expect(
      loadAnchorConfig({ ...testnet, ANCHOR_EOA_CHAIN_IDS: "31337,5611" }).eoaAllowedChainIds,
    ).toEqual([31337, 5611]);
  });

  it("does not sign alone on the opBNB testnet without the opt-in", () => {
    // Running on 5611 is not consent to a solo signer: the default leaves it on the Safe path,
    // or blocked when no Safe is configured.
    const guard = (env: AnchorEnv) => {
      const config = loadAnchorConfig({ ...base, CHAIN_ID: "5611", ...env });
      return checkSubmitAllowed({
        ...config,
        maxFeePerGas: 1n,
        attempts: 0,
        spentTodayWei: 0n,
        inFlightMaxWei: 0n,
        l1FeeBoundWei: 0n,
      });
    };
    expect(guard({})).toEqual({ allow: false, reason: "EOA_SUBMISSION_NOT_ALLOWED_ON_CHAIN_5611" });
    expect(guard({ ANCHOR_SAFE_ADDRESS: `0x${"cd".repeat(20)}` })).toEqual({
      allow: true,
      via: "safe_proposal",
    });
    expect(guard({ ANCHOR_EOA_CHAIN_IDS: "5611" })).toEqual({ allow: true, via: "eoa" });
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
    "ANCHOR_CHAIN_SEARCH_RETRY_MS",
    "ANCHOR_CHAIN_SEARCH_GIVE_UP_MS",
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
      ANCHOR_CHAIN_SEARCH_RETRY_MS: "30000",
      ANCHOR_CHAIN_SEARCH_GIVE_UP_MS: "7200000",
    });
    expect(config.maxAttempts).toBe(5);
    expect(config.dropTimeoutMs).toBe(120_000);
    expect(config.pollIntervalMs).toBe(1000);
    expect(config.reorgWatchMs).toBe(600_000);
    expect(config.recheckIntervalMs).toBe(5000);
    expect(config.chainSearchRetryMs).toBe(30_000);
    expect(config.chainSearchGiveUpMs).toBe(7_200_000);
  });

  it("keeps the defaults when unset", () => {
    const config = loadAnchorConfig(base);
    expect(config.maxAttempts).toBe(3);
    expect(config.dropTimeoutMs).toBe(10 * 60 * 1000);
    expect(config.gasLimit).toBe(200_000n);
    // A failing chain search is retried a minute apart and reaches a person within the hour.
    expect(config.chainSearchRetryMs).toBe(60_000);
    expect(config.chainSearchGiveUpMs).toBe(60 * 60 * 1000);
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

describe("finality tag", () => {
  const on = (chainId: string, env: AnchorEnv = {}) =>
    loadAnchorConfig({ ...base, CHAIN_ID: chainId, ANCHOR_SIGNER_PRIVATE_KEY: generatePrivateKey(), ...env });

  it("defaults to the safe head on shared chains and to none on the local chain", () => {
    expect(on("5611").finalityTag).toBe("safe");
    expect(on("56").finalityTag).toBe("safe");
    // anvil's safe head trails by 32 blocks; e2e would wait for it on every anchor.
    expect(on("31337").finalityTag).toBe("none");
    expect(on("5611", { ANCHOR_FINALITY_TAG: "" }).finalityTag).toBe("safe");
  });

  it("takes each of the three names", () => {
    for (const tag of ["safe", "finalized", "none"] as const) {
      expect(on("5611", { ANCHOR_FINALITY_TAG: tag }).finalityTag).toBe(tag);
    }
  });

  it.each(["Safe", " safe", "latest", "finalised", "0", "false"])(
    "refuses %j instead of falling back to depth alone",
    (value) => {
      expect(() => on("5611", { ANCHOR_FINALITY_TAG: value })).toThrow(
        "ANCHOR_FINALITY_TAG must be one of safe, finalized, none",
      );
    },
  );
});

describe("log lookback", () => {
  const on = (chainId: string, env: AnchorEnv = {}) =>
    loadAnchorConfig({ ...base, CHAIN_ID: chainId, ANCHOR_SIGNER_PRIVATE_KEY: generatePrivateKey(), ...env });

  it("defaults to a day of each chain's blocks", () => {
    // 5,000 blocks were 21 minutes on opBNB's 0.25 s blocks.
    expect(on("5611").logLookbackBlocks).toBe(345_600);
    expect(on("56").logLookbackBlocks).toBe(192_000);
    expect(on("31337").logLookbackBlocks).toBe(86_400);
  });

  it("takes a positive integer and refuses anything else", () => {
    expect(on("5611", { ANCHOR_LOG_LOOKBACK_BLOCKS: "1000" }).logLookbackBlocks).toBe(1000);
    for (const value of ["0", "-1", "1e5", "abc"]) {
      expect(() => on("5611", { ANCHOR_LOG_LOOKBACK_BLOCKS: value })).toThrow(
        "ANCHOR_LOG_LOOKBACK_BLOCKS must be a positive integer",
      );
    }
  });
});

describe("contract code at startup", () => {
  it("refuses an address without code and names no URL", () => {
    expect(missingContractCode(5611, true)).toBeNull();
    expect(missingContractCode(5611, false)).toBe(
      "ANCHOR_CONTRACT_ADDRESS has no contract code on chain 5611; refusing to start",
    );
  });
});
