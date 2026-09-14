import { describe, expect, it } from "vitest";
import type { AdapterDescriptor } from "@mpc/domain";
import {
  buildReceiptBody,
  classifyHttpResponse,
  evaluateResponseBody,
  hashRawResponse,
  invokeHttpAdapter,
} from "../src/services/source-adapter.js";

/**
 * Source Adapter — 05 §5.12, OD-42.
 *
 * The point is **classifying each response into exactly one of 12 outcomes**. Mapping status
 * codes straight to success/failure conflates "no record" with "source outage", and users keep
 * retrying records that do not exist.
 */

const descriptor: AdapterDescriptor = {
  connectionKey: "mn-mineral-registry",
  authorityName: "Mineral Resources Authority",
  jurisdiction: "MNG",
  state: "active",
  proves: ["mining_right_registration"],
  doesNotProve: ["economic_viability", "rights_completeness"],
  stateReason: "",
};

const profile = {
  requiredFields: ["licenseNumber"],
  recordAbsentField: "found",
  recordAbsentValue: "false",
  businessErrorField: "error",
} as const;

const config = {
  endpoint: "https://registry.example/api/licenses",
  headers: {},
  timeoutMs: 1000,
  effectiveAtField: "asOfDate",
  responseProfile: profile,
};

describe("HTTP response classification", () => {
  const base = { signatureValid: null, body: "match" } as const;

  it("treats 404 as no record, not an outage", () => {
    // Mixing them makes users keep retrying records that do not exist.
    expect(classifyHttpResponse({ ...base, status: 404 })).toBe("source_returned_no_record");
  });

  it("treats 5xx and 429 as a source outage", () => {
    expect(classifyHttpResponse({ ...base, status: 503 })).toBe("source_unavailable");
    expect(classifyHttpResponse({ ...base, status: 429 })).toBe("source_unavailable");
  });

  it("distinguishes authentication failure from lack of permission", () => {
    // The former is our config problem, the latter an agreement problem — next steps differ.
    expect(classifyHttpResponse({ ...base, status: 401 })).toBe("authentication_failed");
    expect(classifyHttpResponse({ ...base, status: 403 })).toBe("access_not_authorized");
  });

  it("does not read a response with a broken signature as success", () => {
    const result = classifyHttpResponse({ ...base, status: 200, signatureValid: false });
    expect(result).toBe("signature_invalid");
  });

  it("does not guess values when the schema changes", () => {
    // It parses but is not a format we know. Guessing would record false facts.
    expect(classifyHttpResponse({ ...base, status: 200, body: "drift" })).toBe("schema_changed");
    expect(classifyHttpResponse({ ...base, status: 200, body: "unparsable" })).toBe(
      "schema_changed",
    );
  });

  it("routes a 200 with an empty body to a person", () => {
    // Indistinguishable from no record.
    const result = classifyHttpResponse({ ...base, status: 200, body: "empty" });
    expect(result).toBe("manual_review_required");
  });

  /**
   * 2026-09-10 audit A7.
   *
   * Previously 200 + successful parse meant confirmed. Both `{}` and `{"error":"unavailable"}`
   * became "confirmed by the source".
   */
  it("does not confirm when the response format is undeclared", () => {
    expect(classifyHttpResponse({ ...base, status: 200, body: "unprofiled" })).toBe(
      "manual_review_required",
    );
  });

  it("does not read a business error in a 200 body as confirmation", () => {
    expect(classifyHttpResponse({ ...base, status: 200, body: "business_error" })).toBe(
      "manual_review_required",
    );
  });

  it("does not read 'no record' in a 200 body as confirmation", () => {
    expect(classifyHttpResponse({ ...base, status: 200, body: "no_record" })).toBe(
      "source_returned_no_record",
    );
  });

  it("does not pass an unknown status as success", () => {
    expect(classifyHttpResponse({ ...base, status: 302 })).toBe("manual_review_required");
  });
});

/**
 * Name resolution stub.
 *
 * Tests do not use real DNS. Passing the SSRF check that source endpoints do not resolve to
 * private addresses requires a function returning a public address.
 */
const publicResolver = async () => ["203.0.113.10"];

/**
 * Response body classification — 2026-09-10 audit A7.
 *
 * **A successful parse is not a schema match.** They used to be the same, so a response in
 * which the source said "cannot answer" became `confirmed_from_source`.
 */
describe("evaluateResponseBody", () => {
  it("matches when all declared fields are present", () => {
    const result = evaluateResponseBody(JSON.stringify({ licenseNumber: "MV-1" }), profile);
    expect(result.verdict).toBe("match");
  });

  it("does not read an empty object as a match", () => {
    expect(evaluateResponseBody("{}", profile).verdict).toBe("drift");
  });

  it("does not read a business error as confirmation", () => {
    const result = evaluateResponseBody(JSON.stringify({ error: "unavailable" }), profile);
    expect(result.verdict).toBe("business_error");
    expect(result.detail).toBe("unavailable");
  });

  it("does not read a source-stated no-record as a schema change", () => {
    // It lacks the normal response fields. Matching fields first would make it all drift.
    const result = evaluateResponseBody(JSON.stringify({ found: false }), profile);
    expect(result.verdict).toBe("no_record");
  });

  it("does not confirm without a declaration", () => {
    const bare = {
      requiredFields: [],
      recordAbsentField: null,
      recordAbsentValue: null,
      businessErrorField: null,
    };
    expect(evaluateResponseBody(JSON.stringify({ anything: 1 }), bare).verdict).toBe("unprofiled");
  });

  it("does not read null or arrays as objects", () => {
    expect(evaluateResponseBody("null", profile).verdict).toBe("drift");
    expect(evaluateResponseBody("[]", profile).verdict).toBe("drift");
  });

  it("treats non-JSON as a schema change", () => {
    expect(evaluateResponseBody("<html>maintenance</html>", profile).verdict).toBe("unparsable");
  });

  it("reports an empty body as empty", () => {
    expect(evaluateResponseBody("   ", profile).verdict).toBe("empty");
  });
});

