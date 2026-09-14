import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain-JS package internals, typed only through dist/index.d.ts.
import { loadTokens } from "../lib/tokens.mjs";

/**
 * A design system whose documentation lags its tokens is worse than one with
 * no documentation: it answers "what is `--accent` for" confidently and
 * wrongly. These tests make the token file the authority, so adding a token
 * without saying what it is for fails the build.
 *
 * They also check the agent-facing rules file, because that is the copy most
 * consuming projects will actually load — a token missing there is a token an
 * agent will not use.
 */

const ROOT = ".";
const tokens = [...loadTokens(`${ROOT}/tokens`).values()];
const read = (path: string) => readFileSync(`${ROOT}/${path}`, "utf8");

const patterns = JSON.parse(read("content/patterns.json"));
const voice = JSON.parse(read("content/voice.json"));
const utilitiesCss = read("css/utilities.css");

describe("docs/tokens.md", () => {
  const doc = read("docs/tokens.md");

  it("documents every token", () => {
    const missing = tokens.filter((t) => !doc.includes(`\`${t.cssVar ? `--${t.name}` : t.name}\``));
    expect(
      missing.map((t) => t.name),
      "undocumented tokens",
    ).toEqual([]);
  });

  it("gives every token a bilingual use string", () => {
    for (const token of tokens) {
      expect(token.use?.en.length, `${token.name}.use.en`).toBeGreaterThan(0);
      expect(token.use?.ko.length, `${token.name}.use.ko`).toBeGreaterThan(0);
    }
  });

  it("documents every class the utility layer defines", () => {
    // Comments are stripped first: prose mentioning `tokens.css` would
    // otherwise read as a selector for a class called `css`.
    const source = utilitiesCss.replace(/\/\*[\s\S]*?\*\//g, "");
    // A selector is any run of non-brace characters that opens a block. That
    // includes `@layer utilities` and `@media …`, which carry no class names.
    const defined = new Set(
      [...source.matchAll(/([^{}]+)\{/g)].flatMap(([, selector]) =>
        [...selector.matchAll(/\.([\w-]+)/g)].map(([, name]) => name),
      ),
    );
    const documented = new Set<string>(
      patterns.utilities.map((u: { className: string }) => u.className),
    );

    expect(
      [...defined].filter((c) => !documented.has(c)),
      "undocumented utilities",
    ).toEqual([]);
    expect(
      [...documented].filter((c) => !defined.has(c)),
      "documented but not defined",
    ).toEqual([]);
  });

  it("marks a utility animated exactly when reduced-motion disables it by name", () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(utilitiesCss);
    expect(reduced).not.toBeNull();

    for (const utility of patterns.utilities) {
      expect(reduced![1].includes(`.${utility.className}`), utility.className).toBe(
        utility.animated,
      );
    }
  });
});

describe("ai/CLAUDE.md", () => {
  const rules = read("ai/CLAUDE.md");

  it("lists every CSS variable an agent is allowed to use", () => {
    const missing = tokens.filter((t) => t.cssVar && !rules.includes(`\`--${t.name}\``));
    expect(
      missing.map((t) => t.name),
      "tokens absent from the agent rules",
    ).toEqual([]);
  });

  it("carries every tone rule", () => {
    for (const rule of voice.tone) expect(rules, rule.rule.en).toContain(rule.rule.en);
  });

  it("carries every logo prohibition", () => {
    const logo = JSON.parse(read("content/logo.json"));
    for (const dont of logo.donts) expect(rules, dont.en).toContain(dont.en);
  });

  it("states the positioning so a new project starts from it", () => {
    expect(rules).toContain(voice.positioning.statement.en);
  });
});
