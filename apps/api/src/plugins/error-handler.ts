import type { FastifyInstance } from "fastify";
import { AppError, payloadTooLarge, toErrorEnvelope } from "../errors.js";

/**
 * Fastify refuses a body over `bodyLimit` before any route runs, and that rejection is not an
 * `AppError`. Left alone it became a 500 telling the caller the server broke and the request is
 * worth retrying — neither is true. The caller has to send less, so say so with 413.
 */
function asAppError(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "FST_ERR_CTP_BODY_TOO_LARGE") {
    return payloadTooLarge("PAYLOAD_TOO_LARGE", "The request body is larger than the server accepts");
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
