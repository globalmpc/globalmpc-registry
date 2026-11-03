/**
 * Mail transport settings — account authentication WP2.
 *
 * Read by the jobs worker, which sends, and checked by the API at startup, so a deployment that
 * would send codes through a test transport fails on both rather than quietly in one.
 *
 * | `EMAIL_TRANSPORT` | Where mail goes | Allowed |
 * | --- | --- | --- |
 * | `resend` | Resend `POST /emails` with `RESEND_API_KEY`, from `EMAIL_FROM` on a verified domain (D4) | Everywhere; **the only one in production** |
 * | `smtp` | Plain SMTP to `SMTP_HOST:SMTP_PORT` — the local Mailpit in `docker/docker-compose.yml` | Not in production |
 * | `log` | Nowhere: the worker records the rendered message in `core.email_test_sink` for tests | Not in production |
 *
 * Unset, production means `resend` and anything else means `log`.
 */

export const EMAIL_TRANSPORTS = ["resend", "smtp", "log"] as const;
export type EmailTransportKind = (typeof EMAIL_TRANSPORTS)[number];

export class EmailConfigError extends Error {
  readonly code = "EMAIL_CONFIG_INVALID";
}

/** The transport for this environment, or an error for one production must not use. */
export function resolveEmailTransportKind(
  raw: string | undefined,
  nodeEnv: string | undefined,
): EmailTransportKind {
  const production = nodeEnv === "production";
  const value = raw === undefined || raw.trim() === "" ? (production ? "resend" : "log") : raw.trim();
  if (!(EMAIL_TRANSPORTS as readonly string[]).includes(value)) {
    throw new EmailConfigError(`EMAIL_TRANSPORT must be one of ${EMAIL_TRANSPORTS.join(", ")}`);
  }
  // A test transport in production would drop every sign-in code (log) or hand it to whatever
  // answers on an SMTP port (smtp). Refused at startup, whatever else is configured.
  if (production && value !== "resend") {
    throw new EmailConfigError(`EMAIL_TRANSPORT=${value} cannot be used in production; use resend`);
  }
  return value as EmailTransportKind;
}

/**
 * The address part of `EMAIL_FROM` (`Name <addr@domain>` or `addr@domain`), lower-cased, or
 * `null` when it is not one address.
 */
export function emailFromAddress(from: string): string | null {
  const bracketed = /^[^<>]*<([^<>\s]+)>$/.exec(from.trim());
  const address = (bracketed ? bracketed[1]! : from.trim()).toLowerCase();
  return /^[^@\s<>]+@[^@\s<>.]+(\.[^@\s<>.]+)+$/.test(address) ? address : null;
}

/** Sender used by the local transports when `EMAIL_FROM` is unset. Never used with Resend. */
export const LOCAL_EMAIL_FROM = "MPC Registry <no-reply@registry.localhost.test>";
