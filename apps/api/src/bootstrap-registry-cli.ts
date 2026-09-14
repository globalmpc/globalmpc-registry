import { readFileSync } from "node:fs";
import postgres from "postgres";
import { resolveSecret } from "@mpc/config";
import {
  bootstrapAttestationSchema,
  bootstrapCredential,
  bootstrapPolicySet,
  BootstrapRegistryError,
} from "./bootstrap-registry.js";

/**
 * 검토를 시작하는 데 필요한 세 가지를 넣는 실행기.
 *
 *   pnpm --filter @mpc/api bootstrap:registry credential
 *   pnpm --filter @mpc/api bootstrap:registry schema
 *   pnpm --filter @mpc/api bootstrap:registry policy-set
 *
 * `bootstrap`과 같은 연결(RLS 우회)로 붙는다. 아무것도 지우지 않으므로 같은 값으로
 * 다시 돌려도 안전하다.
 */

const KINDS = ["credential", "schema", "policy-set"] as const;
type Kind = (typeof KINDS)[number];

const kind = process.argv[2] as Kind | undefined;

function fail(lines: readonly string[]): never {
  process.stderr.write(`${lines.join("\n")}\n`);
  process.exit(1);
}

if (!kind || !KINDS.includes(kind)) {
  fail([
    `무엇을 넣을지 골라야 한다 — ${KINDS.join(" | ")}`,
    "",
    "  credential   검토자의 자격. 이것 없이는 검토 배정이 만들어지지 않는다",
    "  schema       검토 규격. draft로는 서명할 수 없다",
    "  policy-set   준비도 규칙. draft로는 평가가 돌지 않는다",
  ]);
}

function required(name: string): string {
  const value = process.env[name] ?? "";
  if (value === "") fail([`환경변수가 없다 — ${name}`]);
  return value;
}

function list(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * 승인자.
 *
 * 비우면 `draft`로 들어간다. **그 상태가 기본값인 것이 의도다** — 승인 경로가
 * 아직 앱에 없으므로(02 §2.8), 승인됐다고 말한 사람의 이름을 받아야만 활성으로
 * 올라간다. 그 이름은 앱이 확인한 사실이 아니라 진술이며 감사에 그렇게 남는다.
 */
function approvedBy(): string | null {
  const value = (process.env["BOOTSTRAP_APPROVED_BY"] ?? "").trim();
  return value === "" ? null : value;
}

const databaseUrl = resolveSecret(
  "DATABASE_URL",
  required("DATABASE_URL"),
  undefined,
  process.env,
);

const tenantSlug = required("BOOTSTRAP_TENANT_SLUG");
const sql = postgres(databaseUrl, { onnotice: () => {} });

try {
  let result;

  if (kind === "credential") {
    result = await bootstrapCredential(sql, {
      tenantSlug,
      walletAddress: required("CREDENTIAL_WALLET"),
      issuerReference: required("CREDENTIAL_ISSUER_REFERENCE"),
      credentialType: required("CREDENTIAL_TYPE"),
      credentialScope: list("CREDENTIAL_SCOPE"),
      jurisdiction: list("CREDENTIAL_JURISDICTION"),
      issuedAt: required("CREDENTIAL_ISSUED_AT"),
      expiresAt: process.env["CREDENTIAL_EXPIRES_AT"] || null,
    });
  } else if (kind === "schema") {
    result = await bootstrapAttestationSchema(sql, {
      tenantSlug,
      schemaKey: required("SCHEMA_KEY"),
      schemaVersion: required("SCHEMA_VERSION"),
      attestationType: required("SCHEMA_ATTESTATION_TYPE"),
      requiredEvidence: list("SCHEMA_REQUIRED_EVIDENCE"),
      acceptedAuthorityTypes: list("SCHEMA_ACCEPTED_AUTHORITY_TYPES"),
      mandatoryLimitations: list("SCHEMA_MANDATORY_LIMITATIONS"),
      jurisdictionProfile: process.env["SCHEMA_JURISDICTION_PROFILE"] ?? "MNG",
      approvedBy: approvedBy(),
    });
  } else {
    // 규칙은 파일 또는 환경변수로 받는다.
    //
    // **파일만 받으면 컨테이너에서 쓸 수 없다.** 배포는 저장소를 마운트하지 않으므로
    // 그 안에 rule set 파일이 없다. 그래서 `POLICY_SET_JSON`을 함께 받는다 —
    // Coolify 같은 환경에서 넣을 수 있는 것은 환경변수뿐이다.
    const path = process.env["POLICY_SET_FILE"] ?? "";
    const inline = process.env["POLICY_SET_JSON"] ?? "";
    if (path === "" && inline === "") {
      fail(["POLICY_SET_FILE 또는 POLICY_SET_JSON이 필요하다 — rule set을 어디서 읽을지"]);
    }

    const source = path === "" ? "POLICY_SET_JSON" : path;
    let definition: unknown;
    try {
      definition = JSON.parse(path === "" ? inline : readFileSync(path, "utf8"));
    } catch (error) {
      fail([`rule set을 읽지 못했다 — ${source}`, String(error)]);
    }
    result = await bootstrapPolicySet(sql, {
      tenantSlug,
      definition,
      approvedBy: approvedBy(),
    });
  }

  process.stdout.write(
    `${JSON.stringify({
      msg: result.created ? `bootstrap.${kind}.created` : `bootstrap.${kind}.exists`,
      id: result.id,
      state: result.state,
    })}\n`,
  );
} catch (error) {
  const message = error instanceof BootstrapRegistryError ? error.message : String(error);
  process.stderr.write(`bootstrap ${kind} 실패 — ${message}\n`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
