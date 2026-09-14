import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { errorEnvelope } from "./common.js";
import { ROUTES } from "./routes.js";

/**
 * OpenAPI 3.1 생성.
 *
 * ADR-T05: Zod로 한 번 정의하고 문서를 생성한다. 런타임 검증과 문서가 같은
 * 정의에서 나오므로 둘이 갈라질 수 없다. 손으로 쓴 OpenAPI는 반드시 갈라진다.
 *
 * CI는 이 스크립트의 출력과 커밋된 `openapi.json`을 비교해 드리프트를 실패로
 * 처리한다(`pnpm check:openapi`).
 */

function schemaFor(schema: Parameters<typeof zodToJsonSchema>[0], name: string): unknown {
  // OpenAPI 3.1은 JSON Schema 2020-12를 쓴다. zod-to-json-schema가 지원하는
  // 가장 가까운 타깃이 2019-09이며, 여기서 쓰는 스키마 구성에서는 두 드래프트가
  // 동일하게 해석된다.
  return zodToJsonSchema(schema, {
    name,
    target: "jsonSchema2019-09",
    $refStrategy: "none",
  });
}

function pathParameters(routePath: string): unknown[] {
  const matches = routePath.match(/\{([^}]+)\}/g) ?? [];
  return matches.map((match) => ({
    name: match.slice(1, -1),
    in: "path",
    required: true,
    schema: { type: "string" },
  }));
}

const paths: Record<string, Record<string, unknown>> = {};

for (const route of ROUTES) {
  const parameters: unknown[] = [...pathParameters(route.path)];

  if (route.mutation) {
    parameters.push({
      name: "Idempotency-Key",
      in: "header",
      required: true,
      schema: { type: "string", minLength: 16 },
      description: "mutation 재시도 시 중복 실행을 막는다 (07 §7.1)",
    });
  }

  // query string 계약을 OpenAPI parameter로 편다. 여기 없는 파라미터를 보내면
  // 서버가 거절하므로, 목록에 없다는 것이 곧 "보낼 수 없다"는 뜻이다.
  if (route.querySchema !== undefined) {
    // `name`을 주면 zod-to-json-schema가 `definitions` 아래로 감싼다. parameter는
    // 그 안쪽 object가 필요하므로 한 겹 벗긴다.
    const wrapper = schemaFor(route.querySchema, `${route.operationId}Query`) as {
      readonly definitions?: Record<string, unknown>;
    };
    const jsonSchema = (wrapper.definitions?.[`${route.operationId}Query`] ?? {}) as {
      readonly properties?: Record<string, unknown>;
      readonly required?: readonly string[];
    };
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
      description: 'versioned resource의 기대 version. `"3"` 형식 (07 §7.1)',
    });
  }

  const operation: Record<string, unknown> = {
    operationId: route.operationId,
    summary: route.summary,
    tags: [route.public ? "public" : "workspace"],
    parameters,
    responses: {
      "200": {
        description: "성공",
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
      "400": errorResponse("요청이 유효하지 않다"),
      "401": errorResponse("인증이 필요하다"),
      "403": errorResponse("권한이 없다 — 필요한 role과 access request 경로를 반환한다"),
      "409": errorResponse("resourceVersion 충돌 또는 idempotency key 재사용"),
      "422": errorResponse("도메인 규칙 위반 (예: GATE_GAP_BLOCKS_GO)"),
      "503": errorResponse("외부 source·chain·ERSP 사용 불가 — retryable을 확인한다"),
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
          schema: schemaFor(route.requestSchema, `${route.operationId}Request`),
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
      "이 API는 법률 효력·투자 적합성·전문 의견의 정확성을 판정하지 않는다. " +
      "`legalEffect`는 `none` 또는 `counsel_required`만 반환한다.",
  },
  servers: [{ url: "/", description: "same-origin" }],
  tags: [
    { name: "public", description: "무인증 공개 조회. 별도 rate limit과 projection을 쓴다." },
    { name: "workspace", description: "인증된 워크스페이스. 서버가 최종 권한을 판정한다." },
  ],
  components: {
    securitySchemes: {
      siweSession: {
        type: "http",
        scheme: "bearer",
        description:
          "SIWE(EIP-4361) 로그인으로 발급된 세션 토큰. wallet 서명만으로 부여되는 권한은 " +
          "public read와 governance 참여뿐이다(OD-04).",
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
process.stdout.write(`OpenAPI ${outPath}에 기록 (${ROUTES.length} routes)\n`);
