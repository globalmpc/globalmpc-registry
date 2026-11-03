-- Google and Microsoft sign-in: linked identities and login transactions — account authentication WP4.
--
-- Tables and the session binding only; the functions that use them are in 0121. Decisions, in
-- the plan's table form (plan §3):
--
-- | Identity / case | Namespace and uniqueness | Who may set it | Frozen or live | Result / priority |
-- | --- | --- | --- | --- | --- |
-- | Google identity | `(provider, issuer = https://accounts.google.com, subject_key = sub)`; one live row per key **across every tenant** (D6) | The holder, from an aal2+ session (link), or by accepting an invitation whose address the IdP verified | Live; unlink is audited and keeps the row | Matched only by the key. The token's email is never used to find an account |
-- | Microsoft identity | `(provider, issuer = https://login.microsoftonline.com/{tid}/v2.0, subject_key = oid)`, `idp_tenant = tid`; same uniqueness | Same | Live | Matched only by `(tid, oid)`. `email`, `preferred_username`, `upn` and `sub` are never used for matching |
-- | Login transaction | Random `state` (stored as SHA-256), one browser binding (SHA-256), one nonce (SHA-256), the PKCE verifier and nonce sealed under a key derived from `SESSION_SECRET` (D10, `mpc/oidc-tx/v1`) | Started by the API's start routes; the database decides who may start a link or accept an invitation | Single use: claimed once (the sealed secret is cleared), completed once; 10 minutes | Proof that this browser started this flow, for this purpose and this session or invitation |
-- | Session from Google / Microsoft | `core.sessions.oidc_transaction_id` | Only the function that completed the transaction in the same database transaction | — | A `google` / `microsoft` session without a transaction completed for its subject cannot exist (CHECK + trigger); the general session function refuses both (0121) |
--
-- The application role holds **no privilege** on either table. It reaches them only through
-- 0121's SECURITY DEFINER functions, which is how the email-code and MFA tables work (0113, 0115).

CREATE TYPE core.oidc_provider AS ENUM ('google', 'microsoft');
CREATE TYPE core.oidc_purpose AS ENUM ('sign_in', 'link', 'invitation_accept');

-- ---------------------------------------------------------------------------
-- Linked identities
-- ---------------------------------------------------------------------------

