-- Restore the legacy API grants during the rolling deployment and rollback window.
-- The historical development revision of 0155 revoked these privileges.
-- The current 0155 retains them, and 0156 reconciles the OIDC function settings.
GRANT SELECT ON core.webauthn_credentials, core.totp_authenticators, core.recovery_codes, core.mfa_reset_requests TO mpc_app;
GRANT INSERT (id, tenant_id, subject_id, reason, requested_by_subject_id) ON core.mfa_reset_requests TO mpc_app;
GRANT EXECUTE ON FUNCTION
 core.begin_totp_enrolment(uuid,uuid,bytea,bytea), core.complete_totp(uuid,uuid,bigint,text[]),
 core.complete_webauthn_authentication(uuid,text,text,bigint,boolean),
 core.complete_webauthn_registration(uuid,text,text,bytea,bigint,text[],uuid,boolean,text,boolean,text,text[]),
 core.consume_recovery_code(uuid,text), core.create_webauthn_challenge(uuid,core.webauthn_challenge_purpose,text),
 core.decide_mfa_reset(uuid,uuid,boolean,text,integer), core.live_webauthn_challenge(uuid,core.webauthn_challenge_purpose),
 core.mfa_status(uuid), core.regenerate_recovery_codes(uuid,text[]), core.remove_authenticator(uuid,text,uuid),
 core.rename_webauthn_credential(uuid,uuid,text), core.reserve_totp_attempt(uuid,boolean)
 TO mpc_app;
