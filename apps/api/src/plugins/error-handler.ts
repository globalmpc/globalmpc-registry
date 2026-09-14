import type { FastifyInstance } from "fastify";
import { AppError, toErrorEnvelope } from "../errors.js";

export async function registerErrorHandler(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((error, request, reply) => {
    const status = error instanceof AppError ? error.statusCode : 500;

    // Details go to the server log; the response carries only the envelope.
    request.log.error(
      { err: error, correlationId: request.context?.correlationId },
      "request failed",
    );

    reply
      .status(status)
      .send(toErrorEnvelope(error, request.context?.correlationId ?? "unknown"));
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