CREATE TABLE core.external_identities (
  id             UUID PRIMARY KEY,
  tenant_id      UUID NOT NULL REFERENCES core.tenants (id),
  subject_id     UUID NOT NULL,
  provider       core.oidc_provider NOT NULL,
  -- The ID token's `iss`, exactly. For Microsoft it names the user's directory, so the same `oid`
  -- in two directories is two identities.
  issuer         TEXT NOT NULL,
  -- Google `sub`; Microsoft `oid`. Never an email address.
  subject_key    TEXT NOT NULL CHECK (subject_key ~ '^[!-~]{1,255}$'),
  -- Microsoft `tid`. NULL for Google.
  idp_tenant     TEXT,
  -- Keyed hash (`mpc/email-audit/v1`) of the address the provider reported when the identity was
  -- linked, if any. A record for the audit trail; nothing matches on it.
  email_hash     TEXT CHECK (email_hash IS NULL OR email_hash ~ '^[0-9a-f]{64}$'),
  linked_via     TEXT NOT NULL CHECK (linked_via IN ('link', 'invitation')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at   TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  -- `unlinked_by_holder`, … A short code, never free text.
  revoked_reason TEXT CHECK (revoked_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT external_identities_revoked_shape CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  -- COALESCE: a NULL `idp_tenant` would make the Microsoft branch NULL, and a CHECK passes NULL.
  CONSTRAINT external_identities_issuer CHECK (COALESCE(
    (provider = 'google' AND issuer = 'https://accounts.google.com' AND idp_tenant IS NULL)
    OR (
      provider = 'microsoft'
      AND idp_tenant IS NOT NULL
      AND idp_tenant ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND issuer = 'https://login.microsoftonline.com/' || idp_tenant || '/v2.0'
      AND subject_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ), false)
  ),
  FOREIGN KEY (tenant_id, subject_id) REFERENCES core.subjects (tenant_id, id)
);

-- D6: one live identity, one subject, one tenant. A plain (partial) UNIQUE spans every tenant.
-- An unlinked row stays as history and frees the key for a later link.
CREATE UNIQUE INDEX external_identities_live_key
  ON core.external_identities (provider, issuer, subject_key) WHERE revoked_at IS NULL;
-- One live identity per provider per person: a second Google account is a second sign-in method
-- nobody needs, and every extra one is more of the account reachable from outside.
CREATE UNIQUE INDEX external_identities_one_per_provider
  ON core.external_identities (subject_id, provider) WHERE revoked_at IS NULL;
CREATE INDEX external_identities_tenant_idx ON core.external_identities (tenant_id, subject_id);

ALTER TABLE core.external_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.external_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.external_identities
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

REVOKE ALL ON core.external_identities FROM PUBLIC;

/** Only a person signs in. A service subject authenticates with a service token (0109). */
CREATE FUNCTION core.external_identity_person_only() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM core.subjects s
    WHERE s.id = NEW.subject_id AND s.tenant_id = NEW.tenant_id AND s.kind = 'person'
  ) THEN
    RAISE EXCEPTION 'an external identity belongs to a person subject' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER external_identities_person_only
  BEFORE INSERT OR UPDATE OF subject_id, tenant_id ON core.external_identities
  FOR EACH ROW EXECUTE FUNCTION core.external_identity_person_only();

-- ---------------------------------------------------------------------------
-- Login transactions
-- ---------------------------------------------------------------------------

/**
 * One authorization-code flow, from the start route to the callback.
 *
 * Not tenant-scoped until something decides the tenant: a sign-in transaction has none until its
 * identity is found. Forced RLS as for every table with a tenant column, although no application
 * role holds a privilege here.
 *
 * - `state_hash` — SHA-256 of the `state` the provider echoes back; the callback finds the row by it.
 * - `binding_hash` — SHA-256 of a secret only the browser that started the flow holds. A callback
 *   carrying someone else's `state` and `code` (login CSRF: an attacker's own sign-in completed
 *   in the victim's browser) does not match it.
 * - `nonce_hash` — SHA-256 of the nonce in the ID token; the API checks the sealed nonce against it.
 * - `secret_ciphertext` — AES-256-GCM of the PKCE verifier and the nonce, key HKDF-derived from
 *   `SESSION_SECRET` (`mpc/oidc-tx/v1`), the row id as associated data. Present only until the
 *   transaction is claimed: a copy of the database taken afterwards holds nothing to redeem.
 */
CREATE TABLE core.oidc_login_transactions (
  id                UUID PRIMARY KEY,
  provider          core.oidc_provider NOT NULL,
  purpose           core.oidc_purpose NOT NULL,
  state_hash        TEXT NOT NULL UNIQUE CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  binding_hash      TEXT NOT NULL CHECK (binding_hash ~ '^[0-9a-f]{64}$'),
  nonce_hash        TEXT NOT NULL CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
  secret_ciphertext BYTEA CHECK (secret_ciphertext IS NULL OR length(secret_ciphertext) BETWEEN 29 AND 1024),
  redirect_uri      TEXT NOT NULL CHECK (redirect_uri ~ '^https?://[^\s]+$' AND length(redirect_uri) <= 512),
  tenant_id         UUID REFERENCES core.tenants (id),
  -- link: the session that asked, and its subject. sign-in / invitation: the subject the
  -- completion found or created.
  subject_id        UUID,
  session_id        UUID REFERENCES core.sessions (id) ON DELETE CASCADE,
  invitation_id     UUID REFERENCES core.invitations (id),
  display_name      TEXT CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 200),
  identity_id       UUID REFERENCES core.external_identities (id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  claimed_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  -- The database transaction that completed it. A session may name this row only from that same
  -- transaction (trigger below), so one completion is one session.
  completed_txid    xid8,
  outcome           TEXT CHECK (outcome IN (
                      'session', 'linked', 'not_found', 'unavailable', 'provider_already_linked',
                      'email_mismatch', 'email_unavailable', 'invitation_invalid', 'step_up_required'
                    )),
  CONSTRAINT oidc_tx_lifetime CHECK (expires_at = created_at + interval '10 minutes'),
  CONSTRAINT oidc_tx_link_shape
    CHECK ((purpose = 'link') = (session_id IS NOT NULL)),
  CONSTRAINT oidc_tx_link_bound
    CHECK (purpose <> 'link' OR (tenant_id IS NOT NULL AND subject_id IS NOT NULL)),
  CONSTRAINT oidc_tx_invitation_shape
    CHECK ((purpose = 'invitation_accept') = (invitation_id IS NOT NULL AND display_name IS NOT NULL)),
  CONSTRAINT oidc_tx_secret_until_claimed
    CHECK ((claimed_at IS NULL) = (secret_ciphertext IS NOT NULL)),
  CONSTRAINT oidc_tx_completed_after_claim
    CHECK (completed_at IS NULL OR claimed_at IS NOT NULL),
  CONSTRAINT oidc_tx_completed_shape
    CHECK ((completed_at IS NULL) = (completed_txid IS NULL) AND (completed_at IS NULL) = (outcome IS NULL)),
  CONSTRAINT oidc_tx_session_outcome
    CHECK (outcome IS DISTINCT FROM 'session' OR (identity_id IS NOT NULL AND subject_id IS NOT NULL AND tenant_id IS NOT NULL)),
  FOREIGN KEY (tenant_id, subject_id) REFERENCES core.subjects (tenant_id, id)
);

CREATE INDEX oidc_login_transactions_created_idx ON core.oidc_login_transactions (created_at);
CREATE INDEX oidc_login_transactions_identity_idx ON core.oidc_login_transactions (identity_id)
  WHERE identity_id IS NOT NULL;
CREATE INDEX oidc_login_transactions_session_idx ON core.oidc_login_transactions (session_id)
  WHERE session_id IS NOT NULL;

ALTER TABLE core.oidc_login_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.oidc_login_transactions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.oidc_login_transactions
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

REVOKE ALL ON core.oidc_login_transactions FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- A Google / Microsoft session names the transaction it completed
-- ---------------------------------------------------------------------------

-- 0108–0116 let `core.create_subject_session` record `google` / `microsoft` on the caller's word
-- and said WP4 must bind them to a verified login. Sessions minted that way proved nothing (only
-- tests could create them); they end here, as email-code sessions did in 0113. Same handling as
-- 0108: sessions force RLS on their owner, so a migration role that does not bypass it lifts
-- FORCE for this statement and puts it back.
DO $$
DECLARE
  lift BOOLEAN := NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user);
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  PERFORM set_config('row_security', 'off', true);
  IF lift THEN
    ALTER TABLE core.sessions NO FORCE ROW LEVEL SECURITY;
  END IF;

  -- Their factor proofs and WebAuthn challenges go with them (ON DELETE CASCADE, 0115), as
  -- when the purge deletes a session; a spent recovery code stays spent.
  DELETE FROM core.sessions WHERE first_factor IN ('google', 'microsoft');

  IF lift THEN
    ALTER TABLE core.sessions FORCE ROW LEVEL SECURITY;
  END IF;
  PERFORM set_config('row_security', 'on', true);
  PERFORM set_config('lock_timeout', '0', true);
