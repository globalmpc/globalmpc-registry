-- One signing wallet per account, changed by replacing it — account authentication WP5 follow-up.
--
-- A wallet is a signing key, never a way to sign in (0122, 0125). An account holds **exactly one
-- active wallet at a time**, and an active address belongs to exactly one account: 1:1 both
-- ways. The holder changes it by binding another; disabling leaves the account with none.
--
-- 1. **Uniqueness of the active key, not of every key ever bound.** 0001 made
--    `(wallet_address, chain_id)` unique over every row, disabled ones included, so a disabled
--    address could never be bound again — not by the person who lost and found it, not by a new
--    holder. It is now unique among active rows only, and a second partial unique index keeps one
--    active wallet per subject. Two concurrent binds for one subject serialize on the subject row
--    (`core.mfa_lock_session`); the index is the backstop for any other writer.
--
-- 2. **Disabled rows are history and never change.** A trigger refuses any update of a row once
--    `disabled_at` is set — no revival, no move to another subject, no new address. A re-bind of
--    the same address inserts a new row; the old one keeps the subject that signed with it, so
--    attestations and gate decisions signed before keep naming the wallet row and subject that
--    signed (their `signer_wallet_address` is a frozen fact; nothing re-reads it against the live
--    binding). `core.bind_wallet_by_proof` returns the newest earlier row of the same address and
--    chain in any tenant (`rebind_of`) for the audit row.
--
--    **A compromised or admin-disabled key is never bound again**, by anyone, the same person
--    included: a key disabled as `key_compromised`, replaced with the cause `key_compromised`, or
--    disabled by an admin (the decider is not the wallet's subject) is refused at bind with
--    `WALLET_UNAVAILABLE` — the same code as an address active elsewhere, so the answer does not
--    say which. **A lost key comes back only to its own subject** (`key_lost`, directly or as a
--    replace cause; also a wallet consolidated by this migration, or disabled with no recorded
--    event): someone else may have found it. A key its holder retired for `rotation` or
--    `offboarding` can be bound by anyone who proves it (a key handed on). Every comparison is
--    NULL-safe and an unknown refuses. The history is read across tenants, with
--    `row_security = off`: the function's owner must bypass RLS (superuser or BYPASSRLS), and an
--    owner that does not makes the bind fail loudly rather than check one tenant only.
--
-- 3. **Bind and replace are one ceremony.** The challenge records the subject's active wallet
--    when it is issued (`replaces_wallet_id`) and says so to the caller, so the screen can show
--    "this will replace 0xabc…" before anyone signs. At bind time, in one transaction under the
--    subject lock: the active wallet must still be the one the challenge named (otherwise the
--    challenge is stale and refused), the old wallet is disabled with reason `replaced`, and the
--    new one is inserted. Never zero, never two. A bind needs the strongest factor held, as in
--    0122 — a replace is a bind. Binding the address that is already the active wallet is refused.
--    The holder says why (`replace_cause`: `rotation` by default, `key_lost`, `key_compromised`);
--    it is recorded on the `replaced` disable event and read by the re-bind refusal above.
--
--    **Assurance.** A replace is a disable of the old wallet, and follows the disable rule: when
--    the replaced wallet was operator-verified (`bound_via = 'operator'`), the subject's identity
--    assurance falls to the floor (`wallet_only`) until an admin verifies the person again — that
--    verification was of that wallet. Otherwise the level stays. The bind rule still holds: a
--    proof never raises it.
--
--    **Sessions.** A replace keeps the account's sessions. The old key is disabled in the same
--    transaction, so no signature from it is accepted afterwards, and a wallet signs nobody in, so
--    no session rests on it; the replace itself needed the strongest factor. Disabling without a
--    replacement still ends every session of the subject (AC-27, unchanged) — that is the path for
--    a lost or compromised key, and it leaves the account with no signing wallet.
--
-- 4. **Governance (D9): the active wallet is the governance wallet.** There is nothing left to
--    designate, so `core.designate_governance_wallet` and `subjects.governance_wallet_id` are
--    dropped; vote weight on a snapshot proposal is read from the voter's active wallet. A vote now
--    records the wallet its weight came from (`weight_wallet_address`), unique per proposal, and a
--    trigger pins that wallet and weight once written: after a replace, the voter may change their
--    choice but the weight stays the first wallet's, and a new holder of that wallet cannot vote
--    with its balance again on the same proposal.
--
-- 5. **Consolidation of existing data.** Before 0130 nothing stopped a subject holding several
--    active wallets (dev and seed data only; production binds were one per person). For each such
--    subject this migration keeps one active wallet — the designated governance wallet if it is
--    still active; otherwise an operator-verified one (`bound_via = 'operator'`) before a proof
--    binding, then the highest `assurance_level`; then the most recently bound one (`bound_at`,
--    then `created_at`, then id, all descending) — and disables every other one with reason
--    `consolidated_single_wallet`,
--    recorded in `wallet_disable_events` with no deciding person (`disabled_by_subject_id` NULL,
--    allowed for this reason only) and one `migration.wallet.consolidated` audit row per wallet
--    (no actor: a migration is not a person). No session is revoked: the subject keeps a wallet
--    and no key changed hands. Snapshot votes cast before 0130 are given the wallet whose recorded
--    weight they used when exactly one of the voter's wallets matches; others stay NULL and keep
--    their weight on re-vote.
--
--    *Edited in place after review (final cross-package review, F4).* The first revision kept the
--    newest wallet whatever its binding, so a later dev-chain proof wallet won over the
--    operator-verified key. The keep order above replaced it here rather than in a later
--    migration because consolidation runs once: a forward migration could not undo a choice
--    already made. No shared environment had applied this migration; databases that applied the
--    first revision keep its choice. The chain cannot be told apart here (`CHAIN_ID` is runtime
--    configuration), so the order does not try.
--
-- 6. **Admins disable, never bind.** Unchanged from 0122: the application role has no INSERT on
--    wallets and only `UPDATE (disabled_at, version)`; the freeze trigger stops it re-enabling one.
--    `replaced` and `consolidated_single_wallet` are system reasons a person cannot choose, and a
--    trigger refuses either on any insert not made by the table owner — the definer functions and
--    this migration — so the application role cannot forge a replace cause or a decider-less row.
--
-- | Case | Identity namespace | Authority | Frozen vs live | Input scope | Status priority | Result |
-- | --- | --- | --- | --- | --- | --- | --- |
-- | Bind, no active wallet | subject in its tenant; address+chain global among active rows | holder, strongest factor, proof | live: new row | challenge row only | — | bound |
-- | Bind, active wallet W | same | same | W frozen (disabled `replaced` + cause), new row live | challenge row; W must equal `replaces_wallet_id`; cause from the holder | the bind wins over W, atomically | replaced; sessions kept; operator-verified W drops assurance to `wallet_only` |
-- | Bind, wallet changed since the challenge | same | — | — | challenge is stale | the current wallet wins | `WALLET_CHALLENGE_INVALID` |
-- | Bind the active address again | same | — | — | — | — | `WALLET_ALREADY_ACTIVE` |
-- | Bind an address active elsewhere | global | — | — | — | the active holder wins | `WALLET_UNAVAILABLE` |
-- | Bind a disabled address (same or new holder) | global for `rebind_of` | holder, proof | old row frozen, new row live | — | — | bound, audited with `rebind_of` |
-- | Bind an address ever compromised or admin-disabled | global history | — | old rows frozen | every disable event of the address | the compromise / admin decision wins | `WALLET_UNAVAILABLE` |
-- | Bind an address lost / consolidated / disabled without an event, as another subject | global history | — | old rows frozen | NULL subject or decider counts as another | the earlier holder wins | `WALLET_UNAVAILABLE` (the same subject re-binds) |
-- | App role inserts a `replaced` / consolidated event | — | owner only | — | — | — | `WALLET_REASON_INVALID` |
-- | Disable own wallet | subject | holder, aal2 | row frozen | reason chosen by the person | — | every session ends (AC-27) |
-- | Admin disable | subject | admin | row frozen | — | — | every session ends (AC-27) |
-- | Signature after replace from the old key | subject | — | old signatures frozen | signer must be the active wallet | live binding | `SIGNATURE_SIGNER_MISMATCH` |
-- | Vote again after replace | proposal+subject; proposal+wallet | voter | weight and wallet pinned at first vote (snapshot: weight pinned even with no wallet recorded) | choice only | first vote's weight | choice changes, weight does not |
-- | New holder of a wallet that already voted | proposal+wallet | — | pinned | — | first vote | `GOVERNANCE_WALLET_ALREADY_VOTED` |

SELECT set_config('lock_timeout', '5s', true);

-- ---------------------------------------------------------------------------
-- System disable reasons
-- ---------------------------------------------------------------------------

ALTER TABLE core.wallet_disable_events
  DROP CONSTRAINT wallet_disable_events_reason_code_check,
  ADD CONSTRAINT wallet_disable_events_reason_code_check CHECK (
    reason_code IN ('key_lost', 'key_compromised', 'rotation', 'offboarding', 'replaced', 'consolidated_single_wallet')
  ),
  ALTER COLUMN disabled_by_subject_id DROP NOT NULL,
  -- Only the migration's consolidation has no deciding person.
  ADD CONSTRAINT wallet_disable_events_decider CHECK (
    (disabled_by_subject_id IS NULL) = (reason_code = 'consolidated_single_wallet')
  ),
  -- Why the holder replaced the key: a replace is a disable, and a compromised key stays refused.
  ADD COLUMN replace_cause TEXT CHECK (replace_cause IN ('rotation', 'key_lost', 'key_compromised')),
  ADD CONSTRAINT wallet_disable_events_replace_cause CHECK (
    (replace_cause IS NOT NULL) = (reason_code = 'replaced')
  );

/**
 * System reasons are written only by this database's own functions. The application role inserts
 * disable events for the admin disable (0028) with a person's reason; it must not be able to
 * write `replaced` (whose cause a re-bind reads) or `consolidated_single_wallet` (no decider).
 * The SECURITY DEFINER functions and migrations run as the table's owner; the application role
 * is not the owner and is not a member of it, so a direct insert of either reason is refused.
 */
CREATE FUNCTION core.wallet_disable_events_system_reason() RETURNS trigger
LANGUAGE plpgsql
SET search_path = core, pg_temp
AS $$
BEGIN
  IF NEW.reason_code IN ('replaced', 'consolidated_single_wallet')
     AND NOT pg_has_role(current_user, (SELECT c.relowner FROM pg_class c WHERE c.oid = TG_RELID), 'USAGE') THEN
    RAISE EXCEPTION 'WALLET_REASON_INVALID: % is recorded only by the database', NEW.reason_code
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER wallet_disable_events_system_reason
  BEFORE INSERT OR UPDATE ON core.wallet_disable_events
  FOR EACH ROW EXECUTE FUNCTION core.wallet_disable_events_system_reason();

-- ---------------------------------------------------------------------------
-- 5. Consolidation, then 4. the votes' weight wallet (both read the governance designation)
-- ---------------------------------------------------------------------------

ALTER TABLE core.governance_votes
  ADD COLUMN weight_wallet_address TEXT CHECK (weight_wallet_address ~ '^0x[0-9a-f]{40}$');

-- Same handling as 0108: `row_security = off` turns a filtered read into an error, and a role that
-- does not bypass RLS lifts FORCE for the statement and puts it back, inside this transaction.
DO $$
DECLARE
  lift BOOLEAN := NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user);
  r RECORD;
