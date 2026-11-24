# Tenant removal review

The Registry runs as one shared instance. Organizations and projects remain the
units of administration and access. Removing the tenant column must preserve
access to existing records and the verifiability of historical signatures and
anchors.

| Identity or case | Authority and time basis | Input scope | Result and priority |
| --- | --- | --- | --- |
| Person and session | Active subject and verified session at request time | Current organization and project bindings, role and assurance | Expired or revoked sessions fail before resource authorization |
| Organization membership | Current organization assignment | Organization identified by the stored resource relationship | Membership does not imply access to every project |
| Private project records | Current scoped role and action permission | Project and its owning organization derived from stored relationships | Deny unassigned actors and cross-project substitutions |
| Worker and service credentials | Live service identity and narrowly scoped grants | Job and resource relationships stored by trusted producers | Fail closed on a mismatched resource or missing permission |
| Published evidence and signed history | Original publication and signature authority | Frozen serialization, signature domain and original payload | Keep historical bytes and identifiers verifiable after migration |
| Existing data | The operator confirmed the existing database contains one tenant | Preserve project keys, subjects, catalog definitions and their relationships | Keep existing record IDs and rights in the shared Registry |

Before changing the database boundary, verify own-project success, other-project
denial within and across organizations, revoked access, service access, public
projection, and historical proof verification. Exercise migrated data and runtime
roles with their actual grants. Authentication and authorization changes require
independent security review before merge.

## Actor-based row-level security

The operator chose actor-based RLS: the database decides project reach from the
authenticated subject's live role bindings, not from a project chosen by the API.
Migration `0168_actor_project_scope.sql` is the expand step.

| Identity or case | Authority and time basis | Input scope | Result and priority |
| --- | --- | --- | --- |
| Actor | `app.actor_subject_id`, set by `withActor` only from a resolved live session or service token | Transaction-local | No actor reaches no project-owned row |
| Project binding | Live, unrevoked binding of an unsuspended subject at statement time | The bound project, narrowed by `jurisdiction` | Same-organization sibling projects stay excluded |
| Organization binding (`scope_kind = organization`) | Live binding and the project's current owning organization | Projects that organization owns, narrowed by `jurisdiction` | Organization membership never reaches another organization's project |
| Registry-wide binding (`scope_kind = registry`, `tenant` before 0169; no project) | Live binding | Every project, or the listed jurisdictions' projects | Revocation or suspension removes reach on the next statement |
| `scope_kind = none` without a project | Live binding | None | Reaches no project |
| Project row writes | Values being written, not the pre-statement reach | Owner organization, host jurisdiction and id of the new row | Handing a project to an organization outside reach is rejected |
| Rolling deploy (0168 only) | Running versions set only `app.current_tenant` | `tenant_isolation` and `actor_project_scope` were permissive and OR-ed | Superseded by 0169: no rolling compatibility (operator decision) |

The database decides reach only. Role-action permission, session assurance,
sensitivity, assignment and conflict rules remain API decisions, so database reach
can equal but never exceed API reach. Session assurance narrowing is not visible to
the database; a binding narrowed by sign-in level still reaches its projects at the
database layer and is refused by the API decision.

