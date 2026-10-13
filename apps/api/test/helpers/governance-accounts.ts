import { randomUUID } from "node:crypto";
import { newAccount, type TestAccount, type TestFixture } from "./db.js";

/**
 * Adds one tenant A account with a single role binding.
 *
 * Governance space tests need proposers, voters and recorders of **both** spaces, and a project
 * voter bound to one project. The shared fixture seeds only the protocol pair, so these are
 * created per test file instead of widening every file's fixture.
 */
export async function addGovernanceAccount(
  fx: TestFixture,
  role: string,
  options: {
    readonly projectId?: string;
    readonly assurance?: "wallet_only" | "identity_bound" | "high_assurance";
  } = {},
): Promise<TestAccount> {
  const account = newAccount();
  const subject = randomUUID();
  await fx.sql`
    INSERT INTO core.subjects (id, tenant_id, kind, display_name)
    VALUES (${subject}, ${fx.tenantA}, 'person', ${role})
  `;
  await fx.sql`
    INSERT INTO core.wallet_identities (
      id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at
    ) VALUES (
      ${randomUUID()}, ${fx.tenantA}, ${subject}, ${account.address}, 31337,
      ${options.assurance ?? "identity_bound"}, now()
    )
  `;
  await fx.sql`
    INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, project_id, role)
    VALUES (
      ${randomUUID()}, ${fx.tenantA}, ${subject}, ${fx.orgA}, ${options.projectId ?? null}, ${role}
    )
  `;
  return account;
}
