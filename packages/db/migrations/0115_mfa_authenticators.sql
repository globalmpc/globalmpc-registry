-- Second factors — account authentication WP3: storage.
--
-- A session's AAL comes from what it proved (0108). This migration adds what a second factor is
-- proved **against**, and the evidence a proof leaves behind:
--
-- 1. `core.webauthn_credentials` — passkeys. The credential id is the authenticator's, unique
--    across the whole registry (one physical credential never belongs to two subjects). The sign
--    counter is tracked so a cloned authenticator that replays an old count is refused.
-- 2. `core.totp_authenticators` — one active TOTP per subject, plus at most one pending setup
--    waiting for its first code. The secret is AES-256-GCM ciphertext; the key is derived by the
--    API from `SESSION_SECRET` (HKDF-SHA256, info `mpc/totp-secret/v1`) and never reaches the
--    database. `last_used_step` refuses a code whose 30-second step was already accepted, and the
--    failure columns hold the lockout (5 attempts per 15 minutes) in the database, so restarting
--    or scaling the API does not reset it.
-- 3. `core.recovery_codes` — ten per set, SHA-256 of an 80-bit random code (D10: a plain hash of
--    a random secret needs no key). Single use; a new set voids the codes left in the old one.
-- 4. `core.webauthn_challenges` — one per ceremony, bound to the session and subject that asked,
--    five minutes, single use. They live and die with their session (ON DELETE CASCADE), so the
--    session purge removes them.
-- 5. `core.session_factor_proofs` — the evidence a session's second factor rests on: the WebAuthn
--    challenge this session consumed, the TOTP step it spent, or the recovery code it used. 0116
--    makes a session's `second_factor` point at one, so the database itself refuses a session
--    that claims a factor nothing proved.
-- 6. `core.mfa_reset_requests` — journey 6, a person who lost every factor. Two people: one
--    proposes, another approves; approval revokes every authenticator and session of the subject
--    and opens a 24-hour window in which an aal1 session may enrol a first factor again (0117).
--
-- Everything is tenant-scoped with forced row-level security. The API reads what it must show
-- or verify (credentials, TOTP rows, recovery codes, reset requests) and writes **only** through
-- the SECURITY DEFINER functions of 0116 / 0117 — except proposing a reset, a plain insert under
-- RLS like every other two-person proposal (0028, 0042). Challenges and proofs it cannot touch
-- at all.

CREATE TYPE core.webauthn_challenge_purpose AS ENUM ('registration', 'authentication');

-- ---------------------------------------------------------------------------
-- 1. Passkeys
-- ---------------------------------------------------------------------------

CREATE TABLE core.webauthn_credentials (
  id              UUID PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES core.tenants (id),
  subject_id      UUID NOT NULL,
  -- base64url, as the browser reports it. 1023 bytes is the WebAuthn maximum (L3 §5.1).
  credential_id   TEXT NOT NULL UNIQUE
                    CHECK (credential_id ~ '^[A-Za-z0-9_-]+$' AND length(credential_id) BETWEEN 16 AND 1364),
  -- COSE public key exactly as the authenticator returned it.
  public_key      BYTEA NOT NULL CHECK (octet_length(public_key) BETWEEN 16 AND 4096),
  sign_count      BIGINT NOT NULL DEFAULT 0 CHECK (sign_count BETWEEN 0 AND 4294967295),
  transports      TEXT[] NOT NULL DEFAULT '{}'
                    CHECK (transports <@ ARRAY['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']),
  aaguid          UUID NOT NULL,
  -- What registration saw. Registration requires user verification, so this is always true; it
  -- is kept so a later relaxation could not pass silently.
  user_verified   BOOLEAN NOT NULL CHECK (user_verified),
  device_type     TEXT NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up       BOOLEAN NOT NULL,
  -- The holder's label for it ("work laptop"). Display only.
  name            TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 64),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at    TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  revoked_reason  TEXT CHECK (revoked_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT webauthn_credentials_subject_same_tenant
    FOREIGN KEY (tenant_id, subject_id) REFERENCES core.subjects (tenant_id, id),
  CONSTRAINT webauthn_credentials_revoked_reason
    CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);

