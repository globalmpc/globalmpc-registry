import postgres from "postgres";
import { resolveSecret } from "@mpc/config";
import { bootstrapOperator, BootstrapError } from "./bootstrap.js";
import type { BootstrapInput } from "./bootstrap.js";

/**
 * 운영 bootstrap 실행기.
 *
 * 배포 직후 한 번, 또는 사람을 추가할 때마다 부른다. 아무것도 지우지 않으므로
 * 같은 값으로 다시 돌려도 안전하다.
 *
 * **RLS를 우회하는 연결로 붙는다.** 여기서 만드는 것이 tenant 자신이라 tenant
 * 컨텍스트를 먼저 세울 수 없다. `mpc_app_login`이 아니라 migration을 돌린 것과
 * 같은 연결 문자열을 준다.
 */

const REQUIRED = [
  "DATABASE_URL",
  "BOOTSTRAP_TENANT_SLUG",
  "BOOTSTRAP_TENANT_NAME",
  "BOOTSTRAP_ORG_NAME",
  "BOOTSTRAP_SUBJECT_NAME",
  "BOOTSTRAP_WALLET",
] as const;

const missing = REQUIRED.filter((name) => (process.env[name] ?? "") === "");
if (missing.length > 0) {
  process.stderr.write(
    [
      `환경변수가 없다 — ${missing.join(", ")}`,
      "",
      "필수:",
      "  DATABASE_URL              migration을 돌린 것과 같은 연결(RLS 우회)",
      "  BOOTSTRAP_TENANT_SLUG     tenant 식별자. 이미 있으면 그것을 쓴다",
      "  BOOTSTRAP_TENANT_NAME     tenant 표시 이름",
      "  BOOTSTRAP_ORG_NAME        조직 법인명",
      "  BOOTSTRAP_SUBJECT_NAME    사람 표시 이름",
      "  BOOTSTRAP_WALLET          0x로 시작하는 40자리 주소",
      "",
      "선택:",
      "  BOOTSTRAP_JURISDICTION    ISO3 대문자 3글자 (기본 MNG)",
      "  BOOTSTRAP_CHAIN_ID        56 또는 97 (기본 97)",
      "  BOOTSTRAP_ROLE            역할 (기본 mpc_operator)",
      "  BOOTSTRAP_ASSURANCE       wallet_only·identity_bound·high_assurance",
      "                            (기본 high_assurance)",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

// DATABASE_URL은 `file:`·`env:` 참조로도 줄 수 있다. API·worker와 같은 경로를
// 지나야 "배포에서만 다르게 동작"하는 구간이 생기지 않는다.
const databaseUrl = resolveSecret(
  "DATABASE_URL",
  process.env["DATABASE_URL"] as string,
  undefined,
  process.env,
);

const input: BootstrapInput = {
  tenantSlug: process.env["BOOTSTRAP_TENANT_SLUG"] as string,
  tenantName: process.env["BOOTSTRAP_TENANT_NAME"] as string,
  organizationName: process.env["BOOTSTRAP_ORG_NAME"] as string,
  jurisdiction: process.env["BOOTSTRAP_JURISDICTION"] ?? "MNG",
  subjectName: process.env["BOOTSTRAP_SUBJECT_NAME"] as string,
  walletAddress: process.env["BOOTSTRAP_WALLET"] as string,
  chainId: Number(process.env["BOOTSTRAP_CHAIN_ID"] ?? "97"),
  role: process.env["BOOTSTRAP_ROLE"] ?? "mpc_operator",
  assuranceLevel: (process.env["BOOTSTRAP_ASSURANCE"] ??
    "high_assurance") as BootstrapInput["assuranceLevel"],
};

const sql = postgres(databaseUrl, { onnotice: () => {} });

try {
  const result = await bootstrapOperator(sql, input);
  // 지갑 주소는 공개 정보다. 그 외에 비밀이 되는 값은 여기에 없다.
  process.stdout.write(
    `${JSON.stringify({
      msg: result.created ? "bootstrap.created" : "bootstrap.exists",
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      subjectId: result.subjectId,
      wallet: input.walletAddress.toLowerCase(),
      role: input.role,
      roleGranted: result.roleGranted,
    })}\n`,
  );
} catch (error) {
  // 무엇이 잘못됐는지 사람이 읽을 수 있게 남긴다. 스택은 원인을 가린다.
  const message = error instanceof BootstrapError ? error.message : String(error);
  process.stderr.write(`bootstrap 실패 — ${message}\n`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
