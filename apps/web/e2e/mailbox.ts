import { createHmac } from "node:crypto";
import { expect, type CDPSession, type Page } from "@playwright/test";
import postgres from "postgres";

/**
 * What the account specs need from outside the browser (WP6).
 *
 * **The mailbox.** The API runs with `EMAIL_TRANSPORT=log` here, and no jobs worker drains the
 * outbox, so every mail stays `pending` in `core.email_outbox` with its parameters — the code or
 * the link a person would have received. The spec reads it as the superuser, the same way the API
 * tests do; the application role cannot (0113).
 *
 * **The authenticator app.** RFC 6238 with the parameters the `otpauth://` URI states (SHA-1,
 * 6 digits, 30 s), computed here from the secret the enrolment screen shows for manual entry.
 */

let sql: postgres.Sql | undefined;

export function database(): postgres.Sql {
  const url = process.env["E2E_DATABASE_URL"];
  if (!url) throw new Error("E2E_DATABASE_URL must identify the runner's seeded database");
  sql ??= postgres(url, { max: 1, onnotice: () => {}, prepare: false });
  return sql;
}

export async function closeMailbox(): Promise<void> {
  await sql?.end({ timeout: 5 });
  sql = undefined;
}

type Template = "sign_in_code" | "invitation_link" | "invitation_code";

/** The newest pending mail of `template` to `recipient`, polled until it is there. */
async function mail(recipient: string, template: Template): Promise<Record<string, string>> {
  let params: Record<string, string> | undefined;
  await expect
    .poll(
      async () => {
        const [row] = await database()<{ params: Record<string, string> }[]>`
          SELECT params FROM core.email_outbox
          WHERE recipient = ${recipient.toLowerCase()} AND template = ${template} AND state = 'pending'
          ORDER BY created_at DESC LIMIT 1
        `;
        params = row?.params;
        return params !== undefined;
      },
      { message: `${template} mail to ${recipient}` },
    )
    .toBe(true);
  return params!;
}

export async function invitationLink(recipient: string): Promise<string> {
  return (await mail(recipient, "invitation_link"))["link"]!;
}

export async function mailedCode(recipient: string, template: "sign_in_code" | "invitation_code"): Promise<string> {
  return (await mail(recipient, template))["code"]!;
}

function base32(secret: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.replace(/=+$/, "").toUpperCase()) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error("not base32");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes);
}

function totpAt(secret: string, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32(secret)).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, "0");
}

/**
 * A code from a time step after `usedStep`. The server refuses a step it already accepted (a
 * replayed code), so a second sign-in in the same 30 s waits for the next one.
 */
export async function totp(secret: string, usedStep = -1): Promise<{ code: string; step: number }> {
  let step = Math.floor(Date.now() / 30_000);
  while (step <= usedStep) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    step = Math.floor(Date.now() / 30_000);
  }
  return { code: totpAt(secret, step), step };
}

const authenticators = new WeakMap<Page, Promise<{ readonly cdp: CDPSession; readonly id: string }>>();

/**
 * The page's platform authenticator with a verified user, answering every passkey prompt by
 * itself. Chrome allows one internal authenticator per page, so it is made once and shared: a
 * spec's own passkeys and the demo people's (`connectAs`) live in the same one.
 */
export function addVirtualAuthenticator(page: Page): Promise<{ readonly cdp: CDPSession; readonly id: string }> {
  let made = authenticators.get(page);
  if (!made) {
    made = (async () => {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("WebAuthn.enable");
      const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      });
      return { cdp, id: authenticatorId };
    })();
    authenticators.set(page, made);
  }
  return made;
}