CREATE INDEX webauthn_credentials_subject_idx ON core.webauthn_credentials (subject_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. TOTP
-- ---------------------------------------------------------------------------

CREATE TABLE core.totp_authenticators (
  id                        UUID PRIMARY KEY,
  tenant_id                 UUID NOT NULL REFERENCES core.tenants (id),
  subject_id                UUID NOT NULL,
  -- AES-256-GCM of the 20-byte secret, with the 16-byte tag appended. The additional data binds
  -- it to this row and subject, so a ciphertext copied onto another row does not decrypt.
  secret_ciphertext         BYTEA NOT NULL CHECK (octet_length(secret_ciphertext) BETWEEN 32 AND 128),
  secret_nonce              BYTEA NOT NULL CHECK (octet_length(secret_nonce) = 12),
  -- Which derived key encrypted it. Rotating `SESSION_SECRET` changes the key; see deployment.md.
  key_version               SMALLINT NOT NULL DEFAULT 1 CHECK (key_version >= 1),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A setup is pending until its first valid code; it can be confirmed only before this.
  pending_expires_at        TIMESTAMPTZ NOT NULL,
  confirmed_at              TIMESTAMPTZ,
  -- The last accepted 30-second step. A code of this step or an earlier one is refused.
  last_used_step            BIGINT CHECK (last_used_step >= 0),
  last_used_at              TIMESTAMPTZ,
  -- Attempts in the current window. Counted **before** a code is checked and cleared by a
  -- valid one, so concurrent guesses cannot all slip in before the count.
  failed_attempts           INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  failure_window_started_at TIMESTAMPTZ,
  revoked_at                TIMESTAMPTZ,
  revoked_reason            TEXT CHECK (revoked_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT totp_authenticators_subject_same_tenant
    FOREIGN KEY (tenant_id, subject_id) REFERENCES core.subjects (tenant_id, id),
  CONSTRAINT totp_authenticators_revoked_reason
    CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  -- A step is spent only by a confirmed authenticator (confirming spends the first one).
  CONSTRAINT totp_authenticators_step_after_confirm
    CHECK (last_used_step IS NULL OR confirmed_at IS NOT NULL),
  CONSTRAINT totp_authenticators_window
    CHECK ((failed_attempts = 0) OR (failure_window_started_at IS NOT NULL))
);

CREATE UNIQUE INDEX totp_authenticators_one_active
  ON core.totp_authenticators (subject_id) WHERE confirmed_at IS NOT NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX totp_authenticators_one_pending
  ON core.totp_authenticators (subject_id) WHERE confirmed_at IS NULL AND revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Recovery codes
-- ---------------------------------------------------------------------------

CREATE TABLE core.recovery_codes (
  id                     UUID PRIMARY KEY,
  tenant_id              UUID NOT NULL REFERENCES core.tenants (id),
  subject_id             UUID NOT NULL,
  -- The ten codes generated together. Regenerating voids what is left of the previous set.
  set_id                 UUID NOT NULL,
  code_hash              TEXT NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at            TIMESTAMPTZ,
  -- The session the code restored. A proof names this pair, so it names a code that session used.
  consumed_by_session_id UUID,
  voided_at              TIMESTAMPTZ,
  CONSTRAINT recovery_codes_subject_same_tenant
    FOREIGN KEY (tenant_id, subject_id) REFERENCES core.subjects (tenant_id, id),
  CONSTRAINT recovery_codes_consumed_together
    CHECK ((consumed_at IS NULL) = (consumed_by_session_id IS NULL)),
  CONSTRAINT recovery_codes_unique_in_set UNIQUE (set_id, code_hash),
  CONSTRAINT recovery_codes_consumed_by UNIQUE (id, consumed_by_session_id)
);

CREATE INDEX recovery_codes_usable_idx
  ON core.recovery_codes (subject_id, code_hash) WHERE consumed_at IS NULL AND voided_at IS NULL;

-- ---------------------------------------------------------------------------
-- 4. WebAuthn challenges
-- ---------------------------------------------------------------------------

CREATE TABLE core.webauthn_challenges (
  id                     UUID PRIMARY KEY,
  tenant_id              UUID NOT NULL REFERENCES core.tenants (id),
  subject_id             UUID NOT NULL,
  session_id             UUID NOT NULL REFERENCES core.sessions (id) ON DELETE CASCADE,
  purpose                core.webauthn_challenge_purpose NOT NULL,
  -- 32 random bytes, base64url without padding — what the browser echoes in clientDataJSON.
  challenge              TEXT NOT NULL UNIQUE CHECK (challenge ~ '^[A-Za-z0-9_-]{43}$'),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at             TIMESTAMPTZ NOT NULL,
  consumed_at            TIMESTAMPTZ,
  consumed_by_session_id UUID,
  CONSTRAINT webauthn_challenges_subject_same_tenant
    FOREIGN KEY (tenant_id, subject_id) REFERENCES core.subjects (tenant_id, id),
  CONSTRAINT webauthn_challenges_ttl CHECK (expires_at <= created_at + interval '5 minutes'),
  CONSTRAINT webauthn_challenges_consumed_together
    CHECK ((consumed_at IS NULL) = (consumed_by_session_id IS NULL)),
  -- Only the session that asked for a challenge can spend it.
  CONSTRAINT webauthn_challenges_consumed_by_owner
    CHECK (consumed_by_session_id IS NULL OR consumed_by_session_id = session_id),
  CONSTRAINT webauthn_challenges_consumed_by UNIQUE (id, consumed_by_session_id)
);

CREATE INDEX webauthn_challenges_session_idx ON core.webauthn_challenges (session_id, purpose)
  WHERE consumed_at IS NULL;

-- ---------------------------------------------------------------------------
-- 5. Proofs
-- ---------------------------------------------------------------------------

CREATE TABLE core.session_factor_proofs (
  id                    UUID PRIMARY KEY,
  tenant_id             UUID NOT NULL REFERENCES core.tenants (id),
  subject_id            UUID NOT NULL,
  session_id            UUID NOT NULL REFERENCES core.sessions (id) ON DELETE CASCADE,
  factor                core.session_second_factor NOT NULL,
  webauthn_challenge_id UUID UNIQUE,
  webauthn_credential_id UUID REFERENCES core.webauthn_credentials (id),
  totp_authenticator_id UUID REFERENCES core.totp_authenticators (id),
  totp_step             BIGINT,
  recovery_code_id      UUID UNIQUE,
  proven_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT session_factor_proofs_subject_same_tenant
    FOREIGN KEY (tenant_id, subject_id) REFERENCES core.subjects (tenant_id, id),
  -- The challenge was consumed, and by this session — not merely issued, not another session's.
  CONSTRAINT session_factor_proofs_consumed_challenge
    FOREIGN KEY (webauthn_challenge_id, session_id)
    REFERENCES core.webauthn_challenges (id, consumed_by_session_id),
  CONSTRAINT session_factor_proofs_consumed_code
    FOREIGN KEY (recovery_code_id, session_id)
    REFERENCES core.recovery_codes (id, consumed_by_session_id),
  -- A TOTP step proves once, whichever session spends it.
  CONSTRAINT session_factor_proofs_totp_step_once UNIQUE (totp_authenticator_id, totp_step),
  CONSTRAINT session_factor_proofs_shape CHECK (
    CASE factor
      WHEN 'passkey' THEN webauthn_challenge_id IS NOT NULL AND webauthn_credential_id IS NOT NULL
        AND totp_authenticator_id IS NULL AND totp_step IS NULL AND recovery_code_id IS NULL
      WHEN 'totp' THEN totp_authenticator_id IS NOT NULL AND totp_step IS NOT NULL
        AND webauthn_challenge_id IS NULL AND webauthn_credential_id IS NULL AND recovery_code_id IS NULL
      WHEN 'recovery_code' THEN recovery_code_id IS NOT NULL
        AND webauthn_challenge_id IS NULL AND webauthn_credential_id IS NULL
        AND totp_authenticator_id IS NULL AND totp_step IS NULL
    END
  ),
  -- The key a session's `second_factor` references (0116): proof, session and factor together.
  CONSTRAINT session_factor_proofs_session_factor UNIQUE (id, session_id, factor)
);

-- ---------------------------------------------------------------------------
-- 6. Admin MFA reset (two-person)
-- ---------------------------------------------------------------------------

CREATE TYPE core.mfa_reset_state AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE core.mfa_reset_requests (
  id                      UUID PRIMARY KEY,
  tenant_id               UUID NOT NULL REFERENCES core.tenants (id),
  -- Whose factors are reset.
  subject_id              UUID NOT NULL,
  reason                  TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  requested_by_subject_id UUID NOT NULL,
  requested_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  state                   core.mfa_reset_state NOT NULL DEFAULT 'pending',
  decided_by_subject_id   UUID,
  decided_at              TIMESTAMPTZ,
  decision_reason         TEXT CHECK (decision_reason IS NULL OR length(btrim(decision_reason)) BETWEEN 1 AND 2000),
  -- Until when an aal1 session of the subject may enrol a first factor. Set by approval only.
  enrolment_window_until  TIMESTAMPTZ,
  version                 INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT mfa_reset_subject_same_tenant
    FOREIGN KEY (tenant_id, subject_id) REFERENCES core.subjects (tenant_id, id),
  CONSTRAINT mfa_reset_requester_same_tenant
    FOREIGN KEY (tenant_id, requested_by_subject_id) REFERENCES core.subjects (tenant_id, id),
  CONSTRAINT mfa_reset_decider_same_tenant
    FOREIGN KEY (tenant_id, decided_by_subject_id) REFERENCES core.subjects (tenant_id, id),
  -- Two people, and the decider is not the subject: approving one's own proposal, or the reset
  -- of one's own account, would be a one-person path to a fresh enrolment window. Proposing a
  -- reset of one's own account is allowed — someone else still decides it (as role grants, 0076).
  CONSTRAINT mfa_reset_two_person CHECK (
    decided_by_subject_id IS NULL OR decided_by_subject_id <> requested_by_subject_id
  ),
  CONSTRAINT mfa_reset_not_self_target CHECK (
    decided_by_subject_id IS NULL OR decided_by_subject_id <> subject_id
  ),
  CONSTRAINT mfa_reset_decision_shape CHECK (
    (state = 'pending' AND decided_by_subject_id IS NULL AND decided_at IS NULL
      AND enrolment_window_until IS NULL)
    OR (state = 'rejected' AND decided_by_subject_id IS NOT NULL AND decided_at IS NOT NULL
      AND enrolment_window_until IS NULL)
    OR (state = 'approved' AND decided_by_subject_id IS NOT NULL AND decided_at IS NOT NULL
      AND enrolment_window_until = decided_at + interval '24 hours')
  )
);

CREATE UNIQUE INDEX mfa_reset_requests_one_pending ON core.mfa_reset_requests (subject_id)
  WHERE state = 'pending';
CREATE INDEX mfa_reset_requests_tenant_idx ON core.mfa_reset_requests (tenant_id, requested_at DESC);

-- ---------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------

ALTER TABLE core.webauthn_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.webauthn_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.webauthn_credentials
  USING (tenant_id = core.current_tenant()) WITH CHECK (tenant_id = core.current_tenant());

ALTER TABLE core.totp_authenticators ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.totp_authenticators FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.totp_authenticators
  USING (tenant_id = core.current_tenant()) WITH CHECK (tenant_id = core.current_tenant());

ALTER TABLE core.recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.recovery_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.recovery_codes
  USING (tenant_id = core.current_tenant()) WITH CHECK (tenant_id = core.current_tenant());

ALTER TABLE core.webauthn_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.webauthn_challenges FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.webauthn_challenges
  USING (tenant_id = core.current_tenant()) WITH CHECK (tenant_id = core.current_tenant());

ALTER TABLE core.session_factor_proofs ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.session_factor_proofs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.session_factor_proofs
  USING (tenant_id = core.current_tenant()) WITH CHECK (tenant_id = core.current_tenant());

ALTER TABLE core.mfa_reset_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.mfa_reset_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.mfa_reset_requests
  USING (tenant_id = core.current_tenant()) WITH CHECK (tenant_id = core.current_tenant());

-- Reads only: listing passkeys, decrypting a TOTP secret in the API, counting recovery codes.
-- Every change goes through 0116's functions, which also decide whether it is allowed.
REVOKE ALL ON core.webauthn_credentials, core.totp_authenticators, core.recovery_codes,
  core.webauthn_challenges, core.session_factor_proofs, core.mfa_reset_requests FROM mpc_app;
GRANT SELECT ON core.webauthn_credentials, core.totp_authenticators, core.recovery_codes TO mpc_app;
-- A reset is proposed like every other two-person request; it is decided only by 0117's function.
-- Proposing is a plain insert of the proposal's own columns; state, decision, window and version
-- keep their defaults (pending, none, none, 1). Anything else — an already-decided row — would
-- open an enrolment window with no second person, so only `core.decide_mfa_reset` decides.
GRANT SELECT ON core.mfa_reset_requests TO mpc_app;
GRANT INSERT (id, tenant_id, subject_id, reason, requested_by_subject_id) ON core.mfa_reset_requests TO mpc_app;
