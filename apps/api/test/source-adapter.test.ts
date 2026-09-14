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
 * 핵심은 **응답을 12개 결과 중 하나로 정확히 나누는 것**이다. 상태 코드를
 * 그대로 성공/실패로 나누면 "기록 없음"과 "출처 장애"가 같아지고, 사용자는
 * 존재하지 않는 기록을 계속 재시도한다.
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

describe("HTTP 응답 분류", () => {
  const base = { signatureValid: null, body: "match" } as const;

  it("404는 장애가 아니라 기록 없음이다", () => {
    // 둘을 섞으면 사용자는 존재하지 않는 기록을 계속 재시도한다.
    expect(classifyHttpResponse({ ...base, status: 404 })).toBe("source_returned_no_record");
  });

  it("5xx와 429는 출처 장애다", () => {
    expect(classifyHttpResponse({ ...base, status: 503 })).toBe("source_unavailable");
    expect(classifyHttpResponse({ ...base, status: 429 })).toBe("source_unavailable");
  });

  it("인증 실패와 권한 없음을 구분한다", () => {
    // 전자는 우리 설정 문제고 후자는 협의 문제다 — 다음에 할 일이 다르다.
    expect(classifyHttpResponse({ ...base, status: 401 })).toBe("authentication_failed");
    expect(classifyHttpResponse({ ...base, status: 403 })).toBe("access_not_authorized");
  });

  it("서명이 깨진 응답을 성공으로 읽지 않는다", () => {
    const result = classifyHttpResponse({ ...base, status: 200, signatureValid: false });
    expect(result).toBe("signature_invalid");
  });

  it("스키마가 바뀌면 값을 추측하지 않는다", () => {
    // 파싱은 되지만 우리가 아는 형식이 아니다. 추측해 넣으면 틀린 사실이 남는다.
    expect(classifyHttpResponse({ ...base, status: 200, body: "drift" })).toBe("schema_changed");
    expect(classifyHttpResponse({ ...base, status: 200, body: "unparsable" })).toBe(
      "schema_changed",
    );
  });

  it("200인데 본문이 비면 사람이 본다", () => {
    // 기록 없음과 구분되지 않는다.
    const result = classifyHttpResponse({ ...base, status: 200, body: "empty" });
    expect(result).toBe("manual_review_required");
  });

  /**
   * 2026-09-10 실사 A7.
   *
   * 이전에는 200 + 파싱 성공이면 확정이었다. `{}`도 `{"error":"unavailable"}`도
   * "출처가 확인해 줬다"가 됐다.
   */
  it("응답 형식이 선언되지 않았으면 확정하지 않는다", () => {
    expect(classifyHttpResponse({ ...base, status: 200, body: "unprofiled" })).toBe(
      "manual_review_required",
    );
  });

  it("200 본문의 업무 오류를 확인으로 읽지 않는다", () => {
    expect(classifyHttpResponse({ ...base, status: 200, body: "business_error" })).toBe(
      "manual_review_required",
    );
  });

  it("200 본문의 '기록 없음'을 확인으로 읽지 않는다", () => {
    expect(classifyHttpResponse({ ...base, status: 200, body: "no_record" })).toBe(
      "source_returned_no_record",
    );
  });

  it("모르는 상태를 성공으로 넘기지 않는다", () => {
    expect(classifyHttpResponse({ ...base, status: 302 })).toBe("manual_review_required");
  });
});

/**
 * 이름 해석 stub.
 *
 * 테스트는 실제 DNS를 쓰지 않는다. 출처 endpoint가 사설 주소로 해석되지 않는지
 * 보는 검사(SSRF)를 지나려면 공개 주소를 돌려주는 함수가 필요하다.
 */
const publicResolver = async () => ["203.0.113.10"];

/**
 * 응답 본문 판정 — 2026-09-10 실사 A7.
 *
 * **파싱 성공은 스키마 일치가 아니다.** 이전에는 그 둘이 같았고, 그래서 출처가
 * "답할 수 없다"고 말한 응답이 `confirmed_from_source`가 됐다.
 */
