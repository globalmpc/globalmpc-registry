-- Invitations, email change requests, emailed codes and the mail queue — account authentication WP2.
--
-- Tables only; the functions that use them are in 0114. Decisions, in the plan's table form:
--
-- | Identity / case | Namespace | Who may set it | Frozen or live | Result / priority |
-- | --- | --- | --- | --- | --- |
-- | Invitation | Random token, stored as keccak256; one email, one tenant, one organisation | An admin (`admin.invitation.manage`) | Single use, 72 h, revocable | Accepting creates a `person` subject with **no role** and an aal1 session |
-- | Emailed code | One live challenge per (purpose, address); 8 digits, HMAC under a key derived from `SESSION_SECRET` (D10) | Issued by the start functions; the API never stores the code | 10 min, 5 attempts, single use; a new code supersedes the old | Proof of control of the address for that purpose only |
-- | Email change | Request per subject; new address globally unique | Proposed and decided by two different admins, neither of them the subject | Approved for 72 h, then the code to the new address completes it | Swaps the address and revokes every session of the subject |
-- | Session from a code | `core.sessions.email_challenge_id` | Only the function that consumed the challenge in the same transaction | — | An `email_code` session without a consumed challenge cannot exist (constraint and trigger) |
--
-- Status priority when a code is checked (first match wins): rate limit → no live challenge →
-- expired → attempts exhausted → wrong code → the account no longer holds the address → success.

-- ---------------------------------------------------------------------------
-- Invitations
-- ---------------------------------------------------------------------------

