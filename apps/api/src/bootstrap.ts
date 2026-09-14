import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { ROLE_MINIMUM_ASSURANCE, satisfiesAssurance } from "@mpc/api-contract";
import type { AssuranceLevel } from "@mpc/api-contract";

/**
 * 운영 bootstrap — 배포된 시스템에 첫 사람을 넣는다.
 *
 * migration은 스키마만 만든다. 그 위에 tenant·조직·주체·지갑·역할이 없으면 SIWE
 * 로그인은 되지만 어떤 역할도 없다. 화면은 뜨는데 할 수 있는 일이 없는 상태다.
 *
 * `apps/web/e2e/seed.ts`로 이 자리를 대신할 수 없다. 그것은 스키마를 드롭하고
 * 다시 만들며, 심는 계정의 개인키가 저장소에 그대로 있다 — 배포 주소에 그것을
 * 심으면 키를 아는 누구나 운영자로 로그인한다.
 *
 * 이 함수는 **아무것도 지우지 않는다.** 같은 입력을 다시 돌리면 이미 있는 것을
 * 그대로 두고 없는 것만 채운다. 배포 파이프라인이 매번 호출해도 안전해야 한다.
 *
 * RLS를 우회하는 연결(superuser)로 부른다. 여기서 만드는 것이 tenant 자신이므로
 * tenant 컨텍스트를 먼저 세울 수 없다.
 */

export class BootstrapError extends Error {
  readonly code = "BOOTSTRAP_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "BootstrapError";
  }
}

export interface BootstrapInput {
  /** tenant 식별자. 이미 있으면 그것을 쓴다. */
  readonly tenantSlug: string;
  readonly tenantName: string;
  /** 조직 법인명. 같은 tenant에 같은 이름이 있으면 그것을 쓴다. */
  readonly organizationName: string;
  /** ISO3 관할 코드. */
  readonly jurisdiction: string;
  readonly subjectName: string;
  readonly walletAddress: string;
  /** 56(BSC mainnet) 또는 97(BSC testnet). */
  readonly chainId: number;
  readonly role: string;
  readonly assuranceLevel: AssuranceLevel;
}

export interface BootstrapResult {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly subjectId: string;
  /** 이번 호출이 지갑·주체를 새로 만들었는가. 이미 있었으면 false다. */
  readonly created: boolean;
  /** 이번 호출이 역할 배정을 새로 만들었는가. */
  readonly roleGranted: boolean;
}

const ASSURANCE_LEVELS: readonly AssuranceLevel[] = [
  "wallet_only",
  "identity_bound",
  "high_assurance",
];

const WALLET_PATTERN = /^0x[0-9a-f]{40}$/;

/**
 * 입력을 먼저 전부 검증한다.
 *
 * DB에 절반만 들어간 뒤 실패하면 다음 실행이 무엇을 고쳐야 하는지 알 수 없다.
 * 특히 assurance는 DB가 막지 않는다 — 낮게 넣어도 행은 들어가고, 요청마다 403이
 * 나며, 화면에는 이유가 안 보인다. 그래서 여기서 막는다.
 */
function validate(input: BootstrapInput): { walletAddress: string } {
  if (input.tenantSlug.trim() === "") {
    throw new BootstrapError("tenantSlug가 비어 있다");
  }
  if (input.tenantName.trim() === "" || input.organizationName.trim() === "") {
    throw new BootstrapError("tenantName과 organizationName이 필요하다");
  }
  if (input.subjectName.trim() === "") {
    throw new BootstrapError("subjectName이 필요하다");
  }
  if (!/^[A-Z]{3}$/.test(input.jurisdiction)) {
    throw new BootstrapError(`jurisdiction은 ISO3 대문자 3글자여야 한다 — ${input.jurisdiction}`);
  }

  const walletAddress = input.walletAddress.toLowerCase();
  if (!WALLET_PATTERN.test(walletAddress)) {
    throw new BootstrapError(`walletAddress 형식이 올바르지 않다 — ${input.walletAddress}`);
  }

  // API가 56·97만 받는다. 다른 체인으로 바인딩하면 그 지갑으로는 로그인할 수 없다.
  if (input.chainId !== 56 && input.chainId !== 97) {
    throw new BootstrapError("chainId는 56(BSC mainnet) 또는 97(BSC testnet)이어야 한다");
  }

  const required = ROLE_MINIMUM_ASSURANCE[input.role];
  if (required === undefined) {
    const known = Object.keys(ROLE_MINIMUM_ASSURANCE).sort().join(", ");
    throw new BootstrapError(`모르는 역할이다 — ${input.role}. 가능한 값: ${known}`);
  }

  if (!ASSURANCE_LEVELS.includes(input.assuranceLevel)) {
    throw new BootstrapError(`모르는 assuranceLevel이다 — ${input.assuranceLevel}`);
  }

  if (!satisfiesAssurance(input.assuranceLevel, required)) {
    throw new BootstrapError(
      `${input.role}은 최소 ${required}를 요구한다 — 주어진 값은 ${input.assuranceLevel}이다`,
    );
  }

  return { walletAddress };
}