BEGIN
  PERFORM set_config('row_security', 'off', true);
  IF lift THEN
    ALTER TABLE core.subjects NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE core.wallet_identities NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE core.wallet_disable_events NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE core.governance_votes NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE core.governance_vote_weights NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE core.governance_proposals NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE audit.events NO FORCE ROW LEVEL SECURITY;
  END IF;

  -- Snapshot votes: the voter's wallet whose recorded weight the vote carries, when exactly one
  -- matches (addresses were unique over all rows before 0130, so each belongs to one subject).
  UPDATE core.governance_votes v
  SET weight_wallet_address = m.wallet_address
  FROM (
    SELECT v2.id, min(vw.wallet_address) AS wallet_address
    FROM core.governance_votes v2
    JOIN core.governance_proposals p ON p.id = v2.proposal_id AND p.snapshot_block IS NOT NULL
    JOIN core.governance_vote_weights vw ON vw.proposal_id = v2.proposal_id AND vw.weight = v2.weight
    JOIN core.wallet_identities w ON w.wallet_address = vw.wallet_address AND w.subject_id = v2.voter_subject_id
    GROUP BY v2.id
    HAVING count(DISTINCT vw.wallet_address) = 1
  ) m
  WHERE m.id = v.id;

  FOR r IN
    SELECT w.id, w.tenant_id, w.subject_id, w.version, keep.id AS kept_id
    FROM core.wallet_identities w
    JOIN LATERAL (
      SELECT k.id
      FROM core.wallet_identities k
      JOIN core.subjects s ON s.id = k.subject_id
      WHERE k.subject_id = w.subject_id AND k.disabled_at IS NULL
      ORDER BY COALESCE(k.id = s.governance_wallet_id, false) DESC,
        (k.bound_via = 'operator') DESC,
        k.assurance_level DESC,
        k.bound_at DESC NULLS LAST, k.created_at DESC, k.id DESC
      LIMIT 1
    ) keep ON true
    WHERE w.subject_id IS NOT NULL AND w.disabled_at IS NULL AND w.id <> keep.id
    ORDER BY w.subject_id, w.id
  LOOP
    UPDATE core.wallet_identities SET disabled_at = now(), version = version + 1 WHERE id = r.id;
    INSERT INTO core.wallet_disable_events (
      id, tenant_id, wallet_identity_id, reason_code, detail, disabled_by_subject_id
    ) VALUES (
      gen_random_uuid(), r.tenant_id, r.id, 'consolidated_single_wallet',
      'Migration 0130: one active signing wallet per account; kept ' || r.kept_id::text, NULL
    );
    INSERT INTO audit.events (
      tenant_id, actor_subject_id, actor_wallet, effective_role, command, resource_type, resource_id,
      before_version, after_version, reason, correlation_id, detail
    ) VALUES (
      r.tenant_id, NULL, NULL, NULL, 'migration.wallet.consolidated', 'wallet_identity', r.id,
      r.version, r.version + 1, 'consolidated_single_wallet', 'migration-0130',
      jsonb_build_object('subjectId', r.subject_id, 'keptWalletId', r.kept_id, 'revokedSessions', 0)
    );
  END LOOP;

  IF lift THEN
    ALTER TABLE core.subjects FORCE ROW LEVEL SECURITY;
    ALTER TABLE core.wallet_identities FORCE ROW LEVEL SECURITY;
    ALTER TABLE core.wallet_disable_events FORCE ROW LEVEL SECURITY;
    ALTER TABLE core.governance_votes FORCE ROW LEVEL SECURITY;
    ALTER TABLE core.governance_vote_weights FORCE ROW LEVEL SECURITY;
    ALTER TABLE core.governance_proposals FORCE ROW LEVEL SECURITY;
    ALTER TABLE audit.events FORCE ROW LEVEL SECURITY;
  END IF;
  PERFORM set_config('row_security', 'on', true);
