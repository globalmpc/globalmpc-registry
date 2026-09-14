/**
 * tokens/*.json → dist/*
 *
 *   node scripts/build.mjs
 *
 * Every output is derived from the same token map, so a consumer on Flutter
 * and a consumer on Tailwind cannot be looking at different colours. `dist/`
 * is committed: a project adopting the system should be able to copy one file
 * without installing a toolchain first.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { alphaOf, toArgb, toHex } from "../lib/color.mjs";
import { cssTokens, loadTokens } from "../lib/tokens.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8")).version;

const tokens = loadTokens(`${ROOT}/tokens`);
const css = cssTokens(tokens);

const banner = (comment = "/*", close = " */") =>
  `${comment} MPC design tokens ${version} — GENERATED from tokens/*.json. Do not edit.${close}\n`;

mkdirSync(`${ROOT}/dist`, { recursive: true });

/* ── tokens.css ────────────────────────────────────────────────────────
   The primary artefact. A CSS consumer imports this and nothing else. */

writeFileSync(
  `${ROOT}/dist/tokens.css`,
  banner() + "\n:root {\n" + css.map((t) => `  --${t.name}: ${t.value};`).join("\n") + "\n}\n",
);

/* ── tokens.json ───────────────────────────────────────────────────────
   Flat, pre-resolved, no DTCG nesting. What a script or a non-CSS platform
   reads when it does not want to implement colour conversion. */

writeFileSync(
  `${ROOT}/dist/tokens.json`,
  JSON.stringify(
    {
      version,
      tokens: Object.fromEntries(
        [...tokens.values()].map((t) => [
          t.name,
          {
            group: t.group,
            type: t.type,
            value: t.value,
            ...(t.type === "color" ? { hex: toHex(t.value), alpha: alphaOf(t.value) } : {}),
            cssVar: t.cssVar,
            description: t.description,
            ...(t.use ? { use: t.use } : {}),
            ...(t.note ? { note: t.note } : {}),
          },
        ]),
      ),
    },
    null,
    2,
  ) + "\n",
);

/* ── tokens.scss ───────────────────────────────────────────────────────
   Sass consumers cannot read CSS custom properties at compile time, so they
   get literals. Same values, different binding time. */

writeFileSync(
  `${ROOT}/dist/tokens.scss`,
  banner("//", "") + "\n" + css.map((t) => `$${t.name}: ${t.value};`).join("\n") + "\n",
);

/* ── tokens.dart ───────────────────────────────────────────────────────
   Flutter has no oklch: colours are resolved to ARGB here. Non-colour tokens
   are emitted as their own maps so a Dart consumer gets the radius scale and
   the font stacks too, not just the palette. */

const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/**
 * `radius-sm` inside `MpcRadius` reads as `MpcRadius.radiusSm`. Strip the
 * prefix the class name already carries; a bare `radius` becomes `base`.
 */
const dartName = (name, prefix) => {
  if (!prefix || !name.startsWith(prefix)) return camel(name);
  const rest = name.slice(prefix.length).replace(/^-/, "");
  return rest === "" ? "base" : camel(rest);
};

const dartSection = (label, entries) =>
  `abstract final class ${label} {\n${entries.join("\n")}\n}\n`;

const colors = [...tokens.values()].filter((t) => t.type === "color");
const dimensions = [...tokens.values()].filter((t) => t.type === "dimension");
const families = [...tokens.values()].filter((t) => t.type === "fontFamily");

writeFileSync(
  `${ROOT}/dist/tokens.dart`,
  banner("//", "") +
    "\nimport 'dart:ui';\n\n" +
    dartSection(
      "MpcColors",
      colors.map((t) => `  static const Color ${dartName(t.name)} = Color(${toArgb(t.value)});`),
    ) +
    "\n" +
    dartSection(
      "MpcRadius",
      dimensions.map(
        (t) =>
          `  static const double ${dartName(t.name, "radius")} = ${parseFloat(t.value).toFixed(1)};`,
      ),
    ) +
    "\n" +
    dartSection(
      "MpcFonts",
      families.map(
        (t) =>
          `  static const String ${dartName(t.name, "font")} = '${t.extensions["mpc.family"] ?? t.value}';`,
      ),
    ),
);

/* ── utilities.css ─────────────────────────────────────────────────────
   Not derived from tokens — this is authored CSS that consumes them. It ships
   through dist so a consumer imports two files from one place rather than
   reaching into the package's source layout. */

writeFileSync(
  `${ROOT}/dist/utilities.css`,
  banner() + "\n" + readFileSync(`${ROOT}/css/utilities.css`, "utf8"),
);

/* ── index.js / index.d.ts ─────────────────────────────────────────────
   For JS consumers that want the data rather than the stylesheet. Kept to a
   re-export of tokens.json so there is one shape to learn, not two. */

writeFileSync(
  `${ROOT}/dist/index.js`,
  banner() +
    `\nimport tokens from "./tokens.json" with { type: "json" };\n\n` +
    `export const VERSION = tokens.version;\nexport const TOKENS = tokens.tokens;\n\n` +
    `/** Resolved sRGB hex for a colour token, or undefined. */\n` +
    `export const hex = (name) => TOKENS[name]?.hex;\n`,
);

writeFileSync(
  `${ROOT}/dist/index.d.ts`,
  banner() +
    `
export interface CopyText {
  en: string;
}

export interface Token {
  group: string;
  type: "color" | "dimension" | "fontFamily";
  /** The value as authored — oklch for screen colours. */
  value: string;
  /** Resolved sRGB hex. Colour tokens only. */
  hex?: string;
  /** Alpha channel, 0–1. Colour tokens only. */
  alpha?: number;
  /** False for reference-only values, such as the print stops. */
  cssVar: boolean;
  description: string;
  use?: CopyText;
  note?: CopyText;
}

export declare const VERSION: string;
export declare const TOKENS: Record<string, Token>;
export declare function hex(name: string): string | undefined;
`,
);

console.log(
  `dist/  (${css.length} CSS vars, ${tokens.size} tokens total: ` +
    `${colors.length} colour, ${dimensions.length} dimension, ${families.length} fontFamily)`,
);
