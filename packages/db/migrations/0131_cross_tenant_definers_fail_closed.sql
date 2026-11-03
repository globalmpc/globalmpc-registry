-- Cross-tenant SECURITY DEFINER functions fail loudly under an owner that does not bypass RLS.
--
-- Every account-authentication table has FORCE ROW LEVEL SECURITY with the tenant policy
-- (`tenant_id = core.current_tenant()`), so the table owner is filtered like anyone else unless it
-- is superuser or has BYPASSRLS. The definer functions below read **outside the caller's tenant
-- context by design** — a sign-in that does not know its tenant yet, an address or identity that
-- must be unused in every tenant, a token or state hash looked up before any tenant is set, a purge
-- or gauge over every tenant. Under an owner that does not bypass RLS they would not fail: they
-- would see zero rows and answer as if nothing existed ("address free", "identity not linked",
-- "no such session") — the unsafe direction.
--
-- `row_security = off` turns that into an error ("query would be affected by row-level security
-- policy") for such an owner, and changes nothing for one that bypasses RLS (the supported setup,
-- docs/operations/deployment.md). 0130 did this for `core.bind_wallet_by_proof`; this migration
-- does it for every other cross-tenant definer from 0112 to 0130. ALTER FUNCTION only: the bodies
-- are unchanged, and 0112–0130 stay as applied.
--
-- Audit (every SECURITY DEFINER function created or replaced in 0112–0130):
--
-- | Function | Why it reads across tenants |
-- | --- | --- |
-- | find_person_by_email | the person behind an address, in any tenant (sign-in) |
-- | start_email_challenge | sign-in: no tenant yet; invitation by token; pending address change by address |
-- | verify_sign_in_code | consumes the challenge by address, before any tenant is set |
-- | create_invitation | `email_in_use`: the address must be free in every tenant |
-- | accept_invitation | invitation by token; the address must be free in every tenant |
-- | request_email_change | `email_in_use`: the target address must be free in every tenant |
-- | decide_email_change | supersedes the address's live challenges wherever they are |
-- | complete_email_change | consumes the challenge by address; the address must be free everywhere |
-- | purge_email_auth_records | maintenance over every tenant |
-- | open_bootstrap_enrolment_window | bootstrap: the person by id, with no tenant context |
-- | start_oidc_transaction | invitation by token hash, before a tenant is set |
-- | claim_oidc_transaction | the transaction by state hash, before a tenant is set |
-- | complete_oidc_sign_in | the identity in any tenant |
-- | complete_oidc_link | "not linked anywhere": the identity in every tenant |
-- | complete_oidc_invitation | the identity and the address in every tenant |
-- | purge_oidc_records, purge_auth_records | maintenance over every tenant |
-- | resolve_session | the session by token hash, before a tenant is set |
-- | sessions_refuse_suspended | trigger on every session insert, which happens in sign-in paths with no tenant set; reading nothing would let a suspended person in |
-- | decide_subject_suspension | supersedes the person's address challenges wherever they are |
-- | operational_gauges | counts over every tenant |
-- | governance_votes_pin_weight | reads the proposal whatever tenant context the writer set; reading nothing would unpin a snapshot weight |
-- | bind_wallet_by_proof | (0130, already set) the key's disable history in every tenant |
-- | revoke_session | (0108) sign-out by token hash, with no tenant set; reading nothing would leave the session live |
-- | resolve_service_token | (0109) the token by hash, before a tenant is set |
-- | resolve_role_bindings | (0005, 0026, 0074) the subject's bindings, read by the session resolver before a tenant is set; reading nothing would narrow a session to no roles silently |
--
-- Same-tenant (left as they are): they act on the caller's session, subject or request inside the
-- tenant context the caller set — the MFA functions (mfa_status, the WebAuthn and TOTP functions,
-- recovery codes, remove_authenticator), revoke_invitation, revoke_subject_sessions,
-- revoke_subject_identities, decide_mfa_reset, list/unlink_external_identities,
-- subject_sign_in_providers, list_own_sessions, revoke_own_session, disable_own_wallet, the wallet
-- challenge functions, create_subject_session (only refuses), and the triggers. Those that refuse
-- when they read nothing: session_email_challenge_consumed, session_oidc_transaction_completed,
-- external_identity_person_only, subject_suspension_proposal_guard. *Corrected after review:* this
-- list first also named mfa_reset_separation_guard and refuse_suspended_actor, which answered "not
-- suspended" when they read nothing; they run in the caller's tenant or inside a function listed
-- above (and inherit its setting), and fail closed on a missing row only since 0132. `packages/db/test/cross-tenant-definers.test.ts` holds both lists and
-- fails on a definer function that is in neither.
--
-- Of 0105–0111 the rest are same-tenant or need nothing: create_subject_session and
-- revoke_subject_sessions (listed above), purge_auth_records and resolve_session (listed above),
-- service_token_subject_is_service (SECURITY INVOKER), and chain.register_anchor_contract (writes
-- `chain.anchor_contracts`, which has no RLS). Older definers off the session and service-token
-- paths (public read models, the ledger, sweeps, the worker heartbeat) are not part of this audit;
-- the test lists them separately.

