import { expect, type Page } from "@playwright/test";
import { demoEmail, demoPasskey } from "./demo-people";
import { addVirtualAuthenticator, database, mailedCode } from "./mailbox";
import { useWallet as installTestWallet } from "./wallet";

/**
 * The current session token, read from the browser's cookie jar.
 *
 * Since WP6 the token is an HttpOnly cookie page script cannot read; specs that call the API
 * directly with `page.request` take it from the context instead and send it as their own bearer
 * (the web proxy forwards a request's own `Authorization` unchanged).
 */
export async function sessionToken(page: Page): Promise<string> {
  const cookie = (await page.context().cookies()).find(
    (candidate) => candidate.name === SESSION_COOKIE || candidate.name === "__Host-mpc_session",
  );
  expect(cookie, "no session cookie: sign in first").toBeDefined();
  return cookie!.value;
}

/** The development cookie name (`bff.ts`); the run's web server is never a production build. */
const SESSION_COOKIE = "mpc_session";

/**
 * Sessions this worker has already signed in, by person. Reusing one is what keeps the suite from
 * mailing a code and asking for a passkey on every one of its hundred switches between people;
 * each is still a session a real sign-in issued, and it is used only while the server says it
 * is live and complete (a spec that signs out, or a recovery that ends sessions, revokes it, and
 * the next switch signs in afresh).
 */
const sessions = new Map<string, string>();

/** Passkeys each page's virtual authenticator holds, so one is added once per page. */
const held = new WeakMap<Page, Set<string>>();

/**
 * Signs in as a demo person, through the screens a person uses (WP7).
 *
 * The first time in a worker: `/connect` → the emailed code (read from the outbox, as the API
 * runs with `EMAIL_TRANSPORT=log`) → `/auth/mfa` → the person's passkey, answered by Chrome's
 * virtual authenticator. Afterwards the session that journey issued is put back in the cookie jar,
 * after the server confirms it is still that person's, still live and past its second factor.
 *
 * Switching people drops the previous cookie without signing out, as closing a browser profile
 * would; signing out is a journey of its own that specs drive through the button.
 *
 * The person's wallet answers the page's `window.ethereum` (`wallet.ts`) — used only when a screen
 * asks for a signature, never to sign in. `{ wallet: false }` leaves the page's wallets to the
 * spec (`wallet-connect.spec.ts` installs its own).
 *
 * The exit condition is the header naming the person's sign-in method on `/w/projects` and the
 * server naming the person's subject, so a stale session of someone else cannot pass for this one.
 */
export async function connectAs(
  page: Page,
  label: string,
  options: { readonly wallet?: boolean } = {},
): Promise<void> {
  const wallet = options.wallet ?? true;
  if (wallet) await installTestWallet(page, label);
  const subjectId = await subjectOf(label);
  const context = page.context();
  await context.clearCookies({ name: SESSION_COOKIE });

  const cached = sessions.get(label);
  if (cached) {
    await context.addCookies([
      { name: SESSION_COOKIE, value: cached, domain: "localhost", path: "/", httpOnly: true, sameSite: "Strict" },
    ]);
    if (await isComplete(page, subjectId)) {
      await page.goto("/w/projects");
      await expectSignedIn(page);
      return;
    }
    sessions.delete(label);
    await context.clearCookies({ name: SESSION_COOKIE });
  }

  await signInByJourney(page, label, wallet);
  expect(await isComplete(page, subjectId), `the journey did not sign ${label} in`).toBe(true);
  sessions.set(label, await sessionToken(page));
}

/**
 * Readies a page for `label` to sign in by hand: signed out, the person's passkey in the page's
 * virtual authenticator and the wallet answering. For a spec that drives the sign-in screens
 * itself (by keyboard, say); `connectAs` does the same before its own journey.
 */
export async function prepareSignIn(page: Page, label: string, wallet = true): Promise<void> {
  if (wallet) await installTestWallet(page, label);
  await page.context().clearCookies({ name: SESSION_COOKIE });
  await holdPasskey(page, label);
  await allowAnotherCode();
}

