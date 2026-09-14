import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  checkChannelReady,
  checkSecondReview,
  classifyBulkExport,
  classifySignedDocument,
  detectSchemaDrift,
  requiresSecondReview,
} from "../src/channels.js";

/**
 * Evidence channel parity — AC-29.
 *
 * 네 채널이 같은 result enum을 쓰되 각자가 막아야 하는 것은 다르다. 이 파일이
 * 보는 것은 **약한 채널이 쉬운 채널이 되지 않는가**다.
 */
describe("schema drift", () => {
  it("사라진 필드를 잡는다", () => {
    const drift = detectSchemaDrift(["licenseId", "holder", "expiresAt"], ["licenseId", "holder"]);
    expect(drift.drifted).toBe(true);
    // 있던 컬럼이 사라지면 파서가 undefined를 빈 값으로 넘길 수 있다.
    expect(drift.removed).toEqual(["expiresAt"]);
  });

  it("새로 생긴 필드도 drift다", () => {
    const drift = detectSchemaDrift(["licenseId"], ["licenseId", "newColumn"]);
    expect(drift.drifted).toBe(true);
    expect(drift.added).toEqual(["newColumn"]);
  });

  it("선언이 없으면 대조하지 않았다고 말한다", () => {
    const drift = detectSchemaDrift([], ["a", "b"]);
    // 모르는 것을 일치로 읽지 않는다.
    expect(drift.compared).toBe(false);
    expect(drift.drifted).toBe(false);
  });

  it("순서가 달라도 같은 집합이면 drift가 아니다", () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.string({ minLength: 1 }), { minLength: 1 }), (fields) => {
        const shuffled = [...fields].reverse();
        expect(detectSchemaDrift(fields, shuffled).drifted).toBe(false);
      }),
    );
  });
});

describe("bulk export", () => {
  it("drift가 있으면 확정되지 않는다", () => {
    const { result } = classifyBulkExport({
      declaredFields: ["licenseId", "expiresAt"],
      observedFields: ["licenseId"],
      recordFound: true,
    });
    // 컬럼이 바뀐 파일에서 읽은 값은 다른 것을 가리킬 수 있다.
    expect(result).toBe("schema_changed");
  });

  it("대조하지 않았으면 사람이 본다", () => {
    const { result } = classifyBulkExport({
      declaredFields: [],
      observedFields: ["licenseId"],
      recordFound: true,
    });
    expect(result).toBe("manual_review_required");
  });

  it("파일은 정상인데 기록이 없으면 기록 없음이다", () => {
    const { result } = classifyBulkExport({
      declaredFields: ["licenseId"],
      observedFields: ["licenseId"],
      recordFound: false,
    });
    // 장애가 아니라 사실이다.
    expect(result).toBe("source_returned_no_record");
  });
});

describe("signed document", () => {
  it("서명 검증 실패는 확정되지 않는다", () => {
    expect(
      classifySignedDocument({ signatureValid: false, signerRecognized: true, recordFound: true }),
    ).toBe("signature_invalid");
  });

  it("검증하지 못한 것과 실패한 것을 구분한다", () => {
    // 공개키를 등록하지 않는 것으로 검증을 건너뛸 수 없다.
    expect(
      classifySignedDocument({ signatureValid: null, signerRecognized: true, recordFound: true }),
    ).toBe("manual_review_required");
  });

  it("유효한 서명이라도 모르는 서명자면 거절한다", () => {
    // 유효한 서명은 서명자가 누구인지를 말하지 않는다.
    expect(
      classifySignedDocument({ signatureValid: true, signerRecognized: false, recordFound: true }),
    ).toBe("signature_invalid");
  });

  it("서명이 맞고 서명자를 알면 확정된다", () => {
    expect(
      classifySignedDocument({ signatureValid: true, signerRecognized: true, recordFound: true }),
    ).toBe("confirmed_from_source");
  });
});

describe("manual second review", () => {
  it("수동 확인만 두 번째 검토를 요구한다", () => {
    expect(requiresSecondReview("manual_official_registry_confirmation")).toBe(true);
    expect(requiresSecondReview("authenticated_api")).toBe(false);
  });

  it("두 번째 검토가 없으면 확정되지 않는다", () => {
    const check = checkSecondReview({ firstConfirmedBy: "a", secondConfirmedBy: null });
    expect(check.ok).toBe(false);
  });

  it("같은 사람이 두 번 확인할 수 없다", () => {
    // 목적이 다른 눈인데 같은 사람을 허용하면 절차만 남는다.
    const check = checkSecondReview({ firstConfirmedBy: "a", secondConfirmedBy: "a" });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain("처음 확인한 사람");
  });

  it("다른 사람이 확인하면 통과한다", () => {
    expect(checkSecondReview({ firstConfirmedBy: "a", secondConfirmedBy: "b" }).ok).toBe(true);
  });
});

describe("채널 요건", () => {
  it("확정이 아니면 요건을 묻지 않는다", () => {
    // 실패는 실패대로 기록돼야 한다.
    const check = checkChannelReady({
      method: "manual_official_registry_confirmation",
      result: "source_unavailable",
    });
    expect(check.ok).toBe(true);
  });

  it("서명 증거 없는 서명 문서는 확정될 수 없다", () => {
    const check = checkChannelReady({
      method: "verifiable_signed_document",
      result: "confirmed_from_source",
      signatureValid: null,
    });
    expect(check.ok).toBe(false);
  });

  it("관측 스키마 없는 bulk export는 확정될 수 없다", () => {
    const check = checkChannelReady({
      method: "official_bulk_export",
      result: "confirmed_from_source",
      observedFields: null,
    });
    expect(check.ok).toBe(false);
  });

  it("API 채널은 채널 증거를 요구하지 않는다", () => {
    // API는 상태 코드가 실패를 알린다. 그 판정은 adapter가 이미 했다.
    const check = checkChannelReady({
      method: "authenticated_api",
      result: "confirmed_from_source",
    });
    expect(check.ok).toBe(true);
  });
});
