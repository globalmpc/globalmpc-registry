import { afterEach, describe, expect, it, vi } from "vitest";
import { recordProjectFact } from "../src/lib/projects-api";
import { mockHttp } from "./support/http";

afterEach(() => vi.unstubAllGlobals());

describe("matrix confirmation namespace", () => {
  it.each([["rights", "legacy"], ["mineral_licence", "catalog"]])(
    "declares the %s namespace so historical catalog keys cannot change legacy meaning",
    async (factKey, factScope) => {
      const url = `/api/v1/projects/project/facts/${factKey}/confirmations`;
      const calls = mockHttp({ [`POST ${url}`]: { factKey, status: "pending", version: 2 } });
      await recordProjectFact("token", "project", factKey!, 1, {
        status: "pending", evidence: null, asOf: null, reason: "Explicit confirmation",
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.body).toMatchObject({ factScope, status: "pending", reason: "Explicit confirmation" });
      expect(calls[0]!.headers.get("if-match")).toBe('\"1\"');
    },
  );
});
