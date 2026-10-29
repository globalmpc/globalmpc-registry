import { describe, expect, it } from "vitest";
import {
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
