import type { ErrorEnvelope } from "@mpc/api-contract";

/**
 * Error envelope from 07 §7.1.
 *
 * Why `retryable` is required: 07 §7.11 forbids returning `source_returned_no_record` and a
 * timeout under the same code. If the client guesses whether to retry, it mistakes
 * "no record" for an outage.
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
    readonly retryable: boolean,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (code: string, message: string, details?: Record<string, unknown>) =>
  new AppError(code, message, 400, false, details);

export const unauthorized = (code: string, message: string) =>
  new AppError(code, message, 401, false);

export const forbidden = (code: string, message: string, details?: Record<string, unknown>) =>
  new AppError(code, message, 403, false, details);

export const notFound = (message: string) => new AppError("NOT_FOUND", message, 404, false);

export const conflict = (code: string, message: string, details?: Record<string, unknown>) =>
  new AppError(code, message, 409, false, details);

/**
 * 412 — If-Match differs from the current version.
 *
 * The state the client saw differs from the server's current state. Retrying gives the same
 * result, so `retryable` is false. Re-reading and deciding again is not a retry.
 */
export const preconditionFailed = (
  code: string,
  message: string,
  details?: Record<string, unknown>,
) => new AppError(code, message, 412, false, details);

/**
 * 428 — Changing a versioned resource without If-Match.
 *
 * Answering 412 reads as "wrong version" and hides the fact that the client did not send the
 * header. Say exactly what is missing.
 */
export const preconditionRequired = (
  code: string,
  message: string,
  details?: Record<string, unknown>,
) => new AppError(code, message, 428, false, details);

export const unprocessable = (code: string, message: string, details?: Record<string, unknown>) =>
  new AppError(code, message, 422, false, details);

/**
 * 429 — Request cap exceeded.
 *
 * `retryable` is true. The cap lifts over time; marking it non-retryable makes users give
 * up — exactly the distinction 07 §7.11 requires.
 */
export const tooManyRequests = (
  code: string,
  message: string,
  details?: Record<string, unknown>,
) => new AppError(code, message, 429, true, details);

export const unavailable = (code: string, message: string) =>
  new AppError(code, message, 503, true);

export function toErrorEnvelope(error: unknown, correlationId: string): ErrorEnvelope {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
      retryable: error.retryable,
      correlationId,
    };
  }

  // Do not expose internal messages of unknown errors. Details stay only in server logs.
  return {
    code: "INTERNAL_ERROR",
    message: "The request could not be processed",
    retryable: true,
    correlationId,
  };
}
