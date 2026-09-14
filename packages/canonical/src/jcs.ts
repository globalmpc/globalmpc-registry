import { CanonicalError } from "./errors.js";

/**
 * MPC canonical serialization — a restricted profile of RFC 8785 (JCS).
 *
 * The only difference from RFC 8785: **JSON numbers are not allowed.**
 *
 * JCS number serialization depends on IEEE 754 double precision and ECMAScript
 * `Number::toString`. Round-tripping mine resources, ownership ratios, or amounts through doubles
 * can change values, and spec 05 §5.9 requires "numbers, units, and currencies keep original units and reference dates".
 * Forbidding numbers makes AC-11 (same input → byte-equivalent result) hold regardless of
 * language or runtime.
 *
 * Numbers are expressed as decimal strings, with unit and reference date in separate fields.
 */

export type CanonicalValue =
  | string
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

/**
 * RFC 8785 §3.2.2.2 string escaping.
 *
 * Why not JSON.stringify: on a lone surrogate, JSON.stringify follows the ES2019 well-formed
 * rule and lets it through escaped as `\uXXXX`. Two different inputs could then serialize to the
 * same bytes. Here they are rejected.
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
          "String contains an unpaired surrogate",
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
        "String contains an unpaired low surrogate",
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
 * Object key ordering — RFC 8785 requires lexicographic order of UTF-16 code unit values.
 * JS default string comparison is exactly that order.
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
        "JSON numbers are not allowed in a canonical payload. Use a decimal string and a unit field",
        path,
      );

    case "bigint":
      throw new CanonicalError(
        "E_CANONICAL_NUMBER_FORBIDDEN",
        "bigint is not allowed in a canonical payload. Use a decimal string",
        path,
      );

    case "undefined":
    case "function":
    case "symbol":
      throw new CanonicalError(
        "E_CANONICAL_UNSUPPORTED_TYPE",
        `${typeof value} is not allowed in a canonical payload`,
        path,
      );

    case "object":
      break;

    default:
      throw new CanonicalError(
        "E_CANONICAL_UNSUPPORTED_TYPE",
        `Unknown type: ${typeof value}`,
        path,
      );
  }

  const objectValue = value as object;

  if (seen.has(objectValue)) {
    throw new CanonicalError("E_CANONICAL_CIRCULAR", "Circular references cannot be serialized", path);
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
        "Date, Map, Set, and class instances must be converted to plain structures before serialization",
        path,
      );
    }

    const record = objectValue as Record<string, unknown>;
    const entries = sortKeys(Object.keys(record)).map((key) => {
      const encodedKey = serializeString(key, path);
      // JSON Pointer escaping: ~ → ~0, / → ~1
      const pointerKey = key.replace(/~/g, "~0").replace(/\//g, "~1");
      const encodedValue = serializeValue(record[key], `${path}/${pointerKey}`, seen);
      return `${encodedKey}:${encodedValue}`;
    });

    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(objectValue);
  }
}

/** Produces the canonical JSON string. No whitespace, sorted keys, no numbers. */
export function canonicalize(value: CanonicalValue): string {
  return serializeValue(value, "", new Set());
}

/** UTF-8 bytes of canonical JSON. Hash input always goes through this function. */
export function canonicalBytes(value: CanonicalValue): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}
