import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain-JS package internals, typed only through dist/index.d.ts.
import { alphaOf, contrastRatio, toHex } from "../lib/color.mjs";
// @ts-expect-error — see above.
import { cssTokens, loadTokens, TokenError } from "../lib/tokens.mjs";

/**
 * The package publishes five artefacts derived from one token file. These
 * tests hold that derivation to its promise: every consumer, on every
 * platform, is looking at the same colour — and `dist/` is not stale.
 */

const ROOT = ".";
const tokens = loadTokens(`${ROOT}/tokens`);
const dist = JSON.parse(readFileSync(`${ROOT}/dist/tokens.json`, "utf8"));
const css = readFileSync(`${ROOT}/dist/tokens.css`, "utf8");
const dart = readFileSync(`${ROOT}/dist/tokens.dart`, "utf8");

const swatch = (name: string): string => {
  const token = tokens.get(name);
  if (!token) throw new Error(`No token named ${name}`);
  return toHex(token.value);
};

describe("token source", () => {
  it("rejects a token with an unsupported $type", () => {
    expect(() => loadTokens(`${ROOT}/test/fixtures/bad-type`)).toThrow(TokenError);
  });

  it("rejects a colour value it cannot resolve", () => {
    expect(() => loadTokens(`${ROOT}/test/fixtures/bad-color`)).toThrow(TokenError);
  });

  it("rejects two tokens claiming the same name", () => {
    expect(() => loadTokens(`${ROOT}/test/fixtures/duplicate`)).toThrow(/duplicate token name/);
  });
});

describe("dist is current", () => {
  it("emits a CSS variable for every token that declares one", () => {
    for (const token of cssTokens(tokens)) {
      expect(css, token.name).toContain(`--${token.name}: ${token.value};`);
    }
  });

  it("emits no CSS variable for reference-only tokens", () => {
    for (const token of [...tokens.values()].filter((t) => !t.cssVar)) {
      expect(css, token.name).not.toContain(`--${token.name}:`);
    }
  });

  it("carries every token into tokens.json with the same value", () => {
    expect(Object.keys(dist.tokens).sort()).toEqual([...tokens.keys()].sort());
    for (const [name, entry] of Object.entries<{ value: string }>(dist.tokens)) {
      expect(entry.value, name).toBe(tokens.get(name).value);
    }
  });

  it("resolves colours to hex consistently across json and dart", () => {
    for (const token of [...tokens.values()].filter((t) => t.type === "color")) {
      const hex = toHex(token.value);
      expect(dist.tokens[token.name].hex, token.name).toBe(hex);
      // Dart carries the same RGB with alpha promoted to the leading byte.
      const argb = `0x${Math.round(alphaOf(token.value) * 255)
        .toString(16)
        .padStart(2, "0")
        .toUpperCase()}${hex.slice(1)}`;
      expect(dart, token.name).toContain(`Color(${argb})`);
    }
  });
});

describe("colour system claims", () => {
  /** WCAG AA for large text and UI components. */
  const AA_LARGE = 3;
  /** WCAG AA for body text. */
  const AA_BODY = 4.5;

  it("keeps body text legible on every dark surface", () => {
    for (const surface of ["background", "surface", "surface-elevated"]) {
      expect(contrastRatio(swatch("foreground"), swatch(surface)), surface).toBeGreaterThanOrEqual(
        AA_BODY,
      );
    }
  });

  it("keeps secondary text legible on the page background", () => {
    expect(contrastRatio(swatch("muted-foreground"), swatch("background"))).toBeGreaterThanOrEqual(
      AA_BODY,
    );
  });

  it("keeps the interface copper legible on dark surfaces", () => {
    expect(contrastRatio(swatch("copper"), swatch("background"))).toBeGreaterThanOrEqual(AA_BODY);
    expect(contrastRatio(swatch("copper"), swatch("surface-elevated"))).toBeGreaterThanOrEqual(
      AA_BODY,
    );
  });

  /**
   * The signal colours are read as words far more often than they are used as
   * fills — "revoked", "3 failed", "cannot sign in". Nothing here checked them,
   * and one of them was below the floor the whole time: `destructive` reaches
   * only 3.80:1 on the page background. It went unnoticed because no screen in
   * the accessibility sweep happened to render destructive text.
   *
   * `destructive` stays where it is. It is dark enough to carry near-white text
   * *on top of* it, which is the other job it has to do — and a single swatch
   * cannot be both. `destructive-text` is the twin for the text case.
   */
  it("keeps every signal colour legible as text on every dark surface", () => {
    for (const signal of ["positive", "alert", "destructive-text"]) {
      for (const surface of ["background", "surface", "surface-elevated"]) {
        expect(
          contrastRatio(swatch(signal), swatch(surface)),
          `${signal} on ${surface}`,
        ).toBeGreaterThanOrEqual(AA_BODY);
      }
    }
  });

  it("keeps text on a destructive fill legible", () => {
    expect(
      contrastRatio(swatch("destructive-foreground"), swatch("destructive")),
    ).toBeGreaterThanOrEqual(AA_BODY);
  });

  /**
   * The reason the pair exists. If `destructive` ever drifts light enough to
   * pass as text, it has stopped being a fill that near-white text can sit on —
   * and this test says so before someone collapses the two back into one.
   */
  it("shows why the destructive fill and its text twin are not interchangeable", () => {
    expect(contrastRatio(swatch("destructive"), swatch("background"))).toBeLessThan(AA_BODY);
  });

  it("keeps text on a copper fill legible", () => {
    expect(contrastRatio(swatch("primary-foreground"), swatch("copper"))).toBeGreaterThanOrEqual(
      AA_BODY,
    );
  });

  it("keeps the print stops legible on paper", () => {
    expect(
      contrastRatio(swatch("print-copper-deep"), swatch("print-paper")),
    ).toBeGreaterThanOrEqual(AA_LARGE);
    for (const ink of ["print-ink", "print-ink-muted"]) {
      expect(contrastRatio(swatch(ink), swatch("print-paper")), ink).toBeGreaterThanOrEqual(
        AA_BODY,
      );
    }
  });

  it("shows why the screen and print coppers are not interchangeable", () => {
    // Putting the screen copper on paper is exactly the mistake the split
    // prevents: it drops below the large-text floor.
    expect(contrastRatio(swatch("copper"), swatch("print-paper"))).toBeLessThan(AA_LARGE);
  });
});
