import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { parseRuleSet } from "@mpc/policy";
import { ROLE_DEPLOY_BOUND } from "./audit.js";

/**
 * 검토를 시작하는 데 필요한 세 가지를 배포된 시스템에 넣는다.
 *
 * `bootstrap.ts`가 사람을 넣으면 로그인과 프로젝트 등록까지 간다. 거기서 멈춘다 —
 * 검토 배정은 검토자의 **credential**과 **attestation schema**를 요구하고, 준비도
 * 평가는 **policy rule set**을 요구한다. 셋을 만드는 경로가 E2E seed에만 있었고,
 * 그 seed는 스키마를 드롭하므로 배포에서 쓸 수 없다.
 *
 * **이것은 API가 아니다.** 02 §2.8은 credential 확인·schema/policy 승인을 각각
 * 별도 역할의 일로 정의하고, 그 화면과 route는 아직 없다. 여기 있는 것은 운영자가
 * 배포 환경에서 직접 넣는 경로이며, **누가 승인했다고 말했는지를 감사에 남기는
 * 것**으로 그 부재를 가리지 않는다.
 *
 * 규칙 셋:
 *
 * - 아무것도 지우거나 덮어쓰지 않는다. 이미 있으면 그대로 두고 `created: false`다.
 * - 승인자를 대지 않으면 `draft`로 들어간다. draft schema로는 서명할 수 없고,
 *   draft policy set으로는 평가가 돌지 않는다 — 그것이 "아직 승인되지 않았다"의
 *   정확한 표시다.
 * - 만료된 자격을 `valid`로 넣지 않는다. 넣으면 서명 시점 검사가 통과하고
 *   attestation에 거짓 상태가 박힌다.
 *
 * RLS를 우회하는 연결(superuser)로 부른다.
 */

export class BootstrapRegistryError extends Error {
  readonly code = "BOOTSTRAP_REGISTRY_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "BootstrapRegistryError";
  }
}

interface AuditInput {
  readonly tenantId: string;
  readonly command: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly reason: string | null;
  readonly detail: Record<string, unknown>;
}

/**
 * 사람의 세션이 없는 mutation의 감사 기록.
 *
 * `actor_subject_id`·`actor_wallet`을 비운다. 이 경로를 실행한 것은 배포 환경에
 * 접근할 수 있는 운영자이고, 그 사람을 앱이 식별하지 않는다 — 없는 신원을
 * 지어내지 않고 없다고 적는다. `command` 접두사 `bootstrap.`이 그 사실을 표시한다.
 *
 * `effective_role`도 같은 이유로 `mpc_operator`가 아니다. 어떤 권한 판정도
 * 지나지 않았으므로 그 자리에 역할 이름을 적으면 기록이 거짓말을 한다.
 */
async function recordBootstrapAudit(
  tx: postgres.TransactionSql,
  entry: AuditInput,
): Promise<void> {
  await tx`
    INSERT INTO audit.events (
      tenant_id, actor_subject_id, actor_wallet, effective_role,
      command, resource_type, resource_id, reason, correlation_id, detail
    ) VALUES (
      ${entry.tenantId}, NULL, NULL, ${ROLE_DEPLOY_BOUND},
      ${entry.command}, ${entry.resourceType}, ${entry.resourceId},
      ${entry.reason}, ${randomUUID()}, ${tx.json(entry.detail as never)}
    )
  `;
}

async function requireTenant(tx: postgres.TransactionSql, slug: string): Promise<string> {
  const [tenant] = await tx<{ id: string }[]>`
    SELECT id FROM core.tenants WHERE slug = ${slug}
  `;
  if (!tenant) {
    throw new BootstrapRegistryError(
      `tenant를 찾을 수 없다 — ${slug}. 사람을 먼저 넣는다(\`pnpm --filter @mpc/api bootstrap\`)`,
    );
  }
  return tenant.id;
}

// --- credential -------------------------------------------------------------