END
$$;

-- ---------------------------------------------------------------------------
-- 1. Uniqueness among active wallets
-- ---------------------------------------------------------------------------

ALTER TABLE core.wallet_identities DROP CONSTRAINT wallet_identities_wallet_address_chain_id_key;

CREATE UNIQUE INDEX wallet_identities_active_address_key
  ON core.wallet_identities (wallet_address, chain_id) WHERE disabled_at IS NULL;

CREATE UNIQUE INDEX wallet_identities_one_active_per_subject
  ON core.wallet_identities (subject_id) WHERE disabled_at IS NULL;

-- History lookups (`rebind_of`) by address.
CREATE INDEX wallet_identities_address_idx ON core.wallet_identities (wallet_address, chain_id);

-- ---------------------------------------------------------------------------
-- 2. A disabled row never changes
-- ---------------------------------------------------------------------------

CREATE FUNCTION core.wallet_identities_frozen_when_disabled() RETURNS trigger
LANGUAGE plpgsql
SET search_path = core, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'WALLET_HISTORY_FROZEN: a disabled wallet row is history and is never changed'
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER wallet_identities_frozen_when_disabled
  BEFORE UPDATE ON core.wallet_identities
  FOR EACH ROW WHEN (OLD.disabled_at IS NOT NULL)
  EXECUTE FUNCTION core.wallet_identities_frozen_when_disabled();

