import { describe, expect, it } from "vitest";
import { CanonicalError } from "../src/errors.js";
import { canonicalBytes, canonicalize } from "../src/jcs.js";

describe("canonicalize — key ordering", () => {
  it("sorts object keys by ascending UTF-16 code units", () => {
    expect(canonicalize({ b: "1", a: "2", C: "3" })).toBe('{"C":"3","a":"2","b":"1"}');
  });

  it("sorts nested objects at every level", () => {
    expect(canonicalize({ z: { y: "1", x: "2" }, a: "3" })).toBe(
      '{"a":"3","z":{"x":"2","y":"1"}}',
    );
  });

  it("preserves array order — arrays are not sorted", () => {
    expect(canonicalize(["c", "a", "b"])).toBe('["c","a","b"]');
  });

  it("two inputs with different key order produce the same bytes", () => {
    const a = canonicalize({ one: "1", two: "2", three: "3" });
    const b = canonicalize({ three: "3", one: "1", two: "2" });
    expect(a).toBe(b);
  });
});

describe("canonicalize — numbers forbidden (ADR-T07)", () => {
  it("rejects integers", () => {
    expect(() => canonicalize({ amount: 1 } as never)).toThrowError(CanonicalError);
    try {
      canonicalize({ amount: 1 } as never);
    } catch (error) {
      expect((error as CanonicalError).code).toBe("E_CANONICAL_NUMBER_FORBIDDEN");
      expect((error as CanonicalError).path).toBe("/amount");
    }
  });

  it("rejects floating point", () => {
    expect(() => canonicalize({ grade: 0.1 } as never)).toThrowError(
      /JSON numbers are not allowed/,
    );
  });

  it("rejects bigint", () => {
    expect(() => canonicalize({ supply: 10n } as never)).toThrowError(CanonicalError);
  });

  it("allows decimal strings", () => {
    expect(canonicalize({ amount: "10000000000", unit: "MPC" })).toBe(
      '{"amount":"10000000000","unit":"MPC"}',
    );
  });
});

describe("canonicalize — type rejection", () => {
  it("rejects undefined", () => {
    expect(() => canonicalize({ a: undefined } as never)).toThrowError(
      /undefined is not allowed/,
    );
  });

  it("rejects Date — it must be converted to a plain structure", () => {
    expect(() => canonicalize({ at: new Date(0) } as never)).toThrowError(
      /converted to plain structures/,
    );
  });

  it("rejects Map", () => {
    expect(() => canonicalize({ m: new Map() } as never)).toThrowError(CanonicalError);
  });

  it("rejects circular references", () => {
    const cyclic: Record<string, unknown> = { a: "1" };
    cyclic["self"] = cyclic;
    expect(() => canonicalize(cyclic as never)).toThrowError(/Circular reference/);
  });

  it("referencing the same object twice as siblings is not circular", () => {
    const shared = { a: "1" };
    expect(canonicalize({ x: shared, y: shared })).toBe('{"x":{"a":"1"},"y":{"a":"1"}}');
  });
});

describe("canonicalize — string escaping (RFC 8785 §3.2.2.2)", () => {
  it("uses short escapes for control characters", () => {
    expect(canonicalize("a\nb")).toBe('"a\\nb"');
    expect(canonicalize("a\tb")).toBe('"a\\tb"');
    expect(canonicalize("a\rb")).toBe('"a\\rb"');
    expect(canonicalize("a\bb")).toBe('"a\\bb"');
    expect(canonicalize("a\fb")).toBe('"a\\fb"');
  });

  it("escapes quotes and backslashes", () => {
    expect(canonicalize('a"b')).toBe('"a\\"b"');
    expect(canonicalize("a\\b")).toBe('"a\\\\b"');
  });

  it("uses lowercase \\u00xx for control characters without a short form", () => {
    expect(canonicalize("")).toBe('"\\u0001"');
    expect(canonicalize("")).toBe('"\\u001f"');
  });

  it("does not escape non-ASCII characters", () => {
    expect(canonicalize("몽골 Mongolia Монгол")).toBe('"몽골 Mongolia Монгол"');
  });

  it("passes a valid surrogate pair", () => {
    expect(canonicalize("\u{1F600}")).toBe('"\u{1F600}"');
  });

  it("rejects an unpaired high surrogate", () => {
    expect(() => canonicalize("\ud800")).toThrowError(/surrogate/);
  });

  it("rejects an unpaired low surrogate", () => {
    expect(() => canonicalize("\udc00")).toThrowError(/surrogate/);
  });
});

describe("canonicalBytes", () => {
  it("produces UTF-8 bytes", () => {
    expect(canonicalBytes({ a: "b" })).toEqual(new TextEncoder().encode('{"a":"b"}'));
  });

  it("encodes non-ASCII as UTF-8", () => {
    const bytes = canonicalBytes("몽");
    expect(bytes).toEqual(new TextEncoder().encode('"몽"'));
  });
});

describe("canonicalize — primitives", () => {
  it("serializes null, boolean, and strings", () => {
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize(true)).toBe("true");
    expect(canonicalize(false)).toBe("false");
    expect(canonicalize("")).toBe('""');
  });

  it("empty object and empty array", () => {
    expect(canonicalize({})).toBe("{}");
    expect(canonicalize([])).toBe("[]");
  });

  it("inserts no whitespace", () => {
    expect(canonicalize({ a: ["1", "2"], b: { c: "3" } })).toBe(
      '{"a":["1","2"],"b":{"c":"3"}}',
    );
  });
});
