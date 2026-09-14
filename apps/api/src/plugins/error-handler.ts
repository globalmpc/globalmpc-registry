import type { FastifyInstance } from "fastify";
import { AppError, toErrorEnvelope } from "../errors.js";

export async function registerErrorHandler(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((error, request, reply) => {
    const status = error instanceof AppError ? error.statusCode : 500;

    // 서버 로그에는 상세를, 응답에는 envelope만 보낸다.
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
      message: "요청한 경로가 없다",
      retryable: false,
      correlationId: request.context?.correlationId ?? "unknown",
    });
  });
}
