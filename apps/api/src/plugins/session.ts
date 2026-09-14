import { randomBytes } from "node:crypto";
import type postgres from "postgres";
import { recoverMessageAddress } from "viem";
import { parseSiweMessage } from "viem/siwe";
import { TENANT_WIDE_ROLES, type AssuranceLevel } from "@mpc/api-contract";
import { withTenant } from "@mpc/db";
import type { AppConfig } from "../config.js";
import { unauthorized } from "../errors.js";

export interface Session {
  readonly walletAddress: `0x${string}`;
  readonly chainId: number;
  readonly subjectId: string | null;
  readonly tenantId: string | null;
  readonly assuranceLevel: AssuranceLevel;
  readonly roleBindings: readonly {
    readonly role: string;
    readonly organizationId: string | null;
    readonly projectId: string | null;
  }[];
  readonly projectIds: readonly string[];
  /**
   * 조직 ID → 그 조직이 소유한 프로젝트 ID.
   *
   * 프로젝트 당사자 역할의 조직 수준 바인딩이 어디까지 닿는지를 정한다. 없으면
   * 아무 프로젝트에도 닿지 않는 것으로 본다(넓히지 않고 좁힌다).
   */
  readonly organizationProjectIds?: Readonly<Record<string, readonly string[]>>;
}

const NONCE_TTL_MS = 10 * 60 * 1000;

export const SIWE_STATEMENT =
  "MPC Registry에 로그인합니다. 이 서명은 자산 이동이나 승인을 발생시키지 않습니다.";

export async function issueNonce(
  sql: postgres.Sql,
  walletAddress: string,
  chainId: number,
): Promise<{ nonce: string; expiresAt: string }> {
  // SIWE nonce는 알파뉴메릭 8자 이상이어야 한다(EIP-4361).
  const nonce = randomBytes(12).toString("hex");
  const expiresAt = new Date(Date.now() + NONCE_TTL_MS).toISOString();

  await sql`
    INSERT INTO core.siwe_nonces (nonce, wallet_address, chain_id, expires_at)
    VALUES (${nonce}, ${walletAddress.toLowerCase()}, ${chainId}, ${expiresAt})
  `;

  return { nonce, expiresAt };
}

/**
 * SIWE 검증 — ADR-T06.
 *
 * 확인하는 것: 서명 유효성, domain 일치, chainId 일치, nonce 미사용, 만료.
 * 확인하지 않는 것: 이 주소가 누구인가. identity binding은 별도 record다(02 §2.9).
 *
 * EOA 서명만 지원한다. `recoverMessageAddress`는 RPC 없이 로컬에서 주소를
 * 복구하므로 로그인 경로가 외부 노드 가용성에 묶이지 않는다. 스마트 컨트랙트
 * 지갑(EIP-1271)은 RPC가 필요하므로 별도 결정으로 미룬다.
 */
export async function verifySiwe(
  sql: postgres.Sql,
  config: AppConfig,
  message: string,
  signature: `0x${string}`,
): Promise<Session> {
  const parsed = parseSiweMessage(message);
  if (!parsed.address || !parsed.nonce) {
    throw unauthorized("SIWE_MESSAGE_INVALID", "SIWE 메시지를 해석할 수 없다");
  }

  if (parsed.domain !== config.siweDomain) {
    throw unauthorized("SIWE_DOMAIN_MISMATCH", "메시지의 domain이 이 서비스와 다르다");
  }
  if (parsed.chainId !== config.chainId) {
    throw unauthorized("SIWE_CHAIN_MISMATCH", "메시지의 chain ID가 이 서비스와 다르다");
  }
  if (parsed.expirationTime && parsed.expirationTime.getTime() < Date.now()) {
    throw unauthorized("SIWE_MESSAGE_EXPIRED", "메시지가 만료됐다");
  }
  /**
   * `notBefore`는 서명자가 "이 시점 전에는 쓰지 말라"고 밝힌 것이다.
   *
   * 보지 않으면 그 선언이 아무 효과가 없고, 미리 서명해 둔 메시지를 서명자가
   * 의도한 시점 밖에서 쓸 수 있다. EIP-4361이 이 필드를 정의한 이유다.
   */
  if (parsed.notBefore && parsed.notBefore.getTime() > Date.now()) {
    throw unauthorized("SIWE_MESSAGE_NOT_YET_VALID", "아직 사용할 수 없는 메시지다");
  }
  /**
   * `uri`도 대조한다 — 07 §7.1.
   *
   * domain만 보면 같은 호스트의 다른 출처로 유도된 서명이 통과한다. 지갑이
   * 사용자에게 보여 준 대상과 서버가 인정하는 대상이 같아야 한다.
   */
  if (parsed.uri !== config.siweUri) {
    throw unauthorized("SIWE_URI_MISMATCH", "메시지의 uri가 이 서비스와 다르다");
  }

  const address = parsed.address.toLowerCase() as `0x${string}`;

  // nonce를 원자적으로 소비한다. 두 요청이 동시에 와도 하나만 성공한다.
  const [consumed] = await sql<{ nonce: string }[]>`
    UPDATE core.siwe_nonces
    SET consumed_at = now()
    WHERE nonce = ${parsed.nonce}
      AND consumed_at IS NULL
      AND expires_at > now()
      AND wallet_address = ${address}
    RETURNING nonce
  `;

  if (!consumed) {
    throw unauthorized("SIWE_NONCE_ALREADY_USED", "이 nonce는 이미 사용됐거나 만료됐다");
  }

  let recovered: string;
  try {
    recovered = (await recoverMessageAddress({ message, signature })).toLowerCase();
  } catch {
    throw unauthorized("SIWE_SIGNATURE_INVALID", "서명을 검증할 수 없다");
  }

  if (recovered !== address) {
    throw unauthorized("SIWE_SIGNATURE_INVALID", "서명자가 메시지의 주소와 다르다");
  }

  return resolveSession(sql, address, config.chainId);
}

