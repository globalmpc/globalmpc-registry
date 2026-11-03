import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import type { TypedDataDefinition } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { connectAs } from "./connect-as";
import { addVirtualAuthenticator, closeMailbox, database, invitationLink, mailedCode } from "./mailbox";

/**
 * The person without a usable role (plan §4 journey 1, priority rule 4).
 *
 * 1. An invited person who has no role yet lands on "access pending" after the recovery codes —
 *    not on a project list that answers with a refusal naming every role — and every role screen
 *    says the same, while their own settings stay open.
 * 2. A reviewer who replaces an operator-verified signing wallet keeps the role but loses the
 *    identity assurance it needs: the screen says so right after the replace, the header marks the
 *    role inactive with the reason, and an administrator's "Set assurance" puts it back in effect.
 *
 * The person is a fresh invitee each time, so no demo person's wallet or level changes under the
 * specs that sign with them.
 */

const TENANT_A_ORG = "aaaaaaaa-0000-0000-0000-000000000001";

test.describe.configure({ mode: "serial", timeout: 120_000 });
test.afterAll(closeMailbox);

async function invite(page: Page, email: string): Promise<void> {
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
}

/** A new browser for the invitee: accepts, enrols a passkey and keeps the recovery codes. */
async function enrolInvitee(browser: Browser, email: string, name: string): Promise<Page> {
  const context = await browser.newContext({ baseURL: `http://localhost:${process.env["E2E_WEB_PORT"]}` });
  const page = await context.newPage();
  await addVirtualAuthenticator(page);
  await page.goto(await invitationLink(email));
  await expect(page.getByTestId("invitation-accept")).toBeVisible();
  await page.getByLabel("Your name, as colleagues will see it").fill(name);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await page.getByLabel(/-digit code$/).fill(await mailedCode(email, "invitation_code"));
  await page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(page).toHaveURL(/\/auth\/mfa/);
  await page.getByTestId("passkey-enrol").click();
  await expect(page.getByTestId("recovery-code-list").locator("li")).not.toHaveCount(0);
  await page.getByRole("checkbox", { name: "I have saved these codes somewhere safe" }).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  return page;
}

/** A wallet in the page that answers with `key` — the person's new signing key. */
async function holdWallet(page: Page, key: `0x${string}`): Promise<string> {
  const account = privateKeyToAccount(key);
  await page.exposeFunction("__apWallet", async (method: string, params: unknown[]) => {
    if (method === "eth_requestAccounts" || method === "eth_accounts") return [account.address];
    if (method === "eth_chainId") return "0x7a69";
    if (method === "wallet_switchEthereumChain") return null;
    if (method === "eth_signTypedData_v4") return account.signTypedData(typed(JSON.parse((params as string[])[1]!)));
    throw new Error(`Unsupported ${method}`);
  });
  await page.addInitScript(() => {
    const call = (window as unknown as { __apWallet(m: string, p: unknown[]): Promise<unknown> }).__apWallet;
    Object.defineProperty(window, "ethereum", {
      value: {
        request: ({ method, params }: { method: string; params?: unknown[] }) => call(method, params ?? []),
        on() {},
        removeListener() {},
      },
      configurable: true,
    });
  });
  return account.address;
}

function typed(request: {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}): TypedDataDefinition {
  const numeric = new Set(
    (request.types[request.primaryType] ?? []).filter((field) => /^u?int\d*$/.test(field.type)).map((field) => field.name),
  );
  const message = Object.fromEntries(
    Object.entries(request.message).map(([key, value]) => [
      key,
      numeric.has(key) && (typeof value === "string" || typeof value === "number") ? BigInt(value) : value,
    ]),
  );
  const types = { ...request.types } as Record<string, unknown>;
  delete types["EIP712Domain"];
  return { ...request, types, message } as unknown as TypedDataDefinition;
}

test("an invited person without a role lands on access pending and can only reach their own account", async ({
  page,
  browser,
}) => {
  const email = `pending-${randomUUID().slice(0, 8)}@example.test`;
  await invite(page, email);
  const me = await enrolInvitee(browser, email, "Pending Person");
  try {
    await expect(me).toHaveURL(/\/w\/access-pending$/);
    const pending = me.getByTestId("access-pending");
    await expect(pending.getByRole("heading", { name: "Access pending" })).toBeVisible();
    await expect(pending).toContainText("a second administrator approves each grant");
    await expect(pending.getByRole("link", { name: /Request access/ })).toHaveAttribute("href", "/w/access-requests");
    await expect(pending.getByRole("link", { name: /Account settings/ })).toHaveAttribute("href", "/w/settings");
    await expect(me.getByTestId("effective-roles")).toHaveText("No roles");

    for (const path of ["/w/projects", "/w/governance", "/w/audit", "/w/work"]) {
      await me.goto(path);
      await expect(pending).toBeVisible();
      await expect(me.getByTestId("error-notice")).toHaveCount(0);
      await expect(me.getByRole("button", { name: "New project" })).toHaveCount(0);
    }
    await pending.getByRole("link", { name: /Account settings/ }).click();
    await expect(me.getByTestId("settings-sessions")).toBeVisible();
    await me.goto("/w/access-requests");
    await expect(pending).toHaveCount(0);

    await me.goto("/w/access-pending");
    await pending.getByTestId("access-pending-sign-out").click();
    await expect(me.getByRole("banner").getByRole("link", { name: "Sign in →" })).toBeVisible();
  } finally {
    await me.context().close();
  }
});

