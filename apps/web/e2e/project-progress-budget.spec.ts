import { expect, test } from "@playwright/test";
import { connectAs } from "./connect-as";
import { command } from "./evidence-ledger-journey";

test("a tall project list bounds progress reads and remains usable after rate limiting", async ({page}) => {
  await page.setViewportSize({width:1440,height:1600});
  await connectAs(page,"Operator A");
  const prefix=`BUDGET-${Date.now()}`;
  for(let i=0;i<6;i++) {
    await command(page,"/api/v1/projects",{
      projectKey:`${prefix}-${i}`,name:`Progress budget mine ${i}`,hostCountryIso3:"MNG",minerals:["copper"],
      ownerOrganizationId:"aaaaaaaa-0000-0000-0000-000000000001",referenceStatus:"synthetic_test_project",
    });
  }
  let requests=0;
  let limited=true;
  let release!:()=>void;
  const pending=new Promise<void>(resolve=>{release=resolve;});
  await page.route("**/api/v1/projects/*/evidence-ledger",async route=>{
    requests++;
    if (!limited) { await route.continue(); return; }
    await pending;
    await route.fulfill({status:429,contentType:"application/json",body:JSON.stringify({code:"RATE_LIMITED",message:"Wait",retryable:true,correlationId:"budget-test"})});
  });
  try {
    await page.goto("/w/projects");
    await expect(page.getByTestId("project-list").getByRole("row").filter({hasText:prefix})).toHaveCount(6);
    expect(requests).toBe(0);
    const rows=page.getByTestId("project-list").getByRole("row").filter({hasText:prefix});
    await expect(rows.getByText("No saved assessment available")).toHaveCount(6);
    for(let i=0;i<6;i++) await rows.nth(i).getByRole("button",{name:"Load progress"}).click();
    await expect.poll(()=>requests).toBeGreaterThanOrEqual(2);
    expect(requests).toBe(2);
    release();
    const paused=page.getByTestId("project-list").getByText(/Progress loading paused/);
    await expect(paused).toHaveCount(6);
    expect(requests).toBe(2);
    await expect(page.getByRole("button",{name:"Retry progress"})).toHaveCount(6);
    await rows.first().getByRole("button",{name:"Retry progress"}).click();
    await expect(paused).toHaveCount(6);
    expect(requests).toBe(2);
    limited=false;
    const now=await page.evaluate(()=>Date.now());
    await page.clock.setFixedTime(new Date(now+60_001));
    expect(requests).toBe(2);
    await rows.first().getByRole("button",{name:"Retry progress"}).click();
    await expect(rows.first().getByText("Last requested assessment · may be outdated")).toBeVisible();
    expect(requests).toBe(3);
    await page.unroute("**/api/v1/projects/*/evidence-ledger");
    await page.getByRole("link",{name:"Inspect requirements →"}).first().click();
    await expect(page.getByRole("heading",{name:"Requirements",exact:true})).toBeVisible();
    await expect(page.getByTestId("evidence-ledger")).toBeVisible();
  } finally {release();}
});
