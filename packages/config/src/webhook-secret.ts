import { resolveSecret } from "./secrets.js";

/**
 * Webhook signing-secret references — W-087.
 *
 * A notification sink's `secretReference` is set by a tenant operator through the API and
 * resolved by the worker. Accepting any `env:`/`file:` value let that operator point the worker
 * at its own database URL, the anchor signer key, or any readable file. The value never left,
 * but whether it resolved did — the error text reached the admin screen.
 *
 * References are confined to a namespace that holds webhook secrets only:
 *
 * - `env:WEBHOOK_SECRET_<NAME>` — NAME is `[A-Z0-9_]`, 1–64 characters.
 * - `file:/run/secrets/webhook_<name>` — name is `[A-Za-z0-9_-]`, 1–64 characters. No `/` is
 *   allowed, so no subdirectory and no `..`. This is where Docker secrets named
 *   `webhook_<name>` land by default.
 *
 * Literal values (`plain:` or no scheme) are refused — the value would sit in the database.
 *
 * The API checks this at registration and the worker again before resolving, so a row written
 * before this rule, or by hand, is still refused.
 */
export const WEBHOOK_SECRET_ENV_PREFIX = "WEBHOOK_SECRET_";
export const WEBHOOK_SECRET_FILE_PREFIX = "/run/secrets/webhook_";

const ALLOWED_REFERENCE =
  /^(?:env:WEBHOOK_SECRET_[A-Z0-9_]{1,64}|file:\/run\/secrets\/webhook_[A-Za-z0-9_-]{1,64})$/;

export function isAllowedWebhookSecretReference(reference: string): boolean {
  return ALLOWED_REFERENCE.test(reference);
}

export class WebhookSecretReferenceError extends Error {
  readonly code = "WEBHOOK_SECRET_REFERENCE_NOT_ALLOWED";
  constructor() {
    // Carries no reference. A path is information about the deployment layout.
    super(
      `Webhook secret reference must be env:${WEBHOOK_SECRET_ENV_PREFIX}<NAME> or file:${WEBHOOK_SECRET_FILE_PREFIX}<name>`,
    );
    this.name = "WebhookSecretReferenceError";
  }
}

/** Resolves a webhook secret, refusing anything outside the namespace before reading. */
export function resolveWebhookSecret(
  reference: string,
  readFile?: (path: string) => string,
  env?: NodeJS.ProcessEnv,
): string {
  if (!isAllowedWebhookSecretReference(reference)) throw new WebhookSecretReferenceError();
  return resolveSecret("NOTIFY_SINK_SECRET", reference, readFile, env);
}