/**
 * Signs `label` in through the screens, always as a new session, never the cached one: for a spec
 * that needs a second session of the same person (the session list, say).
 */
export async function signInAfresh(page: Page, label: string, wallet = true): Promise<void> {
  await signInByJourney(page, label, wallet);
  expect(await isComplete(page, await subjectOf(label))).toBe(true);
}

async function signInByJourney(page: Page, label: string, wallet: boolean): Promise<void> {
  await prepareSignIn(page, label, wallet);
  const email = demoEmail(label);
  await page.goto("/connect");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByTestId("code-sent")).toBeVisible();
  await page.getByLabel(/-digit code$/).fill(await mailedCode(email, "sign_in_code"));
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page).toHaveURL(/\/auth\/mfa/);
  await page.getByTestId("passkey-prove").click();
  // A person holding no role lands on the access-pending screen (plan §4 journey 1).
  await expect(page).toHaveURL(/\/w\/(projects|access-pending)$/);
  await expectSignedIn(page);
}

async function expectSignedIn(page: Page): Promise<void> {
  const topBar = page.locator("header.topbar");
  await expect(topBar.getByTestId("sign-in-method")).toHaveText("email");
  await expect(topBar.getByRole("button", { name: "Sign out" })).toBeVisible();
}

async function isComplete(page: Page, subjectId: string): Promise<boolean> {
  const response = await page.request.get("/api/v1/auth/session");
  if (!response.ok()) return false;
  const session = (await response.json()) as {
    authenticated?: boolean;
    subjectId?: string;
    aal?: string;
    recoveryLimited?: boolean;
  };
  return (
    session.authenticated === true &&
    session.subjectId === subjectId &&
    session.aal !== "aal1" &&
    session.recoveryLimited !== true
  );
}

const subjects = new Map<string, string>();

async function subjectOf(label: string): Promise<string> {
  const known = subjects.get(label);
  if (known) return known;
  const [row] = await database()<{ id: string }[]>`
    SELECT id FROM core.subjects WHERE email = ${demoEmail(label)}
  `;
  if (!row) throw new Error(`the seed gave no account the address of "${label}"`);
  subjects.set(label, row.id);
  return row.id;
}

/**
 * Adds the person's passkey to this page's virtual authenticator, at the counter the server last
 * accepted: a fresh page starts a fresh authenticator, and a counter that did not increase would
 * be refused as a cloned key.
 *
 * `connectAs` calls it only when it signs in by the journey; a spec that reuses the cached session
 * and later answers a passkey prompt itself (signing in again with Google, say) calls it first, or
 * the page's authenticator holds nothing and the prompt waits for ever.
 */
export async function holdPasskey(page: Page, label: string): Promise<void> {
  const authenticator = await addVirtualAuthenticator(page);
  const labels = held.get(page) ?? new Set<string>();
  held.set(page, labels);
  if (labels.has(label)) return;
  const passkey = demoPasskey(label);
  const [row] = await database()<{ sign_count: string }[]>`
    SELECT sign_count::text FROM core.webauthn_credentials WHERE credential_id = ${passkey.credentialId}
  `;
  await authenticator.cdp.send("WebAuthn.addCredential", {
    authenticatorId: authenticator.id,
    credential: {
      credentialId: Buffer.from(passkey.credentialId, "base64url").toString("base64"),
      isResidentCredential: false,
      rpId: "localhost",
      privateKey: passkey.privateKey,
      signCount: Number(row?.sign_count ?? 0),
    },
  });
  labels.add(label);
}

/**
 * Clears the sign-in code limits for this person and for the runner's address before a journey.
 *
 * The database limits code requests per address and per IP (0114) — 5 and 20 in 15 minutes — and
 * every request of the suite comes from 127.0.0.1, so a full run would hit them and fail on a 429
 * that has nothing to do with the spec. This changes only the run's own database, as the
 * superuser; the limits themselves stay, and `apps/api/test/email-auth.test.ts` covers them.
 */
async function allowAnotherCode(): Promise<void> {
  await database()`
    DELETE FROM core.auth_rate_events WHERE action IN ('code_start', 'code_verify')
  `;
}
