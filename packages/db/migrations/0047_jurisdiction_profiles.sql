-- Jurisdiction profile as reviewed data — spec 04 §4.9, 02 §2.8, OD-43.
--
-- **Why:** the readiness assessment context carried a fixed profile state (`approved`) and a
-- fixed environmental requirement basis for one country. A suspended profile still assessed as
-- approved, and every jurisdiction inherited that one country's environmental law — the Core
-- hard-coding OD-43 rules out.
--
-- The profile key is the value `compliance_policy_sets.jurisdiction_profile` already carries, so
-- a policy set names the profile it is assessed under.
--
-- **Versions, not edits.** A change is a proposal in `core.registry_proposals` (0043) with kind
-- `jurisdiction_profile`; when someone other than the proposer approves it, the next version is
-- inserted here. Nothing updates or deletes a version, so an assessment made before a suspension
-- can still be explained by the version it read.
--
-- **Only reviewed states are stored.** Of the 04 §4.9 machine, `drafting` is a proposal not yet
-- sent and `review_ready` is a pending proposal. A row exists only after approval, so it is
-- `approved`, `stale` or `suspended`. Transitions between versions follow the same machine as
-- `jurisdictionProfileMachine` in @mpc/domain; a version that keeps the state revises content.
--
-- The reporting standard stays out of this table until OD-46 decides where it lives.

ALTER TYPE core.registry_kind ADD VALUE 'jurisdiction_profile';

CREATE TABLE core.jurisdiction_profiles (
  id                              UUID PRIMARY KEY,
  tenant_id                       UUID NOT NULL REFERENCES core.tenants(id),
  jurisdiction                    TEXT NOT NULL CHECK (length(btrim(jurisdiction)) > 0),
  profile_version                 INTEGER NOT NULL CHECK (profile_version > 0),
  state                           TEXT NOT NULL CHECK (state IN ('approved', 'stale', 'suspended')),
  -- Absent means "no basis recorded". Readiness then reports not_evaluable instead of guessing.
  environmental_requirement_basis TEXT
                                    CHECK (environmental_requirement_basis IS NULL
                                           OR length(btrim(environmental_requirement_basis)) > 0),
  -- Readiness reads the latest version effective at its evaluation time.
  effective_from                  TIMESTAMPTZ NOT NULL,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, jurisdiction, profile_version)
);

/**
 * Versions are consecutive and follow the state machine.
 *
 * The API checks the same before it writes, to say why. This keeps a direct write — or two
 * approvals racing past the API check — from skipping a version, taking effect before the
 * previous version, or leaving `suspended` for `stale`. A race for the same version number is
 * caught by the UNIQUE constraint.
 */
CREATE OR REPLACE FUNCTION core.guard_jurisdiction_profile_version() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  previous_version        INTEGER;
  previous_state          TEXT;
  previous_effective_from TIMESTAMPTZ;
BEGIN
  SELECT profile_version, state, effective_from
    INTO previous_version, previous_state, previous_effective_from
  FROM core.jurisdiction_profiles
  WHERE tenant_id = NEW.tenant_id AND jurisdiction = NEW.jurisdiction
  ORDER BY profile_version DESC
  LIMIT 1;

  IF previous_version IS NULL THEN
    IF NEW.profile_version <> 1 OR NEW.state <> 'approved' THEN
      RAISE EXCEPTION 'The first version of a jurisdiction profile is version 1 and approved'
        USING ERRCODE = 'raise_exception';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.profile_version <> previous_version + 1 THEN
    RAISE EXCEPTION 'Jurisdiction profile versions are consecutive: expected %, got %',
      previous_version + 1, NEW.profile_version
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Readiness takes the highest version already in effect. That is the version in force only if
  -- versions take effect in order; a backdated version would override its predecessor's period.
  IF NEW.effective_from < previous_effective_from THEN
    RAISE EXCEPTION 'A jurisdiction profile version cannot take effect before the previous one (%)',
      previous_effective_from
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.state <> previous_state AND (previous_state, NEW.state) NOT IN (
    ('approved', 'stale'), ('approved', 'suspended'),
    ('stale', 'approved'), ('stale', 'suspended'),
    ('suspended', 'approved')
  ) THEN
    RAISE EXCEPTION 'Jurisdiction profile transition % → % is not allowed', previous_state, NEW.state
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER jurisdiction_profiles_version_guard
  BEFORE INSERT ON core.jurisdiction_profiles
  FOR EACH ROW EXECUTE FUNCTION core.guard_jurisdiction_profile_version();

CREATE OR REPLACE FUNCTION core.reject_jurisdiction_profile_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A jurisdiction profile version cannot be modified or deleted. Propose a new version'
    USING ERRCODE = 'raise_exception';
END
$$;

CREATE TRIGGER jurisdiction_profiles_immutable
  BEFORE UPDATE OR DELETE ON core.jurisdiction_profiles
  FOR EACH ROW EXECUTE FUNCTION core.reject_jurisdiction_profile_mutation();

ALTER TABLE core.jurisdiction_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.jurisdiction_profiles FORCE ROW LEVEL SECURITY;

CREATE POLICY jurisdiction_profiles_tenant ON core.jurisdiction_profiles FOR ALL
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

-- INSERT for the approval route, as for the other review registries. No UPDATE or DELETE.
GRANT SELECT, INSERT ON core.jurisdiction_profiles TO mpc_app;