describe("evaluateResponseBody", () => {
  it("선언된 필드가 다 있으면 일치다", () => {
    const result = evaluateResponseBody(JSON.stringify({ licenseNumber: "MV-1" }), profile);
    expect(result.verdict).toBe("match");
  });

  it("빈 객체를 일치로 읽지 않는다", () => {
    expect(evaluateResponseBody("{}", profile).verdict).toBe("drift");
  });

  it("업무 오류를 확인으로 읽지 않는다", () => {
    const result = evaluateResponseBody(JSON.stringify({ error: "unavailable" }), profile);
    expect(result.verdict).toBe("business_error");
    expect(result.detail).toBe("unavailable");
  });

  it("출처가 밝힌 기록 없음을 스키마 변경으로 읽지 않는다", () => {
    // 정상 응답의 필드를 갖지 않는다. 필드 대조를 먼저 하면 전부 drift가 된다.
    const result = evaluateResponseBody(JSON.stringify({ found: false }), profile);
    expect(result.verdict).toBe("no_record");
  });

  it("선언이 없으면 확정하지 않는다", () => {
    const bare = {
      requiredFields: [],
      recordAbsentField: null,
      recordAbsentValue: null,
      businessErrorField: null,
    };
    expect(evaluateResponseBody(JSON.stringify({ anything: 1 }), bare).verdict).toBe("unprofiled");
  });

  it("null과 배열을 객체로 읽지 않는다", () => {
    expect(evaluateResponseBody("null", profile).verdict).toBe("drift");
    expect(evaluateResponseBody("[]", profile).verdict).toBe("drift");
  });

  it("JSON이 아니면 스키마 변경이다", () => {
    expect(evaluateResponseBody("<html>maintenance</html>", profile).verdict).toBe("unparsable");
  });

  it("빈 본문은 비었다고 말한다", () => {
    expect(evaluateResponseBody("   ", profile).verdict).toBe("empty");
  });
});

describe("adapter 호출", () => {
  it("접근이 승인되지 않은 출처를 부르지 않는다", async () => {
    // 부르면 401을 받아 "인증 실패"로 기록하게 된다 — 실제로는 협의가 안 된 것이다.
    let called = false;
    const result = await invokeHttpAdapter(
      {
        descriptor: { ...descriptor, state: "pending_access", stateReason: "협의 중" },
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

  it("수동 수집 출처는 검토 필요로 표시한다", async () => {
    const result = await invokeHttpAdapter(
      {
        descriptor: { ...descriptor, state: "manual", stateReason: "API 없음" },
        config,
        queryBasis: {},
      },
      (async () => new Response("", { status: 200 })) as typeof fetch,
      publicResolver,
    );

    if (result.kind === "failed") expect(result.result).toBe("manual_review_required");
  });

  it("정상 응답에서 원문 해시와 기준일을 뽑는다", async () => {
    const body = JSON.stringify({ licenseNumber: "MV-1", asOfDate: "2026-08-01T00:00:00Z" });
    const result = await invokeHttpAdapter(
      { descriptor, config, queryBasis: { licenseNumber: "MV-1" } },
      (async () => new Response(body, { status: 200 })) as typeof fetch,
      publicResolver,
    );

    expect(result.kind).toBe("outcome");
    if (result.kind === "outcome") {
      expect(result.outcome.rawHash).toBe(hashRawResponse(body));
      // 조회 시각과 다르다. 같게 두면 자료가 실제보다 최신으로 보인다.
      expect(result.outcome.effectiveAt).toBe("2026-08-01T00:00:00.000Z");
    }
  });

  it("타임아웃을 기록 없음으로 읽지 않는다", async () => {
    const result = await invokeHttpAdapter(
      { descriptor, config, queryBasis: {} },
      (async () => {
        throw new Error("aborted");
      }) as typeof fetch,
      publicResolver,
    );

    if (result.kind === "failed") expect(result.result).toBe("source_unavailable");
  });

  it("선언되지 않은 형식의 200을 확정하지 않는다", async () => {
    // A7 부정 테스트. 이전에는 이 응답이 confirmed_from_source였다.
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

  it("JSON이 아닌 응답을 스키마 변경으로 본다", async () => {
    const result = await invokeHttpAdapter(
      { descriptor, config, queryBasis: {} },
      (async () => new Response("<html>maintenance</html>", { status: 200 })) as typeof fetch,
      publicResolver,
    );

    if (result.kind === "failed") expect(result.result).toBe("schema_changed");
  });
});

describe("receipt 본문", () => {
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

  it("authority의 한계가 반드시 들어간다", () => {
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

  it("실패한 조회에 가짜 해시를 만들지 않는다", () => {
    const body = buildReceiptBody(
      descriptor,
      { kind: "failed", result: "source_unavailable", detail: "timeout" },
      extra,
    );

    // 원문이 없다. 0으로 채워 "해시가 있다"고 보이게 하지 않는다.
    expect(body["rawHash"]).toBe(`0x${"0".repeat(64)}`);
    expect(body["freshnessStatus"]).toBe("unknown");
  });
});
