/* MPC design tokens 0.1.0 — GENERATED from tokens/*.json. Do not edit. */

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
