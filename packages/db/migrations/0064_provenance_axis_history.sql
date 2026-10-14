-- Provenance axis history — spec 05 §5.3, REQ-DAPP-004.
--
-- The three axes — evidence tier, artifact lifecycle and verification state — are orthogonal,
-- and each keeps its own history. Until now a claim held only the current tier and state, and an
-- artifact had no lifecycle at all: "when did this claim become analyst_checked, and because of
-- what" had no answer.
--
-- The history is written by triggers, not by routes. A route that forgets to write it would
-- leave a gap indistinguishable from "nothing changed". Routes supply the cause through the
-- transaction-local settings `mpc.provenance_cause` and `mpc.provenance_actor`; without them the
-- row still appears, marked as unattributed.

/**
 * Artifact lifecycle — 05 §5.3.
 *
 * `created → validated → accepted|rejected → superseded|revoked`; only a `public_projection` may
 * become `published`. The existing `revoked_at` / `superseded_by` columns stay the record of when
 * and by what; setting them moves the lifecycle, so the two cannot disagree.
 */
ALTER TABLE core.artifacts
  ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'created'
    CHECK (lifecycle_state IN (
      'created', 'validated', 'accepted', 'rejected', 'superseded', 'revoked', 'published'
    )),
  ADD CONSTRAINT artifact_only_projection_published
    CHECK (lifecycle_state <> 'published' OR kind = 'public_projection');

UPDATE core.artifacts SET lifecycle_state = 'superseded' WHERE superseded_by IS NOT NULL;
UPDATE core.artifacts SET lifecycle_state = 'revoked' WHERE revoked_at IS NOT NULL;

CREATE OR REPLACE FUNCTION core.artifact_lifecycle_allows(from_state TEXT, to_state TEXT)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  -- Mirrors `artifactLifecycleMachine` in packages/domain. Terminal states have no exits.
  SELECT CASE from_state
    WHEN 'created'   THEN to_state IN ('validated', 'rejected', 'superseded', 'revoked')
    WHEN 'validated' THEN to_state IN ('accepted', 'rejected', 'superseded', 'revoked')
    WHEN 'accepted'  THEN to_state IN ('published', 'superseded', 'revoked')
    WHEN 'published' THEN to_state IN ('superseded', 'revoked')
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION core.guard_artifact_lifecycle() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL THEN
    NEW.lifecycle_state := 'revoked';
  ELSIF NEW.superseded_by IS NOT NULL AND OLD.superseded_by IS NULL THEN
    NEW.lifecycle_state := 'superseded';
  END IF;

  IF NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state
     AND NOT core.artifact_lifecycle_allows(OLD.lifecycle_state, NEW.lifecycle_state)
  THEN
    RAISE EXCEPTION 'Artifact lifecycle transition % -> % is not allowed',
      OLD.lifecycle_state, NEW.lifecycle_state
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER artifacts_guard_lifecycle
  BEFORE UPDATE ON core.artifacts
  FOR EACH ROW EXECUTE FUNCTION core.guard_artifact_lifecycle();

CREATE TABLE core.provenance_axis_history (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES core.tenants(id),
  subject_kind     TEXT NOT NULL CHECK (subject_kind IN ('claim', 'artifact')),
  subject_id       UUID NOT NULL,
  axis             TEXT NOT NULL
                     CHECK (axis IN ('evidence_tier', 'artifact_lifecycle', 'verification_state')),
  -- NULL `from_value` is the first entry; NULL `to_value` is a tier that was cleared.
  from_value       TEXT,
  to_value         TEXT,
  cause            TEXT NOT NULL CHECK (length(btrim(cause)) > 0),
  actor_subject_id UUID,
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The axes are not interchangeable: an artifact has no verification state, a claim no lifecycle.
  CONSTRAINT provenance_axis_matches_subject CHECK (
    (subject_kind = 'claim' AND axis IN ('evidence_tier', 'verification_state'))
    OR (subject_kind = 'artifact' AND axis = 'artifact_lifecycle')
  )
);

CREATE INDEX provenance_axis_history_subject_idx
  ON core.provenance_axis_history (subject_id, axis, recorded_at);