test("replacing an operator-verified wallet marks the reviewer role inactive until an admin sets the level", async ({
  page,
  browser,
}) => {
  const email = `rotate-${randomUUID().slice(0, 8)}@example.test`;
  const name = `Rotating Reviewer ${randomUUID().slice(0, 4)}`;
  await invite(page, email);
  const me = await enrolInvitee(browser, email, name);
  try {
    // The grant and the operator-verified wallet the dev deployment's reviewers hold, as the seed
    // writes them (an admin bind no longer exists; the two-person grant is covered elsewhere).
    const session = (await (await me.request.get("/api/v1/auth/session")).json()) as {
      subjectId: string;
      tenantId: string;
    };
    const old = privateKeyToAccount(generatePrivateKey());
    const sql = database();
    await sql`
      INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
      VALUES (gen_random_uuid(), ${session.tenantId}, ${session.subjectId}, ${TENANT_A_ORG}, 'reviewer_cp_qp')
    `;
    await sql`
      INSERT INTO core.wallet_identities (
        id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at, bound_via
      ) VALUES (
        gen_random_uuid(), ${session.tenantId}, ${session.subjectId}, ${old.address.toLowerCase()}, 31337,
        'high_assurance', now(), 'operator'
      )
    `;
    await sql`
      UPDATE core.subjects SET assurance_level = 'high_assurance', version = version + 1
      WHERE id = ${session.subjectId}
    `;

    const next = await holdWallet(me, generatePrivateKey());
    await me.goto("/w/settings");
    await expect(me.getByTestId("effective-roles")).toHaveText("reviewer_cp_qp");
    await expect(me.getByTestId("inactive-roles")).toHaveCount(0);

    const wallets = me.getByTestId("settings-wallets");
    await expect(wallets.getByTestId("wallet-current")).toContainText(old.address, { ignoreCase: true });
    await wallets.getByTestId("replace-wallet").click();
    const confirm = wallets.getByTestId("replace-confirm");
    await expect(confirm.getByTestId("replace-operator-verified")).toBeVisible();
    await confirm.getByTestId("confirm-replace").click();
    await expect(wallets.getByTestId("wallet-current")).toContainText(next, { ignoreCase: true });

    // Right after the replace: what happened and what to do next.
    const done = wallets.getByTestId("replace-done-operator");
    await expect(done).toContainText("your identity assurance is now wallet_only");
    await expect(done.getByTestId("replace-done-inactive")).toHaveText("reviewer_cp_qp");
    await expect(done).toContainText("Admin → Set assurance");
    // The header no longer lists the role as in effect.
    await expect(me.getByTestId("effective-roles")).toHaveText("");
    await expect(me.getByTestId("inactive-roles")).toHaveText("reviewer_cp_qp");
    await expect(me.getByTestId("inactive-roles-reason")).toContainText("Identity verification needed — ask an admin");
    // Every role screen explains the inactive role instead of refusing with ASSURANCE_LEVEL_INSUFFICIENT.
    await me.goto("/w/projects");
    const pending = me.getByTestId("access-pending");
    await expect(pending.getByRole("heading", { name: "Your roles are not in effect" })).toBeVisible();
    await expect(pending.getByTestId("access-pending-inactive-roles")).toContainText(
      "reviewer_cp_qp — needs high_assurance",
    );
    await expect(me.getByTestId("error-notice")).toHaveCount(0);

    // The administrator's step from the notice puts the role back in effect.
    await page.goto("/w/admin");
    const row = page.getByTestId("admin-subjects").locator("tr", { hasText: name });
    await row.getByRole("button", { name: "Set assurance" }).click();
    await page.getByRole("combobox", { name: "Assurance level" }).selectOption("high_assurance");
    await page.getByRole("textbox", { name: "What you checked (required)" }).fill("new wallet read back by phone");
    await page.getByRole("button", { name: "Set level", exact: true }).click();
    await expect(row.getByTestId("subject-assurance")).toHaveText("high_assurance");

    await me.reload();
    await expect(me.getByTestId("effective-roles")).toHaveText("reviewer_cp_qp");
    await expect(me.getByTestId("inactive-roles")).toHaveCount(0);
    await expect(me.getByRole("heading", { name: "Projects" })).toBeVisible();
  } finally {
    await me.context().close();
  }
});
