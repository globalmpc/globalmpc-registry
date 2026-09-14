/* MPC design tokens 0.1.0 — GENERATED from tokens/*.json. Do not edit. */

import tokens from "./tokens.json" with { type: "json" };

export const VERSION = tokens.version;
export const TOKENS = tokens.tokens;

/** Resolved sRGB hex for a colour token, or undefined. */
export const hex = (name) => TOKENS[name]?.hex;
