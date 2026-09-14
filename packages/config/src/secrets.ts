/**
 * Secret resolution — spec 06 §6.4.
 *
 * Until now every secret went into an environment variable as a literal value. The problem is not
 * that the value is missing but that **nobody can tell where it came from**.
 *
 * - The value shows up verbatim in process listings, crash dumps, and `docker inspect`.
 * - Rotation requires a redeploy.
 * - There is no record of who set the value or when.
 *
 * So environment variables hold a **reference** and this module resolves it. The reference format
 * is `scheme:locator`; literal values are still accepted — if local development required a vault,
 * nobody would run it.
 *
 * Supported schemes:
 *
 * - `file:/path/to/secret` — read from a file. Docker secrets and Kubernetes projected volumes take
 *   this form. The value never lands in the process environment.
 * - `env:OTHER_VAR` — points at another environment variable. Uses the name the platform injects
 *   while keeping our own name separate.
 * - `plain:<value>` — explicitly marks a literal value.
 * - No scheme means a literal value (backward compatible).
 *
 * **Never put a resolved value in a log or error message.** On failure, report only the scheme and
 * locator of the reference string.
 */

import { readFileSync } from "node:fs";

export class SecretResolutionError extends Error {
  readonly code = "SECRET_UNRESOLVED";
  constructor(
    readonly variableName: string,
    reason: string,
  ) {
    // Carries no value. Records only which variable failed to resolve and why.
    super(`could not resolve ${variableName} — ${reason}`);
    this.name = "SecretResolutionError";
  }
}

export type SecretScheme = "file" | "env" | "plain" | "inline";

export interface SecretReference {
  readonly scheme: SecretScheme;
  /** The part after the scheme. For `inline`, the whole raw string. */
  readonly locator: string;
}

const SCHEME_PATTERN = /^(file|env|plain):(.+)$/s;

export function parseSecretReference(raw: string): SecretReference {
  const match = SCHEME_PATTERN.exec(raw);
  if (!match) return { scheme: "inline", locator: raw };
  return { scheme: match[1] as SecretScheme, locator: match[2]! };
}

/**
 * Turns a reference into its actual value.
 *
 * Local development and CI use `inline` as-is; deployed environments read secrets mounted via
 * `file:`. Both paths go through the same function, so no "behaves differently only in deployment"
 * section exists.
 */
export function resolveSecret(
  variableName: string,
  raw: string | undefined,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (raw === undefined || raw.length === 0) {
    throw new SecretResolutionError(variableName, "no value");
  }

  const reference = parseSecretReference(raw);

  switch (reference.scheme) {
    case "file": {
      let contents: string;
      try {
        contents = readFile(reference.locator);
      } catch (error) {
        throw new SecretResolutionError(
          variableName,
          `could not read file: ${reference.locator} (${(error as NodeJS.ErrnoException).code ?? "unknown"})`,
        );
      }
      // Editors append a trailing newline. Left in place, it silently corrupts a signing key.
      const trimmed = contents.trim();
      if (trimmed.length === 0) {
        throw new SecretResolutionError(variableName, `file is empty: ${reference.locator}`);
      }
      return trimmed;
    }

    case "env": {
      const value = env[reference.locator];
      if (!value) {
        throw new SecretResolutionError(
          variableName,
          `referenced environment variable is empty: ${reference.locator}`,
        );
      }
      return value;
    }

    case "plain":
      return reference.locator;

    case "inline":
      return reference.locator;
  }
}

/**
 * Startup summary of secret state.
 *
 * Carries no value. Records only which variable was read via which scheme — when operations asks
 * "which key are we using right now", the answer must already be in the log.
 */
export interface SecretAudit {
  readonly variableName: string;
  readonly scheme: SecretScheme;
  /** A fingerprint of the value, not the value. Confirms rotation without exposing it. */
  readonly fingerprint: string;
}

export function fingerprintSecret(value: string, hash: (input: string) => string): string {
  // Keep only the first 12 characters. The full hash would be a rainbow-table target.
  return hash(value).slice(0, 12);
}
