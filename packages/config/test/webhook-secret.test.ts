import { describe, expect, it } from "vitest";
import {
  isAllowedWebhookSecretReference,
  resolveWebhookSecret,
  WebhookSecretReferenceError,
} from "../src/webhook-secret.js";

/**
 * Webhook signing-secret references — W-087.
 *
 * A tenant operator sets the reference; the worker resolves it. Unrestricted, it could point
 * the worker at its own database URL, the anchor signer key, or any readable file.
 */
describe("webhook secret reference namespace", () => {
  it.each([
    "env:WEBHOOK_SECRET_ACME",
    "env:WEBHOOK_SECRET_A_1",
    "file:/run/secrets/webhook_acme",
    "file:/run/secrets/webhook_acme-2",
  ])("accepts %s", (reference) => {
    expect(isAllowedWebhookSecretReference(reference)).toBe(true);
  });

  it.each([
    "env:DATABASE_URL",
    "env:ANCHOR_SIGNER_KEY",
    "env:WEBHOOK_SECRET_",
    "env:webhook_secret_acme",
    "file:/run/secrets/worker_database_url",
    "file:/etc/passwd",
    "file:/run/secrets/webhook_../worker_database_url",
    "file:/run/secrets/webhook_a/b",
    "file:/run/secrets/webhook_",
    "plain:literal-secret",
    "literal-secret",
    "env:WEBHOOK_SECRET_ACME\n",
    " env:WEBHOOK_SECRET_ACME",
  ])("rejects %j", (reference) => {
    expect(isAllowedWebhookSecretReference(reference)).toBe(false);
  });

  it("refuses a reference outside the namespace before reading anything", () => {
    let touched = false;
    const readFile = () => {
      touched = true;
      return "value";
    };

    expect(() => resolveWebhookSecret("file:/etc/passwd", readFile, {})).toThrow(
      WebhookSecretReferenceError,
    );
    expect(touched).toBe(false);
  });

  it("keeps the refused reference out of the error", () => {
    // The error may travel into logs; a path is information about the deployment layout.
    expect(() => resolveWebhookSecret("file:/run/secrets/worker_database_url")).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("worker_database_url") }),
    );
  });

  it("resolves an allowed env reference", () => {
    expect(
      resolveWebhookSecret("env:WEBHOOK_SECRET_ACME", undefined, { WEBHOOK_SECRET_ACME: "s3cret" }),
    ).toBe("s3cret");
  });

  it("resolves an allowed file reference", () => {
    const paths: string[] = [];
    const readFile = (path: string) => {
      paths.push(path);
      return "s3cret\n";
    };

    expect(resolveWebhookSecret("file:/run/secrets/webhook_acme", readFile, {})).toBe("s3cret");
    expect(paths).toEqual(["/run/secrets/webhook_acme"]);
  });
});