describe("adapter calls", () => {
  it("does not call a source whose access is not approved", async () => {
    // Calling would get a 401 recorded as "auth failure" — when no agreement exists yet.
    let called = false;
    const result = await invokeHttpAdapter(
      {
        descriptor: { ...descriptor, state: "pending_access", stateReason: "under negotiation" },
        config,
        queryBasis: {},
      },
      (async () => {
        called = true;
        return new Response("", { status: 200 });
      }) as typeof fetch,
      publicResolver,
    );

    expect(called).toBe(false);
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.result).toBe("access_not_authorized");
  });

  it("marks a manually collected source as needing review", async () => {
    const result = await invokeHttpAdapter(
      {
        descriptor: { ...descriptor, state: "manual", stateReason: "no API" },
        config,
        queryBasis: {},
      },
      (async () => new Response("", { status: 200 })) as typeof fetch,
      publicResolver,
    );

    if (result.kind === "failed") expect(result.result).toBe("manual_review_required");
  });

  it("extracts the raw hash and as-of date from a normal response", async () => {
    const body = JSON.stringify({ licenseNumber: "MV-1", asOfDate: "2026-08-01T00:00:00Z" });
    const result = await invokeHttpAdapter(
      { descriptor, config, queryBasis: { licenseNumber: "MV-1" } },
      (async () => new Response(body, { status: 200 })) as typeof fetch,
      publicResolver,
    );

    expect(result.kind).toBe("outcome");
    if (result.kind === "outcome") {
      expect(result.outcome.rawHash).toBe(hashRawResponse(body));
      // Differs from the lookup time. Equating them makes data look fresher than it is.
      expect(result.outcome.effectiveAt).toBe("2026-08-01T00:00:00.000Z");
    }
  });

  it("does not read a timeout as no record", async () => {
    const result = await invokeHttpAdapter(
      { descriptor, config, queryBasis: {} },
      (async () => {
        throw new Error("aborted");
      }) as typeof fetch,
      publicResolver,
    );

    if (result.kind === "failed") expect(result.result).toBe("source_unavailable");
  });

  it("does not confirm a 200 in an undeclared format", async () => {
    // A7 negative test. Previously this response was confirmed_from_source.
    const result = await invokeHttpAdapter(
      {
        descriptor,
        config: {
          ...config,
          responseProfile: {
            requiredFields: [],
            recordAbsentField: null,
            recordAbsentValue: null,
            businessErrorField: null,
          },
        },
        queryBasis: {},
      },
      (async () => new Response(JSON.stringify({ error: "unavailable" }), { status: 200 })) as
        typeof fetch,
      publicResolver,
    );

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.result).toBe("manual_review_required");
  });

  it("treats a non-JSON response as a schema change", async () => {
    const result = await invokeHttpAdapter(
      { descriptor, config, queryBasis: {} },
      (async () => new Response("<html>maintenance</html>", { status: 200 })) as typeof fetch,
      publicResolver,
    );

    if (result.kind === "failed") expect(result.result).toBe("schema_changed");
  });
});

describe("receipt body", () => {
  const extra = {
    connectionId: "c1",
    authorityId: "a1",
    collectionMethod: "authenticated_api",
    authenticationMethod: "mtls+oauth2",
    endpointOrDocumentRef: "https://registry.example/api/licenses",
    sourceSchemaVersion: "2026-01",
    adapterVersion: "1.0.0",
    termsLicense: "data sharing agreement",
    commercialReuse: "unconfirmed",
    disclosurePermission: "restricted",
  };

  it("always includes the authority's limitations", () => {
    const body = buildReceiptBody(
      descriptor,
      {
        kind: "outcome",
        outcome: {
          result: "confirmed_from_source",
          rawHash: `0x${"ab".repeat(32)}`,
          queryBasis: {},
          limitations: [],
          effectiveAt: null,
        },
      },
      extra,
    );

    expect(body["limitations"]).toContain("economic_viability");
  });

  it("does not fabricate a hash for a failed lookup", () => {
    const body = buildReceiptBody(
      descriptor,
      { kind: "failed", result: "source_unavailable", detail: "timeout" },
      extra,
    );

    // There is no raw body. Do not fill with zeros to fake "a hash exists".
    expect(body["rawHash"]).toBe(`0x${"0".repeat(64)}`);
    expect(body["freshnessStatus"]).toBe("unknown");
  });
});
