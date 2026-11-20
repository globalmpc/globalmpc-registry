import { BUILT_SERVER, SESSION_COOKIE } from "./server-mode";
import { openHeaderMenu } from "./header-menu";
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { openEmailSignIn, connectAs } from "./connect-as";
import { addVirtualAuthenticator, closeMailbox, invitationLink, mailedCode, totp } from "./mailbox";

/**
 * Account sign-in in the browser (WP6) — journeys 1, 2 and 4 of the account plan.
 *
 * Browser → web proxy (cookie BFF) → API → PostgreSQL, with mail read from the outbox and the
 * authenticator app computed from the secret the screen shows. Nothing here signs in through a
 * shortcut: every session is issued by the same screens a person uses.
 */

const TENANT_A_ORG = "aaaaaaaa-0000-0000-0000-000000000001";

// A second sign-in by authenticator app must wait for the next 30 s time step (the server refuses a
// replayed step), so a journey can spend up to 30 s idle on top of its own work.
test.describe.configure({ mode: "serial", timeout: 90_000 });
test.afterAll(closeMailbox);

/** Operator A (an account, signed in by email and passkey) invites `email` through the admin screen. */
async function invite(page: Page, email: string): Promise<void> {
  await connectAs(page, "Operator A");
  await page.goto("/w/admin");
  await page.getByText("Invite a person", { exact: true }).click();
  const panel = page.getByTestId("admin-invitations");
  await panel.getByLabel("Email address").fill(email);
  // The seeded organisation loads asynchronously; its initial text input is
  // replaced by a select. Wait for the ready control instead of racing that swap.
  const organisation = panel.getByRole("combobox", { name: "Organisation", exact: true });
  await organisation.selectOption(TENANT_A_ORG);
  await expect(organisation).toHaveValue(TENANT_A_ORG);
  await panel.getByLabel("Invitation role", { exact: true }).selectOption("");
  await panel.getByRole("button", { name: "Send invitation" }).click();
  await expect(panel.getByTestId("invitation-list")).toContainText(email);
  await openHeaderMenu(page, "Account");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("banner").getByRole("link", { name: "Sign in →" })).toBeVisible();
}

/** Opens the emailed invitation link and accepts it with the emailed code; lands on `/auth/mfa`. */
async function accept(page: Page, email: string, name: string): Promise<void> {
  const link = await invitationLink(email);
  expect(new URL(link).search).toBe("");
  await page.goto(link);
  await expect(page.getByTestId("invitation-accept")).toBeVisible();
  // The token is read from the fragment and removed from the address bar at once.
  expect(new URL(page.url()).hash).toBe("");

  await page.getByLabel("Your name, as colleagues will see it").fill(name);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await page.getByLabel(/-digit code$/).fill(await mailedCode(email, "invitation_code"));
  await page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(page).toHaveURL(/\/w\/access-pending/);
}

test("an invited person signs in by emailed code, and the token stays out of page script", async ({
  page,
  context,
}) => {
  const email = `invitee-${randomUUID().slice(0, 8)}@example.test`;
  await invite(page, email);
  await accept(page, email, "Totp Person");

  await expect(page.getByTestId("access-pending")).toContainText("Access pending");
  await expect(page.getByTestId("error-notice")).toHaveCount(0);
  await expect(page.getByTestId("sign-in-method")).toHaveText("email");

  // The session is an HttpOnly, SameSite=Strict cookie; nothing script can read holds the token.
  const cookie = (await context.cookies()).find((candidate) => candidate.name === SESSION_COOKIE);
  expect(cookie).toMatchObject({ httpOnly: true, secure: BUILT_SERVER, sameSite: "Strict", path: "/" });
  expect(await page.evaluate(() => document.cookie)).not.toContain(cookie!.value);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(
    cookie!.value,
  );

  // A state-changing request from another site is refused before it reaches the API.
  const forged = await page.request.post("/api/v1/auth/logout", { headers: { origin: "https://evil.example" } });
  expect(forged.status()).toBe(403);
  expect((await forged.json()).code).toBe("CROSS_SITE_REQUEST_REFUSED");

  // The access-pending panel offers sign-out too; this is the header's.
  await page.getByRole("banner").getByText("Account", { exact: true }).first().click();
  await openHeaderMenu(page, "Account");
  await page.getByRole("banner").getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("banner").getByRole("link", { name: "Sign in →" })).toBeVisible();
  expect((await context.cookies()).some((candidate) => candidate.name === SESSION_COOKIE)).toBe(false);

  // An encoded spelling of the verify route (review M1). The API would decode `%76` and issue a
  // session; the proxy must refuse it rather than pass the token back to page script. The code is
  // a valid one: the literal route right after accepts it, so the 400 is the path, not the code.
  const post = (path: string, body: unknown) =>
    page.evaluate(
      async ([target, payload]) => {
        const response = await fetch(target as string, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        return { status: response.status, text: await response.text() };
      },
      [path, body] as const,
    );
  expect((await post("/api/v1/auth/email/start", { email })).status).toBe(202);
  const code = await mailedCode(email, "sign_in_code");
  const encoded = await post("/api/v1/auth/email/%76erify", { email, code });
  expect(encoded.status).toBe(400);
  expect(JSON.parse(encoded.text)).toMatchObject({ code: "PATH_ENCODING_REFUSED" });
  expect(encoded.text).not.toContain("sessionToken");
  expect((await context.cookies()).some((candidate) => candidate.name === SESSION_COOKIE)).toBe(false);

  // Signing in again: the emailed code on the literal route, then the authenticator app (a later
  // step than enrolment).
  const literal = await post("/api/v1/auth/email/verify", { email, code });
  expect(literal.status).toBe(200);
  expect(literal.text).not.toContain("sessionToken");
  expect((await context.cookies()).some((candidate) => candidate.name === SESSION_COOKIE)).toBe(true);
  await page.goto("/w/work");
  await expect(page.getByTestId("access-pending")).toBeVisible();
});
