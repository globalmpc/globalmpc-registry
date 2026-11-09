import { BUILT_SERVER, SESSION_COOKIE, OIDC_COOKIE } from "./server-mode";
import { openHeaderMenu } from "./header-menu";
import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { connectAs, holdPasskey, sessionToken } from "./connect-as";
import { closeMailbox, invitationLink, totp } from "./mailbox";
import { approveAtProvider, MOCK_MICROSOFT_TENANT } from "./oidc";

/**
 * Google and Microsoft in the browser (WP7) — account plan journeys 3 and 5 and the link from
 * settings.
 *
 * Browser → web proxy (cookie BFF) → API → the mock provider over the test relay
 * (`e2e/oidc-relay.ts`), with the person's approval at the provider played by `e2e/oidc.ts`. The
 * API's OIDC library runs unchanged against the real issuer URLs, so discovery, the ID-token
 * signature, issuer, audience, nonce, PKCE and the redirect URI are all checked as in production.
 *
 * **SameSite.** The session cookie and the OIDC browser binding are both `SameSite=Strict`. The
 * provider's redirect back is a cross-site top-level navigation, on which Chrome sends neither;
 * the callback page completes the flow with a same-origin `fetch`, on which it sends both. These
 * journeys are the evidence that Strict holds across the round trip — no cookie is relaxed.
 */

test.describe.configure({ mode: "serial", timeout: 90_000 });
test.afterAll(closeMailbox);

const TENANT_A_ORG = "aaaaaaaa-0000-0000-0000-000000000001";

function cookie(cookies: readonly { name: string }[], name: string) {
  return cookies.find((candidate) => candidate.name === name) as
    | { name: string; httpOnly: boolean; sameSite: string; path: string }
    | undefined;
}

async function expectStrictSession(context: BrowserContext): Promise<void> {
  const cookies = await context.cookies();
  expect(cookie(cookies, SESSION_COOKIE)).toMatchObject({ httpOnly: true, secure: BUILT_SERVER, sameSite: "Strict", path: "/" });
  // The binding is single-use: gone once the callback completed.
  expect(cookie(cookies, OIDC_COOKIE)).toBeUndefined();
}

/**
 * Unlinks any Google sign-in the person still has, through the API as the person would from
 * settings, so a retry of the journey starts from the same state as its first attempt.
 */
async function unlinkGoogle(page: Page): Promise<void> {
  const headers = { authorization: `Bearer ${await sessionToken(page)}` };
  const response = await page.request.get("/api/v1/auth/identities", { headers });
  expect(response.ok()).toBe(true);
  const { items } = (await response.json()) as { items: { id: string; provider: string; revokedAt: string | null }[] };
  for (const identity of items.filter((item) => item.provider === "google" && item.revokedAt === null)) {
    const unlinked = await page.request.post(`/api/v1/auth/identities/${identity.id}/unlink`, { headers });
    expect(unlinked.ok(), await unlinked.text()).toBe(true);
  }
}

async function signOut(page: Page): Promise<void> {
  await page.getByRole("banner").getByText("Account", { exact: true }).first().click();
  await openHeaderMenu(page, "Account");
  await page.getByRole("banner").getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("banner").getByRole("link", { name: "Sign in →" })).toBeVisible();
}