SELECT set_config('lock_timeout', '5s', true);

ALTER FUNCTION core.find_person_by_email(text) SET row_security = off;
ALTER FUNCTION core.start_email_challenge(core.email_challenge_purpose, text, text, uuid, bytea, text, text, text) SET row_security = off;
ALTER FUNCTION core.verify_sign_in_code(text, bytea, text, text, uuid, text, integer) SET row_security = off;
ALTER FUNCTION core.create_invitation(uuid, uuid, text, uuid, text, text) SET row_security = off;
ALTER FUNCTION core.accept_invitation(text, bytea, text, uuid, text, uuid, text, integer) SET row_security = off;
ALTER FUNCTION core.request_email_change(uuid, uuid, text, text, uuid) SET row_security = off;
ALTER FUNCTION core.decide_email_change(uuid, uuid, boolean, text, integer, uuid, bytea, text) SET row_security = off;
ALTER FUNCTION core.complete_email_change(text, bytea, text, text) SET row_security = off;
ALTER FUNCTION core.purge_email_auth_records() SET row_security = off;
ALTER FUNCTION core.open_bootstrap_enrolment_window(uuid) SET row_security = off;
ALTER FUNCTION core.start_oidc_transaction(uuid, core.oidc_provider, core.oidc_purpose, text, text, text, bytea, text, uuid, text, text, text) SET row_security = off;
ALTER FUNCTION core.claim_oidc_transaction(text, text, core.oidc_provider, uuid) SET row_security = off;
ALTER FUNCTION core.complete_oidc_sign_in(uuid, text, text, uuid, text, integer) SET row_security = off;
ALTER FUNCTION core.complete_oidc_link(uuid, uuid, text, text, text, text, uuid) SET row_security = off;
ALTER FUNCTION core.complete_oidc_invitation(uuid, text, text, text, text, text, uuid, uuid, uuid, text, integer) SET row_security = off;
ALTER FUNCTION core.purge_oidc_records() SET row_security = off;
ALTER FUNCTION core.purge_auth_records() SET row_security = off;
ALTER FUNCTION core.resolve_session(text) SET row_security = off;
ALTER FUNCTION core.sessions_refuse_suspended() SET row_security = off;
ALTER FUNCTION core.decide_subject_suspension(uuid, uuid, boolean, text, integer) SET row_security = off;
ALTER FUNCTION core.operational_gauges() SET row_security = off;
ALTER FUNCTION core.governance_votes_pin_weight() SET row_security = off;
ALTER FUNCTION core.revoke_session(text) SET row_security = off;
ALTER FUNCTION core.resolve_service_token(text) SET row_security = off;
ALTER FUNCTION core.resolve_role_bindings(uuid) SET row_security = off;

SELECT set_config('lock_timeout', '0', true);
