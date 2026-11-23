# Microsoft sign-in removal (0171)

Requested 2026-11-23 alongside the tenant removal (PR #169): "remove Microsoft login entirely".
Google and the emailed code stay the ways in. This supersedes decision D2 of
`docs/account-authentication-plan.md` for Microsoft.

## Decision table

| Question | Decision |
| --- | --- |
| Identity namespace | Only Google `(iss = https://accounts.google.com, sub)`. `core.oidc_provider` is `{google}`; `core.session_first_factor` is `{email_code, google, siwe_legacy}`; `core.external_identities.idp_tenant` is dropped; `OIDC_PROVIDERS = ["google"]`. |
| Authority | A Microsoft identity signs nobody in, links nothing and accepts no invitation. `/api/v1/auth/oidc/microsoft/*` answers `REQUEST_INVALID`, as for any unknown provider, before and after sign-in. Who may sign in or link with Google is unchanged. |
| Frozen vs live state | Every Microsoft session, login transaction and identity (live or revoked) is deleted by 0171. Signed records, role bindings and audit events are kept as written, including audit events that name `microsoft`. A pending recovery notice drops `microsoft` from `removedSignIns`; settled notices are untouched. |
| Input scope | Rows whose provider or first factor is `microsoft`; the deployment settings `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_ALLOWED_TENANTS`. |
| Status priority | Fail closed. A wallet recovery opened from a Microsoft session stops the migration (its record would otherwise go with the session through `ON DELETE CASCADE`). The API refuses to start while a Microsoft setting is non-empty; the CDK no longer forwards them, so a deployed environment that still holds them starts without them. |

No rolling compatibility: an API build from before 0171 calls `complete_oidc_link` /
`complete_oidc_invitation` with `p_idp_tenant` and fails against this schema, as agreed for
#169.

## What changed

- **Database (0171):** deletes the rows above, rebuilds both enum types without `microsoft`,
  drops `idp_tenant`, re-creates the session and identity CHECK constraints and the two session
  triggers that name the column, and re-creates the 13 functions that name either type or the
  column. Bodies are unchanged except for `p_idp_tenant` and comments; grants are restored
  (`REVOKE … FROM PUBLIC`, `GRANT … TO mpc_app` where it was granted before). The unused
  seven-argument `complete_oidc_link` (before 0156) is not re-created.
- **API:** `services/oidc.ts` validates Google tokens only; `tenant_not_allowed` /
  `OIDC_TENANT_NOT_ALLOWED` and `idpTenant` are gone; the E2E relay no longer forwards
  `login.microsoftonline.com`; `/auth/methods` no longer has `microsoft`.
- **Jobs worker:** recovery notices accept `removedSignIns` of `[]` or `["google"]` only.
- **Web:** no Microsoft button, label or link; the callback page treats `microsoft` as an unknown
  provider. The proxy was already provider-agnostic and is unchanged.
- **Deployment:** `.env.example`, `cdk/.env.example`, `docker/docker-compose.yml`, CDK config and
  README, `docs/operations/deployment.md`.

## Verification

- `packages/db/test/remove-microsoft-migration.test.ts` on a database migrated to 0170 with
  Microsoft and Google rows: the wallet-recovery guard stops the migration with nothing applied;
  then every Microsoft row goes and Google rows stay; the pending notice keeps `["google"]`; no
  function or constraint mentions `microsoft` or `idp_tenant`; the owner cannot insert a Microsoft
  identity or name the factor; recreated functions keep their grants.
- `apps/api/test/oidc.test.ts`: Microsoft start / callback (anonymous) and link start / callback
  (aal2) answer `REQUEST_INVALID`. `apps/api/test/config.test.ts`: each Microsoft setting refuses
  start-up, empty does not. `apps/api/test/oidc-test-relay.test.ts`: the Microsoft host is refused.
- `cdk/test/stacks.test.ts`: the Microsoft settings are not forwarded (written; this suite has not
  run locally or in CI, as before).
- `apps/web/e2e/oidc.spec.ts`: no Microsoft button; the proxy's Microsoft start is refused.

Independent security review of this change is pending with the rest of #169.
