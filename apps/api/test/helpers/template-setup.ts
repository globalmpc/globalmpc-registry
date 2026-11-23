import postgres from "postgres";
import type { TestProject } from "vitest/node";
import { prepareTemplate } from "./template.js";

/**
 * Migrates the fixture template once, before any test file starts. Migrating inside a file's
 * `beforeAll` would spend most of its hook timeout, and a worker connected to the template while
 * migrating would make another worker's clone fail.
 */
export default async function setup(project: TestProject): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    project.provide("apiTemplate", "");
    return;
  }
  const admin = postgres(url, { onnotice: () => {}, max: 1 });
  try {
    project.provide("apiTemplate", await prepareTemplate(admin, new URL(url)));
  } finally {
    await admin.end();
  }
}