ALTER TABLE core.provenance_axis_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.provenance_axis_history FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON core.provenance_axis_history
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

GRANT SELECT, INSERT ON core.provenance_axis_history TO mpc_app;

CREATE OR REPLACE FUNCTION core.reject_provenance_history_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Provenance axis history cannot be modified or deleted';
END
$$;

CREATE TRIGGER provenance_axis_history_append_only
  BEFORE UPDATE OR DELETE ON core.provenance_axis_history
  FOR EACH ROW EXECUTE FUNCTION core.reject_provenance_history_mutation();

CREATE OR REPLACE FUNCTION core.record_provenance_axis(
  p_tenant UUID, p_kind TEXT, p_subject UUID, p_axis TEXT, p_from TEXT, p_to TEXT, p_op TEXT
) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO core.provenance_axis_history (
    tenant_id, subject_kind, subject_id, axis, from_value, to_value, cause, actor_subject_id
  ) VALUES (
    p_tenant, p_kind, p_subject, p_axis, p_from, p_to,
    coalesce(
      nullif(current_setting('mpc.provenance_cause', true), ''),
      CASE p_op WHEN 'INSERT' THEN 'created' ELSE 'unattributed_update' END
    ),
    nullif(current_setting('mpc.provenance_actor', true), '')::uuid
  );
END
$$;

CREATE OR REPLACE FUNCTION core.track_claim_axes() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM core.record_provenance_axis(
      NEW.tenant_id, 'claim', NEW.id, 'evidence_tier', NULL, NEW.evidence_tier::text, TG_OP);
    PERFORM core.record_provenance_axis(
      NEW.tenant_id, 'claim', NEW.id, 'verification_state', NULL, NEW.verification_state::text, TG_OP);
    RETURN NEW;
  END IF;

  IF NEW.evidence_tier IS DISTINCT FROM OLD.evidence_tier THEN
    PERFORM core.record_provenance_axis(
      NEW.tenant_id, 'claim', NEW.id, 'evidence_tier',
      OLD.evidence_tier::text, NEW.evidence_tier::text, TG_OP);
  END IF;
  IF NEW.verification_state IS DISTINCT FROM OLD.verification_state THEN
    PERFORM core.record_provenance_axis(
      NEW.tenant_id, 'claim', NEW.id, 'verification_state',
      OLD.verification_state::text, NEW.verification_state::text, TG_OP);
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER claims_track_axes
  AFTER INSERT OR UPDATE ON core.claims
  FOR EACH ROW EXECUTE FUNCTION core.track_claim_axes();

CREATE OR REPLACE FUNCTION core.track_artifact_lifecycle() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM core.record_provenance_axis(
      NEW.tenant_id, 'artifact', NEW.id, 'artifact_lifecycle', NULL, NEW.lifecycle_state, TG_OP);
  ELSIF NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state THEN
    PERFORM core.record_provenance_axis(
      NEW.tenant_id, 'artifact', NEW.id, 'artifact_lifecycle',
      OLD.lifecycle_state, NEW.lifecycle_state, TG_OP);
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER artifacts_track_lifecycle
  AFTER INSERT OR UPDATE ON core.artifacts
  FOR EACH ROW EXECUTE FUNCTION core.track_artifact_lifecycle();

-- Rows that existed before tracking get one entry per axis saying so. "Why is there nothing
-- before this" has an answer.
INSERT INTO core.provenance_axis_history (
  tenant_id, subject_kind, subject_id, axis, from_value, to_value, cause, recorded_at
)
SELECT c.tenant_id, 'claim', c.id, axis.name, NULL, axis.value,
       'history tracking began (migration 0064)', c.created_at
FROM core.claims c
CROSS JOIN LATERAL (VALUES
  ('evidence_tier', c.evidence_tier::text),
  ('verification_state', c.verification_state::text)
) AS axis(name, value);

INSERT INTO core.provenance_axis_history (
  tenant_id, subject_kind, subject_id, axis, from_value, to_value, cause, recorded_at
)
SELECT a.tenant_id, 'artifact', a.id, 'artifact_lifecycle', NULL, a.lifecycle_state,
       'history tracking began (migration 0064)', a.created_at
FROM core.artifacts a;
