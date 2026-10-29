import { describe, expect, it } from "vitest";
import { assertNotDevKey, isPublicDevAddress, PUBLIC_DEV_ADDRESSES } from "../src/dev-keys.js";

// The list itself is checked against the mnemonic in apps/anchor-worker/test/dev-keys.test.ts,
// where viem is available; this package has no dependencies.

describe("well-known development keys", () => {
  const anvil0 = PUBLIC_DEV_ADDRESSES[0]!;
  const fresh = `0x${"12".repeat(20)}`;

  it("matches regardless of casing", () => {
    expect(isPublicDevAddress(anvil0.toUpperCase().replace("0X", "0x"))).toBe(true);
    expect(isPublicDevAddress(fresh)).toBe(false);
  });

  it("is allowed on the local chain only", () => {
    expect(() => assertNotDevKey("KEY", anvil0, 31337)).not.toThrow();
    for (const chainId of [5611, 56, 97]) {
      expect(() => assertNotDevKey("KEY", anvil0, chainId), String(chainId)).toThrowError(
        /KEY is a public development key \(anvil\/hardhat or a committed fixture\)/,
      );
    }
    expect(() => assertNotDevKey("KEY", fresh, 5611)).not.toThrow();
  });
});