export interface CredentialInput {
  readonly tenantSlug: string;
  /** 자격을 가진 사람의 지갑. `bootstrap`으로 이미 들어와 있어야 한다. */
  readonly walletAddress: string;
  /** 발급 기관과 자격 번호. 사람이 대조할 수 있는 문자열이어야 한다. */
  readonly issuerReference: string;
  /** `competent_person`·`laboratory`·`legal_practitioner` 등. */
  readonly credentialType: string;
  /** 이 자격이 덮는 claim type. 비면 서명이 막힌다. */
  readonly credentialScope: readonly string[];
  readonly jurisdiction: readonly string[];
  readonly issuedAt: string;
  /** 없으면 만료 없는 자격이다. 있으면 미래여야 한다. */
  readonly expiresAt: string | null;
}

export interface BootstrapRegistryResult {
  readonly id: string;
  readonly created: boolean;
  readonly state: string;
}

export async function bootstrapCredential(
  sql: postgres.Sql,
  input: CredentialInput,
): Promise<BootstrapRegistryResult> {
  const wallet = input.walletAddress.toLowerCase();

  if (input.credentialScope.length === 0) {
    throw new BootstrapRegistryError(
      "credentialScope가 비어 있다. 범위 없는 자격으로는 서명이 거절된다(02 §2.5)",
    );
  }
  if (input.issuerReference.trim() === "" || input.credentialType.trim() === "") {
    throw new BootstrapRegistryError("issuerReference와 credentialType이 필요하다");
  }

  const issuedAt = new Date(input.issuedAt);
  if (Number.isNaN(issuedAt.getTime())) {
    throw new BootstrapRegistryError(`issuedAt을 읽을 수 없다 — ${input.issuedAt}`);
  }

  let expiresAt: Date | null = null;
  if (input.expiresAt !== null) {
    expiresAt = new Date(input.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) {
      throw new BootstrapRegistryError(`expiresAt을 읽을 수 없다 — ${input.expiresAt}`);
    }
    // 이미 지난 자격을 `valid`로 넣지 않는다. 서명 시점 검사가 통과해 버리고,
    // attestation의 credential 스냅숏에 거짓 상태가 남는다(AC-12·AC-17).
    if (expiresAt.getTime() <= Date.now()) {
      throw new BootstrapRegistryError(
        `expiresAt이 과거다 — ${input.expiresAt}. 만료된 자격은 valid로 등록하지 않는다`,
      );
    }
  }

  return sql.begin(async (tx) => {
    const tenantId = await requireTenant(tx, input.tenantSlug);

    // 소속 조직은 가장 먼저 만들어진 역할 바인딩에서 가져온다. 정렬 없이 LIMIT 1을
    // 쓰면 여러 조직에 바인딩된 사람에게서 매번 다른 조직이 나온다 — 자격이 어느
    // 조직 아래 있는지가 실행할 때마다 달라지면 독립성 판단의 근거가 흔들린다.
    const [identity] = await tx<{ subject_id: string | null; organization_id: string | null }[]>`
      SELECT w.subject_id, rb.organization_id
      FROM core.wallet_identities w
      LEFT JOIN core.role_bindings rb
        ON rb.subject_id = w.subject_id AND rb.revoked_at IS NULL
      WHERE w.wallet_address = ${wallet} AND w.tenant_id = ${tenantId}
        AND w.disabled_at IS NULL
      ORDER BY rb.granted_at NULLS LAST, rb.id
      LIMIT 1
    `;

    if (!identity?.subject_id) {
      throw new BootstrapRegistryError(
        `이 tenant에 ${wallet} 지갑이 없다. 사람을 먼저 넣는다`,
      );
    }

    const existing = await tx<{ id: string; current_status: string }[]>`
      SELECT id, current_status FROM core.credentials
      WHERE tenant_id = ${tenantId} AND subject_id = ${identity.subject_id}
        AND issuer_reference = ${input.issuerReference}
    `;
    const found = existing[0];
    if (found) return { id: found.id, created: false, state: found.current_status };

    const id = randomUUID();
    await tx`
      INSERT INTO core.credentials (
        id, tenant_id, subject_id, organization_id, issuer_reference,
        credential_type, credential_scope, jurisdiction, issued_at, expires_at,
        current_status
      ) VALUES (
        ${id}, ${tenantId}, ${identity.subject_id}, ${identity.organization_id},
        ${input.issuerReference}, ${input.credentialType},
        ${input.credentialScope as string[]}, ${input.jurisdiction as string[]},
        ${issuedAt}, ${expiresAt}, 'valid'
      )
    `;

    await recordBootstrapAudit(tx, {
      tenantId,
      command: "bootstrap.credential.created",
      resourceType: "credential",
      resourceId: id,
      reason: null,
      detail: {
        issuerReference: input.issuerReference,
        credentialType: input.credentialType,
        scope: input.credentialScope,
      },
    });

    return { id, created: true, state: "valid" };
  });
}

