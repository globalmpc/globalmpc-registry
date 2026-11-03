import { expect, test, type Browser, type Page } from "@playwright/test";
import { signInAfresh } from "./connect-as";

/**
 * Where the account is signed in (WP7). Two browsers of one person: the second lists both
 * sessions, names its own as this browser, and ends the first; the first is then signed out on its
 * next request, the second stays in.
 *
 * Both sessions are new sign-ins and only the first is ended — by its id, not "every other one" —
 * so a session another worker holds for the same person is never touched.
 */
const PERSON = "Reader A";

async function browserOf(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  return context.newPage();
}

async function currentSessionId(page: Page): Promise<string> {
  const response = await page.request.get("/api/v1/auth/sessions");
  expect(response.ok()).toBe(true);
  const { items } = (await response.json()) as { items: { id: string; current: boolean }[] };
  const current = items.find((item) => item.current);
  expect(current, "the list names this browser's session").toBeTruthy();
  return current!.id;
}

test("ends another browser's session from settings, keeping this one", async ({ browser }) => {
  const laptop = await browserOf(browser);
  const phone = await browserOf(browser);
  try {
    await signInAfresh(laptop, PERSON);
    const laptopSession = await currentSessionId(laptop);
    await signInAfresh(phone, PERSON);
    const phoneSession = await currentSessionId(phone);
    expect(phoneSession).not.toBe(laptopSession);

    await phone.goto("/w/settings");
    const section = phone.getByTestId("settings-sessions");
    const here = section.getByTestId("session-current");
    await expect(here).toHaveAttribute("data-session-id", phoneSession);
    await expect(here).toContainText("emailed code + passkey");
    await expect(here).toContainText("this browser");
    await expect(here.getByRole("button")).toHaveCount(0);

    const other = section.locator(`[data-session-id="${laptopSession}"]`);
    await expect(other).toHaveAttribute("data-testid", "session-other");
    await other.getByRole("button", { name: "End session" }).click();
    await expect(other).toHaveCount(0);

    // The ended browser is signed out on its next request; this one is still in.
    const ended = await laptop.request.get("/api/v1/auth/session");
    expect(((await ended.json()) as { authenticated?: boolean }).authenticated).not.toBe(true);
    await laptop.goto("/w/projects");
    await expect(laptop.getByTestId("workspace-signed-out")).toBeVisible();
    await phone.reload();
    await expect(phone.getByTestId("session-current")).toHaveAttribute("data-session-id", phoneSession);

    // Ending it again changes nothing and says so.
    const again = await phone.request.post(`/api/v1/auth/sessions/${laptopSession}/revocation`, {
      headers: { origin: new URL(phone.url()).origin },
    });
    expect(again.ok()).toBe(true);
    expect(((await again.json()) as { revoked?: boolean }).revoked).toBe(false);
  } finally {
    await laptop.context().close();
    await phone.context().close();
  }
});