test("a person links Google from settings at aal2, then signs in with it and still gives their passkey", async ({
  page,
  context,
}) => {
  const sub = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  await connectAs(page, "Approver A");
  await unlinkGoogle(page);

  // Link: the provider round trip starts and ends in this account session.
  await page.goto("/w/settings");
  const link = await approveAtProvider(page, { sub });
  await page.getByTestId("link-google").click();
  const atProvider = await link.visited;
  expect(atProvider.url.origin).toBe("https://accounts.google.com");
  expect(cookie(atProvider.cookies, OIDC_COOKIE)).toMatchObject({ httpOnly: true, secure: BUILT_SERVER, sameSite: "Strict" });
  expect(cookie(atProvider.cookies, SESSION_COOKIE)).toMatchObject({ httpOnly: true, secure: BUILT_SERVER, sameSite: "Strict" });
  await expect(page.getByTestId("oidc-linked")).toContainText("Google is now linked to your account.");
  await expectStrictSession(context);
  await page.goto("/w/settings");
  await expect(page.getByTestId("settings-identities")).toContainText("Google");
  await expect(page.getByTestId("link-google")).toHaveCount(0);

  // Sign in with it: Google is the first factor only — the passkey is still asked for.
  await signOut(page);
  await page.goto("/connect");
  const signIn = await approveAtProvider(page, { sub });
  await page.getByTestId("oidc-google").click();
  expect(cookie((await signIn.visited).cookies, OIDC_COOKIE)).toMatchObject({ sameSite: "Strict" });
  await expect(page).toHaveURL(/\/auth\/mfa/);
  await page.goto("/w/projects");
  await expect(page).toHaveURL(/\/auth\/mfa\?next=%2Fw%2Fprojects/);
  // connectAs may have reused a session signed in on another page, leaving this page's
  // authenticator empty: hand it the passkey before the prompt.
  await holdPasskey(page, "Approver A");
  await page.getByTestId("passkey-prove").click();
  await expect(page).toHaveURL(/\/w\/projects$/);
  await expect(page.getByTestId("sign-in-method")).toHaveText("Google");
  await expectStrictSession(context);

  // An identity is matched by its key alone: another Google account with no link signs no one in.
  await signOut(page);
  await page.goto("/connect");
  const stranger = await approveAtProvider(page, { sub: `${sub}9` });
  await page.getByTestId("oidc-google").click();
  await stranger.visited;
  await expect(page.getByTestId("oidc-error")).toBeVisible();
  expect(cookie(await context.cookies(), SESSION_COOKIE)).toBeUndefined();
});

test("an invited person accepts with Microsoft once the directory vouches for the address (xms_edov)", async ({
  page,
  context,
}) => {
  const email = `ms-${randomUUID().slice(0, 8)}@contoso.example`;

  // Operator A invites the address.
  await connectAs(page, "Operator A");
  await page.goto("/w/admin");
  const panel = page.getByTestId("admin-invitations");
  await panel.getByLabel("Email address").fill(email);
  const organisation = panel.getByLabel("Organisation");
  await expect(organisation).toBeEnabled();
  if ((await organisation.evaluate((element) => element.tagName)) === "SELECT") {
    await organisation.selectOption(TENANT_A_ORG);
  } else {
    await organisation.fill(TENANT_A_ORG);
  }
  await panel.getByRole("button", { name: "Send invitation" }).click();
  await expect(panel.getByTestId("invitation-list")).toContainText(email);
  await signOut(page);

  await page.goto(await invitationLink(email));
  await expect(page.getByTestId("invitation-accept")).toBeVisible();
  await page.getByLabel("Your name, as colleagues will see it").fill("Microsoft Person");

  // Without `xms_edov` the directory has not vouched for the address: the invitation is not
  // accepted, and the emailed code is offered instead.
  const unverified = await approveAtProvider(page, { email, tid: MOCK_MICROSOFT_TENANT });
  await page.getByTestId("oidc-microsoft").click();
  await unverified.visited;
  await expect(page.getByTestId("oidc-error")).toBeVisible();
  expect(cookie(await context.cookies(), SESSION_COOKIE)).toBeUndefined();

  // With it, the same invitation is accepted and the person owes a second factor.
  await page.getByTestId("oidc-error").getByRole("link").click();
  await expect(page.getByTestId("invitation-accept")).toBeVisible();
  await page.getByLabel("Your name, as colleagues will see it").fill("Microsoft Person");
  const vouched = await approveAtProvider(page, { email, tid: MOCK_MICROSOFT_TENANT, xms_edov: true });
  await page.getByTestId("oidc-microsoft").click();
  const atProvider = await vouched.visited;
  expect(atProvider.url.origin).toBe("https://login.microsoftonline.com");
  expect(cookie(atProvider.cookies, OIDC_COOKIE)).toMatchObject({ httpOnly: true, secure: BUILT_SERVER, sameSite: "Strict" });
  await expect(page).toHaveURL(/\/auth\/mfa/);
  await expect(page.getByRole("heading", { name: "Set up your second factor" })).toBeVisible();

  await page.getByTestId("totp-setup").click();
  const secret = (await page.getByTestId("totp-secret").innerText()).trim();
  await page.getByLabel("6-digit code from your authenticator app").fill((await totp(secret)).code);
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByTestId("recovery-code-list").locator("li")).not.toHaveCount(0);
  await page.getByRole("checkbox", { name: "I have saved these codes somewhere safe" }).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page).toHaveURL(/\/w\/access-pending$/);
  await expect(page.getByTestId("sign-in-method")).toHaveText("Microsoft");
  await expectStrictSession(context);
});
