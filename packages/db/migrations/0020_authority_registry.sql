-- Authority Registry operational path — spec 02 §2.8, 05 §5.11, REQ-DAPP-043.
--
-- Until now authorities and source connections were created only in seeds and tests.
-- There was no path to register or update an institution in operation, so rows had to be INSERTed
-- directly into the DB, and then **who registered and who approved is not recorded.**
--
-- What 02 §2.8 defines: the Trust Registry operator registers, and an independent reviewer
-- performs the `accepted` transition. **An operator-only transition is forbidden.**

ALTER TABLE core.authorities
  -- Who proposed it as a candidate. It must not equal the approver, so it must be stored to check.
  ADD COLUMN registered_by UUID REFERENCES core.subjects(id),
  ADD COLUMN accepted_by   UUID REFERENCES core.subjects(id),
  ADD COLUMN accepted_at   TIMESTAMPTZ,
  -- Why it is in this state. `suspended`·`revoked` cannot exist without a reason.
  ADD COLUMN state_reason  TEXT;

/**
 * A state carries a reason.
 *
 * Suspending or revoking an authority affects every receipt that relied on it.
 * A change without a reason leaves "why did it become unusable" unanswerable later.
 */
ALTER TABLE core.authorities
  ADD CONSTRAINT authority_negative_state_needs_reason
  CHECK (
    state NOT IN ('suspended', 'revoked', 'superseded')
    OR (state_reason IS NOT NULL AND length(btrim(state_reason)) > 0)
  );

/**
 * Authority history — versioning for REQ-DAPP-043.
 *
 * The `version` column alone only guards concurrency. A Source Receipt relies on the authority
 * as of lookup time; if we cannot later reproduce **what this authority claimed to
 * confirm** at that time, the receipt's limitation text loses its basis.
 *
 * Append-only. If past versions can be edited, it is not history.
 */
CREATE TABLE core.authority_versions (
  id              UUID PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES core.tenants(id),
  authority_id    UUID NOT NULL,
  version         INTEGER NOT NULL,
  name            TEXT NOT NULL,
  jurisdiction    TEXT NOT NULL,
  proves          TEXT[] NOT NULL,
  does_not_prove  TEXT[] NOT NULL,
  recognized_scope TEXT[] NOT NULL,
  verification_method TEXT NOT NULL,
  public_disclosure_level core.sensitivity NOT NULL,
  valid_from      DATE NOT NULL,
  valid_until     DATE,
  state           core.authority_state NOT NULL,
  state_reason    TEXT,
  -- What changed and why.
  change_reason   TEXT NOT NULL CHECK (length(btrim(change_reason)) > 0),
  changed_by      UUID REFERENCES core.subjects(id),
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (authority_id, version),
  FOREIGN KEY (tenant_id, authority_id) REFERENCES core.authorities (tenant_id, id)
);

CREATE INDEX authority_versions_authority_idx
  ON core.authority_versions (authority_id, version DESC);

ALTER TABLE core.authority_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.authority_versions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON core.authority_versions
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

GRANT SELECT, INSERT ON core.authority_versions TO mpc_app;

CREATE OR REPLACE FUNCTION core.reject_authority_version_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Authority history cannot be modified or deleted';
END
$$;

CREATE TRIGGER authority_versions_append_only
  BEFORE UPDATE OR DELETE ON core.authority_versions
  FOR EACH ROW EXECUTE FUNCTION core.reject_authority_version_mutation();

/**
 * A connection of an unapproved authority cannot become active.
 *
 * What 02 §2.8 forbids: **turning API success into authority approval**.
 * Having a connection attached and deciding to trust that authority are different things;
 * without this constraint, just enabling a connection would skip the approval process.
 */
CREATE OR REPLACE FUNCTION core.check_connection_authority_accepted() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  authority_state core.authority_state;
BEGIN
  IF NEW.state <> 'active' THEN
    RETURN NEW;
  END IF;

  SELECT a.state INTO authority_state
  FROM core.authorities a WHERE a.id = NEW.authority_id;

  IF authority_state IS DISTINCT FROM 'accepted' THEN
    RAISE EXCEPTION 'A connection to an authority that is not accepted (%) cannot become active', authority_state;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER source_connections_require_accepted_authority
  BEFORE INSERT OR UPDATE ON core.source_connections
  FOR EACH ROW EXECUTE FUNCTION core.check_connection_authority_accepted();

/**
 * When an authority leaves the approved state, demote its connections — propagation for AC-04·AC-21.
 *
 * If an authority is suspended but its connection stays `active`, the UI keeps showing "connected"
 * and collection keeps running. Suspension loses its meaning.
 *
 * Demote to `degraded` — keep the connection settings, block only calls. `disabled` is
 * an explicit manual shutoff; using it here would make the two indistinguishable.
 */
CREATE OR REPLACE FUNCTION core.propagate_authority_state() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'accepted' AND NEW.state <> 'accepted' THEN
    UPDATE core.source_connections
    SET state = 'degraded'
    WHERE authority_id = NEW.id AND state = 'active';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER authorities_propagate_state
  AFTER UPDATE ON core.authorities
  FOR EACH ROW EXECUTE FUNCTION core.propagate_authority_state();

-- Leave an initial version for existing rows. Recording that history starts at this migration
-- is what lets us answer "why is there nothing before v1".
INSERT INTO core.authority_versions (
  id, tenant_id, authority_id, version, name, jurisdiction, proves, does_not_prove,
  recognized_scope, verification_method, public_disclosure_level,
  valid_from, valid_until, state, state_reason, change_reason
)
SELECT gen_random_uuid(), a.tenant_id, a.id, a.version, a.name, a.jurisdiction,
       a.proves, a.does_not_prove, a.recognized_scope, a.verification_method,
       a.public_disclosure_level, a.valid_from, a.valid_until, a.state, a.state_reason,
       'Initial record when history tracking began (migration 0020)'
FROM core.authorities a;