// --- attestation schema -----------------------------------------------------

export interface AttestationSchemaInput {
  readonly tenantSlug: string;
  readonly schemaKey: string;
  readonly schemaVersion: string;
  readonly attestationType: string;
  readonly requiredEvidence: readonly string[];
  readonly acceptedAuthorityTypes: readonly string[];
  /** 이 schema로 만든 attestation이 반드시 밝혀야 하는 한계. */
  readonly mandatoryLimitations: readonly string[];
  readonly jurisdictionProfile: string;
  /**
   * 승인했다고 말한 사람.
   *
   * 없으면 `draft`로 들어간다 — 그 상태로는 서명이 거절된다. 있으면 `active`가
   * 되고 그 이름이 감사에 남는다. 앱이 확인한 사실이 아니라 **운영자가 한 진술**이며,
   * 그렇게 기록된다(02 §2.8의 승인 경로가 생기기 전까지의 한계).
   */
  readonly approvedBy: string | null;
}

export async function bootstrapAttestationSchema(
  sql: postgres.Sql,
  input: AttestationSchemaInput,
): Promise<BootstrapRegistryResult> {
  if (input.mandatoryLimitations.length === 0) {
    throw new BootstrapRegistryError(
      "mandatoryLimitations가 비어 있다. 한계 없는 검토 규격은 만들지 않는다(AC-01)",
    );
  }

  const state = input.approvedBy === null ? "draft" : "active";

  return sql.begin(async (tx) => {
    const tenantId = await requireTenant(tx, input.tenantSlug);

    const existing = await tx<{ id: string; state: string }[]>`
      SELECT id, state FROM core.attestation_schemas
      WHERE tenant_id = ${tenantId} AND schema_key = ${input.schemaKey}
        AND schema_version = ${input.schemaVersion}
    `;
    const found = existing[0];
    if (found) {
      // 등록과 승인을 두 번에 나눠 할 수 있어야 한다(02 §2.8). draft로 넣어 둔 것을
      // 뒤에 승인하는 경로가 없으면 한 사람이 한 번에 다 하는 것 말고는 방법이 없다.
      if (found.state === "draft" && input.approvedBy !== null) {
        await tx`
          UPDATE core.attestation_schemas SET state = 'active' WHERE id = ${found.id}
        `;
        await recordBootstrapAudit(tx, {
          tenantId,
          command: "bootstrap.attestation_schema.approved",
          resourceType: "attestation_schema",
          resourceId: found.id,
          reason: input.approvedBy,
          detail: { schemaKey: input.schemaKey, approvalIsOperatorStatement: true },
        });
        return { id: found.id, created: false, state: "active" };
      }
      return { id: found.id, created: false, state: found.state };
    }

    const id = randomUUID();
    await tx`
      INSERT INTO core.attestation_schemas (
        id, tenant_id, schema_key, schema_version, attestation_type,
        required_evidence, accepted_authority_types, mandatory_limitations,
        jurisdiction_profile, state
      ) VALUES (
        ${id}, ${tenantId}, ${input.schemaKey}, ${input.schemaVersion},
        ${input.attestationType}::core.attestation_type,
        ${input.requiredEvidence as string[]}, ${input.acceptedAuthorityTypes as string[]},
        ${input.mandatoryLimitations as string[]}, ${input.jurisdictionProfile}, ${state}
      )
    `;

    await recordBootstrapAudit(tx, {
      tenantId,
      command: "bootstrap.attestation_schema.created",
      resourceType: "attestation_schema",
      resourceId: id,
      reason: input.approvedBy,
      detail: {
        schemaKey: input.schemaKey,
        schemaVersion: input.schemaVersion,
        state,
        approvalIsOperatorStatement: input.approvedBy !== null,
      },
    });

    return { id, created: true, state };
  });
}

