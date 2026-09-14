import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { badRequest } from "../errors.js";

/**
 * 07 §7.1: 모든 응답에 `requestId`·`asOf`가 있고 오류에 `correlationId`가 있다.
 *
 * correlationId는 클라이언트가 헤더로 넘기면 이어받는다. 외부 시스템과의 추적을
 * 위해서다. 없으면 새로 만든다.
 */
export interface RequestContext {
  readonly requestId: string;
  readonly correlationId: string;
  readonly asOf: string;
}

export function newRequestContext(headerCorrelationId?: string): RequestContext {
  const requestId = randomUUID();
  return {
    requestId,
    correlationId: headerCorrelationId ?? requestId,
    asOf: new Date().toISOString(),
  };
}

declare module "fastify" {
  interface FastifyRequest {
    context: RequestContext;
  }
}

export async function registerRequestContext(app: FastifyInstance): Promise<void> {
  // onRequest 훅에서 매 요청마다 채운다. 초기값은 자리만 잡는다.
  app.decorateRequest("context", null as unknown as RequestContext);

  app.addHook("onRequest", async (request, reply) => {
    const header = request.headers["x-correlation-id"];
    request.context = newRequestContext(typeof header === "string" ? header : undefined);
    reply.header("X-Request-Id", request.context.requestId);
    reply.header("X-Correlation-Id", request.context.correlationId);
  });

  /**
   * 경로 파라미터의 UUID 형식을 한 곳에서 검사한다.
   *
   * 형식이 틀린 값을 DB에 넘기면 PostgreSQL이 타입 오류를 던지고 그것이 500
   * INTERNAL_ERROR로 나간다 — 클라이언트는 서버 장애로 오인하고 재시도한다.
   *
   * route마다 검사하면 57곳을 유지해야 하고 새 route에서 빠뜨린다. 이름이
   * `...Id`로 끝나는 파라미터를 한 번에 본다.
   */
  app.addHook("preValidation", async (request) => {
    const params = request.params as Record<string, unknown> | undefined;
    if (!params) return;

    for (const [name, value] of Object.entries(params)) {
      if (!name.endsWith("Id") || typeof value !== "string") continue;
      // gateId는 UUID가 아니라 사람이 읽는 식별자다(`registry_publication`).
      if (name === "gateId") continue;
      if (!UUID_PATTERN.test(value)) {
        throw badRequest("PATH_PARAM_INVALID", `${name}가 UUID 형식이 아니다`, {
          parameter: name,
          received: value,
        });
      }
    }
  });
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
