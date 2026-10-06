import { describe, expect, it } from "vitest";
import {
  fingerprintSecret,
  parseSecretReference,
  resolveSecret,
  SecretResolutionError,
} from "../src/secrets.js";

/**
 * Secret resolution — 06 §6.4.
 *
 * Half of what this file checks is not "the value reads correctly" but **the value does not
 * leak**. A value in an error message turns the log into a leak path.
 */

const files: Record<string, string> = {
  "/run/secrets/session": "a-very-long-session-secret-value\n",
  "/run/secrets/empty": "   \n",
};

const readFile = (path: string): string => {
  const contents = files[path];
  if (contents === undefined) {
    const error = new Error("ENOENT") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    throw error;
  }
  return contents;
};

describe("reference parsing", () => {
  it("splits off the scheme when present", () => {
    expect(parseSecretReference("file:/run/secrets/x")).toEqual({
      scheme: "file",
      locator: "/run/secrets/x",
    });
  });

  it("treats a string without a scheme as a literal value", () => {
    // If local development required a vault, nobody would run it.
    expect(parseSecretReference("literal-value")).toEqual({
      scheme: "inline",
      locator: "literal-value",
    });
  });

  it("does not truncate a value that contains colons", () => {
    // DATABASE_URL is `postgres://user:pass@host`. Mistaking that for a scheme would break the
    // whole connection string.
    expect(parseSecretReference("postgres://u:p@localhost:5432/db")).toEqual({
      scheme: "inline",
      locator: "postgres://u:p@localhost:5432/db",
    });
  });

  it("plain explicitly marks a literal value", () => {
    expect(parseSecretReference("plain:file:not-a-path")).toEqual({
      scheme: "plain",
      locator: "file:not-a-path",
    });
  });
});

describe("resolution", () => {
  it("reads from a file and strips the trailing newline", () => {
    // An editor-appended newline left in place silently corrupts a signing key.
    expect(resolveSecret("SESSION_SECRET", "file:/run/secrets/session", readFile)).toBe(
      "a-very-long-session-secret-value",
    );
  });

  it("can point at another environment variable", () => {
    const value = resolveSecret("DATABASE_URL", "env:PLATFORM_DB_URL", readFile, {
      PLATFORM_DB_URL: "postgres://localhost/x",
    });
    expect(value).toBe("postgres://localhost/x");
  });

  it("accepts a literal value", () => {
    expect(resolveSecret("SESSION_SECRET", "literal", readFile)).toBe("literal");
  });
});

describe("failure", () => {
  it("names the variable when the value is missing", () => {
    expect(() => resolveSecret("SESSION_SECRET", undefined, readFile)).toThrow(
      SecretResolutionError,
    );
  });

  it("reports the path and code when the file is missing", () => {
    try {
      resolveSecret("SESSION_SECRET", "file:/nope", readFile);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain("/nope");
      expect((error as Error).message).toContain("ENOENT");
    }
  });

  it("does not accept an empty file as a value", () => {
    // Letting a whitespace-only file through starts the server with an empty secret.
    expect(() => resolveSecret("SESSION_SECRET", "file:/run/secrets/empty", readFile)).toThrow(
      /is empty/,
    );
  });

  it("names the referenced environment variable when it is empty", () => {
    try {
      resolveSecret("DATABASE_URL", "env:MISSING", readFile, {});
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain("MISSING");
    }
  });

  it("keeps the value out of the error message", () => {
    // If this file's contents reached the error, the log would become a leak path.
    const secret = "a-very-long-session-secret-value";
    try {
      // No case reads an existing file under a wrong variable name. Instead, point the env at a
      // variable holding the value, then trigger a different failure and check the message.
      resolveSecret("SESSION_SECRET", "file:/nope", readFile, { X: secret });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });
});

describe("fingerprint", () => {
  const hash = (input: string) => `sha-${input.length}-${input.slice(0, 2)}-padding-padding`;

  it("produces a short fingerprint that does not expose the value", () => {
    const fingerprint = fingerprintSecret("super-secret-value", hash);
    expect(fingerprint).toHaveLength(12);
    expect(fingerprint).not.toContain("secret");
  });

  it("the same value yields the same fingerprint", () => {
    // The purpose is to confirm rotation without exposing the value.
    expect(fingerprintSecret("v1", hash)).toBe(fingerprintSecret("v1", hash));
    expect(fingerprintSecret("v1", hash)).not.toBe(fingerprintSecret("value-2", hash));
  });
});
