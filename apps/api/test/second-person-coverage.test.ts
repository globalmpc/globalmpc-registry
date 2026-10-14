import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ACTION_POLICIES } from "@mpc/api-contract";

const ROUTES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/routes");

/**
 * Markers of a "this person must differ from that person" check in a route — the error codes
 * of every two-person refusal, and resources flagged as separation-sensitive.
 */
const SEPARATION_MARKER =
  /"[A-Z_]*(SELF_APPROVAL|SELF_PUBLICATION|SELF_RELEASE|SELF_TARGET|SELF_STATUS_CHANGE|RESUME_SELF|SAME_PERSON|SEPARATION_OF_DUTIES)"|separationSensitive: true/g;

const ACTION_LITERAL = /"([a-z_]+\.[a-z_.]+)"/g;

/**
 * The action authorized nearest to `index` — the closest before it, else the first after.
 *
 * A marker inside a shared resource builder (`const GATE_RESOURCE = (...) =>`) belongs to the
 * action authorized where the builder is first used, so the search moves there.
 */
function actionNear(source: string, index: number): string | null {
  const builder = [...source.slice(0, index).matchAll(/^const ([A-Z_]+) = \(/gm)].at(-1);
  if (builder && !source.slice(builder.index!, index).includes("\n}")) {
    const use = source.indexOf(`${builder[1]}(`, builder.index! + builder[0].length);
    if (use !== -1) index = use;
  }
  const actions = [...source.matchAll(ACTION_LITERAL)].filter(
    (match) => ACTION_POLICIES[match[1]!] !== undefined,
  );
  const before = actions.filter((match) => match.index! < index).at(-1);
  const after = actions.find((match) => match.index! > index);
  return (before ?? after)?.[1] ?? null;
}

/**
 * Every route-level two-person check belongs to a marked second-person action.
 *
 * The contract test catches decision verbs; this catches a separation check added to an action
 * whose name does not say "approve".
 */
describe("second-person coverage of route separation checks", () => {
  it("each separation check sits under a second-person action", () => {
    const unmarked: string[] = [];
    for (const file of readdirSync(ROUTES_DIR).filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(path.join(ROUTES_DIR, file), "utf8");
      for (const match of source.matchAll(SEPARATION_MARKER)) {
        const action = actionNear(source, match.index!);
        if (action === null || !ACTION_POLICIES[action]?.secondPerson) {
          unmarked.push(`${file}: ${match[0]} → ${action ?? "no action"}`);
        }
      }
    }
    expect(unmarked).toEqual([]);
  });
});
