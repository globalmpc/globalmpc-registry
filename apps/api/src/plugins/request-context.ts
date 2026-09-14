import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { badRequest } from "../errors.js";

/**
 * 07 §7.1: every response has `requestId` and `asOf`, and errors have `correlationId`.
 *
 * A correlationId the client passes in a header is carried over, for tracing across external
 * systems. Otherwise a new one is generated.
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
  // Filled on every request in the onRequest hook. The initial value only reserves the slot.
  app.decorateRequest("context", null as unknown as RequestContext);

  app.addHook("onRequest", async (request, reply) => {
    const header = request.headers["x-correlation-id"];
    request.context = newRequestContext(typeof header === "string" ? header : undefined);
    reply.header("X-Request-Id", request.context.requestId);
    reply.header("X-Correlation-Id", request.context.correlationId);
  });

  /**
   * Checks the UUID format of path parameters in one place.
   *
   * Passing a malformed value to the DB makes PostgreSQL throw a type error that goes out as a 500
   * INTERNAL_ERROR — the client mistakes it for a server outage and retries.
   *
   * Checking per route means maintaining 57 places and missing it on new routes. Parameters whose
   * names end in `...Id` are checked in one pass.
   */
  app.addHook("preValidation", async (request) => {
    const params = request.params as Record<string, unknown> | undefined;
    if (!params) return;

    for (const [name, value] of Object.entries(params)) {
      if (!name.endsWith("Id") || typeof value !== "string") continue;
      // gateId is a human-readable identifier, not a UUID (`registry_publication`).
      if (name === "gateId") continue;
      if (!UUID_PATTERN.test(value)) {
        throw badRequest("PATH_PARAM_INVALID", `${name} is not a valid UUID`, {
          parameter: name,
          received: value,
        });
      }
    }
  });
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