-- ---------------------------------------------------------------------------
-- 4. Governance: the active wallet, and a pinned weight per vote
-- ---------------------------------------------------------------------------

DROP FUNCTION core.designate_governance_wallet(UUID, UUID, INTEGER);
ALTER TABLE core.subjects DROP CONSTRAINT subjects_governance_wallet_own;
ALTER TABLE core.subjects DROP COLUMN governance_wallet_id;

-- One use of a wallet's snapshot balance per proposal, whoever holds the wallet now.
CREATE UNIQUE INDEX governance_votes_weight_wallet_key
  ON core.governance_votes (proposal_id, weight_wallet_address) WHERE weight_wallet_address IS NOT NULL;

/**
 * Pins a vote's weight wallet, and — on a snapshot proposal — its weight, whether or not a wallet
 * was recorded (votes from before 0130 may have none). Live-weight proposals keep re-weighing.
 * SECURITY DEFINER so the proposal is read whatever tenant context the writer set.
 */
CREATE FUNCTION core.governance_votes_pin_weight() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
BEGIN
  IF NEW.weight_wallet_address IS DISTINCT FROM OLD.weight_wallet_address
     OR (NEW.weight IS DISTINCT FROM OLD.weight AND (
           OLD.weight_wallet_address IS NOT NULL
           OR EXISTS (SELECT 1 FROM core.governance_proposals p
                      WHERE p.id = OLD.proposal_id AND p.snapshot_block IS NOT NULL))) THEN
    RAISE EXCEPTION 'GOVERNANCE_VOTE_WEIGHT_PINNED: a snapshot vote keeps the wallet and weight it was first cast with'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER governance_votes_pin_weight
  BEFORE UPDATE ON core.governance_votes
  FOR EACH ROW EXECUTE FUNCTION core.governance_votes_pin_weight();

