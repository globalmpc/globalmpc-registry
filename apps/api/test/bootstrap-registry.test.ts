import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
 * Bootstrap of the three things a review needs to start.
 *
 * With only people seeded, flow reaches project creation and stops at review — assignment
 * needs a credential and schema, readiness needs a policy set. The only path that created
 * those three was the E2E seed.
 *
 * This checks not "the row was inserted" but **that nothing is inserted in a false state**.
 * An expired credential entered as valid, or an unapproved spec as active, lets every
 * later check pass.
 */
describeDb("review registry bootstrap", () => {
  let fx: TestFixture;
  let tenantSlug: string;

  beforeAll(async () => {
    fx = await setupFixture();
    tenantSlug = `br-${randomUUID().slice(0, 8)}`;
  });

  afterAll(async () => {
    await fx.close();
  });

  const newEmail = () => `reviewer-${randomUUID().slice(0, 8)}@example.test`;

  /**
   * The tenant's reviewer, the way an operator brings in the first one: bootstrap, by email (no
   * wallet, WP7). Bootstrap creates only the first holder of a role, so every case shares it.
   */
  let seeded: string | null = null;
  async function seedPerson(): Promise<string> {
    if (seeded !== null) return seeded;
    const email = newEmail();
    await bootstrapOperator(fx.sql, {
      tenantSlug,
      tenantName: "Bootstrap registry tenant",
      organizationName: "Bootstrap registry org",
      jurisdiction: "MNG",
      subjectName: "Reviewer",
      email,
      role: "reviewer_cp_qp",
      assuranceLevel: "high_assurance",
    });
    seeded = email;
    return email;
  }

  function credential(overrides: Record<string, unknown> = {}) {
    return {
      tenantSlug,
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

  it("creating a credential and rerunning leaves exactly one", async () => {
    const email = await seedPerson();
    const args = credential({ email });

    const first = await bootstrapCredential(fx.sql, args);
    const second = await bootstrapCredential(fx.sql, args);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(first.state).toBe("valid");
  });

  it("does not insert an expired credential as valid", async () => {
    const email = await seedPerson();
    await expect(
      bootstrapCredential(fx.sql, credential({ email, expiresAt: "2020-01-01T00:00:00Z" })),
    ).rejects.toThrow(BootstrapRegistryError);
  });

  it("rejects a credential without scope — it could not sign anything", async () => {
    const email = await seedPerson();
    await expect(
      bootstrapCredential(fx.sql, credential({ email, credentialScope: [] })),
    ).rejects.toThrow(BootstrapRegistryError);
  });

  it("does not attach a credential to a nonexistent person or wallet", async () => {
    await expect(bootstrapCredential(fx.sql, credential({ email: newEmail() }))).rejects.toThrow(
      /No person with this email address/,
    );
    await expect(
      bootstrapCredential(fx.sql, credential({ walletAddress: `0x${"9".repeat(40)}` })),
    ).rejects.toThrow(/is not in this tenant/);
  });

  it("names the holder by exactly one of email or a wallet they hold, and never echoes the address", async () => {
    const email = await seedPerson();
    await expect(bootstrapCredential(fx.sql, credential({}))).rejects.toThrow(/exactly one/);
    await expect(
      bootstrapCredential(fx.sql, credential({ email, walletAddress: `0x${"9".repeat(40)}` })),
    ).rejects.toThrow(/exactly one/);
    const malformed = bootstrapCredential(fx.sql, credential({ email: "secret-person@@example.com" }));
    await expect(malformed).rejects.toThrow(/not one email address/);
    await expect(malformed).rejects.not.toThrow(/secret-person/);

    // A wallet the holder bound still names them (fixture tenant A's reviewer).
    const created = await bootstrapCredential(fx.sql, {
      ...credential({ walletAddress: fx.reviewerA.address.toUpperCase().replace("0X", "0x") }),
      tenantSlug: `t-${fx.tenantA.slice(0, 8)}`,
    });
    expect(created).toMatchObject({ created: true, state: "valid" });
    const [row] = await fx.sql<{ subject_id: string }[]>`SELECT subject_id FROM core.credentials WHERE id = ${created.id}`;
    expect(row!.subject_id).toBe(fx.reviewerSubjectA);
  });

  it("refuses a wallet address that changed hands rather than guess which holder is meant", async () => {
    const address = `0x${randomUUID().replaceAll("-", "").slice(0, 32)}${"a".repeat(8)}`;
    const [earlier, current] = [randomUUID(), randomUUID()];
    await fx.sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name, assurance_level)
      VALUES (${earlier}, ${fx.tenantA}, 'person', 'Earlier holder', 'wallet_only'),
             (${current}, ${fx.tenantA}, 'person', 'Current holder', 'wallet_only')
    `;
    // The earlier holder retired the key; someone else proved it and holds it now.
    await fx.sql`
      INSERT INTO core.wallet_identities (
        id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at, bound_via, disabled_at
      ) VALUES
        (${randomUUID()}, ${fx.tenantA}, ${earlier}, ${address}, 31337, 'wallet_only', now() - interval '2 days', 'proof', now() - interval '1 day'),
        (${randomUUID()}, ${fx.tenantA}, ${current}, ${address}, 31337, 'wallet_only', now(), 'proof', NULL)
    `;
    const refused = bootstrapCredential(fx.sql, {
      ...credential({ walletAddress: address }),
      tenantSlug: `t-${fx.tenantA.slice(0, 8)}`,
    });
    await expect(refused).rejects.toThrow(/may have changed hands\. Name the holder by email/);
    expect(await fx.sql`SELECT 1 FROM core.credentials WHERE subject_id IN (${earlier}, ${current})`).toHaveLength(0);
  });

  it("a review spec without an approver is draft", async () => {
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

  it("rejects a review spec without limitations (AC-01)", async () => {
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

  it("naming an approver makes it active and records who said so in audit", async () => {
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
    // A person the app has not identified. No identity is invented.
    expect(event?.actor_subject_id).toBeNull();
  });

  it("a spec inserted as draft can be approved later (02 §2.8)", async () => {
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

  it("a rule inserted as draft can be approved later too", async () => {
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

  it("rejects a rule set that fails the schema (OD-15)", async () => {
    await seedPerson();
    await expect(
      bootstrapPolicySet(fx.sql, {
        tenantSlug,
        definition: { ...RULE_SET, version: "1" },
        approvedBy: null,
      }),
    ).rejects.toThrow(BootstrapRegistryError);
  });

  it("takes row columns from the rule set values", async () => {
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
