import {
  EmailConfigError,
  emailFromAddress,
  LOCAL_EMAIL_FROM,
  resolveEmailTransportKind,
  resolveSecret,
  type EmailTransportKind,
} from "@mpc/config";

/**
 * Mail settings for the jobs worker — account authentication WP2.
 *
 * | Variable | Meaning |
 * | --- | --- |
 * | `EMAIL_TRANSPORT` | `resend` / `smtp` / `log` (`@mpc/config` email.ts). Production allows only `resend`. |
 * | `RESEND_API_KEY` | Resend key; a `file:` reference is accepted. Required for `resend`. |
 * | `EMAIL_FROM` | Sender on the Resend-verified domain (`Name <no-reply@domain>`). Required for `resend`. |
 * | `SMTP_HOST` / `SMTP_PORT` | Local Mailpit for `smtp` (default `localhost:1025`). |
 * | `EMAIL_SEND_TIMEOUT_MS` | Per-send timeout, default 10 000. |
 * | `EMAIL_MAX_ATTEMPTS` | Sends per message before it is marked failed, default 5. |
 * | `EMAIL_BACKOFF_MS` | First retry delay, doubled per attempt, default 5 000. |
 *
 * Only the worker reads the key and sender: the API never sends mail, so it never holds the key.
 * A missing or malformed value stops the worker at startup instead of failing every send.
 */

export interface EmailWorkerConfig {
  readonly transport: EmailTransportKind;
  readonly from: string;
  readonly resendApiKey: string | null;
  readonly smtpHost: string;
  readonly smtpPort: number;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly backoffMs: number;
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new EmailConfigError(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

export function loadEmailWorkerConfig(env: NodeJS.ProcessEnv = process.env): EmailWorkerConfig {
  const transport = resolveEmailTransportKind(env["EMAIL_TRANSPORT"], env["NODE_ENV"]);
  const rawFrom = env["EMAIL_FROM"]?.trim() ? env["EMAIL_FROM"].trim() : null;

  let resendApiKey: string | null = null;
  if (transport === "resend") {
    const reference = env["RESEND_API_KEY"];
    if (!reference || reference.trim() === "") {
      throw new EmailConfigError("RESEND_API_KEY is required when EMAIL_TRANSPORT=resend");
    }
    resendApiKey = resolveSecret("RESEND_API_KEY", reference).trim();
    if (resendApiKey === "") throw new EmailConfigError("RESEND_API_KEY is empty");
    if (!rawFrom) throw new EmailConfigError("EMAIL_FROM is required when EMAIL_TRANSPORT=resend");
  }

  const from = rawFrom ?? LOCAL_EMAIL_FROM;
  if (emailFromAddress(from) === null || /[\r\n]/.test(from)) {
    throw new EmailConfigError("EMAIL_FROM must be one address, optionally as `Name <address>`");
  }

  return {
    transport,
    from,
    resendApiKey,
    smtpHost: env["SMTP_HOST"]?.trim() || "localhost",
    smtpPort: positiveInteger(env, "SMTP_PORT", 1025, 65_535),
    timeoutMs: positiveInteger(env, "EMAIL_SEND_TIMEOUT_MS", 10_000, 60_000),
    maxAttempts: positiveInteger(env, "EMAIL_MAX_ATTEMPTS", 5, 20),
    backoffMs: positiveInteger(env, "EMAIL_BACKOFF_MS", 5_000, 3_600_000),
  };
}