END
$$;

ALTER TABLE core.sessions
  ADD COLUMN oidc_transaction_id UUID REFERENCES core.oidc_login_transactions (id),
  ADD CONSTRAINT sessions_oidc_has_transaction
    CHECK ((first_factor IN ('google', 'microsoft')) = (oidc_transaction_id IS NOT NULL)),
  -- One completed login, one session.
  ADD CONSTRAINT sessions_oidc_transaction_once UNIQUE (oidc_transaction_id);

/**
 * The transaction a new `google` / `microsoft` session names was completed **in this database
 * transaction**, as a sign-in, by the same provider, for this subject in this tenant.
 *
 * The CHECK above stops a session that names no transaction; this stops one that names a
 * transaction it did not just complete — an old one, someone else's, one for another provider,
 * or a link (which proves the person already had a session, not that they signed in). SECURITY
 * DEFINER only to read the transaction table, which no application role can.
 */
CREATE FUNCTION core.session_oidc_transaction_completed() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
BEGIN
  IF NEW.oidc_transaction_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM core.oidc_login_transactions t
    WHERE t.id = NEW.oidc_transaction_id
      AND t.completed_txid = pg_current_xact_id()
      AND t.outcome = 'session'
      AND t.purpose IN ('sign_in', 'invitation_accept')
      AND t.provider::text = NEW.first_factor::text
      AND t.subject_id = NEW.subject_id
      AND t.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'session names login transaction % that this transaction did not complete for its subject',
      NEW.oidc_transaction_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER sessions_oidc_transaction_completed
  BEFORE INSERT OR UPDATE OF oidc_transaction_id, subject_id, tenant_id, first_factor ON core.sessions
  FOR EACH ROW EXECUTE FUNCTION core.session_oidc_transaction_completed();