Stages (all in PR #169):

1. Done: actor helpers and policies on records that always belong to one project
   (`0168`), with `packages/db/test/actor-project-scope.test.ts` under a NOSUPERUSER
   NOBYPASSRLS `mpc_app` login.
2. Done (`0169`): records reached through a parent record, records that may have no
   project, Registry reference data and account records.
3. Done: API, worker, bootstrap and seed consumers use `withActor`; `withTenant`,
   `app.current_tenant` and every SECURITY DEFINER read of the tenant are gone.
4. Done (`0169`): `tenant_isolation`, tenant keys, foreign keys, `tenant_id` columns
   (including `audit.events.tenant_id`), `core.tenants` and the tenant helpers are
   dropped.

## Contract step: 0169 decisions

Operator decisions: old versions may break (no rolling compatibility); production holds
one tenant, so no snapshot or rollback plan is kept; `audit.events.tenant_id` is dropped.

| Identity or case | Authority and time basis | Input scope | Result and priority |
| --- | --- | --- | --- |
| Migration owner | Superuser or `BYPASSRLS` at migration time | Every row, to rename scopes and rebuild keys | `TENANT_REMOVAL_REQUIRES_BYPASSRLS` before any change otherwise (`remove-tenant-migration.test.ts`) |
| Deployment CLIs (bootstrap, `service-token ensure`, dev demo) | Migration table owner that bypasses RLS (`requireDeploymentOwner`) | Registry-wide first holder, service subject and demo namespace | NOBYPASSRLS owner refused before writing; it would see nothing without an actor |
| Session-keyed definers (`mfa_lock_session`, `list_own_sessions`, `list_external_identities`, `start_oidc_transaction`, wallet/WebAuthn challenge lookups) | Live session whose subject is `core.current_actor()` | The caller's own session | Another subject's session id answers "no live session" (the tenant used to bound this) |
| Decision definers (`decide_email_change`, `decide_mfa_reset`, `decide_subject_suspension`, `revoke_invitation`, `create_invitation`, `request_email_change`) | The decider/requester is the authenticated actor | Named decider argument | A decider other than the actor is refused (`insufficient_privilege`) |
| `revoke_subject_sessions` | Internal definers (email-change completion, MFA reset, suspension) and the admin wallet-disable route after its API authorization | Subject being revoked | Deliberately not actor-guarded: those flows may run with no actor, or revoke someone else's sessions by design, and must still revoke. It only ends sessions; the application role's callers decide whose |
| `subject_sign_in_providers` | Live actor | Provider list | Absent/suspended actors get nothing (the tenant used to bound this) |
| Organization-scoped admin on another company's project route | API action policy | Project in the path | `403` (role/scope refusal, before any read) |
| Row hidden by RLS (document status, project registry, governance space, signature) | Database reach | Id in the path | `404`, the same answer as a missing row; a foreign project is indistinguishable from a missing one |
| Project key, catalog key, schema key | Global unique constraints | Registry-wide | Duplicate project key → `409 PROJECT_KEY_TAKEN` without naming the holder (was a `500`) |
| Ledger configuration lock | One Registry configuration | `hashtextextended('ledger-config', 0)` | Every configuration writer waits on publications; there is no per-company configuration |
| Scan worker | Its service token's subject and live `scan_service` binding (Registry scope) | Uploads it reaches | `SCAN_SERVICE_TENANT_SLUG` removed; worker role granted `resolve_service_token` and the actor helpers, not BYPASSRLS. Every queue statement also names `project_id = ANY(core.actor_project_ids())`, because the deployed `mpc_worker_login` bypasses RLS (Duno); tested as both a NOBYPASSRLS and a BYPASSRLS worker login |
| Review independence (rule 2, credential holder organization) | All live bindings of the person judged, at decision time | `core.subject_affiliated_organizations` / `core.subject_holder_organization` (0170): organization ids only, live actors only | A project-scoped resolver no longer misses the signer's operator binding on a project it cannot reach and restore a non-independent review as active (Duno) |
| Wallet binding (EIP-712 `WalletBinding`) | Signature over purpose, subject, wallet, chain, nonce | New challenges only | `tenantId` removed from the typed data; a signature requested by an old client no longer verifies (accepted: no rolling compatibility) |
| Dev demo keys | Existing `DEMO-V1-INPUT-<ns>` project | Reuses the old tenant UUID suffix when present, else `registry` | A rerun on an existing Registry does not add a second set |
| Historical records | Frozen bytes, hashes, signatures and anchors | Unchanged rows | No signed payload included the tenant except the wallet challenge above; anchored and published bytes are not rewritten |

Removed objects: `core.tenants`, `core.current_tenant()`, `core.registry_tenant()`, the 0167
`core.project_exports` legacy view and its trigger. Views that exposed `tenant_id` are
recreated without it.

User-visible wording: the empty project list keeps the §11.7 text "No projects are available
to your account. There is no data here; this is not a permission problem." Strings that said
"tenant" now say Registry, company or organization. The Microsoft OIDC directory names
(`idp_tenant`, `MICROSOFT_ALLOWED_TENANTS`, `OIDC_TENANT_NOT_ALLOWED`) were a different concept;
they went with Microsoft sign-in itself in 0171 (`microsoft-sign-in-removal.md`).

Test infrastructure: API fixtures each clone a migrated template database prepared once by
`apps/api/test/helpers/template-setup.ts` (`globalSetup`), since a single Registry can no
longer be partitioned per test by tenant.

Operator follow-up: remove `BOOTSTRAP_TENANT_SLUG`, `BOOTSTRAP_TENANT_NAME`,
`SCAN_SERVICE_TENANT_SLUG` and `DEMO_TENANT_SLUG` from the github-manager Pulumi stack.

Verification limits: cdk tests were not run locally (the private package registry is
unreachable from the development machine); they rely on CI. Independent human security
review of this boundary change is pending and required before merge.
