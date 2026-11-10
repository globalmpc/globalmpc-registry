import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { connectIsolated } from "./helpers/isolated-db.js";
import { loadEmailWorkerConfig } from "../src/email/config.js";
import { deliverEmailOnce } from "../src/email/delivery.js";
import { EMAIL_TEMPLATES, maskEmail, renderEmail } from "../src/email/messages.js";
import {
  createLogTransport,
  createResendTransport,
  createSmtpTransport,
  RESEND_ENDPOINT,
  type EmailTransport,
} from "../src/email/transport.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Account email sending — account authentication WP2.
 *
 * Held here: production refuses every transport but Resend and Resend without its key or sender;
 * no subject carries a code and every code mail says when it expires and what to do if it was not
 * asked for; a Resend failure is a reason code that names neither the address nor anything the
 * provider answered; the request times out; SMTP cannot be steered into extra headers or
 * recipients; delivery clears the address and code whatever the outcome, does not send expired
 * mail, retries a bounded number of times and logs no code or full address.
 */

const CODE = "12345678";
const ADDRESS = "person.name@example.com";

describe("mail configuration", () => {
  it("refuses the test transports in production", () => {
    for (const transport of ["log", "smtp"]) {
      expect(() =>
        loadEmailWorkerConfig({ NODE_ENV: "production", EMAIL_TRANSPORT: transport }),
      ).toThrow(/cannot be used in production/);
    }
  });

  it("uses Resend in production by default and then needs its key and sender", () => {
    expect(() => loadEmailWorkerConfig({ NODE_ENV: "production" })).toThrow(/RESEND_API_KEY is required/);
    expect(() =>
      loadEmailWorkerConfig({ NODE_ENV: "production", RESEND_API_KEY: "re_test" }),
    ).toThrow(/EMAIL_FROM is required/);
    const config = loadEmailWorkerConfig({
      NODE_ENV: "production",
      RESEND_API_KEY: "re_test",
      EMAIL_FROM: "MPC Registry <no-reply@mail.example.com>",
    });
    expect(config).toMatchObject({ transport: "resend", timeoutMs: 10_000, maxAttempts: 5 });
  });

  it("refuses a sender that is not one address and keeps the key out of the message", () => {
    expect(() =>
      loadEmailWorkerConfig({ EMAIL_TRANSPORT: "resend", RESEND_API_KEY: "re_secret_value", EMAIL_FROM: "a@b.com, c@d.com" }),
    ).toThrow(/EMAIL_FROM must be one address/);
    try {
      loadEmailWorkerConfig({ EMAIL_TRANSPORT: "resend", RESEND_API_KEY: "re_secret_value", EMAIL_FROM: "x" });
    } catch (error) {
      expect(String(error)).not.toContain("re_secret_value");
    }
  });

  it("defaults to the test sink outside production", () => {
    expect(loadEmailWorkerConfig({}).transport).toBe("log");
  });
});

