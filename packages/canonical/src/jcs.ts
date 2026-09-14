import { CanonicalError } from "./errors.js";

/**
 * MPC canonical serialization — RFC 8785(JCS) 제한 프로파일.
 *
 * RFC 8785와의 차이는 하나뿐이다: **JSON number를 허용하지 않는다.**
 *
 * JCS의 number 직렬화는 IEEE 754 배정밀도와 ECMAScript `Number::toString`에
 * 의존한다. 광산 자원량·지분율·금액을 배정밀도로 왕복시키면 값이 바뀔 수 있고,
 * spec 05 §5.9는 "수치·단위·통화는 원 단위와 기준일 보존"을 요구한다.
 * number를 금지하면 AC-11(동일 입력 → byte-equivalent 결과)이 언어·런타임과
 * 무관하게 성립한다.
 *
 * 수치는 decimal string으로 표현하고 단위·기준일을 별도 필드에 둔다.
 */

export type CanonicalValue =
  | string
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

/**
 * RFC 8785 §3.2.2.2 문자열 이스케이프.
 *
 * JSON.stringify를 쓰지 않는 이유: lone surrogate를 만나면 JSON.stringify는
 * ES2019 well-formed 규칙에 따라 `\uXXXX`로 이스케이프해 통과시킨다. 그러면
 * 서로 다른 두 입력이 같은 바이트로 직렬화될 수 있다. 여기서는 거절한다.
 */
function serializeString(value: string, path: string): string {
  let out = '"';

  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);

    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        throw new CanonicalError(
          "E_CANONICAL_LONE_SURROGATE",
          "문자열에 짝이 없는 surrogate가 있다",
          path,
        );
      }
      out += value[i]! + value[i + 1]!;
      i += 1;
      continue;
    }

    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new CanonicalError(
        "E_CANONICAL_LONE_SURROGATE",
        "문자열에 짝이 없는 low surrogate가 있다",
        path,
      );
    }

    switch (code) {
      case 0x08:
        out += "\\b";
        break;
      case 0x09:
        out += "\\t";
        break;
      case 0x0a:
        out += "\\n";
        break;
      case 0x0c:
        out += "\\f";
        break;
      case 0x0d:
        out += "\\r";
        break;
      case 0x22:
        out += '\\"';
        break;
      case 0x5c:
        out += "\\\\";
        break;
      default:
        if (code < 0x20) {
          out += `\\u${code.toString(16).padStart(4, "0")}`;
        } else {
          out += value[i]!;
        }
    }
  }

  return `${out}"`;
}

/**
 * 객체 키 정렬 — RFC 8785는 UTF-16 코드 유닛 값의 lexicographic 순서를 요구한다.
 * JS의 기본 문자열 비교가 정확히 그 순서다.
 */
function sortKeys(keys: string[]): string[] {
  return [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function serializeValue(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return serializeString(value, path);

    case "boolean":
      return value ? "true" : "false";

    case "number":
      throw new CanonicalError(
        "E_CANONICAL_NUMBER_FORBIDDEN",
        "canonical payload에 JSON number를 쓸 수 없다. decimal string과 단위 필드를 사용한다",
        path,
      );

    case "bigint":
      throw new CanonicalError(
        "E_CANONICAL_NUMBER_FORBIDDEN",
        "canonical payload에 bigint를 쓸 수 없다. decimal string을 사용한다",
        path,
      );

    case "undefined":
    case "function":
    case "symbol":
      throw new CanonicalError(
        "E_CANONICAL_UNSUPPORTED_TYPE",
        `canonical payload에 ${typeof value}를 쓸 수 없다`,
        path,
      );

    case "object":
      break;

    default:
      throw new CanonicalError(
        "E_CANONICAL_UNSUPPORTED_TYPE",
        `알 수 없는 타입: ${typeof value}`,
        path,
      );
  }

  const objectValue = value as object;

  if (seen.has(objectValue)) {
    throw new CanonicalError("E_CANONICAL_CIRCULAR", "순환 참조는 직렬화할 수 없다", path);
  }
  seen.add(objectValue);

  try {
    if (Array.isArray(objectValue)) {
      const items = objectValue.map((item, index) =>
        serializeValue(item, `${path}/${index}`, seen),
      );
      return `[${items.join(",")}]`;
    }

    if (!isPlainObject(objectValue)) {
      throw new CanonicalError(
        "E_CANONICAL_NON_PLAIN_OBJECT",
        "Date·Map·Set·클래스 인스턴스는 직렬화 전에 평문 구조로 변환해야 한다",
        path,
      );
    }

    const record = objectValue as Record<string, unknown>;
    const entries = sortKeys(Object.keys(record)).map((key) => {
      const encodedKey = serializeString(key, path);
      // JSON Pointer 이스케이프: ~ → ~0, / → ~1
      const pointerKey = key.replace(/~/g, "~0").replace(/\//g, "~1");
      const encodedValue = serializeValue(record[key], `${path}/${pointerKey}`, seen);
      return `${encodedKey}:${encodedValue}`;
    });

    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(objectValue);
  }
}

/** canonical JSON 문자열을 만든다. 공백 없음, 키 정렬됨, number 금지. */
export function canonicalize(value: CanonicalValue): string {
  return serializeValue(value, "", new Set());
}

/** canonical JSON의 UTF-8 바이트. 해시 입력은 항상 이 함수를 통과한다. */
export function canonicalBytes(value: CanonicalValue): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}
