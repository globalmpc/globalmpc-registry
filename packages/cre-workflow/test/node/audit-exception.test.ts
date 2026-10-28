import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

/**
 * pnpm-workspace.yaml ignores GHSA-mrhx-c7xc-m3w5 (zod < 4.6.6) for the CRE SDK's pinned
 * zod 3. The ignore is global, so this keeps it from hiding any other dependent.
 *
 * Every reference to a vulnerable zod counts: a direct `zod: 3.x` dependency, an npm alias
 * (`zod3: zod@3.x`) and a peer-resolved suffix (`viem: 2.x(zod@3.x)`). Only snapshots on the
 * SDK's own chain may carry one: the SDK and its Javy plugin, zod itself, and viem/ox/abitype,
 * whose zod is an optional peer. A new package reaching any of those with zod 3 is itself
 * flagged, because its own dependency line carries the `(zod@3.x)` suffix.
 */
const ALLOWED_SNAPSHOTS = new Set(["@chainlink/cre-sdk", "@chainlink/cre-sdk-javy-plugin", "zod", "viem", "ox", "abitype"]);

function vulnerable(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  return major < 4 || (major === 4 && (minor < 6 || (minor === 6 && patch < 6)));
}

const packageName = (key: string) => key.replace(/^'|'$/g, "").replace(/^(@?[^@]+)@.*$/, "$1");

/** Owners (`importer <path>` or `snapshot <name>`) that reference a vulnerable zod. */
function vulnerableZodOwners(lockfile: string): Set<string> {
  const owners = new Set<string>();
  let section = "";
  let owner = "";
  let dependency = "";
  for (const line of lockfile.split("\n")) {
    if (/^\S/.test(line)) {
      section = line;
      continue;
    }
    if (section !== "importers:" && section !== "snapshots:") continue;
    if (/^ {2}\S/.test(line)) owner = line.trim().replace(/:$/, "");
    const name = /^ {6}('?[^\s:']+'?):/.exec(line)?.[1];
    if (name !== undefined) dependency = name.replace(/'/g, "");
    const versions = [...line.matchAll(/zod@(\d+\.\d+\.\d+)/g)].map((match) => match[1]!);
    const direct = /^ {6}zod: '?(\d+\.\d+\.\d+)/.exec(line)?.[1];
    if (direct) versions.push(direct);
    // Importers list `zod:` followed by `specifier:` and `version:` lines.
    const importerVersion = dependency === "zod" ? /^ {8}version: (\d+\.\d+\.\d+)/.exec(line)?.[1] : undefined;
    if (section === "importers:" && importerVersion) versions.push(importerVersion);
    if (!versions.some(vulnerable)) continue;
    owners.add(section === "importers:" ? `importer ${owner}` : `snapshot ${packageName(owner)}`);
  }
  return owners;
}

const unexpected = (owners: Set<string>) =>
  [...owners].filter((owner) => !(owner.startsWith("snapshot ") && ALLOWED_SNAPSHOTS.has(owner.slice(9))));

const lockfile = readFileSync(new URL("../../../../pnpm-lock.yaml", import.meta.url), "utf8");

describe("zod audit exception", () => {
  test("only the CRE SDK chain resolves a vulnerable zod", () => {
    const owners = vulnerableZodOwners(lockfile);
    expect(unexpected(owners)).toEqual([]);
    expect(owners.has("snapshot @chainlink/cre-sdk")).toBe(true);
  });

  const snapshotsAt = lockfile.indexOf("\nsnapshots:\n") + "\nsnapshots:\n".length;
  const importersAt = lockfile.indexOf("\nimporters:\n") + "\nimporters:\n".length;
  const withSnapshot = (entry: string) => `${lockfile.slice(0, snapshotsAt)}\n${entry}\n${lockfile.slice(snapshotsAt)}`;
  const withImporter = (entry: string) => `${lockfile.slice(0, importersAt)}\n${entry}\n${lockfile.slice(importersAt)}`;
  const mutations: Record<string, string> = {
    "direct dependency": withSnapshot("  '@evil/pkg@1.0.0':\n    dependencies:\n      zod: 3.22.0"),
    "npm alias": withSnapshot("  evil@1.0.0:\n    dependencies:\n      zod3: zod@3.25.76"),
    "peer-resolved suffix": withSnapshot("  evil@1.0.0:\n    dependencies:\n      viem: 2.57.11(typescript@5.9.3)(zod@3.25.76)"),
    "peer suffix in key": withSnapshot("  evil@1.0.0(zod@3.25.76):\n    dependencies:\n      tslib: 2.8.1"),
    "optional dependency": withSnapshot("  evil@1.0.0:\n    optionalDependencies:\n      zod: 4.6.5"),
    "workspace dependency": withImporter("  packages/evil:\n    dependencies:\n      zod:\n        specifier: 3.25.76\n        version: 3.25.76"),
    "workspace alias": withImporter("  packages/evil:\n    dependencies:\n      zod3:\n        specifier: npm:zod@3.25.76\n        version: zod@3.25.76"),
    "workspace peer suffix": withImporter("  packages/evil:\n    dependencies:\n      viem:\n        specifier: 2.57.11\n        version: 2.57.11(typescript@7.0.2)(zod@3.25.76)"),
  };
  for (const [name, mutated] of Object.entries(mutations)) {
    test(`flags a new ${name}`, () => {
      expect(unexpected(vulnerableZodOwners(mutated))).toHaveLength(1);
    });
  }
  test("patched zod references are not flagged", () => {
    const patched = withSnapshot("  ok@1.0.0:\n    dependencies:\n      zod: 4.6.6\n      viem: 2.57.11(typescript@5.9.3)(zod@4.6.7)");
    expect(unexpected(vulnerableZodOwners(patched))).toEqual([]);
  });
});
