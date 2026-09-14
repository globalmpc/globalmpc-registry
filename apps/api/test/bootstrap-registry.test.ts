import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { bootstrapOperator } from "../src/bootstrap.js";
import {
  bootstrapAttestationSchema,
  bootstrapCredential,
  bootstrapPolicySet,
  BootstrapRegistryError,
} from "../src/bootstrap-registry.js";
import { setupFixture, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * 검토를 시작하는 데 필요한 세 가지의 bootstrap.
 *
 * 사람만 넣으면 프로젝트 등록까지 가고 검토 구간에서 멈춘다 — 배정이 credential과
 * schema를, 준비도가 policy set을 요구하기 때문이다. 그 셋을 만드는 경로가 E2E
 * seed에만 있었다.
 *
 * 여기서 확인하는 것은 "행이 들어갔다"가 아니라 **거짓 상태로 들어가지 않는다**이다.
 * 만료된 자격이 valid로, 승인 없는 규격이 active로 들어가면 그 뒤의 검사가 전부
 * 통과해 버린다.
 */
describeDb("검토 registry bootstrap", () => {
  let fx: TestFixture;
  let tenantSlug: string;

  beforeAll(async () => {
    fx = await setupFixture();
    tenantSlug = `br-${randomUUID().slice(0, 8)}`;
  });

  afterAll(async () => {
    await fx.close();
  });

  function newWallet(): `0x${string}` {
    return privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as `0x${string}`;
  }

  async function seedPerson(): Promise<`0x${string}`> {
    const wallet = newWallet();
    await bootstrapOperator(fx.sql, {
      tenantSlug,
      tenantName: "Bootstrap registry tenant",
      organizationName: "Bootstrap registry org",
      jurisdiction: "MNG",
      subjectName: "Reviewer",
      walletAddress: wallet,
      chainId: 97,
      role: "reviewer_cp_qp",
      assuranceLevel: "high_assurance",
    });
    return wallet;
  }

  function credential(overrides: Record<string, unknown> = {}) {
    return {
      tenantSlug,
      walletAddress: overrides["walletAddress"] as string,
      issuerReference: `CP #${randomUUID().slice(0, 8)}`,
      credentialType: "competent_person",
      credentialScope: ["mining_right_registration"],
      jurisdiction: ["MNG"],
      issuedAt: "2024-01-01T00:00:00Z",
      expiresAt: "2030-01-01T00:00:00Z",
      ...overrides,
    } as Parameters<typeof bootstrapCredential>[1];
  }

  const RULE_SET = {
    ruleSetId: "bootstrap-gate",
    version: "1.0.0",
    effectiveFrom: "2026-01-01T00:00:00Z",
    supersededBy: null,
    jurisdictionProfile: "MNG",
    gateId: "registry_publication",
    retroactive: false,
    requirements: [
      {
        requirementId: "project-identity",
        label: "Project identity",
        appliesWhen: { op: "always" },
        requiredClaimTypes: ["project_identity"],
        minimumGrade: "self_reported",
        freshnessThresholdDays: null,
        requiredAttestations: [],
        blockingConflictTypes: [],
        notEvaluableWhen: { op: "never" },
        watchWhen: null,
      },
    ],
  };

  it("자격을 만들고 다시 돌려도 하나만 남는다", async () => {
    const wallet = await seedPerson();
    const args = credential({ walletAddress: wallet });

    const first = await bootstrapCredential(fx.sql, args);
    const second = await bootstrapCredential(fx.sql, args);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(first.state).toBe("valid");
  });

  it("만료된 자격을 valid로 넣지 않는다", async () => {
    const wallet = await seedPerson();
    await expect(
      bootstrapCredential(fx.sql, credential({ walletAddress: wallet, expiresAt: "2020-01-01T00:00:00Z" })),
    ).rejects.toThrow(BootstrapRegistryError);
  });

  it("범위 없는 자격을 거절한다 — 그 자격으로는 서명이 막힌다", async () => {
    const wallet = await seedPerson();
    await expect(
      bootstrapCredential(fx.sql, credential({ walletAddress: wallet, credentialScope: [] })),
    ).rejects.toThrow(BootstrapRegistryError);
  });

  it("없는 지갑에는 자격을 붙이지 않는다", async () => {
    await expect(
      bootstrapCredential(fx.sql, credential({ walletAddress: newWallet() })),
    ).rejects.toThrow(BootstrapRegistryError);
  });

  it("승인자를 대지 않은 검토 규격은 draft다", async () => {
    await seedPerson();
    const result = await bootstrapAttestationSchema(fx.sql, {
      tenantSlug,
      schemaKey: `signoff-${randomUUID().slice(0, 8)}`,
      schemaVersion: "1",
      attestationType: "professional_signoff",
      requiredEvidence: ["mining_right_registration"],
      acceptedAuthorityTypes: ["government_registry"],
      mandatoryLimitations: ["Does not include a site visit"],
      jurisdictionProfile: "MNG",
      approvedBy: null,
    });
    expect(result.state).toBe("draft");
  });

  it("한계 없는 검토 규격을 거절한다 (AC-01)", async () => {
    await seedPerson();
    await expect(
      bootstrapAttestationSchema(fx.sql, {
        tenantSlug,
        schemaKey: `nolimit-${randomUUID().slice(0, 8)}`,
        schemaVersion: "1",
        attestationType: "professional_signoff",
        requiredEvidence: [],
        acceptedAuthorityTypes: [],
        mandatoryLimitations: [],
        jurisdictionProfile: "MNG",
        approvedBy: "Approver",
      }),
    ).rejects.toThrow(BootstrapRegistryError);
  });

  it("승인자를 대면 활성이 되고 누가 말했는지가 감사에 남는다", async () => {
    await seedPerson();
    const schemaKey = `approved-${randomUUID().slice(0, 8)}`;
    const result = await bootstrapAttestationSchema(fx.sql, {
      tenantSlug,
      schemaKey,
      schemaVersion: "1",
      attestationType: "professional_signoff",
      requiredEvidence: ["mining_right_registration"],
      acceptedAuthorityTypes: ["government_registry"],
      mandatoryLimitations: ["Does not include a site visit"],
      jurisdictionProfile: "MNG",
      approvedBy: "Verification lead",
    });

    expect(result.state).toBe("active");

    const [event] = await fx.sql<{ reason: string; actor_subject_id: string | null }[]>`
      SELECT reason, actor_subject_id FROM audit.events
      WHERE resource_id = ${result.id} AND command = 'bootstrap.attestation_schema.created'
    `;
    expect(event?.reason).toBe("Verification lead");
    // 앱이 식별하지 않은 사람이다. 없는 신원을 지어내지 않는다.
    expect(event?.actor_subject_id).toBeNull();
  });

  it("draft로 넣은 규격을 나중에 승인할 수 있다 (02 §2.8)", async () => {
    await seedPerson();
    const schemaKey = `two-step-${randomUUID().slice(0, 8)}`;
    const args = {
      tenantSlug,
      schemaKey,
      schemaVersion: "1",
      attestationType: "professional_signoff",
      requiredEvidence: ["mining_right_registration"],
      acceptedAuthorityTypes: ["government_registry"],
      mandatoryLimitations: ["Does not include a site visit"],
      jurisdictionProfile: "MNG",
      approvedBy: null,
    } as Parameters<typeof bootstrapAttestationSchema>[1];

    const drafted = await bootstrapAttestationSchema(fx.sql, args);
    expect(drafted.state).toBe("draft");

    const approved = await bootstrapAttestationSchema(fx.sql, {
      ...args,
      approvedBy: "Verification lead",
    });
    expect(approved.id).toBe(drafted.id);
    expect(approved.created).toBe(false);
    expect(approved.state).toBe("active");

    const [event] = await fx.sql<{ reason: string }[]>`
      SELECT reason FROM audit.events
      WHERE resource_id = ${drafted.id} AND command = 'bootstrap.attestation_schema.approved'
    `;
    expect(event?.reason).toBe("Verification lead");
  });

  it("draft로 넣은 규칙도 나중에 승인할 수 있다", async () => {
    await seedPerson();
    const definition = { ...RULE_SET, ruleSetId: `two-step-${randomUUID().slice(0, 8)}` };

    const drafted = await bootstrapPolicySet(fx.sql, { tenantSlug, definition, approvedBy: null });
    expect(drafted.state).toBe("draft");

    const approved = await bootstrapPolicySet(fx.sql, {
      tenantSlug,
      definition,
      approvedBy: "Verification lead",
    });
    expect(approved.id).toBe(drafted.id);
    expect(approved.state).toBe("effective");
  });

  it("schema를 통과하지 못하는 rule set을 거절한다 (OD-15)", async () => {
    await seedPerson();
    await expect(
      bootstrapPolicySet(fx.sql, {
        tenantSlug,
        definition: { ...RULE_SET, version: "1" },
        approvedBy: null,
      }),
    ).rejects.toThrow(BootstrapRegistryError);
  });

  it("rule set의 값에서 행의 열을 가져온다", async () => {
    await seedPerson();
    const result = await bootstrapPolicySet(fx.sql, {
      tenantSlug,
      definition: RULE_SET,
      approvedBy: "Verification lead",
    });

    expect(result.state).toBe("effective");

    const [row] = await fx.sql<{ gate_id: string; rule_set_version: string }[]>`
      SELECT gate_id, rule_set_version FROM core.compliance_policy_sets WHERE id = ${result.id}
    `;
    expect(row?.gate_id).toBe("registry_publication");
    expect(row?.rule_set_version).toBe("1.0.0");
  });
});
