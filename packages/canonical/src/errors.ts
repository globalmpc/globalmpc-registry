/**
 * Every failure in the canonical layer is identified by a code.
 *
 * If this layer silently coerced values, anchor roots would diverge. Rejecting instead of
 * coercing is this module's only error strategy.
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
  /** JSON Pointer path of the failing value. A root failure is the empty string. */
  readonly path: string;

  constructor(code: CanonicalErrorCode, message: string, path = "") {
    super(path ? `${message} (at ${path || "/"})` : message);
    this.name = "CanonicalError";
    this.code = code;
    this.path = path;
  }
}
