# Database implementation and migration agreements

Read the repository `AGENTS.md`, `CONTRIBUTING.md`, `docs/review-guidelines.md` and
`docs/ci.md` before changing this package or its migrations.

## Actor boundaries and runtime identities

Before changing a project-scoped table, RLS policy, grant, role or database consumer,
identify which runtime login executes each operation and whether it is actor-scoped or
explicitly every-project (the worker role). Record the identity authority,
transaction-local context, input scope and retry behavior in the review decision table.

- A project predicate does not supply `app.actor_subject_id`. Actor-scoped consumers
  must use `withActor` for all statements, including lease selection, failure
  updates, attempt refunds and queue counts. Keep the explicit project predicate.
- Connection-pool reuse must not carry an actor into the next operation. Keep
  actor settings transaction-local and external I/O outside the transaction.
- Role membership inherits grants, not the BYPASSRLS attribute. Do not infer a
  login's behavior from a parent role, its name or a passing owner/superuser test.
- Do not change role attributes, disable RLS, or introduce privileged SQL functions
  to make an actor-scoped consumer see rows. Existing every-project consumers need
  their own documented authority and independent security review.
- SECURITY DEFINER functions keyed by a session or naming a decider act only for the
  authenticated actor (`core.current_actor()`); keep that guard when changing them.

## Migration and regression verification

- Preserve already-applied migration contents; make schema/policy corrections in
  a new forward migration. A consumer missing actor context needs a consumer fix,
  not a migration granting RLS bypass.
- Exercise affected SQL under the intended grants with a non-superuser,
  NOBYPASSRLS login/member role for actor-scoped flows. Assert `rolsuper = false`
  and `rolbypassrls = false`, and verify in-reach success, out-of-reach exclusion,
  failure/retry writes and context cleanup after pooled connection reuse.
- Migration-owner tests still establish schema installation and owner-only CLI
  behavior, but cannot substitute for application/worker runtime tests. Verify
  representative existing data through the upgrade when schema semantics change.
- The scan-worker regression is a concrete counterexample: BYPASSRLS-only tests
  hid an empty RLS-filtered queue. Reuse the approach in
  `apps/scan-worker/test/scanner.test.ts`; retain meaningful lease/concurrency and
  isolation assertions rather than weakening them to obtain passing results.
