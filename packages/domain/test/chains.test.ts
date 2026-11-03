import { describe, expect, it } from "vitest";
import {
  CHAIN_ENVIRONMENTS,
  chainEnvironmentOf,
  sameChainEnvironment,
  describeChains,
  EOA_ANCHOR_ELIGIBLE_CHAIN_IDS,
  isEoaAnchorEligibleChainId,
  isSupportedChainId,
  parseSupportedChainId,
  SUPPORTED_CHAIN_IDS,
} from "../src/chains.js";

describe("supported chains", () => {
  it("accepts BSC mainnet, opBNB testnet, and the local chain", () => {
    for (const id of [56, 5611, 31337]) expect(isSupportedChainId(id), String(id)).toBe(true);
  });

  it("refuses every other chain, including the BSC and opBNB networks that are not listed", () => {
    // 97 is BSC testnet and 204 opBNB mainnet — close enough to be typed by mistake.
    for (const id of [97, 204, 1, 0, -56, 56.5, Number.NaN]) {
      expect(isSupportedChainId(id), String(id)).toBe(false);
    }
    // A string from the environment is not coerced here; callers parse first.
    expect(isSupportedChainId("56")).toBe(false);
  });
});

describe("parsing a configured chain ID", () => {
  it("reads plain decimal digits of a supported chain", () => {
    expect(parseSupportedChainId("56")).toBe(56);
    expect(parseSupportedChainId("5611")).toBe(5611);
    expect(parseSupportedChainId("31337")).toBe(31337);
  });

  it("refuses unsupported chains and any other spelling of a supported one", () => {
    for (const raw of ["97", "204", "0", "", " 56 ", "056x", "0x38", "0x15eb", "5.611e3", "5611.0", "-56", "+56"]) {
      expect(parseSupportedChainId(raw), JSON.stringify(raw)).toBeNull();
    }
  });
});

describe("chains where EOA anchoring may be enabled", () => {
  it("is only the testnet and the local chain", () => {
    expect([...EOA_ANCHOR_ELIGIBLE_CHAIN_IDS].sort()).toEqual([31337, 5611]);
    expect(isEoaAnchorEligibleChainId(5611)).toBe(true);
    expect(isEoaAnchorEligibleChainId(31337)).toBe(true);
  });

  it("never includes mainnet", () => {
    // The Safe multisig holds the submitter role on mainnet; a solo signer would bypass it.
    expect(isEoaAnchorEligibleChainId(56)).toBe(false);
    expect(isEoaAnchorEligibleChainId(97)).toBe(false);
  });

  it("is a subset of the supported chains", () => {
    for (const id of EOA_ANCHOR_ELIGIBLE_CHAIN_IDS) expect(isSupportedChainId(id)).toBe(true);
  });
});

it("names each chain in messages", () => {
  expect(describeChains(SUPPORTED_CHAIN_IDS)).toBe(
    "56 (BSC mainnet), 5611 (opBNB testnet), 31337 (local chain)",
  );
});

describe("the environment of a chain", () => {
  it("classifies every supported chain explicitly", () => {
    expect(Object.keys(CHAIN_ENVIRONMENTS).map(Number).sort()).toEqual([...SUPPORTED_CHAIN_IDS].sort());
    expect(chainEnvironmentOf(56)).toBe("mainnet");
    expect(chainEnvironmentOf(5611)).toBe("testnet");
    expect(chainEnvironmentOf(31337)).toBe("testnet");
  });

  it("gives no environment to a chain outside the list, testnet-looking or not", () => {
    // 97 is BSC testnet: "not mainnet" must not make it a testnet of ours.
    for (const id of [97, 204, 1, 0]) expect(chainEnvironmentOf(id), String(id)).toBeNull();
  });

  it("lets a batch move only between supported chains of one environment", () => {
    expect(sameChainEnvironment(5611, 31337)).toBe(true);
    expect(sameChainEnvironment(31337, 5611)).toBe(true);
    expect(sameChainEnvironment(56, 5611)).toBe(false);
    expect(sameChainEnvironment(5611, 56)).toBe(false);
    // Unknown chains share nothing, not even with each other or themselves.
    expect(sameChainEnvironment(97, 5611)).toBe(false);
    expect(sameChainEnvironment(5611, 97)).toBe(false);
    expect(sameChainEnvironment(97, 97)).toBe(false);
    expect(sameChainEnvironment(97, 204)).toBe(false);
  });
});
