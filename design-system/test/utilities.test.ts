import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain-JS package internals, typed only through dist/index.d.ts.
import { cssTokens, loadTokens } from "../lib/tokens.mjs";

/**
 * The utility layer must stand on its own.
 *
 * `utilities.css` is documented as importable by any consumer — "a consumer
 * without Tailwind can import this directly". That promise only holds if every
 * custom property it reads is one `tokens.css` actually defines. Tailwind's
 * `--color-*` namespace exists only after a project writes an `@theme` block,
 * so a utility reaching for `--color-copper` renders colourless everywhere
 * else — silently, because an undefined `var()` is not an error.
 */

const ROOT = ".";
const tokens = loadTokens(`${ROOT}/tokens`);
const defined = new Set(
  cssTokens(tokens).map((token: { name: string }) => `--${token.name}`),
);

const utilities = readFileSync(`${ROOT}/css/utilities.css`, "utf8");
const built = readFileSync(`${ROOT}/dist/utilities.css`, "utf8");

/**
 * Custom properties the file reads without a fallback.
 *
 * `var(--i, 0)` is excluded on purpose: a declared fallback is the author
 * saying the property comes from outside — the reveal stagger is set inline
 * per element. It is the bare `var(--x)` that has to resolve.
 */
const referenced = (css: string): string[] => [
  ...new Set([...css.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map((match) => match[1]!)),
];

describe("utilities read only tokens that exist", () => {
  it("source references no undefined custom property", () => {
    for (const name of referenced(utilities)) {
      expect(defined, name).toContain(name);
    }
  });

  it("dist references no undefined custom property", () => {
    for (const name of referenced(built)) {
      expect(defined, name).toContain(name);
    }
  });

  it("does not depend on the Tailwind --color-* namespace", () => {
    // Tailwind aliases are a consumer's choice, not this package's contract.
    expect(utilities).not.toMatch(/var\(\s*--color-/);
  });
});