/**
 * wallet → identity·role 해석.
 *
 * 02 §2.9: wallet은 인증 수단이고 identity binding·credential·role binding·
 * assignment는 각각 별도 record다. 연결이 없으면 `wallet_only`이며 이 상태로는
 * public read와 governance 참여만 가능하다(OD-04).
 */
export async function resolveSession(
  sql: postgres.Sql,
  walletAddress: `0x${string}`,
  chainId: number,
): Promise<Session> {
  // 로그인 시점에는 아직 tenant를 모르므로 RLS 정책을 만족시킬 수 없다.
  // 인증 경로만 SECURITY DEFINER 함수로 분리한다(0005_session_resolver.sql).
  // 이 두 함수 외에는 어떤 경로로도 RLS를 우회하지 않는다.
  const [identity] = await sql<
    { subject_id: string | null; tenant_id: string; assurance_level: AssuranceLevel }[]
  >`
    SELECT * FROM core.resolve_wallet_session(${walletAddress}, ${chainId})
  `;

  if (!identity || identity.subject_id === null) {
    return {
      walletAddress,
      chainId,
      subjectId: null,
      tenantId: identity?.tenant_id ?? null,
      assuranceLevel: "wallet_only",
      roleBindings: [],
      projectIds: [],
    };
  }

  const bindings = await sql<
    { role: string; organization_id: string | null; project_id: string | null }[]
  >`
    SELECT * FROM core.resolve_role_bindings(${identity.subject_id})
  `;

  return {
    walletAddress,
    chainId,
    subjectId: identity.subject_id,
    tenantId: identity.tenant_id,
    assuranceLevel: identity.assurance_level,
    roleBindings: bindings.map((row) => ({
      role: row.role,
      organizationId: row.organization_id,
      projectId: row.project_id,
    })),
    projectIds: bindings
      .map((row) => row.project_id)
      .filter((value): value is string => value !== null),
    organizationProjectIds: await resolveOrganizationProjects(sql, identity.tenant_id, bindings),
  };
}

/**
 * 소유 조직으로 좁혀지는 조직 수준 바인딩의 프로젝트 목록.
 *
 * 세션은 요청마다 다시 해석되므로(server.ts) 조직이 새 프로젝트를 만들면 다음
 * 요청부터 닿는다. tenant가 정해진 뒤이므로 RLS 경로(`withTenant`)로 읽는다.
 */
async function resolveOrganizationProjects(
  sql: postgres.Sql,
  tenantId: string,
  bindings: readonly { role: string; organization_id: string | null; project_id: string | null }[],
): Promise<Readonly<Record<string, readonly string[]>>> {
  const organizations = [
    ...new Set(
      bindings
        .filter(
          (row) =>
            row.project_id === null &&
            row.organization_id !== null &&
            !TENANT_WIDE_ROLES.includes(row.role),
        )
        .map((row) => row.organization_id as string),
    ),
  ];
  if (organizations.length === 0) return {};

  const rows = await withTenant(sql, { tenantId }, (tx) =>
    tx<{ id: string; owner_organization_id: string }[]>`
      SELECT id, owner_organization_id
      FROM core.projects
      WHERE owner_organization_id = ANY(${organizations}::uuid[])
    `,
  );

  return organizations.reduce<Record<string, readonly string[]>>(
    (acc, organizationId) => ({
      ...acc,
      [organizationId]: rows
        .filter((row) => row.owner_organization_id === organizationId)
        .map((row) => row.id),
    }),
    {},
  );
}
