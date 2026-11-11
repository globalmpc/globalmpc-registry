# Database implementation and migration agreements

Read the repository `AGENTS.md`, `CONTRIBUTING.md`, `docs/review-guidelines.md` and
`docs/ci.md` before changing this package or its migrations.

## Tenant boundaries and runtime identities

Before changing a tenant table, RLS policy, grant, role or database consumer, identify
which runtime login executes each operation and whether it is tenant-scoped or
explicitly cross-tenant. Record the identity authority, transaction-local context,
input scope and retry behavior in the review decision table.

- A tenant predicate does not supply `app.current_tenant`. Tenant-scoped consumers
  must use `withTenant` for all statements, including lease selection, failure
  updates, attempt refunds and queue counts. Keep the explicit tenant predicate.
- Connection-pool reuse must not carry a tenant into the next operation. Keep
  tenant settings transaction-local and external I/O outside the transaction.
- Role membership inherits grants, not the BYPASSRLS attribute. Do not infer a
  login's behavior from a parent role, its name or a passing owner/superuser test.
- Do not change role attributes, disable RLS, or introduce privileged SQL functions
  to make a tenant-scoped consumer see rows. Existing cross-tenant consumers need
  their own documented authority and independent security review.

## Migration and regression verification

- Preserve already-applied migration contents; make schema/policy corrections in
  a new forward migration. A consumer missing tenant context needs a consumer fix,
  not a migration granting RLS bypass.
- Exercise affected SQL under the intended grants with a non-superuser,
  NOBYPASSRLS login/member role for tenant-scoped flows. Assert `rolsuper = false`
  and `rolbypassrls = false`, and verify own-tenant success, other-tenant exclusion,
  failure/retry writes and context cleanup after pooled connection reuse.
- Migration-owner tests still establish schema installation and owner-only CLI
  behavior, but cannot substitute for application/worker runtime tests. Verify
  representative existing data through the upgrade when schema semantics change.
- The scan-worker regression is a concrete counterexample: BYPASSRLS-only tests
  hid an empty RLS-filtered queue. Reuse the approach in
  `apps/scan-worker/test/scanner.test.ts`; retain meaningful lease/concurrency and
  isolation assertions rather than weakening them to obtain passing results.
