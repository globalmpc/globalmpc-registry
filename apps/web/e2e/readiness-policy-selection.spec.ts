import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { connectAs } from "./connect-as";
import { database, closeMailbox } from "./mailbox";

const policyId = randomUUID();
const ruleSetId = `readiness-regression-${randomUUID()}`;
const projectId = randomUUID();

test.beforeAll(async () => {
  const sql = database();
  await sql`INSERT INTO core.projects(id,tenant_id,project_key,name,host_country_iso3,minerals,owner_organization_id)
    VALUES (${projectId},'e0000000-0000-4000-8000-00000000000a',${`POLICY-${projectId}`},'Policy selection regression','MNG',ARRAY['copper'],'aaaaaaaa-0000-0000-0000-000000000001')`;
  const [source] =
    await sql`SELECT * FROM core.compliance_policy_sets WHERE id='dddddddd-0000-0000-0000-000000000001'`;
  if (!source) throw new Error("Readiness seed policy is missing");
  await sql`INSERT INTO core.compliance_policy_sets
    (id,tenant_id,rule_set_id,rule_set_version,gate_id,jurisdiction_profile,effective_from,definition,state)
    VALUES (${policyId},${source.tenant_id},${ruleSetId},${source.rule_set_version},${source.gate_id},${source.jurisdiction_profile},
      '2000-01-01',${sql.json({ ...source.definition, ruleSetId, effectiveFrom: "2000-01-01T00:00:00Z" })},'effective')`;
});
test.afterAll(closeMailbox);

test("readiness and decision pages use an explicitly selected non-demo policy", async ({
  page,
}) => {
  await connectAs(page, "Operator A");
  for (const path of ["readiness", "gates/registry_publication"]) {
    await page.goto(`/w/projects/${projectId}/${path}`);
    const select = page.getByRole("combobox", { name: "Rule set" });
    await expect(select).toBeVisible();
    const button = page.getByRole("button", {
      name: path === "readiness" ? "Recompute" : "Load current readiness",
      exact: true,
    });
    await expect(button).toBeDisabled();
    await select.selectOption(policyId);
    const result = page.waitForResponse(
      (response) =>
        response
          .url()
          .endsWith(`/projects/${projectId}/readiness-assessments`) &&
        response.request().method() === "POST",
    );
    await button.click();
    const response = await result;
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON()).toEqual({
      policySetId: policyId,
    });
    await expect(page.getByTestId("error-notice")).toHaveCount(0);
    if (path === "readiness")
      await expect(
        page.getByRole("heading", { name: "Reproducibility" }),
      ).toBeVisible();
    else
      await expect(page.getByText(/^\d+ requirements block go$/)).toBeVisible();
  }
});

test("an unconfigured decision gate provides policy setup guidance and prevents evaluation", async ({
  page,
}) => {
  await connectAs(page, "Operator A");
  await page.goto(`/w/projects/${projectId}/gates/unconfigured-gate`);
  await expect(
    page.getByText("No effective rule set is available"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Load current readiness" }),
  ).toBeDisabled();
  await page.getByRole("link", { name: "Open review registries →" }).click();
  await expect(
    page.getByRole("heading", { name: "Review registry proposals" }),
  ).toBeVisible();
});
