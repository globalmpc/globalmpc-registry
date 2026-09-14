/**
 * 규칙 predicate — 제한된 AST.
 *
 * 규칙은 데이터여야 한다. 임의 코드나 표현식 문자열을 평가하면 규칙 version을
 * 저장해도 그때의 판단을 재현할 수 없고, 규칙 변경이 감사 대상이 되지 않는다
 * (05 §5.4, OD-15).
 *
 * 허용 연산자는 여기 정의된 9개뿐이다. 값은 전부 문자열이며 수치 비교는 정수
 * decimal string으로만 한다(ADR-T07의 number 금지를 규칙 계층까지 유지한다).
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

/** 평가 사실. 값은 문자열 또는 문자열 배열이며 undefined는 "없음"이다. */
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
      `${context}: 수치 비교는 정수 decimal string만 허용한다 (받은 값: ${value})`,
    );
  }
  return BigInt(value);
}

function readScalar(facts: Facts, path: string): string | undefined {
  const value = facts[path];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    throw new PredicateError(`${path}는 배열이다. 스칼라 비교에 사용할 수 없다`);
  }
  return value as string;
}

/**
 * 순수 평가. 현재 시각·난수·외부 조회를 사용하지 않는다.
 * 같은 (predicate, facts)는 항상 같은 결과를 만든다(AC-11).
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
      return toBigInt(raw, predicate.path) >= toBigInt(predicate.value, `${predicate.path} 기준값`);
    }

    case "lte": {
      const raw = readScalar(facts, predicate.path);
      if (raw === undefined) return false;
      return toBigInt(raw, predicate.path) <= toBigInt(predicate.value, `${predicate.path} 기준값`);
    }
  }
}

/** predicate가 참조하는 fact 경로 전체. 규칙이 요구하는 입력을 정적으로 알 수 있다. */
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