export async function bootstrapOperator(
  sql: postgres.Sql,
  input: BootstrapInput,
): Promise<BootstrapResult> {
  const { walletAddress } = validate(input);

  return sql.begin(async (tx) => {
    // 지갑을 먼저 본다. 다른 tenant에 이미 묶여 있으면 tenant를 만들기 전에
    // 멈춰야 한다 — 만들고 나서 거절하면 쓰이지 않는 tenant가 남는다.
    const existingWallet = await tx<
      { tenant_id: string; subject_id: string | null; disabled_at: Date | null }[]
    >`
      SELECT tenant_id, subject_id, disabled_at
      FROM core.wallet_identities
      WHERE wallet_address = ${walletAddress} AND chain_id = ${input.chainId}
    `;

    const tenantId = await upsertTenant(tx, input);

    const wallet = existingWallet[0];
    if (wallet && wallet.tenant_id !== tenantId) {
      throw new BootstrapError(
        `이 지갑은 이미 다른 tenant(${wallet.tenant_id})에 묶여 있다. 한 키가 두 tenant의 권한을 갖게 할 수 없다`,
      );
    }
    if (wallet && wallet.disabled_at !== null) {
      throw new BootstrapError(
        "이 지갑은 비활성 상태다. 키 교체는 bootstrap이 아니라 복구 절차로 처리한다(AC-27)",
      );
    }

    const organizationId = await upsertOrganization(tx, tenantId, input);

    let subjectId = wallet?.subject_id ?? null;
    const created = subjectId === null;

    if (subjectId === null) {
      subjectId = randomUUID();
      await tx`
        INSERT INTO core.subjects (id, tenant_id, kind, display_name)
        VALUES (${subjectId}, ${tenantId}, 'person', ${input.subjectName})
      `;
      await tx`
        INSERT INTO core.wallet_identities (
          id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at
        ) VALUES (
          ${randomUUID()}, ${tenantId}, ${subjectId}, ${walletAddress},
          ${input.chainId}, ${input.assuranceLevel}, now()
        )
      `;
    }

    const roleGranted = await grantRole(tx, {
      tenantId,
      subjectId,
      organizationId,
      role: input.role,
    });

    return { tenantId, organizationId, subjectId, created, roleGranted };
  });
}

async function upsertTenant(tx: postgres.TransactionSql, input: BootstrapInput): Promise<string> {
  const existing = await tx<{ id: string }[]>`
    SELECT id FROM core.tenants WHERE slug = ${input.tenantSlug}
  `;
  if (existing[0]) return existing[0].id;

  const id = randomUUID();
  await tx`
    INSERT INTO core.tenants (id, slug, display_name)
    VALUES (${id}, ${input.tenantSlug}, ${input.tenantName})
  `;
  return id;
}

async function upsertOrganization(
  tx: postgres.TransactionSql,
  tenantId: string,
  input: BootstrapInput,
): Promise<string> {
  const existing = await tx<{ id: string }[]>`
    SELECT id FROM core.organizations
    WHERE tenant_id = ${tenantId} AND legal_name = ${input.organizationName}
  `;
  if (existing[0]) return existing[0].id;

  const id = randomUUID();
  await tx`
    INSERT INTO core.organizations (id, tenant_id, legal_name, jurisdiction)
    VALUES (${id}, ${tenantId}, ${input.organizationName}, ${input.jurisdiction})
  `;
  return id;
}

async function grantRole(
  tx: postgres.TransactionSql,
  args: { tenantId: string; subjectId: string; organizationId: string; role: string },
): Promise<boolean> {
  const existing = await tx<{ id: string }[]>`
    SELECT id FROM core.role_bindings
    WHERE tenant_id = ${args.tenantId}
      AND subject_id = ${args.subjectId}
      AND organization_id = ${args.organizationId}
      AND role = ${args.role}
      AND revoked_at IS NULL
  `;
  if (existing[0]) return false;

  await tx`
    INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
    VALUES (${randomUUID()}, ${args.tenantId}, ${args.subjectId}, ${args.organizationId}, ${args.role})
  `;
  return true;
}
