/**
 * Rule predicate — a restricted AST.
 *
 * Rules must be data. Evaluating arbitrary code or expression strings means a stored rule version
 * cannot reproduce the judgment made at the time, and rule changes escape audit (05 §5.4, OD-15).
 *
 * Only the 9 operators defined here are allowed. All values are strings; numeric comparison uses
 * integer decimal strings only (ADR-T07's ban on number extends to the rule layer).
 */

export type Predicate =
  | { readonly op: "always" }
  | { readonly op: "never" }
  | { readonly op: "and"; readonly operands: readonly Predicate[] }
  | { readonly op: "or"; readonly operands: readonly Predicate[] }
  | { readonly op: "not"; readonly operand: Predicate }
  | { readonly op: "eq"; readonly path: string; readonly value: string }
  | { readonly op: "in"; readonly path: string; readonly values: readonly string[] }
  | { readonly op: "exists"; readonly path: string }
  | { readonly op: "gte"; readonly path: string; readonly value: string }
  | { readonly op: "lte"; readonly path: string; readonly value: string };

/** Evaluation facts. Values are strings or string arrays; undefined means "absent". */
export type Facts = Readonly<Record<string, string | readonly string[] | undefined>>;

export class PredicateError extends Error {
  readonly code = "PREDICATE_EVALUATION_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "PredicateError";
  }
}

const INTEGER = /^-?(0|[1-9][0-9]*)$/;

function toBigInt(value: string, context: string): bigint {
  if (!INTEGER.test(value)) {
    throw new PredicateError(
      `${context}: numeric comparison accepts only integer decimal strings (got: ${value})`,
    );
  }
  return BigInt(value);
}

function readScalar(facts: Facts, path: string): string | undefined {
  const value = facts[path];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    throw new PredicateError(`${path} is an array. It cannot be used in a scalar comparison`);
  }
  return value as string;
}

/**
 * Pure evaluation. Uses no clock, randomness, or external lookup.
 * The same (predicate, facts) always yields the same result (AC-11).
 */
export function evaluatePredicate(predicate: Predicate, facts: Facts): boolean {
  switch (predicate.op) {
    case "always":
      return true;

    case "never":
      return false;

    case "and":
      return predicate.operands.every((operand) => evaluatePredicate(operand, facts));

    case "or":
      return predicate.operands.some((operand) => evaluatePredicate(operand, facts));

    case "not":
      return !evaluatePredicate(predicate.operand, facts);

    case "eq": {
      const value = facts[predicate.path];
      if (value === undefined) return false;
      if (Array.isArray(value)) return value.includes(predicate.value);
      return value === predicate.value;
    }

    case "in": {
      const value = facts[predicate.path];
      if (value === undefined) return false;
      if (Array.isArray(value)) {
        return value.some((item) => predicate.values.includes(item));
      }
      return predicate.values.includes(value as string);
    }

    case "exists": {
      const value = facts[predicate.path];
      if (value === undefined) return false;
      if (Array.isArray(value)) return value.length > 0;
      return true;
    }

    case "gte": {
      const raw = readScalar(facts, predicate.path);
      if (raw === undefined) return false;
      return toBigInt(raw, predicate.path) >= toBigInt(predicate.value, `${predicate.path} threshold`);
    }

    case "lte": {
      const raw = readScalar(facts, predicate.path);
      if (raw === undefined) return false;
      return toBigInt(raw, predicate.path) <= toBigInt(predicate.value, `${predicate.path} threshold`);
    }
  }
}

/** All fact paths a predicate references. Lets the inputs a rule needs be known statically. */
export function collectPredicatePaths(predicate: Predicate, out: Set<string> = new Set()): Set<string> {
  switch (predicate.op) {
    case "always":
    case "never":
      break;
    case "and":
    case "or":
      for (const operand of predicate.operands) collectPredicatePaths(operand, out);
      break;
    case "not":
      collectPredicatePaths(predicate.operand, out);
      break;
    default:
      out.add(predicate.path);
  }
  return out;
}
