import type { FastifyInstance } from "fastify";
import { AppError, payloadTooLarge, toErrorEnvelope } from "../errors.js";

/**
 * Postgres gave up on this transaction because another one held what it needed: a deadlock
 * (`40P01`) or a serialization failure (`40001`). Nothing was written, and the same request
 * sent again normally succeeds — so 409 and retryable, not a 500 claiming the server broke.
 * Database refusals that reuse `40001` with a code of their own (`MFA_RESET_VERSION_MISMATCH`)
 * are translated by their routes before they reach here.
 */
const CONCURRENCY_SQLSTATES = new Set(["40P01", "40001"]);

/**
 * Fastify refuses a body over `bodyLimit` before any route runs, and that rejection is not an
 * `AppError`. Left alone it became a 500 telling the caller the server broke and the request is
 * worth retrying — neither is true. The caller has to send less, so say so with 413.
 */
function asAppError(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  // 0128: a suspended subject proposes and decides nothing. It holds no session, so this is the
  // database's second line; any route that reaches it answers 403, never a 500.
  if (
    code === "42501" &&
    !(error instanceof AppError) &&
    /^ACTOR_SUSPENDED:/.test((error as { message?: unknown }).message as string)
  ) {
    return new AppError("ACTOR_SUSPENDED", "This account is suspended and cannot act", 403, false);
  }
  if (code === "FST_ERR_CTP_BODY_TOO_LARGE") {
    return payloadTooLarge("PAYLOAD_TOO_LARGE", "The request body is larger than the server accepts");
  }
  if (typeof code === "string" && CONCURRENCY_SQLSTATES.has(code) && !(error instanceof AppError)) {
    return new AppError(
      "CONCURRENT_REQUEST",
      "Another request changed the same data at the same time. Send the request again",
      409,
      true,
    );
  }
  return error;
}

export async function registerErrorHandler(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((error, request, reply) => {
    const answered = asAppError(error);
    const status = answered instanceof AppError ? answered.statusCode : 500;

    // Details go to the server log; the response carries only the envelope. The original error
    // is logged, not the substitute, so the log still shows what Fastify raised.
    request.log.error(
      { err: error, correlationId: request.context?.correlationId },
      "request failed",
    );

    reply
      .status(status)
      .send(toErrorEnvelope(answered, request.context?.correlationId ?? "unknown"));
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      code: "NOT_FOUND",
      message: "The requested route does not exist",
      retryable: false,
      correlationId: request.context?.correlationId ?? "unknown",
    });
  });
}
