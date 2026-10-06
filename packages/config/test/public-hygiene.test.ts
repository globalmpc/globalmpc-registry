import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  findPublicHygieneViolations,
  isScannedPath,
  parseExtraPatterns,
  scanFile,
  type PublicHygieneRule,
} from "../src/public-hygiene.js";

/**
 * Public release hygiene.
 *
 * This tree is published as open source. Text that only makes sense inside the organization —
 * internal tracker ids, internal audit labels, workstation paths, personal addresses, or any
 * non-English prose — must not reach it. Names that are themselves private (hosts, accounts)
 * are never written into this repository; they come in through `PUBLIC_HYGIENE_EXTRA_PATTERNS`.
 *
 * Fixtures are assembled from parts so this file never matches its own rules.
 */

const rulesOf = (text: string, extra: readonly RegExp[] = []): readonly PublicHygieneRule[] =>
  findPublicHygieneViolations("sample.ts", text, extra).map((violation) => violation.rule);

describe("public hygiene rules", () => {
  it("passes ordinary English source", () => {
    expect(rulesOf("// Spec 05 §5.3, OD-17 — the region has no default.\nconst a = 1;\n")).toEqual([]);
  });

  it("flags Hangul in text", () => {
    expect(rulesOf(`const label = "${String.fromCodePoint(0xd55c)}";`)).toEqual(["non-english-text"]);
  });

  it("flags Hangul jamo, not just syllables", () => {
    expect(rulesOf(`// ${String.fromCodePoint(0x3131)}`)).toEqual(["non-english-text"]);
  });

  it.each(["W", "Q"])("flags internal tracker ids with prefix %s", (prefix) => {
    expect(rulesOf(`// see ${prefix}-${"087"}`)).toEqual(["internal-tracker-id"]);
  });

  it.each(["12", "1000"])("flags tracker ids with %s as the number", (digits) => {
    expect(rulesOf(`// see W-${digits}`)).toEqual(["internal-tracker-id"]);
  });

  it("does not flag documented notation such as OD, AC, or D numbers", () => {
    expect(rulesOf("// OD-17 · AC-29 · D-41 · REQ-DAPP-001 · ADR-T01")).toEqual([]);
  });

  it.each([
    `// ${"2026-09-10"} audit`,
    `// audit ${"A"}2`,
    `// size cap (${"A"}7)`,
    `// drill (${"A"}5·A6)`,
    `// drill (${"A"}5, A6)`,
    `// drill (${"A"}5/A6)`,
  ])("flags internal audit labels: %s", (line) => {
    expect(rulesOf(line)).toEqual(["internal-audit-label"]);
  });

  it("does not flag the word audit on its own or an A4 sheet", () => {
    expect(rulesOf("// subject to audit.\n// A white A4 sheet")).toEqual([]);
  });

  it.each([`/${"Users"}/someone/project`, `/${"home"}/someone/project`, `C:\\${"Users"}\\someone`])(
    "flags workstation paths: %s",
    (line) => {
      expect(rulesOf(line)).toEqual(["workstation-path"]);
    },
  );

  it("flags email addresses outside reserved example domains", () => {
    expect(rulesOf(`// contact ${"someone"}@${"company"}.com`)).toEqual(["email-address"]);
  });

  it.each([
    "ops@example.com",
    "a@b.example",
    "user@hooks.example.test",
    "x@registry.invalid",
    "logo@2x.png",
  ])("does not flag reserved or non-address forms: %s", (value) => {
    expect(rulesOf(`// ${value}`)).toEqual([]);
  });

  it("flags extra patterns supplied at run time and reports their line", () => {
    const violations = findPublicHygieneViolations("a.md", "ok\nhost is secret-host.lan\n", [/secret-host\.lan/]);
    expect(violations).toEqual([{ file: "a.md", line: 2, rule: "extra-pattern" }]);
  });

  it("never echoes the matched text", () => {
    const [violation] = findPublicHygieneViolations("a.md", "token-name\n", [/token-name/]);
    expect(Object.values(violation ?? {})).not.toContain("token-name");
  });

  it("flags a non-English file name", () => {
    expect(findPublicHygieneViolations(`docs/${String.fromCodePoint(0xd55c)}.md`, "", [])).toEqual([
      { file: `docs/${String.fromCodePoint(0xd55c)}.md`, line: 0, rule: "non-english-text" },
    ]);
  });
});

describe("scanFile", () => {
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

  it("scans UTF-8 content", () => {
    expect(scanFile("a.md", encode(`// ${"W"}-001`), [])).toEqual([{ file: "a.md", line: 1, rule: "internal-tracker-id" }]);
  });

  it("checks only the path of a file that is not UTF-8", () => {
    // Compressed image bytes decode to arbitrary code points; scanning them only produces noise.
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0xea, 0xb0, 0x80]);
    expect(scanFile("logo.png", png, [])).toEqual([]);
    expect(scanFile(`${String.fromCodePoint(0xd55c)}.png`, png, [])).toHaveLength(1);
  });

  it("allows non-English script only in the canonical serialization vectors", () => {
    const vector = encode(`{"ja":"${String.fromCodePoint(0x30e2)}"}`);
    expect(scanFile("packages/canonical/test/vectors.json", vector, [])).toEqual([]);
    expect(scanFile("packages/api-contract/test/vectors.json", vector, [])).toHaveLength(1);
  });

  it("does not let the vector allowance cover other rules", () => {
    expect(scanFile("packages/canonical/test/vectors.json", encode(`// ${"Q"}-001`), [])).toHaveLength(1);
  });
});

describe("parseExtraPatterns", () => {
  it("reads one pattern per line and ignores blanks and comments", () => {
    const patterns = parseExtraPatterns("alpha\\.lan\n\n# note\n  beta  \n");
    expect(patterns.map((pattern) => pattern.source)).toEqual(["alpha\\.lan", "beta"]);
    expect(patterns.every((pattern) => pattern.flags.includes("i"))).toBe(true);
  });

  it("returns nothing when unset", () => {
    expect(parseExtraPatterns(undefined)).toEqual([]);
  });

  it("fails on an invalid pattern without echoing it", () => {
    expect(() => parseExtraPatterns("ok\n(unclosed")).toThrow(/line 2/);
    expect(() => parseExtraPatterns("ok\n(unclosed")).not.toThrow(/unclosed/);
  });
});

describe("isScannedPath", () => {
  it.each(["contracts/lib/forge-std/src/Test.sol", "pnpm-lock.yaml"])("skips vendored %s", (file) => {
    expect(isScannedPath(file)).toBe(false);
  });

  it.each(["README.md", "apps/api/src/config.ts", "packages/api-contract/openapi.json"])("scans %s", (file) => {
    expect(isScannedPath(file)).toBe(true);
  });
});

/**
 * The tracked tree itself. Running here, not only as a script, means the existing CI test step
 * enforces it — a new rule cannot be skipped by forgetting to add a workflow step.
 */
describe("tracked tree", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((file) => file !== "" && isScannedPath(file));

  it("has files to scan", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("has no public hygiene violations", () => {
    const extra = parseExtraPatterns(process.env["PUBLIC_HYGIENE_EXTRA_PATTERNS"]);
    const violations = files.flatMap((file) => scanFile(file, readFileSync(path.join(root, file)), extra));
    expect(violations).toEqual([]);
  });
});
