import { randomUUID } from "node:crypto";
import { newAccount, type TestAccount, type TestFixture, syncSubjectAssurance } from "./db.js";

/**
 * Adds one company A account with a single role binding.
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
    readonly jurisdiction?: string[];
    readonly scopeKind?: "registry" | "organization" | "none";
    readonly governanceScope?: "protocol" | "project" | "none";
    readonly assurance?: "wallet_only" | "identity_bound" | "high_assurance";
  } = {},
): Promise<TestAccount> {
  const account = newAccount();
  const subject = randomUUID();
  await fx.sql`
    INSERT INTO core.subjects (id, kind, display_name)
    VALUES (${subject}, 'person', ${role})
  `;
  await fx.sql`
    INSERT INTO core.wallet_identities (
      id, subject_id, wallet_address, chain_id, assurance_level, bound_at
    ) VALUES (
      ${randomUUID()}, ${subject}, ${account.address}, 31337,
      ${options.assurance ?? "identity_bound"}, now()
    )
  `;
  await syncSubjectAssurance(fx.sql);
  await fx.sql`
    INSERT INTO core.role_bindings (id, subject_id, organization_id, project_id, role, governance_scope, jurisdiction, scope_kind)
    VALUES (
      ${randomUUID()}, ${subject}, ${fx.orgA}, ${options.projectId ?? null}, ${role}, ${options.governanceScope ?? null}, ${options.jurisdiction ?? null}, ${options.scopeKind ?? null}
    )
  `;
  return account;
}
