import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { ANVIL_DEV_ADDRESSES, assertNotDevKey, PUBLIC_DEV_ADDRESSES } from "@mpc/config";

/**
 * The refused development addresses, pinned to their sources.
 *
 * `@mpc/config` hardcodes them so it needs no crypto dependency. This derives them again: from
 * the public mnemonic and supported literal signing-fixture declarations in committed sources.
 * This is a static fixture audit, not a general evaluator of arbitrary test expressions.
 * A fixture added without its address in the list fails here — committed means public.
 *
 * Keys are never printed: failures name the file and the derived address only.
 */

const ROOT = join(import.meta.dirname, "..", "..", "..");
const KEY = /0x[0-9a-fA-F]{64}/g;

/** Read only literal key expressions, never execute imported test code or treat hashes as keys. */
function signingFixtureKeys(source: string): `0x${string}`[] {
  const expression = '(?:["\']0x[0-9a-fA-F]{64}["\']|`0x\\$\\{["\'][0-9a-fA-F]{2}["\']\\.repeat\\(32\\)\\}`)';
  const context = '(?:privateKeyToAccount\\(\\s*|(?:const|let)\\s+\\w*(?:KEY|Key)\\s*=\\s*|\\b[A-Z_]*PRIVATE_KEY\\s*:\\s*)';
  return Array.from(source.matchAll(new RegExp(context + '(' + expression + ')', 'g')), (match): `0x${string}` => {
    const literal = match[1]!;
    const repeated = literal.match(/\$\{["']([0-9a-fA-F]{2})["']\.repeat\(32\)\}/);
    return repeated ? `0x${repeated[1]!.repeat(32)}` : literal.slice(1, -1) as `0x${string}`;
  });
}

function testSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? testSources(file) : /\.(?:ts|tsx)$/.test(entry.name) ? [file] : [];
  });
}

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
  for (const tree of ["apps", "packages"]) {
    for (const entry of readdirSync(join(ROOT, tree), { withFileTypes: true })) {
      const directory = join(ROOT, tree, entry.name, "test");
      if (!entry.isDirectory()) continue;
      // Not every workspace package has tests.
      let files: string[];
      try { files = testSources(directory); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const file of files) {
        for (const key of signingFixtureKeys(readFileSync(file, "utf8"))) found.push({ source: file.slice(ROOT.length + 1), key });
      }
    }
  }
  for (const file of readdirSync(join(ROOT, "contracts", "test")).filter((name) => name.endsWith(".sol"))) {
    const source = `contracts/test/${file}`;
    // Solidity fixture keys are integers; addresses and arbitrary bytes32 values are excluded.
    const code = readFileSync(join(ROOT, source), "utf8");
    const declaredKeys = /uint256\s+\w*[Kk]ey\s*=\s*(0x[0-9a-fA-F]+)\s*;/g;
    for (const match of code.matchAll(declaredKeys)) {
      found.push({ source, key: `0x${match[1]!.slice(2).padStart(64, "0")}` });
    }
  }
  return found;
}

describe("public development keys", () => {
  it("distinguishes signing literals from hashes and generated keys", () => {
    const literal = `0x${"33".repeat(32)}`;
    expect(signingFixtureKeys(`const ROOT = "${literal}"; privateKeyToAccount(generatePrivateKey());`)).toEqual([]);
    expect(signingFixtureKeys(`const SIGNER_KEY = "${literal}";`)).toEqual([literal]);
    expect(signingFixtureKeys('privateKeyToAccount(`0x${"11".repeat(32)}`)')).toEqual([`0x${"11".repeat(32)}`]);
  });

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
        "apps/api/test/auth.test.ts",
        "apps/anchor-worker/test/safe-client.test.ts",
        "contracts/test/DeployRegistryAnchor.t.sol",
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