CREATE TABLE core.invitations (
  id                    UUID PRIMARY KEY,
  tenant_id             UUID NOT NULL REFERENCES core.tenants (id),
  organization_id       UUID NOT NULL,
  email                 TEXT NOT NULL CHECK (email = core.normalize_email(email)),
  invited_by_subject_id UUID NOT NULL,
  -- keccak256 of the token, as for sessions and service tokens: the token is 256 random bits, so
  -- a plain hash needs no key (D10).
  token_hash            TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^0x[0-9a-f]{64}$'),
  state                 TEXT NOT NULL DEFAULT 'pending'
                          CHECK (state IN ('pending', 'accepted', 'revoked', 'expired')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at            TIMESTAMPTZ NOT NULL,
  accepted_at           TIMESTAMPTZ,
  accepted_subject_id   UUID,
  revoked_at            TIMESTAMPTZ,
  revoked_by_subject_id UUID,
  version               INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT invitations_lifetime CHECK (expires_at = created_at + interval '72 hours'),
  CONSTRAINT invitations_accept_shape CHECK (
    (state = 'accepted') = (accepted_at IS NOT NULL AND accepted_subject_id IS NOT NULL)
  ),
  CONSTRAINT invitations_revoke_shape CHECK (
    (state = 'revoked') = (revoked_at IS NOT NULL AND revoked_by_subject_id IS NOT NULL)
  ),
  FOREIGN KEY (tenant_id, organization_id) REFERENCES core.organizations (tenant_id, id),
  FOREIGN KEY (tenant_id, invited_by_subject_id) REFERENCES core.subjects (tenant_id, id),
  FOREIGN KEY (tenant_id, accepted_subject_id) REFERENCES core.subjects (tenant_id, id),
  FOREIGN KEY (tenant_id, revoked_by_subject_id) REFERENCES core.subjects (tenant_id, id)
);

-- One open invitation per address, across every tenant (D6). An invitation past its expiry is
-- still `pending` until something flips it; the functions that create invitations flip the
-- address's expired ones first.
CREATE UNIQUE INDEX invitations_one_pending_idx ON core.invitations (email) WHERE state = 'pending';
CREATE INDEX invitations_tenant_idx ON core.invitations (tenant_id, created_at DESC);

ALTER TABLE core.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.invitations
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

-- Admins list their tenant's invitations. Every write goes through 0114's functions, which also
-- check other tenants (D6) and queue the mail.
REVOKE ALL ON core.invitations FROM PUBLIC;
GRANT SELECT ON core.invitations TO mpc_app;

-- ---------------------------------------------------------------------------
-- Email change requests — journey 7
-- ---------------------------------------------------------------------------

CREATE TABLE core.email_change_requests (
  id                      UUID PRIMARY KEY,
  tenant_id               UUID NOT NULL REFERENCES core.tenants (id),
  subject_id              UUID NOT NULL,
  new_email               TEXT NOT NULL CHECK (new_email = core.normalize_email(new_email)),
  reason                  TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  requested_by_subject_id UUID NOT NULL,
  requested_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  state                   TEXT NOT NULL DEFAULT 'pending'
                            CHECK (state IN ('pending', 'approved', 'rejected', 'completed', 'expired')),
  decided_by_subject_id   UUID,
  decided_at              TIMESTAMPTZ,
  decision_reason         TEXT,
  completed_at            TIMESTAMPTZ,
  version                 INTEGER NOT NULL DEFAULT 1,
  /**
   * Two people, neither of them the subject — the same rules as role grants (0028, 0076).
   *
   * Nobody changes their own address: the address is where their sign-in code goes, so changing
   * it is changing their login, which no single person may do for themselves or for anyone else.
   */
  CONSTRAINT email_change_two_person
    CHECK (decided_by_subject_id IS NULL OR decided_by_subject_id <> requested_by_subject_id),
  CONSTRAINT email_change_not_own_request CHECK (requested_by_subject_id <> subject_id),
  CONSTRAINT email_change_not_own_decision
    CHECK (decided_by_subject_id IS NULL OR decided_by_subject_id <> subject_id),
  CONSTRAINT email_change_decision_shape CHECK (
    (state = 'pending' AND decided_by_subject_id IS NULL AND decided_at IS NULL)
    OR (state = 'expired')
    OR (state IN ('approved', 'rejected', 'completed')
        AND decided_by_subject_id IS NOT NULL AND decided_at IS NOT NULL
        AND decision_reason IS NOT NULL AND length(btrim(decision_reason)) > 0)
  ),
  CONSTRAINT email_change_completed_shape CHECK ((state = 'completed') = (completed_at IS NOT NULL)),
  FOREIGN KEY (tenant_id, subject_id) REFERENCES core.subjects (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by_subject_id) REFERENCES core.subjects (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by_subject_id) REFERENCES core.subjects (tenant_id, id)
);

-- One open change per subject, and one open change per target address across every tenant.
CREATE UNIQUE INDEX email_change_requests_one_open_subject_idx
  ON core.email_change_requests (subject_id) WHERE state IN ('pending', 'approved');
CREATE UNIQUE INDEX email_change_requests_one_open_email_idx
  ON core.email_change_requests (new_email) WHERE state IN ('pending', 'approved');
CREATE INDEX email_change_requests_tenant_idx ON core.email_change_requests (tenant_id, requested_at DESC);

ALTER TABLE core.email_change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.email_change_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.email_change_requests
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

REVOKE ALL ON core.email_change_requests FROM PUBLIC;
GRANT SELECT ON core.email_change_requests TO mpc_app;

-- ---------------------------------------------------------------------------
-- Emailed code challenges
-- ---------------------------------------------------------------------------

CREATE TYPE core.email_challenge_purpose AS ENUM ('sign_in', 'invitation', 'email_change');

/**
 * One emailed code.
 *
 * Not tenant-scoped in the RLS sense: a sign-in challenge exists before anyone knows the tenant,
 * and one for an address with no account has no tenant at all. The application role has **no
 * privilege** on this table; only 0114's SECURITY DEFINER functions read or write it.
 *
 * A challenge for an address that has no account (`subject_id` NULL on a `sign_in` or
 * `email_change` challenge) is a decoy: it is written exactly like a real one, so asking for a
 * code does the same database work whether or not the address has an account, and checking a
 * code against it fails the same way, attempts and all. No mail is sent for it.
 */
CREATE TABLE core.email_challenges (
  id              UUID PRIMARY KEY,
  purpose         core.email_challenge_purpose NOT NULL,
  email           TEXT NOT NULL CHECK (email = core.normalize_email(email)),
  tenant_id       UUID REFERENCES core.tenants (id),
  -- The account the code is for. For an invitation, the subject the acceptance created.
  subject_id      UUID,
  invitation_id   UUID REFERENCES core.invitations (id),
  email_change_id UUID REFERENCES core.email_change_requests (id),
  -- HMAC-SHA256 of purpose, address and code under the key HKDF derives from SESSION_SECRET with
  -- info `mpc/email-code/v1`. The code itself is never stored here.
  code_hmac       BYTEA NOT NULL CHECK (length(code_hmac) = 32),
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  consumed_at     TIMESTAMPTZ,
  -- The transaction that consumed it. A session may name this challenge only from that same
  -- transaction (trigger below), so a consumed challenge cannot be reused for a second session.
  consumed_txid   xid8,
  superseded_at   TIMESTAMPTZ,
  CONSTRAINT email_challenges_lifetime CHECK (expires_at = created_at + interval '10 minutes'),
  CONSTRAINT email_challenges_consumed_shape CHECK ((consumed_at IS NULL) = (consumed_txid IS NULL)),
  CONSTRAINT email_challenges_tenant_with_subject CHECK (subject_id IS NULL OR tenant_id IS NOT NULL),
  CONSTRAINT email_challenges_invitation_shape
    CHECK ((purpose = 'invitation') = (invitation_id IS NOT NULL)),
  CONSTRAINT email_challenges_email_change_shape
    CHECK (email_change_id IS NULL OR purpose = 'email_change'),
  FOREIGN KEY (tenant_id, subject_id) REFERENCES core.subjects (tenant_id, id)
);

-- A new code supersedes the old: at most one live challenge per purpose and address.
CREATE UNIQUE INDEX email_challenges_one_live_idx
  ON core.email_challenges (purpose, email) WHERE consumed_at IS NULL AND superseded_at IS NULL;
CREATE INDEX email_challenges_created_idx ON core.email_challenges (created_at);

-- Forced RLS like every table with a tenant column, although no application role holds a
-- privilege here: a grant added by mistake later would still see only its own tenant's rows,
-- and never a decoy (no tenant).
ALTER TABLE core.email_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.email_challenges FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.email_challenges
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

REVOKE ALL ON core.email_challenges FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Rate limits shared by every API instance
-- ---------------------------------------------------------------------------

/**
 * One row per counted request. The in-process limiter in the API counts per replica; this one is
 * in the database so a limit per address holds however many replicas run and whichever address a
 * request comes from.
 *
 * `bucket` is `ip:<keyed hash>`, `email:<keyed hash>` (the API hashes both with the audit key, so
 * no address is stored here), or `invitation:<id>` / `email_change:<id>`.
 */
CREATE TABLE core.auth_rate_events (
  id          BIGSERIAL PRIMARY KEY,
  action      TEXT NOT NULL CHECK (action ~ '^[a-z][a-z_]{0,31}$'),
  bucket      TEXT NOT NULL CHECK (length(bucket) BETWEEN 1 AND 200),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX auth_rate_events_lookup_idx ON core.auth_rate_events (action, bucket, occurred_at);
CREATE INDEX auth_rate_events_occurred_idx ON core.auth_rate_events (occurred_at);

REVOKE ALL ON core.auth_rate_events FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Mail queue
-- ---------------------------------------------------------------------------

/**
 * Mail waiting for the jobs worker.
 *
 * **Not `core.outbox`.** That table carries domain events: its payloads are shown on the ops
 * screen, replayed by an operator command and read by several handlers. A sign-in code must reach
 * one mailbox once and then disappear, so it gets its own queue:
 *
 * - `recipient` and `params` (the code, or the invitation link) exist **only while the row is
 *   pending**. Every way a row settles — sent, failed, expired, superseded — clears both, and a
 *   CHECK makes a settled row holding either impossible. A code therefore sits in the database
 *   for the seconds between the request and the send, never longer than its 10-minute expiry.
 * - A row past `expires_at` is never sent: a late code would only confuse.
 * - A decoy challenge gets a `suppressed` row with no recipient, so the request that created it
 *   wrote the same rows as one for a real account (enumeration, plan §5).
 *
 * The API has no privilege here (0114's functions insert); the jobs worker reads and settles rows.
 */
CREATE TABLE core.email_outbox (
  id              UUID PRIMARY KEY,
  template        TEXT NOT NULL CHECK (template IN (
                    'sign_in_code', 'invitation_link', 'invitation_code',
                    'email_change_code', 'email_changed_notice'
                  )),
  recipient       TEXT CHECK (recipient IS NULL OR recipient = core.normalize_email(recipient)),
  params          JSONB,
  state           TEXT NOT NULL CHECK (state IN (
                    'pending', 'sent', 'failed', 'expired', 'superseded', 'suppressed'
                  )),
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ,
  -- A reason code (`resend_http_500`, `timeout`, …). Never a response body or an address.
  last_error      TEXT CHECK (last_error ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  settled_at      TIMESTAMPTZ,
  challenge_id    UUID REFERENCES core.email_challenges (id),
  invitation_id   UUID REFERENCES core.invitations (id),
  CONSTRAINT email_outbox_secret_only_while_pending
    CHECK ((state = 'pending') = (recipient IS NOT NULL AND params IS NOT NULL)),
  CONSTRAINT email_outbox_settled_shape CHECK ((state = 'pending') = (settled_at IS NULL))
);

CREATE INDEX email_outbox_due_idx ON core.email_outbox (created_at) WHERE state = 'pending';
CREATE INDEX email_outbox_settled_idx ON core.email_outbox (settled_at) WHERE state <> 'pending';
CREATE INDEX email_outbox_challenge_idx ON core.email_outbox (challenge_id);
CREATE INDEX email_outbox_invitation_idx ON core.email_outbox (invitation_id);

REVOKE ALL ON core.email_outbox FROM PUBLIC;
GRANT SELECT, UPDATE ON core.email_outbox TO mpc_worker;

/**
 * What the `log` mail transport "sent" — **test and local builds only**.
 *
 * End-to-end tests need the code a sign-in sent. The jobs worker refuses `EMAIL_TRANSPORT=log`
 * when `NODE_ENV=production`, so in production nothing writes here; elsewhere the worker records
 * the rendered message and tests read it over the migration connection. Rows go after a day.
 */
CREATE TABLE core.email_test_sink (
  id          BIGSERIAL PRIMARY KEY,
  outbox_id   UUID NOT NULL,
  template    TEXT NOT NULL,
  recipient   TEXT NOT NULL,
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

REVOKE ALL ON core.email_test_sink FROM PUBLIC;
GRANT INSERT ON core.email_test_sink TO mpc_worker;
GRANT USAGE ON SEQUENCE core.email_test_sink_id_seq TO mpc_worker;

-- ---------------------------------------------------------------------------
-- A session from an emailed code names the challenge it consumed
-- ---------------------------------------------------------------------------

-- 0108 let `core.create_subject_session` record `email_code` on the caller's word, and said
-- WP2 must bind it to a verified, consumed challenge. Sessions minted that way (only tests could
-- call it) proved nothing; they end here like the cut-over in 0108.
DELETE FROM core.sessions WHERE first_factor = 'email_code';

ALTER TABLE core.sessions
  ADD COLUMN email_challenge_id UUID REFERENCES core.email_challenges (id),
  ADD CONSTRAINT sessions_email_code_has_challenge
    CHECK ((first_factor = 'email_code') = (email_challenge_id IS NOT NULL)),
  -- One code, one session.
  ADD CONSTRAINT sessions_email_challenge_once UNIQUE (email_challenge_id);

/**
 * The challenge a new `email_code` session names was consumed **in this transaction**, for this
 * subject in this tenant.
 *
 * The CHECK above stops a session that names no challenge; this stops one that names a challenge
 * it did not just consume — an old one, someone else's, or one still unanswered. SECURITY
 * DEFINER only to read the challenge table, which no application role can.
 */
CREATE FUNCTION core.session_email_challenge_consumed() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
BEGIN
  IF NEW.email_challenge_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM core.email_challenges c
    WHERE c.id = NEW.email_challenge_id
      AND c.consumed_txid = pg_current_xact_id()
      AND c.subject_id = NEW.subject_id
      AND c.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'session names email challenge % that this transaction did not consume for its subject',
      NEW.email_challenge_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER sessions_email_challenge_consumed
  BEFORE INSERT OR UPDATE OF email_challenge_id, subject_id, tenant_id, first_factor ON core.sessions
  FOR EACH ROW EXECUTE FUNCTION core.session_email_challenge_consumed();

/**
 * Same as 0108, except that it no longer records `email_code`: that session is created only by
 * the function that consumed the code (0114). Google and Microsoft are bound to their verified
 * state rows by WP4; until then only tests call this.
 */
CREATE OR REPLACE FUNCTION core.create_subject_session(
  p_id UUID,
  p_token_hash TEXT,
  p_subject_id UUID,
  p_first_factor core.session_first_factor,
  p_second_factor core.session_second_factor,
  p_ttl_seconds INTEGER
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v_tenant UUID;
  v_expires TIMESTAMPTZ;
BEGIN
  IF p_first_factor = 'siwe_legacy' THEN
    RAISE EXCEPTION 'a wallet session is created by core.create_wallet_session'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_first_factor = 'email_code' THEN
    RAISE EXCEPTION 'an email-code session is created only by the function that consumes the code'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_ttl_seconds IS NULL OR p_ttl_seconds < 1 OR p_ttl_seconds > 28800 THEN
    RAISE EXCEPTION 'session TTL must be between 1 second and 8 hours'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT tenant_id INTO v_tenant FROM core.subjects WHERE id = p_subject_id AND kind = 'person';
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no person subject %', p_subject_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_tenant IS DISTINCT FROM core.current_tenant() THEN
    RAISE EXCEPTION 'subject % is not in the current tenant', p_subject_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO core.sessions (
    id, token_hash, tenant_id, subject_id, first_factor, second_factor, second_factor_at, expires_at
  ) VALUES (
    p_id, p_token_hash, v_tenant, p_subject_id, p_first_factor, p_second_factor,
    CASE WHEN p_second_factor IS NULL THEN NULL ELSE now() END,
    now() + make_interval(secs => p_ttl_seconds)
  )
  RETURNING expires_at INTO v_expires;
  RETURN v_expires;
END
$$;
