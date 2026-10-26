import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { errorEnvelope } from "./common.js";
import { ROUTES } from "./routes.js";

/**
 * OpenAPI 3.1 generation.
 *
 * ADR-T05: define once in Zod and generate the document. Runtime validation and
 * the document come from the same definition, so they cannot diverge.
 * Hand-written OpenAPI always diverges.
 *
 * CI compares this script's output with the committed `openapi.json` and fails
 * on drift (`pnpm check:openapi`).
 */

function schemaFor(schema: z.ZodType, name: string, io: "input" | "output" = "output"): unknown {
  // Requests describe accepted input; responses describe the validated output shape.
  const { $schema, ...converted } = z.toJSONSchema(schema, { target: "draft-2020-12", io });
  return { $ref: `#/definitions/${name}`, definitions: { [name]: converted }, $schema };
}

/** Properties of an object schema, unwrapped from the named `definitions` wrapper. */
function objectProperties(
  schema: z.ZodType,
  name: string,
): { readonly properties?: Record<string, unknown>; readonly required?: readonly string[] } {
  // Named schemas are wrapped under `definitions`.
  // Parameters need the inner object, so unwrap one level.
  const wrapper = schemaFor(schema, name, "input") as { readonly definitions?: Record<string, unknown> };
  return (wrapper.definitions?.[name] ?? {}) as {
    readonly properties?: Record<string, unknown>;
    readonly required?: readonly string[];
  };
}

function pathParameters(
  routePath: string,
  paramsSchema: z.ZodType | undefined,
  operationId: string,
): unknown[] {
  const declared = paramsSchema
    ? (objectProperties(paramsSchema, `${operationId}Params`).properties ?? {})
    : {};
  const matches = routePath.match(/\{([^}]+)\}/g) ?? [];
  return matches.map((match) => {
    const name = match.slice(1, -1);
    return {
      name,
      in: "path",
      required: true,
      schema: declared[name] ?? { type: "string" },
    };
  });
}

const paths: Record<string, Record<string, unknown>> = {};

for (const route of ROUTES) {
  const parameters: unknown[] = [
    ...pathParameters(route.path, route.paramsSchema, route.operationId),
  ];

  if (route.mutation) {
    parameters.push({
      name: "Idempotency-Key",
      in: "header",
      required: true,
      schema: { type: "string", minLength: 16 },
      description: "Prevents duplicate execution when a mutation is retried (07 §7.1)",
    });
  }

  // Expand the query string contract into OpenAPI parameters. The server rejects
  // parameters not listed here, so absence from the list means "cannot be sent".
  if (route.querySchema !== undefined) {
    const jsonSchema = objectProperties(route.querySchema, `${route.operationId}Query`);
    for (const [name, schema] of Object.entries(jsonSchema.properties ?? {})) {
      parameters.push({
        name,
        in: "query",
        required: (jsonSchema.required ?? []).includes(name),
        schema,
      });
    }
  }

  if (route.requiresIfMatch) {
    parameters.push({
      name: "If-Match",
      in: "header",
      required: true,
      schema: { type: "string" },
      description: 'Expected version of the versioned resource. Format: `"3"` (07 §7.1)',
    });
  }

  const operation: Record<string, unknown> = {
    operationId: route.operationId,
    summary: route.summary,
    tags: [route.public ? "public" : "workspace"],
    parameters,
    responses: {
      "200": {
        description: "Success",
        headers: {
          "X-Request-Id": { schema: { type: "string" } },
          "X-Resource-Version": { schema: { type: "string" } },
        },
        content: {
          "application/json": {
            schema: schemaFor(route.responseSchema, `${route.operationId}Response`),
          },
        },
      },
      "400": errorResponse("Invalid request"),
      "401": errorResponse("Authentication required"),
      "403": errorResponse("Forbidden — returns the required role and the access request path"),
      "409": errorResponse("resourceVersion conflict or idempotency key reuse"),
      // Only where a body is sent: the server refuses an oversized body before the route runs,
      // so the caller has to send less. Distinct from 422 UPLOAD_TOO_LARGE, which is the upload
      // cap judged by the route after the body arrived.
      ...(route.requestSchema !== undefined
        ? { "413": errorResponse("Request body larger than the server accepts") }
        : {}),
      "422": errorResponse("Domain rule violation (e.g. GATE_GAP_BLOCKS_GO)"),
      "503": errorResponse("External source, chain, or ERSP unavailable — check retryable"),
    },
  };

  if (route.action !== null) {
    operation["x-mpc-action"] = route.action;
  }
  if (!route.public) {
    operation["security"] = [{ siweSession: [] }];
  }

  if (route.requestSchema !== undefined) {
    operation["requestBody"] = {
      required: true,
      content: {
        "application/json": {
          schema: schemaFor(route.requestSchema, `${route.operationId}Request`, "input"),
        },
      },
    };
  }

  paths[route.path] ??= {};
  paths[route.path]![route.method] = operation;
}

function errorResponse(description: string) {
  return {
    description,
    content: {
      "application/json": {
        schema: schemaFor(errorEnvelope, "ErrorEnvelope"),
      },
    },
  };
}

const document = {
  openapi: "3.1.0",
  info: {
    title: "MPC dApp API",
    version: "1.0.0",
    description:
      "Mining Compliance Evidence & Registry Infrastructure API.\n\n" +
      "This API does not determine legal effect, investment suitability, or the accuracy of professional opinions. " +
      "`legalEffect` returns only `none` or `counsel_required`.",
  },
  servers: [{ url: "/", description: "same-origin" }],
  tags: [
    { name: "public", description: "Unauthenticated public read. Uses a separate rate limit and projection." },
    { name: "workspace", description: "Authenticated workspace. The server makes the final authorization decision." },
  ],
  components: {
    securitySchemes: {
      siweSession: {
        type: "http",
        scheme: "bearer",
        description:
          "Session token issued by SIWE (EIP-4361) login. A wallet signature alone grants only " +
          "public read and governance participation (OD-04).",
      },
    },
  },
  paths,
};

const outPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "openapi.json",
);

writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
process.stdout.write(`OpenAPI written to ${outPath} (${ROUTES.length} routes)\n`);