describe("mail wording", () => {
  const params = {
    code: { code: CODE, expiresMinutes: 10 },
    link: { link: "https://app.example.com/invitations/accept#token=abc", expiresAt: "2026-11-05T10:00Z" },
  };
  /** Notices that name the linked sign-ins they removed. */
  const NOTICES: readonly string[] = ["email_changed_notice", "mfa_reset_notice", "account_suspended_notice"];
  const NO_CODE: readonly string[] = [...NOTICES, "account_reinstated_notice"];
  const paramsFor = (template: (typeof EMAIL_TEMPLATES)[number]) =>
    template === "invitation_link" ? params.link : NO_CODE.includes(template) ? {} : params.code;

  it("never puts a code in a subject, and says when it expires and what to do if unasked", () => {
    for (const template of EMAIL_TEMPLATES) {
      const mail = renderEmail(template, paramsFor(template));
      expect(mail.subject).not.toMatch(/[0-9]{8}/);
      expect(mail.subject).not.toContain("token=");
      if (template === "email_changed_notice") {
        expect(mail.text).toMatch(/did not ask for this/);
        continue;
      }
      if (template === "account_suspended_notice" || template === "account_reinstated_notice") {
        // Suspension (0127): what happened and whom to call; no code, no link.
        expect(mail.text).toMatch(/contact your administrator/);
        expect(mail.text).toMatch(/Two administrators/);
        expect(mail.text).not.toMatch(/[0-9]{8}/);
        expect(mail.text).not.toMatch(/https?:\/\//);
        continue;
      }
      if (template === "mfa_reset_notice") {
        // Nothing usable in it: no code, no link — only what happened and whom to call.
        expect(mail.text).toMatch(/If this wasn't you, contact your administrator/);
        expect(mail.text).not.toMatch(/[0-9]{8}/);
        expect(mail.text).not.toMatch(/https?:\/\//);
        continue;
      }
      expect(mail.text).toMatch(/expires/);
      expect(mail.text).toMatch(/ignore this email/);
      if (template === "invitation_link") expect(mail.text).toContain(params.link.link);
      else expect(mail.text).toContain(CODE);
    }
  });

  it("refuses parameters that are not what the template expects", () => {
    expect(() => renderEmail("sign_in_code", { code: "1234", expiresMinutes: 10 })).toThrow();
    expect(() => renderEmail("sign_in_code", { code: `${CODE}\nBcc: x`, expiresMinutes: 10 })).toThrow();
    expect(() =>
      renderEmail("invitation_link", { link: "javascript:alert(1)", expiresAt: "2026-11-05T10:00Z" }),
    ).toThrow();
    expect(() => renderEmail("invitation_link", { link: "https://a.example/ x", expiresAt: "x" })).toThrow();
  });

  it("recovery notices name the removed linked sign-ins by provider only (0123)", () => {
    for (const template of NOTICES as (typeof EMAIL_TEMPLATES)[number][]) {
      const both = renderEmail(template, { removedSignIns: ["google", "microsoft"] }).text;
      expect(both).toContain("The Google and Microsoft sign-in linked to the account was removed");
      expect(both).toMatch(/link it again/);
      expect(renderEmail(template, { removedSignIns: ["microsoft"] }).text).toContain("The Microsoft sign-in");
      // Nothing was linked, or the row predates 0123: no sentence.
      expect(renderEmail(template, { removedSignIns: [] }).text).not.toMatch(/sign-in linked/);
      expect(renderEmail(template, {}).text).not.toMatch(/sign-in linked/);
      // Only provider names; anything else is refused rather than written into a mail.
      expect(() => renderEmail(template, { removedSignIns: ["google", "google"] })).toThrow();
      expect(() => renderEmail(template, { removedSignIns: ["1234567890@gmail.com"] })).toThrow();
      expect(() => renderEmail(template, { removedSignIns: "google" })).toThrow();
      expect(() => renderEmail(template, null)).toThrow();
    }
  });

  it("the suspension notice says signing in stops and signed history stays; reinstatement reopens enrolment", () => {
    const suspended = renderEmail("account_suspended_notice", {}).text;
    expect(suspended).toMatch(/Signing in is not possible until the account is reinstated/);
    expect(suspended).toMatch(/What you signed before stays as it was/);
    const reinstated = renderEmail("account_reinstated_notice", {}).text;
    expect(reinstated).toMatch(/next 24 hours/);
    expect(() => renderEmail("account_reinstated_notice", null)).toThrow();
  });

  it("masks an address to its first character and domain", () => {
    expect(maskEmail(ADDRESS)).toBe("p***@example.com");
    expect(maskEmail("nope")).toBe("***");
  });
});

describe("Resend transport", () => {
  const message = {
    id: randomUUID(),
    template: "sign_in_code",
    to: ADDRESS,
    from: "MPC Registry <no-reply@mail.example.com>",
    subject: "Your MPC Registry sign-in code",
    text: `code ${CODE}`,
  };

  it("posts one message with the outbox id as idempotency key and a timeout", async () => {
    const fetchImpl = vi.fn(async () => new Response("{\"id\":\"x\"}", { status: 200 }));
    const transport = createResendTransport("re_key", 10_000, fetchImpl as unknown as typeof fetch);
    expect(await transport.send(message)).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(RESEND_ENDPOINT);
    expect((init.headers as Record<string, string>)["idempotency-key"]).toBe(`mpc-email-${message.id}`);
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer re_key");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual({
      from: message.from,
      to: [ADDRESS],
      subject: message.subject,
      text: message.text,
    });
  });

  it("reports a failure as a reason code without the address or the response body", async () => {
    for (const [status, retryable] of [[500, true], [429, true], [422, false], [401, false]] as const) {
      const fetchImpl = vi.fn(
        async () => new Response(`{"message":"bad recipient ${ADDRESS}","echo":"${CODE}"}`, { status }),
      );
      const outcome = await createResendTransport("re_key", 10_000, fetchImpl as unknown as typeof fetch).send(message);
      expect(outcome).toEqual({ ok: false, reason: `resend_http_${status}`, retryable });
      expect(JSON.stringify(outcome)).not.toContain(ADDRESS);
      expect(JSON.stringify(outcome)).not.toContain(CODE);
    }
  });

  it("gives up after its timeout", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    );
    const outcome = await createResendTransport("re_key", 50, fetchImpl as unknown as typeof fetch).send(message);
    expect(outcome).toEqual({ ok: false, reason: "timeout", retryable: true });
  });

  it("reports a connection failure without its message", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`getaddrinfo failed for ${ADDRESS}`);
    });
    const outcome = await createResendTransport("re_key", 1000, fetchImpl as unknown as typeof fetch).send(message);
    expect(outcome).toEqual({ ok: false, reason: "network_error", retryable: true });
  });
});

