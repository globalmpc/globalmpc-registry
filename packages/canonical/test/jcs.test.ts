import { describe, expect, it } from "vitest";
import { CanonicalError } from "../src/errors.js";
import { canonicalBytes, canonicalize } from "../src/jcs.js";

describe("canonicalize — 키 정렬", () => {
  it("객체 키를 UTF-16 코드 유닛 오름차순으로 정렬한다", () => {
    expect(canonicalize({ b: "1", a: "2", C: "3" })).toBe('{"C":"3","a":"2","b":"1"}');
  });

  it("중첩 객체도 각 레벨에서 정렬한다", () => {
    expect(canonicalize({ z: { y: "1", x: "2" }, a: "3" })).toBe(
      '{"a":"3","z":{"x":"2","y":"1"}}',
    );
  });

  it("배열 순서는 보존한다 — 배열은 정렬 대상이 아니다", () => {
    expect(canonicalize(["c", "a", "b"])).toBe('["c","a","b"]');
  });

  it("키 순서가 다른 두 입력이 같은 바이트를 만든다", () => {
    const a = canonicalize({ one: "1", two: "2", three: "3" });
    const b = canonicalize({ three: "3", one: "1", two: "2" });
    expect(a).toBe(b);
  });
});

describe("canonicalize — number 금지 (ADR-T07)", () => {
  it("정수를 거절한다", () => {
    expect(() => canonicalize({ amount: 1 } as never)).toThrowError(CanonicalError);
    try {
      canonicalize({ amount: 1 } as never);
    } catch (error) {
      expect((error as CanonicalError).code).toBe("E_CANONICAL_NUMBER_FORBIDDEN");
      expect((error as CanonicalError).path).toBe("/amount");
    }
  });

  it("부동소수점을 거절한다", () => {
    expect(() => canonicalize({ grade: 0.1 } as never)).toThrowError(
      /JSON number를 쓸 수 없다/,
    );
  });

  it("bigint를 거절한다", () => {
    expect(() => canonicalize({ supply: 10n } as never)).toThrowError(CanonicalError);
  });

  it("decimal string은 허용한다", () => {
    expect(canonicalize({ amount: "10000000000", unit: "MPC" })).toBe(
      '{"amount":"10000000000","unit":"MPC"}',
    );
  });
});

describe("canonicalize — 타입 거절", () => {
  it("undefined를 거절한다", () => {
    expect(() => canonicalize({ a: undefined } as never)).toThrowError(
      /undefined를 쓸 수 없다/,
    );
  });

  it("Date를 거절한다 — 평문 구조로 변환해야 한다", () => {
    expect(() => canonicalize({ at: new Date(0) } as never)).toThrowError(
      /평문 구조로 변환/,
    );
  });

  it("Map을 거절한다", () => {
    expect(() => canonicalize({ m: new Map() } as never)).toThrowError(CanonicalError);
  });

  it("순환 참조를 거절한다", () => {
    const cyclic: Record<string, unknown> = { a: "1" };
    cyclic["self"] = cyclic;
    expect(() => canonicalize(cyclic as never)).toThrowError(/순환 참조/);
  });

  it("같은 객체를 형제로 두 번 참조하는 것은 순환이 아니다", () => {
    const shared = { a: "1" };
    expect(canonicalize({ x: shared, y: shared })).toBe('{"x":{"a":"1"},"y":{"a":"1"}}');
  });
});

describe("canonicalize — 문자열 이스케이프 (RFC 8785 §3.2.2.2)", () => {
  it("제어문자를 짧은 이스케이프로 표현한다", () => {
    expect(canonicalize("a\nb")).toBe('"a\\nb"');
    expect(canonicalize("a\tb")).toBe('"a\\tb"');
    expect(canonicalize("a\rb")).toBe('"a\\rb"');
    expect(canonicalize("a\bb")).toBe('"a\\bb"');
    expect(canonicalize("a\fb")).toBe('"a\\fb"');
  });

  it("따옴표와 역슬래시를 이스케이프한다", () => {
    expect(canonicalize('a"b')).toBe('"a\\"b"');
    expect(canonicalize("a\\b")).toBe('"a\\\\b"');
  });

  it("짧은 형식이 없는 제어문자는 소문자 \\u00xx로 표현한다", () => {
    expect(canonicalize("")).toBe('"\\u0001"');
    expect(canonicalize("")).toBe('"\\u001f"');
  });

  it("비ASCII 문자는 이스케이프하지 않는다", () => {
    expect(canonicalize("몽골 Mongolia Монгол")).toBe('"몽골 Mongolia Монгол"');
  });

  it("올바른 surrogate pair는 통과시킨다", () => {
    expect(canonicalize("\u{1F600}")).toBe('"\u{1F600}"');
  });

  it("짝 없는 high surrogate를 거절한다", () => {
    expect(() => canonicalize("\ud800")).toThrowError(/surrogate/);
  });

  it("짝 없는 low surrogate를 거절한다", () => {
    expect(() => canonicalize("\udc00")).toThrowError(/surrogate/);
  });
});

describe("canonicalBytes", () => {
  it("UTF-8 바이트를 만든다", () => {
    expect(canonicalBytes({ a: "b" })).toEqual(new TextEncoder().encode('{"a":"b"}'));
  });

  it("비ASCII를 UTF-8로 인코딩한다", () => {
    const bytes = canonicalBytes("몽");
    expect(bytes).toEqual(new TextEncoder().encode('"몽"'));
  });
});

describe("canonicalize — 원시값", () => {
  it("null·boolean·문자열을 직렬화한다", () => {
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize(true)).toBe("true");
    expect(canonicalize(false)).toBe("false");
    expect(canonicalize("")).toBe('""');
  });

  it("빈 객체와 빈 배열", () => {
    expect(canonicalize({})).toBe("{}");
    expect(canonicalize([])).toBe("[]");
  });

  it("공백을 넣지 않는다", () => {
    expect(canonicalize({ a: ["1", "2"], b: { c: "3" } })).toBe(
      '{"a":["1","2"],"b":{"c":"3"}}',
    );
  });
});
