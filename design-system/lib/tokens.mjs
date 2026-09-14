/**
 * Loads and validates the DTCG token files.
 *
 * The files follow the Design Tokens Community Group format (`$value`,
 * `$type`, `$description`, `$extensions`) so that a Style Dictionary pipeline
 * or a Figma token plugin can be pointed at them later without a rewrite. The
 * transformation is done here rather than by Style Dictionary because its
 * built-in colour transforms do not understand oklch, and working around that
 * costs more than the ~150 lines this replaces.
 *
 * Validation is strict and fails the build. A token file is the source of
 * truth for several downstream artefacts, and a silently-skipped malformed
 * entry would surface as a missing colour in a consumer's app instead.
 */
import { readFileSync, readdirSync } from "node:fs";
import { toHex } from "./color.mjs";

/** `$type` values this system uses. Anything else is a typo or a new concept. */
export const SUPPORTED_TYPES = ["color", "dimension", "fontFamily"];

export class TokenError extends Error {}

/**
 * Walk a DTCG document, yielding every leaf token with its dotted path.
 *
 * A node is a token when it carries `$value`; anything else with children is a
 * group. `$`-prefixed keys are metadata at every level.
 */
function* walk(node, path = []) {
  if (node === null || typeof node !== "object") return;

  if ("$value" in node) {
    yield { path, node };
    return;
  }

  for (const [key, child] of Object.entries(node)) {
    if (key.startsWith("$")) continue;
    yield* walk(child, [...path, key]);
  }
}

/**
 * Every token across `tokens/`, keyed by its CSS-facing name.
 *
 * The name is the last path segment, not the full dotted path: `color.copper`
 * is `--copper`, because that is what the stylesheet has always called it and
 * renaming 37 tokens to gain a namespace nobody asked for is churn.
 */
export function loadTokens(dir) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (files.length === 0) throw new TokenError(`No token files in ${dir}`);

  const tokens = new Map();

  for (const file of files) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(`${dir}/${file}`, "utf8"));
    } catch (cause) {
      throw new TokenError(`${file}: not valid JSON — ${cause.message}`);
    }

    for (const { path, node } of walk(doc)) {
      const where = `${file}:${path.join(".")}`;
      const name = path.at(-1);

      if (typeof node.$value !== "string" || node.$value.length === 0) {
        throw new TokenError(`${where}: $value must be a non-empty string`);
      }
      if (!SUPPORTED_TYPES.includes(node.$type)) {
        throw new TokenError(
          `${where}: $type "${node.$type}" is not one of ${SUPPORTED_TYPES.join(", ")}`,
        );
      }
      if (tokens.has(name)) {
        throw new TokenError(
          `${where}: duplicate token name "${name}" (also in ${tokens.get(name).file})`,
        );
      }
      if (node.$type === "color" && toHex(node.$value) === null) {
        throw new TokenError(
          `${where}: $value "${node.$value}" is not a colour this build understands`,
        );
      }

      const extensions = node.$extensions ?? {};
      tokens.set(name, {
        name,
        file,
        path,
        group: extensions["mpc.group"] ?? path[0],
        type: node.$type,
        value: node.$value,
        description: node.$description ?? "",
        use: extensions["mpc.use"] ?? null,
        note: extensions["mpc.note"] ?? null,
        /** Print stops and other reference-only values emit no CSS variable. */
        cssVar: extensions["mpc.cssVar"] !== false,
        extensions,
      });
    }
  }

  return tokens;
}

/** Tokens that become `--name` custom properties, in declaration order. */
export function cssTokens(tokens) {
  return [...tokens.values()].filter((t) => t.cssVar);
}
