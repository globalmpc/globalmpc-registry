import type { ErrorEnvelope } from "@mpc/api-contract";

/**
 * 07 §7.1의 error envelope.
 *
 * `retryable`이 필수인 이유: 07 §7.11이 `source_returned_no_record`와 timeout을
 * 같은 code로 반환하지 못하게 한다. 클라이언트가 재시도 여부를 추측하면
 * "기록 없음"을 장애로 오인한다.
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
 * 412 — If-Match가 현재 version과 다르다.
 *
 * 클라이언트가 본 상태와 서버의 현재 상태가 다르다는 뜻이다. 재시도해도 같으므로
 * `retryable`은 false다. 다시 읽고 판단하는 것은 재시도가 아니다.
 */
export const preconditionFailed = (
  code: string,
  message: string,
  details?: Record<string, unknown>,
) => new AppError(code, message, 412, false, details);

/**
 * 428 — versioned resource를 바꾸려는데 If-Match가 없다.
 *
 * 412로 응답하면 "버전이 틀렸다"로 읽혀 클라이언트가 헤더를 안 보냈다는 사실이
 * 가려진다. 무엇이 빠졌는지 그대로 말한다.
 */
export const preconditionRequired = (
  code: string,
  message: string,
  details?: Record<string, unknown>,
) => new AppError(code, message, 428, false, details);

export const unprocessable = (code: string, message: string, details?: Record<string, unknown>) =>
  new AppError(code, message, 422, false, details);

/**
 * 429 — 요청 상한 초과.
 *
 * `retryable`이 true다. 상한은 시간이 지나면 풀리므로 재시도 불가로 표시하면
 * 사용자가 포기한다 — 07 §7.11이 구분하라고 한 바로 그 차이다.
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

  // 알 수 없는 오류의 내부 메시지를 밖으로 내보내지 않는다. 상세는 서버 로그에만 남는다.
  return {
    code: "INTERNAL_ERROR",
    message: "요청을 처리하지 못했다",
    retryable: true,
    correlationId,
  };
}
