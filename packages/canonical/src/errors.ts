/**
 * Canonical 계층의 실패는 전부 코드로 식별한다.
 *
 * 이 계층이 조용히 값을 강제 변환하면 anchor root가 갈라진다. 강제 변환 대신
 * 거절하는 것이 이 모듈의 유일한 오류 전략이다.
 */
export type CanonicalErrorCode =
  | "E_CANONICAL_NUMBER_FORBIDDEN"
  | "E_CANONICAL_UNSUPPORTED_TYPE"
  | "E_CANONICAL_CIRCULAR"
  | "E_CANONICAL_LONE_SURROGATE"
  | "E_CANONICAL_NON_PLAIN_OBJECT"
  | "E_MERKLE_EMPTY_BATCH"
  | "E_MERKLE_DUPLICATE_LEAF"
  | "E_MERKLE_LEAF_NOT_FOUND"
  | "E_LEAF_INVALID_FIELD";

export class CanonicalError extends Error {
  readonly code: CanonicalErrorCode;
  /** 실패한 값의 JSON Pointer 경로. 루트 실패는 빈 문자열이다. */
  readonly path: string;

  constructor(code: CanonicalErrorCode, message: string, path = "") {
    super(path ? `${message} (at ${path || "/"})` : message);
    this.name = "CanonicalError";
    this.code = code;
    this.path = path;
  }
}
