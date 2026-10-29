import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { ANVIL_DEV_ADDRESSES, assertNotDevKey, PUBLIC_DEV_ADDRESSES } from "@mpc/config";

/**
 * The refused development addresses, pinned to their sources.
 *
 * `@mpc/config` hardcodes them so it needs no crypto dependency. This derives them again: from
 * the public mnemonic, and from every key fixture committed to the repository. A fixture added
 * without its address in the list fails here — committed means public.
 *
 * Keys are never printed: failures name the file and the derived address only.
 */

const ROOT = join(import.meta.dirname, "..", "..", "..");
const KEY = /0x[0-9a-fA-F]{64}/g;

/** Every committed place a service or signer key is written down. */
function committedFixtureKeys(): { source: string; key: `0x${string}` }[] {
  const found: { source: string; key: `0x${string}` }[] = [];
  const secrets = join(ROOT, "config", "local-secrets");
  for (const name of readdirSync(secrets)) {
    const value = readFileSync(join(secrets, name), "utf8").trim();
    if (/^0x[0-9a-fA-F]{64}$/.test(value)) {
      found.push({ source: `config/local-secrets/${name}`, key: value as `0x${string}` });
    }
  }
  // Only lines that set a key variable: these files also hold image digests, which are 32-byte
  // hashes of the same shape.
  // Public exports omit private CI workflows; scan every workflow present in either checkout.
  const workflows = readdirSync(join(ROOT, ".github", "workflows"))
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => `.github/workflows/${name}`);
  for (const file of [".env.example", "docker/docker-compose.yml", ...workflows]) {
    for (const line of readFileSync(join(ROOT, file), "utf8").split("\n")) {
      if (!/PRIVATE_KEY|_KEY\b/.test(line)) continue;
      for (const key of line.match(KEY) ?? []) found.push({ source: file, key: key as `0x${string}` });
    }
  }
  return found;
}

describe("public development keys", () => {
  it("include accounts 0–19 of the anvil/hardhat mnemonic", () => {
    const mnemonic = "test test test test test test test test test test test junk";
    const derived = Array.from({ length: 20 }, (_, addressIndex) =>
      mnemonicToAccount(mnemonic, { addressIndex }).address.toLowerCase(),
    );
    expect(ANVIL_DEV_ADDRESSES).toEqual(derived);
  });

  it("include every committed key fixture, refused off the local chain", () => {
    const fixtures = committedFixtureKeys();
    // The scan service and anchor signer fixtures at least; an empty scan means the reader broke.
    expect(fixtures.map((fixture) => fixture.source)).toEqual(
      expect.arrayContaining([
        "config/local-secrets/anchor_signer_key",
        "config/local-secrets/scan_service_key",
        "docker/docker-compose.yml",
        ".env.example",
      ]),
    );
    const missing = fixtures
      .map(({ source, key }) => ({ source, address: privateKeyToAccount(key).address.toLowerCase() }))
      .filter(({ address }) => !PUBLIC_DEV_ADDRESSES.includes(address));
    expect(missing).toEqual([]);
    for (const { source, key } of fixtures) {
      const address = privateKeyToAccount(key).address;
      expect(() => assertNotDevKey("KEY", address, 5611), source).toThrowError(/public development key/);
      expect(() => assertNotDevKey("KEY", address, 31337), source).not.toThrow();
    }
  });
});