// --- compliance policy set --------------------------------------------------

export interface PolicySetInput {
  readonly tenantSlug: string;
  /** `packages/policy`의 rule set. 여기서 파싱해 거절한다. */
  readonly definition: unknown;
  /** attestation schema와 같은 뜻이다. 없으면 `draft`. */
  readonly approvedBy: string | null;
}

export async function bootstrapPolicySet(
  sql: postgres.Sql,
  input: PolicySetInput,
): Promise<BootstrapRegistryResult> {
  // 규칙이 데이터라는 것은 그것이 검증된다는 뜻이다(OD-15). 파싱하지 않고 넣으면
  // 평가 시점에야 깨지고, 그때는 무엇이 잘못됐는지가 gate 화면의 오류로만 보인다.
  let ruleSet;
  try {
    ruleSet = parseRuleSet(input.definition);
  } catch (error) {
    throw new BootstrapRegistryError(
      `rule set이 schema를 통과하지 못했다 — ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const state = input.approvedBy === null ? "draft" : "effective";

  return sql.begin(async (tx) => {
    const tenantId = await requireTenant(tx, input.tenantSlug);

    const existing = await tx<{ id: string; state: string }[]>`
      SELECT id, state FROM core.compliance_policy_sets
      WHERE tenant_id = ${tenantId} AND rule_set_id = ${ruleSet.ruleSetId}
        AND rule_set_version = ${ruleSet.version}
    `;
    const found = existing[0];
    if (found) {
      // schema와 같다 — 넣는 것과 승인하는 것을 나눌 수 있어야 한다.
      if (found.state === "draft" && input.approvedBy !== null) {
        await tx`
          UPDATE core.compliance_policy_sets SET state = 'effective' WHERE id = ${found.id}
        `;
        await recordBootstrapAudit(tx, {
          tenantId,
          command: "bootstrap.policy_set.approved",
          resourceType: "compliance_policy_set",
          resourceId: found.id,
          reason: input.approvedBy,
          detail: { ruleSetId: ruleSet.ruleSetId, approvalIsOperatorStatement: true },
        });
        return { id: found.id, created: false, state: "effective" };
      }
      return { id: found.id, created: false, state: found.state };
    }

    const id = randomUUID();
    await tx`
      INSERT INTO core.compliance_policy_sets (
        id, tenant_id, rule_set_id, rule_set_version, gate_id,
        jurisdiction_profile, effective_from, retroactive, definition, state
      ) VALUES (
        ${id}, ${tenantId}, ${ruleSet.ruleSetId}, ${ruleSet.version}, ${ruleSet.gateId},
        ${ruleSet.jurisdictionProfile}, ${new Date(ruleSet.effectiveFrom)},
        ${ruleSet.retroactive}, ${tx.json(input.definition as never)}, ${state}
      )
    `;

    await recordBootstrapAudit(tx, {
      tenantId,
      command: "bootstrap.policy_set.created",
      resourceType: "compliance_policy_set",
      resourceId: id,
      reason: input.approvedBy,
      detail: {
        ruleSetId: ruleSet.ruleSetId,
        version: ruleSet.version,
        gateId: ruleSet.gateId,
        requirementCount: ruleSet.requirements.length,
        state,
        approvalIsOperatorStatement: input.approvedBy !== null,
      },
    });

    return { id, created: true, state };
  });
}