-- ---------------------------------------------------------------------------
-- 3. The challenge names the wallet it replaces
-- ---------------------------------------------------------------------------

-- A challenge still live from before 0130 names no wallet to replace: for an account that holds
-- one it is stale at bind time and refused, so the screen never replaced a key it did not show.
ALTER TABLE core.wallet_binding_challenges
  ADD COLUMN replaces_wallet_id UUID REFERENCES core.wallet_identities (id);

DROP FUNCTION core.create_wallet_binding_challenge(UUID, UUID, TEXT, INTEGER, TEXT);
DROP FUNCTION core.live_wallet_binding_challenge(UUID, UUID);
DROP FUNCTION core.bind_wallet_by_proof(UUID, UUID, TEXT, UUID);

/**
 * Issues the session's binding challenge for one address on one chain, recording the subject's
 * active wallet (if any) as the one this binding will replace, and returns it with the times.
 * A session holds one live challenge; asking again replaces it. Refused to a session that could
 * not complete the binding, and for the address that already is the active wallet.
 */
CREATE FUNCTION core.create_wallet_binding_challenge(
  p_session_id UUID,
  p_challenge_id UUID,
  p_wallet TEXT,
  p_chain_id INTEGER,
  p_nonce TEXT
) RETURNS TABLE (
  issued_at TIMESTAMPTZ, expires_at TIMESTAMPTZ, tenant_id UUID, subject_id UUID,
  replaces_wallet_id UUID, replaces_wallet_address TEXT, replaces_chain_id INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v core.sessions := core.mfa_lock_session(p_session_id);
  v_active core.wallet_identities;
BEGIN
  PERFORM core.wallet_assert_session(v, 2, true);

  SELECT * INTO v_active FROM core.wallet_identities w
  WHERE w.subject_id = v.subject_id AND w.tenant_id = v.tenant_id AND w.disabled_at IS NULL;
  IF v_active.id IS NOT NULL AND v_active.wallet_address = lower(p_wallet) AND v_active.chain_id = p_chain_id THEN
    RAISE EXCEPTION 'WALLET_ALREADY_ACTIVE: this wallet already is the account''s signing wallet'
      USING ERRCODE = 'unique_violation';
  END IF;

  DELETE FROM core.wallet_binding_challenges c WHERE c.session_id = v.id AND c.consumed_at IS NULL;
  RETURN QUERY
  INSERT INTO core.wallet_binding_challenges AS c (
    id, tenant_id, subject_id, session_id, wallet_address, chain_id, nonce, issued_at, expires_at,
    replaces_wallet_id
  ) VALUES (
    p_challenge_id, v.tenant_id, v.subject_id, v.id, lower(p_wallet), p_chain_id, p_nonce,
    date_trunc('second', now()), date_trunc('second', now()) + interval '5 minutes', v_active.id
  )
  RETURNING c.issued_at, c.expires_at, c.tenant_id, c.subject_id,
    c.replaces_wallet_id, v_active.wallet_address, v_active.chain_id;
END
$$;

/**
 * The session's live binding challenge with that id, or no row. The API rebuilds the signed
 * message from it — never from the request — and verifies the signature against it.
 */
CREATE FUNCTION core.live_wallet_binding_challenge(p_session_id UUID, p_challenge_id UUID)
RETURNS TABLE (
  id UUID, tenant_id UUID, subject_id UUID, wallet_address TEXT, chain_id INTEGER, nonce TEXT,
  issued_at TIMESTAMPTZ, expires_at TIMESTAMPTZ, replaces_wallet_id UUID
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = core, pg_temp
AS $$
  SELECT c.id, c.tenant_id, c.subject_id, c.wallet_address, c.chain_id, c.nonce, c.issued_at,
         c.expires_at, c.replaces_wallet_id
  FROM core.wallet_binding_challenges c
  WHERE c.id = p_challenge_id AND c.session_id = p_session_id AND c.tenant_id = core.current_tenant()
    AND c.consumed_at IS NULL AND c.expires_at > now()
$$;

/**
 * Binds the challenge's wallet to the session's subject after the API verified that `p_signer`
 * signed it, replacing the subject's active wallet if it has one — in this transaction, under the
 * subject lock: the old wallet is disabled (`replaced`) and the new one inserted, so the account
 * never holds zero or two. The challenge is spent here; a second call finds it spent.
 *
 * `p_replace_cause` is why the holder replaces the active wallet (`rotation`, `key_lost`,
 * `key_compromised`); it is recorded only when there is one to replace.
 *
 * Refusals: a challenge issued before the account's wallet changed is stale
 * (`WALLET_CHALLENGE_INVALID`); an address active anywhere, or ever compromised or disabled by an
 * admin, is `WALLET_UNAVAILABLE` — one code, so the answer does not say where or why.
 *
 * Returns the replaced wallet (or NULLs), the newest earlier row of this address and chain in any
 * tenant (`rebind_of`, for the audit), and the subject's identity assurance before and after.
 */
CREATE FUNCTION core.bind_wallet_by_proof(
  p_session_id UUID,
  p_challenge_id UUID,
  p_signer TEXT,
  p_wallet_id UUID,
  p_replace_cause TEXT
) RETURNS TABLE (
  wallet_id UUID, wallet_address TEXT, chain_id INTEGER,
  previous_assurance core.assurance_level, assurance core.assurance_level,
  replaced_wallet_id UUID, replaced_wallet_address TEXT, replaced_chain_id INTEGER,
  replaced_bound_via TEXT, rebind_of UUID, rebind_same_subject BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
-- The re-bind history is read in every tenant. An owner without BYPASSRLS would see only the
-- current tenant's rows under FORCE RLS and quietly narrow the check; with row security off, it
-- fails loudly instead ("query would be affected by row-level security policy").
SET row_security = off
AS $$
#variable_conflict use_column
DECLARE
  v core.sessions := core.mfa_lock_session(p_session_id);
  v_challenge core.wallet_binding_challenges;
  v_active core.wallet_identities;
  v_rebind core.wallet_identities;
  v_before core.assurance_level;
  v_after core.assurance_level;
BEGIN
  PERFORM core.wallet_assert_session(v, 2, true);

  IF p_replace_cause IS NULL OR p_replace_cause NOT IN ('rotation', 'key_lost', 'key_compromised') THEN
    RAISE EXCEPTION 'WALLET_REASON_INVALID: not a reason a person gives for replacing a wallet'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_challenge FROM core.wallet_binding_challenges c
  WHERE c.id = p_challenge_id AND c.session_id = v.id AND c.tenant_id = v.tenant_id
    AND c.subject_id = v.subject_id AND c.consumed_at IS NULL AND c.expires_at > now()
  FOR UPDATE;
  IF NOT FOUND OR v_challenge.wallet_address <> lower(p_signer) THEN
    RAISE EXCEPTION 'WALLET_CHALLENGE_INVALID: no live binding challenge of this session matches'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_active FROM core.wallet_identities w
  WHERE w.subject_id = v.subject_id AND w.tenant_id = v.tenant_id AND w.disabled_at IS NULL
  FOR UPDATE;
  -- The screen showed what this binding replaces; if that changed, the person did not agree.
  IF v_active.id IS DISTINCT FROM v_challenge.replaces_wallet_id THEN
    RAISE EXCEPTION 'WALLET_CHALLENGE_INVALID: the account''s wallet changed since this challenge'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_active.id IS NOT NULL AND v_active.wallet_address = v_challenge.wallet_address
     AND v_active.chain_id = v_challenge.chain_id THEN
    RAISE EXCEPTION 'WALLET_ALREADY_ACTIVE: this wallet already is the account''s signing wallet'
      USING ERRCODE = 'unique_violation';
  END IF;

  -- History of this address in every tenant: a key moves between accounts, not between tenants'
  -- views of it. Every comparison is NULL-safe and an unknown answers "refuse":
  --   * compromised (directly, or as the cause of a replace): never again, not even the same person;
  --   * disabled by an admin (decider is not the wallet's subject, a NULL subject included): never;
  --   * lost (directly or as a replace cause), consolidated by 0130, or disabled with no recorded
  --     event: only the subject that held it — someone else may have found the key;
  --   * rotation and offboarding by the holder: anyone who proves the key.
  -- One refusal code, so the answer does not say why.
  IF EXISTS (
    SELECT 1 FROM core.wallet_identities w
    LEFT JOIN core.wallet_disable_events e ON e.wallet_identity_id = w.id
    WHERE w.wallet_address = v_challenge.wallet_address AND w.chain_id = v_challenge.chain_id
      AND w.disabled_at IS NOT NULL
      AND (
        e.reason_code IS NOT DISTINCT FROM 'key_compromised'
        OR e.replace_cause IS NOT DISTINCT FROM 'key_compromised'
        OR (e.id IS NOT NULL
            AND e.reason_code IS DISTINCT FROM 'consolidated_single_wallet'
            AND e.disabled_by_subject_id IS DISTINCT FROM w.subject_id)
        OR ((e.id IS NULL
             OR e.reason_code IS NOT DISTINCT FROM 'key_lost'
             OR e.replace_cause IS NOT DISTINCT FROM 'key_lost'
             OR e.reason_code IS NOT DISTINCT FROM 'consolidated_single_wallet')
            AND w.subject_id IS DISTINCT FROM v.subject_id)
      )
  ) THEN
    RAISE EXCEPTION 'WALLET_UNAVAILABLE: this wallet cannot be bound'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_rebind FROM core.wallet_identities w
  WHERE w.wallet_address = v_challenge.wallet_address AND w.chain_id = v_challenge.chain_id
    AND w.disabled_at IS NOT NULL
  ORDER BY w.disabled_at DESC, w.created_at DESC, w.id DESC
  LIMIT 1;

  SELECT s.assurance_level INTO v_before FROM core.subjects s WHERE s.id = v.subject_id;
  v_after := v_before;

  IF v_active.id IS NOT NULL THEN
    UPDATE core.wallet_identities SET disabled_at = now(), version = version + 1 WHERE id = v_active.id;
    INSERT INTO core.wallet_disable_events (
      id, tenant_id, wallet_identity_id, reason_code, replace_cause, detail, disabled_by_subject_id
    ) VALUES (
      gen_random_uuid(), v.tenant_id, v_active.id, 'replaced', p_replace_cause,
      'Replaced by wallet ' || p_wallet_id::text, v.subject_id
    );
    -- As a disable of an operator-bound wallet (0122): the operator's verification went with that
    -- wallet, so the level falls to the floor until an admin verifies the person again.
    IF v_active.bound_via = 'operator' THEN
      v_after := 'wallet_only';
    END IF;
  END IF;

  BEGIN
    INSERT INTO core.wallet_identities (
      id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at, bound_via
    ) VALUES (
      p_wallet_id, v.tenant_id, v.subject_id, v_challenge.wallet_address, v_challenge.chain_id,
      'wallet_only', now(), 'proof'
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'WALLET_UNAVAILABLE: this wallet cannot be bound'
      USING ERRCODE = 'insufficient_privilege';
  END;

  UPDATE core.wallet_binding_challenges
  SET consumed_at = now(), wallet_identity_id = p_wallet_id
  WHERE id = v_challenge.id;

  -- The bind rule (0122): a proof never raises the level; the higher of the two stays.
  -- (The new row is `wallet_only`, so this keeps v_after.)
  v_after := GREATEST(
    v_after,
    (SELECT max(w.assurance_level) FROM core.wallet_identities w
     WHERE w.subject_id = v.subject_id AND w.tenant_id = v.tenant_id AND w.disabled_at IS NULL)
  );
  IF v_after IS DISTINCT FROM v_before THEN
    UPDATE core.subjects SET assurance_level = v_after, version = version + 1 WHERE id = v.subject_id;
  END IF;

  RETURN QUERY SELECT p_wallet_id, v_challenge.wallet_address, v_challenge.chain_id, v_before, v_after,
    v_active.id, v_active.wallet_address, v_active.chain_id, v_active.bound_via,
    v_rebind.id, CASE WHEN v_rebind.id IS NULL THEN NULL ELSE v_rebind.subject_id = v.subject_id END;
END
$$;

-- ---------------------------------------------------------------------------
-- 6. A person chooses only a person's reasons
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION core.disable_own_wallet(
  p_session_id UUID,
  p_wallet_id UUID,
  p_reason_code TEXT,
  p_detail TEXT
) RETURNS TABLE (
  wallet_address TEXT, chain_id INTEGER, bound_via TEXT, version INTEGER, revoked_sessions INTEGER,
  previous_assurance core.assurance_level, assurance core.assurance_level
)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v core.sessions := core.mfa_lock_session(p_session_id);
  v_wallet core.wallet_identities;
  v_before core.assurance_level;
  v_after core.assurance_level;
  v_revoked INTEGER;
BEGIN
  PERFORM core.wallet_assert_session(v, 2, false);

  IF p_reason_code IS NULL OR p_reason_code NOT IN ('key_lost', 'key_compromised', 'rotation', 'offboarding') THEN
    RAISE EXCEPTION 'WALLET_REASON_INVALID: not a reason a person gives' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_wallet FROM core.wallet_identities w
  WHERE w.id = p_wallet_id AND w.subject_id = v.subject_id AND w.tenant_id = v.tenant_id
    AND w.disabled_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WALLET_UNKNOWN: not an active wallet of this subject' USING ERRCODE = 'no_data_found';
  END IF;

  UPDATE core.wallet_identities SET disabled_at = now(), version = version + 1 WHERE id = v_wallet.id;
  INSERT INTO core.wallet_disable_events (
    id, tenant_id, wallet_identity_id, reason_code, detail, disabled_by_subject_id
  ) VALUES (gen_random_uuid(), v.tenant_id, v_wallet.id, p_reason_code, p_detail, v.subject_id);

  SELECT s.assurance_level INTO v_before FROM core.subjects s WHERE s.id = v.subject_id;
  v_after := v_before;
  IF v_wallet.bound_via = 'operator' THEN
    v_after := COALESCE(
      (SELECT max(w.assurance_level) FROM core.wallet_identities w
       WHERE w.subject_id = v.subject_id AND w.tenant_id = v.tenant_id AND w.disabled_at IS NULL),
      'wallet_only'
    );
    IF v_after IS DISTINCT FROM v_before THEN
      UPDATE core.subjects SET assurance_level = v_after, version = version + 1 WHERE id = v.subject_id;
    END IF;
  END IF;

  -- AC-27: whoever may hold the key must not keep a session.
  UPDATE core.sessions SET revoked_at = now(), revoked_reason = 'wallet_disabled'
  WHERE subject_id = v.subject_id AND tenant_id = v.tenant_id AND revoked_at IS NULL;
  GET DIAGNOSTICS v_revoked = ROW_COUNT;

  RETURN QUERY SELECT v_wallet.wallet_address, v_wallet.chain_id, v_wallet.bound_via,
    v_wallet.version + 1, v_revoked, v_before, v_after;
END
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

-- The weight wallet is written once, with the vote; the trigger pins it on every update.
REVOKE UPDATE ON core.governance_votes FROM mpc_app;
GRANT UPDATE (choice, weight, cast_at) ON core.governance_votes TO mpc_app;

REVOKE EXECUTE ON FUNCTION
  core.create_wallet_binding_challenge(UUID, UUID, TEXT, INTEGER, TEXT),
  core.live_wallet_binding_challenge(UUID, UUID),
  core.bind_wallet_by_proof(UUID, UUID, TEXT, UUID, TEXT)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  core.create_wallet_binding_challenge(UUID, UUID, TEXT, INTEGER, TEXT),
  core.live_wallet_binding_challenge(UUID, UUID),
  core.bind_wallet_by_proof(UUID, UUID, TEXT, UUID, TEXT)
TO mpc_app;

SELECT set_config('lock_timeout', '0', true);