describe("SMTP transport", () => {
  let server: Server;
  let port = 0;
  const received: string[] = [];
  const socketErrors: Error[] = [];
  let onQuit: ((socket: Socket) => void) | null = null;

  beforeAll(async () => {
    server = createServer((socket) => {
      socket.on("error", (error) => socketErrors.push(error));
      let data = false;
      let buffer = "";
      socket.write("220 test ESMTP\r\n");
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let index: number;
        while ((index = buffer.indexOf("\r\n")) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          received.push(line);
          if (data) {
            if (line === ".") {
              data = false;
              socket.write("250 queued\r\n");
            }
            continue;
          }
          if (line.startsWith("EHLO")) socket.write("250-test\r\n250 OK\r\n");
          else if (line === "DATA") {
            data = true;
            socket.write("354 go\r\n");
          } else if (line === "QUIT") {
            if (onQuit) onQuit(socket); else socket.end("221 bye\r\n");
          }
          else socket.write("250 OK\r\n");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    expect(socketErrors).toEqual([]);
  });

  it("delivers one message to one recipient, with no header a parameter could add", async () => {
    const transport = createSmtpTransport("127.0.0.1", port, 2000);
    const outcome = await transport.send({
      id: randomUUID(),
      template: "sign_in_code",
      to: ADDRESS,
      from: "MPC Registry <no-reply@localhost.test>",
      subject: "Subject\r\nBcc: attacker@example.com",
      text: `line\n.\ncode ${CODE}`,
    });
    expect(outcome).toEqual({ ok: true });
    expect(received.filter((line) => line.startsWith("RCPT TO"))).toEqual([`RCPT TO:<${ADDRESS}>`]);
    expect(received.some((line) => line.startsWith("Bcc:"))).toBe(false);
    expect(received).toContain("..");
  });

  it("waits for the peer's QUIT reply before completing delivery", async () => {
    let release!: () => void;
    let observed!: () => void;
    const quit = new Promise<void>((resolve) => { observed = resolve; });
    onQuit = (socket) => { release = () => socket.end("221 bye\r\n"); observed(); };
    let completed = false;
    const sending = createSmtpTransport("127.0.0.1", port, 2000).send({
      id: randomUUID(), template: "sign_in_code", to: ADDRESS,
      from: "no-reply@localhost.test", subject: "s", text: "t",
    }).then((result) => { completed = true; return result; });
    try { await quit; expect(completed).toBe(false); }
    finally { release(); onQuit = null; }
    expect(await sending).toEqual({ ok: true });
  });

  it("does not retry accepted mail when the QUIT acknowledgement fails", async () => {
    onQuit = (socket) => socket.end("500 quit unavailable\r\n");
    try {
      expect(await createSmtpTransport("127.0.0.1", port, 2000).send({
        id: randomUUID(), template: "sign_in_code", to: ADDRESS,
        from: "no-reply@localhost.test", subject: "s", text: "t",
      })).toEqual({ ok: true });
    } finally { onQuit = null; }
  });

  it("refuses an address that would break out of the envelope", async () => {
    const transport = createSmtpTransport("127.0.0.1", port, 2000);
    const outcome = await transport.send({
      id: randomUUID(),
      template: "sign_in_code",
      to: "a>b@example.com",
      from: "no-reply@localhost.test",
      subject: "s",
      text: "t",
    });
    expect(outcome).toEqual({ ok: false, reason: "invalid_recipient", retryable: false });
  });

  it("reports an unreachable server as a network error", async () => {
    const outcome = await createSmtpTransport("127.0.0.1", 1, 1000).send({
      id: randomUUID(),
      template: "sign_in_code",
      to: ADDRESS,
      from: "no-reply@localhost.test",
      subject: "s",
      text: "t",
    });
    expect(outcome).toMatchObject({ ok: false, retryable: true });
  });
});

describeDb("account email delivery", () => {
  let sql: postgres.Sql;
  const logs: Record<string, unknown>[] = [];
  const emit = (record: Record<string, unknown>) => logs.push(record);
  const options = { from: "MPC Registry <no-reply@localhost.test>", maxAttempts: 3, backoffMs: 1000 };

  beforeAll(async () => {
    sql = await connectIsolated("email_delivery");
  });

  beforeEach(async () => {
    await sql`DELETE FROM core.email_outbox`;
    await sql`DELETE FROM core.email_test_sink`;
    logs.length = 0;
  });

  afterAll(async () => {
    await sql.end();
  });

  async function queue(expiresIn = "10 minutes"): Promise<string> {
    const id = randomUUID();
    await sql`
      INSERT INTO core.email_outbox (id, template, recipient, params, state, expires_at)
      VALUES (
        ${id}, 'sign_in_code', ${ADDRESS}, ${sql.json({ code: CODE, expiresMinutes: 10 })}, 'pending',
        now() + ${expiresIn}::interval
      )
    `;
    return id;
  }

  async function row(id: string) {
    const [found] = await sql<
      { state: string; recipient: string | null; params: unknown; attempts: number; last_error: string | null; next_attempt_at: Date | null }[]
    >`SELECT state, recipient, params, attempts, last_error, next_attempt_at FROM core.email_outbox WHERE id = ${id}`;
    return found!;
  }

  /** As the worker connects: its own role, which bypasses RLS but holds only the grants in 0113. */
  async function asWorker<T>(body: (sql: postgres.Sql) => Promise<T>): Promise<T> {
    const url = new URL(process.env["DATABASE_URL"]!);
    url.pathname = `${url.pathname}_email_delivery`;
    const worker = postgres(url.toString(), {
      onnotice: () => {},
      max: 1,
      connection: { role: "mpc_worker" } as never,
    });
    try {
      return await body(worker);
    } finally {
      await worker.end();
    }
  }

  const failing = (reason: string, retryable: boolean): EmailTransport => ({
    kind: "resend",
    send: async () => ({ ok: false, reason, retryable }),
  });

  it("sends through the test sink as the worker role and clears the address and code", async () => {
    const id = await queue();
    const result = await asWorker((worker) => deliverEmailOnce(worker, createLogTransport(worker), options, emit));
    expect(result).toEqual({ handled: true, sent: 1, failed: 0 });
    expect(await row(id)).toMatchObject({ state: "sent", recipient: null, params: null, attempts: 1 });
    const [sink] = await sql<{ recipient: string; subject: string; body: string }[]>`
      SELECT recipient, subject, body FROM core.email_test_sink WHERE outbox_id = ${id}
    `;
    expect(sink!.recipient).toBe(ADDRESS);
    expect(sink!.body).toContain(CODE);
    expect(sink!.subject).not.toContain(CODE);
    expect(JSON.stringify(logs)).not.toContain(CODE);
    expect(JSON.stringify(logs)).not.toContain(ADDRESS);
    expect(logs[0]).toMatchObject({ msg: "email.sent", to: "p***@example.com" });
  });

  it("does not send mail whose code has expired", async () => {
    const id = await queue("-1 second");
    const send = vi.fn();
    const result = await deliverEmailOnce(sql, { kind: "log", send }, options, emit);
    expect(result).toEqual({ handled: true, sent: 0, failed: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(await row(id)).toMatchObject({ state: "expired", recipient: null, params: null });
  });

  it("retries a temporary failure with backoff, then fails at the cap and clears the code", async () => {
    const id = await queue();
    const transport = failing("resend_http_503", true);

    expect(await deliverEmailOnce(sql, transport, options, emit)).toEqual({ handled: true, sent: 0, failed: 1 });
    const first = await row(id);
    expect(first).toMatchObject({ state: "pending", attempts: 1, last_error: "resend_http_503" });
    expect(first.next_attempt_at!.getTime()).toBeGreaterThan(Date.now());

    // Not due yet: nothing is claimed.
    expect(await deliverEmailOnce(sql, transport, options, emit)).toEqual({ handled: false, sent: 0, failed: 0 });

    for (let attempt = 2; attempt <= options.maxAttempts; attempt++) {
      await sql`UPDATE core.email_outbox SET next_attempt_at = now() WHERE id = ${id}`;
      await deliverEmailOnce(sql, transport, options, emit);
    }
    expect(await row(id)).toMatchObject({
      state: "failed",
      attempts: options.maxAttempts,
      last_error: "resend_http_503",
      recipient: null,
      params: null,
    });
    expect(JSON.stringify(logs)).not.toContain(ADDRESS);
  });

  it("fails a permanent refusal at once", async () => {
    const id = await queue();
    await deliverEmailOnce(sql, failing("resend_http_422", false), options, emit);
    expect(await row(id)).toMatchObject({ state: "failed", attempts: 1, recipient: null, params: null });
  });

  it("fails a row whose parameters are not a code, without sending it", async () => {
    const id = randomUUID();
    await sql`
      INSERT INTO core.email_outbox (id, template, recipient, params, state, expires_at)
      VALUES (${id}, 'sign_in_code', ${ADDRESS}, ${sql.json({ code: "x" })}, 'pending', now() + interval '10 minutes')
    `;
    const send = vi.fn();
    await deliverEmailOnce(sql, { kind: "log", send }, options, emit);
    expect(send).not.toHaveBeenCalled();
    expect(await row(id)).toMatchObject({ state: "failed", last_error: "invalid_params", params: null });
  });

  it("never hands one row to two workers at once", async () => {
    await queue();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const slow: EmailTransport = {
      kind: "log",
      send: async () => {
        await held;
        return { ok: true };
      },
    };
    const first = deliverEmailOnce(sql, slow, options, emit);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await deliverEmailOnce(sql, slow, options, emit);
    expect(second.handled).toBe(false);
    release();
    expect((await first).sent).toBe(1);
  });

  it("cannot be read or changed by the API role", async () => {
    await queue();
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE mpc_app");
        await tx`SELECT * FROM core.email_outbox`;
      }),
    ).rejects.toThrow(/permission denied/);
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE mpc_app");
        await tx`SELECT * FROM core.email_test_sink`;
      }),
    ).rejects.toThrow(/permission denied/);
  });
});
