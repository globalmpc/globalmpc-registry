/* MPC design tokens 0.3.0 — GENERATED from tokens/*.json. Do not edit. */

export interface CopyText {
  en: string;
}

/** @deprecated Renamed to CopyText in 0.3.0, when the Korean field was removed. Removed in 0.4.0. */
export interface Bilingual extends CopyText {
  /** @deprecated No longer emitted since 0.3.0; always undefined. Read `en`. */
  ko?: string;
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
  /** Typed as the deprecated Bilingual through 0.3.x so code reading `.ko` still compiles; CopyText from 0.4.0. */
  use?: Bilingual;
  note?: Bilingual;
}

export declare const VERSION: string;
export declare const TOKENS: Record<string, Token>;
export declare function hex(name: string): string | undefined;
