import { createRequire } from "node:module";
const require = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
);
const { chromium } = require("@playwright/test");
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
// Run from the repository root with the base revision being compared.
const base = process.argv[2];
if (!base)
  throw new Error(
    "Usage: node scripts/verify-codefactor-css.mjs <base-revision>",
  );
const files = ["globals.css", "reference-layout.css"];
const sharedStyles = ["@mpc/design/tokens.css", "@mpc/design/utilities.css"]
  .map((file) => readFileSync(require.resolve(file), "utf8"))
  .join("\n");
const before = files
  .map((f) =>
    execFileSync("git", ["show", `${base}:apps/web/src/app/${f}`], {
      encoding: "utf8",
    }),
  )
  .join("\n");
const after = files
  .map((f) => readFileSync(`apps/web/src/app/${f}`, "utf8"))
  .join("\n");
const html = `<header class="topbar"><div class="topbar-start"><nav><a>Workspace</a></nav></div><div class="topbar-end"><button>Account</button></div></header><main class="main"><div class="page-head"><h1>Registry</h1><p class="sub">Evidence</p></div><div class="public-directory-heading"><h1>Projects</h1></div><div class="public-directory-search"><input></div><div class="public-project-list"><article class="public-project-row"><div><h2><a>Mine</a></h2><p>Published</p></div><div>Verified</div><div>v1</div></article></div><table><thead><tr><th>Name</th></tr></thead><tbody><tr><td>Mine</td></tr></tbody></table><dl class="dl"><dt>Name</dt><dd>Mine</dd></dl><div class="work-summary"><a>Work</a><a>Review</a><a>Publish</a></div><div class="help-grid"><div>Help</div><div>Guide</div></div></main><div class="workspace-content"><div class="project-navigation"><div class="project-navigation-main"><a>Overview</a></div><div class="project-navigation-secondary"><a>Evidence</a></div></div><div class="panel">Panel</div></div><div class="dialog-backdrop"><div class="panel">Step up</div></div><section class="panel"><div class="dialog-backdrop"><div class="panel">Nested step up</div></div></section>`;
const browser = await chromium.launch({ headless: true });
let diffs = [];
for (const width of [375, 640, 641, 760, 1024, 1440]) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  async function snapshot(css) {
    await page.setContent(
      `<style>${sharedStyles}\n${css.replace(/@import\s+[^;]+;/g, "")}</style>${html}`,
    );
    return page.evaluate(() =>
      [...document.querySelectorAll("body *")].map((el) => {
        const s = getComputedStyle(el);
        return {
          tag: el.tagName,
          cls: el.className,
          css: Object.fromEntries(
            [...s].map((k) => [k, s.getPropertyValue(k)]),
          ),
        };
      }),
    );
  }
  const a = await snapshot(before),
    b = await snapshot(after);
  a.forEach((el, i) =>
    Object.keys(el.css).forEach((k) => {
      if (el.css[k] !== b[i].css[k])
        diffs.push({
          width,
          tag: el.tag,
          cls: el.cls,
          property: k,
          before: el.css[k],
          after: b[i].css[k],
        });
    }),
  );
  await page.close();
}
await browser.close();
console.log(
  JSON.stringify(
    { differences: diffs.length, first: diffs.slice(0, 30) },
    null,
    2,
  ),
);
process.exitCode = diffs.length ? 1 : 0;
