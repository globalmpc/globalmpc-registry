import { connect, type Socket } from "node:net";
import type postgres from "postgres";
import type { EmailWorkerConfig } from "./config.js";

/**
 * Mail transports — account authentication WP2.
 *
 * One interface, three ends (`EMAIL_TRANSPORT`, see `@mpc/config` email.ts):
 *
 * - **resend**: `POST https://api.resend.com/emails`, 10 s timeout. The outbox id is the
 *   idempotency key, so a send retried after a crash between Resend accepting and the row being
 *   settled is not delivered twice.
 * - **smtp**: a plain SMTP session to the local Mailpit (`docker/docker-compose.yml`). No TLS and no
 *   AUTH, which is why it is refused in production.
 * - **log**: no mail at all — the rendered message is written to `core.email_test_sink`, where
 *   tests read it. Refused in production.
 *
 * **What a failure reports is a reason code** (`resend_http_503`, `timeout`, …): it is stored in
 * `core.email_outbox.last_error` and logged. A response body is never read — Resend echoes the
 * request (address included) in some errors — and no transport puts the recipient in an error.
 */

export interface OutgoingEmail {
  /** The outbox row id. Resend's idempotency key; the sink's foreign reference. */
  readonly id: string;
  readonly template: string;
  readonly to: string;
  readonly from: string;
  readonly subject: string;
  readonly text: string;
}

export type SendOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly retryable: boolean };

export interface EmailTransport {
  readonly kind: "resend" | "smtp" | "log";
  /**
   * Sends one message. `tx` is the delivery transaction holding the outbox row; only the `log`
   * transport uses it, so its sink row commits or rolls back with the settle.
   */
  send(message: OutgoingEmail, tx?: postgres.TransactionSql): Promise<SendOutcome>;
}

export const RESEND_ENDPOINT = "https://api.resend.com/emails";

export function createResendTransport(
  apiKey: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): EmailTransport {
  return {
    kind: "resend",
    async send(message) {
      let response: Response;
      try {
        response = await fetchImpl(RESEND_ENDPOINT, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            "idempotency-key": `mpc-email-${message.id}`,
          },
          body: JSON.stringify({
            from: message.from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
          }),
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "error",
        });
      } catch (error) {
        const name = (error as { name?: string }).name;
        const timedOut = name === "TimeoutError" || name === "AbortError";
        return { ok: false, reason: timedOut ? "timeout" : "network_error", retryable: true };
      }
      // The body is not read on any path; release it so the connection can be reused.
      await response.body?.cancel().catch(() => undefined);
      if (response.ok) return { ok: true };
      const status = response.status;
      // 429 and 5xx are Resend's to recover from. Any other 4xx (bad key, unverified sender,
      // rejected address) fails the same way next time.
      const retryable = status === 429 || status >= 500;
      return { ok: false, reason: `resend_http_${status}`, retryable };
    },
  };
}

/** Lines of one SMTP reply, read until the final `NNN ` line. */
function smtpSession(socket: Socket, timeoutMs: number) {
  let buffer = "";
  let waiting: ((line: string) => void) | null = null;
  let failure: Error | null = null;
  const lines: string[] = [];

  socket.setEncoding("utf8");
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error("timeout")));
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\r\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(line);
      } else {
        lines.push(line);
      }
    }
  });
  const fail = (error: Error) => {
    failure = error;
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve("");
    }
  };
  socket.on("error", fail);
  socket.on("close", () => fail(failure ?? new Error("closed")));

  const nextLine = (): Promise<string> => {
    const queued = lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      waiting = (line) => (failure && line === "" ? reject(failure) : resolve(line));
    });
  };

  /** Reads one reply and checks its code. */
  const expect = async (code: number): Promise<void> => {
    for (;;) {
      const line = await nextLine();
      if (!/^\d{3}[ -]/.test(line)) throw new Error("smtp_protocol");
      if (line[3] === " ") {
        if (Number(line.slice(0, 3)) !== code) throw new SmtpReplyError(Number(line.slice(0, 3)));
        return;
      }
    }
  };

  const command = async (text: string, code: number): Promise<void> => {
    socket.write(`${text}\r\n`);
    await expect(code);
  };

  return { expect, command };
}

class SmtpReplyError extends Error {
  constructor(readonly code: number) {
    super(`smtp_${code}`);
  }
}

/** A header value with line breaks removed, so a parameter cannot add headers. */
function headerValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

function bareAddress(from: string): string {
  const match = /<([^<>\s]+)>/.exec(from);
  return match ? match[1]! : from.trim();
}

export function createSmtpTransport(host: string, port: number, timeoutMs: number): EmailTransport {
  return {
    kind: "smtp",
    async send(message) {
      // The database already refuses spaces and control characters in an address; angle
      // brackets would still break out of the SMTP envelope.
      if (/[\s<>]/.test(message.to)) {
        return { ok: false, reason: "invalid_recipient", retryable: false };
      }
      const socket = connect({ host, port });
      try {
        const session = smtpSession(socket, timeoutMs);
        await session.expect(220);
        await session.command("EHLO mpc-jobs-worker", 250);
        await session.command(`MAIL FROM:<${bareAddress(message.from)}>`, 250);
        await session.command(`RCPT TO:<${message.to}>`, 250);
        await session.command("DATA", 354);
        const body = message.text
          .replace(/\r?\n/g, "\r\n")
          // Dot-stuffing: a line that starts with "." would otherwise end the message early.
          .replace(/^\./gm, "..");
        const headers = [
          `From: ${headerValue(message.from)}`,
          `To: ${message.to}`,
          `Subject: ${headerValue(message.subject)}`,
          `Message-ID: <${message.id}@mpc-jobs-worker>`,
          `Date: ${new Date().toUTCString()}`,
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=utf-8",
          "Content-Transfer-Encoding: 8bit",
        ].join("\r\n");
        await session.command(`${headers}\r\n\r\n${body}\r\n.`, 250);
        // Drain the QUIT reply before closing: dropping a socket with unread reply
        // bytes can reset the peer. DATA's 250 already accepted the message, so a
        // failed QUIT must not turn successful delivery into a duplicate retry.
        try { await session.command("QUIT", 221); } catch { /* already accepted */ }
        return { ok: true };
      } catch (error) {
        if (error instanceof SmtpReplyError) {
          return { ok: false, reason: `smtp_${error.code}`, retryable: error.code >= 400 && error.code < 500 };
        }
        const timedOut = (error as Error).message === "timeout";
        return { ok: false, reason: timedOut ? "timeout" : "network_error", retryable: true };
      } finally {
        socket.end();
        socket.destroySoon?.();
      }
    },
  };
}

/** Records the rendered message for tests instead of sending it. */
export function createLogTransport(sql: postgres.Sql): EmailTransport {
  return {
    kind: "log",
    async send(message, tx) {
      await (tx ?? sql)`
        INSERT INTO core.email_test_sink (outbox_id, template, recipient, subject, body)
        VALUES (${message.id}, ${message.template}, ${message.to}, ${message.subject}, ${message.text})
      `;
      return { ok: true };
    },
  };
}

export function createEmailTransport(sql: postgres.Sql, config: EmailWorkerConfig): EmailTransport {
  switch (config.transport) {
    case "resend":
      return createResendTransport(config.resendApiKey!, config.timeoutMs);
    case "smtp":
      return createSmtpTransport(config.smtpHost, config.smtpPort, config.timeoutMs);
    case "log":
      return createLogTransport(sql);
  }
}
