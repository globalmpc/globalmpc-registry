-- Attestation Schema and Policy version propagation — spec 04 §4.10 invariant 18, AC-21.
--
-- AC-21 names four origins of change: source, credential, Attestation Schema, Policy version.
-- Sources were covered by 0020 · 0023, credentials by 0051. A new schema or policy version reached
-- nothing: attestations written against a retired schema and assessments evaluated under a
-- replaced rule set looked exactly as current as the day they were made.
--
-- Same two methods as before, chosen by whether the target may change:
--
--   - attestations have a re-review state, so they move to `stale_candidate` (and 0024 carries it on);
--   - assessments are append-only (`assessment_no_update`), so they get a signal instead.
--
-- Nothing is deleted and no past result is rewritten. An assessment evaluated under version 1 was
-- a correct evaluation under version 1; the signal says a newer rule set exists.

-- ---------------------------------------------------------------------------
-- Attestation Schema → attestation
-- ---------------------------------------------------------------------------

/**
 * A schema version stops being the current one.
 *
 * Two ways it happens, and both count:
 *
 *   1. the version itself goes to `superseded` or `retired`;
 *   2. another version of the same `schema_key` becomes `active` — the old one may never be
 *      marked, and its attestations would otherwise look current.
 *
 * Only `active` attestations move, as everywhere in this chain.
 */
CREATE OR REPLACE FUNCTION core.propagate_schema_to_attestations() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.state IS NOT DISTINCT FROM OLD.state THEN
    RETURN NEW;
  END IF;

  IF NEW.state IN ('superseded', 'retired') THEN
    UPDATE core.verification_attestations a
    SET state = 'stale_candidate',
        stale_reason = format('Attestation schema %s version %s was %s',
                              NEW.schema_key, NEW.schema_version, NEW.state)
    WHERE a.schema_id = NEW.id
      AND a.state = 'active';
  ELSIF NEW.state = 'active' THEN
    UPDATE core.verification_attestations a
    SET state = 'stale_candidate',
        stale_reason = format('Attestation schema %s has a new active version %s (attested under %s)',
                              NEW.schema_key, NEW.schema_version, old_schema.schema_version)
    FROM core.attestation_schemas old_schema
    WHERE old_schema.tenant_id = NEW.tenant_id
      AND old_schema.schema_key = NEW.schema_key
      AND old_schema.id <> NEW.id
      AND a.schema_id = old_schema.id
      AND a.state = 'active';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER attestation_schemas_propagate_to_attestations
  AFTER INSERT OR UPDATE ON core.attestation_schemas
  FOR EACH ROW EXECUTE FUNCTION core.propagate_schema_to_attestations();

-- ---------------------------------------------------------------------------
-- Policy version → assessment signal
-- ---------------------------------------------------------------------------

ALTER TABLE core.evidence_stale_signals
  /**
   * The rule set the target was evaluated under, when the signal comes from a policy change.
   *
   * `origin_attestation_id` cannot carry this: a policy change has no attestation behind it, and
   * with that column NULL the existing unique key treats every insert as new, so each state
   * change of the policy would add another open signal for the same assessment.
   */
  ADD COLUMN origin_policy_set_id UUID,
  -- FK checks bypass RLS, so the key carries the tenant (0006).
  ADD CONSTRAINT stale_signal_policy_same_tenant
    FOREIGN KEY (tenant_id, origin_policy_set_id)
    REFERENCES core.compliance_policy_sets (tenant_id, id);

CREATE UNIQUE INDEX evidence_stale_signals_policy_origin_key
  ON core.evidence_stale_signals (target_type, target_id, origin_policy_set_id)
  WHERE origin_policy_set_id IS NOT NULL;

/**
 * The origin of a signal is part of its cause, and a cause does not change (0024).
 *
 * Redefined to add `origin_policy_set_id` to the protected columns; otherwise identical.
 */
CREATE OR REPLACE FUNCTION core.protect_stale_signal() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.resolution <> 'open' THEN
    RAISE EXCEPTION 'A closed signal cannot be changed (current: %)', OLD.resolution;
  END IF;

  IF NEW.target_type IS DISTINCT FROM OLD.target_type
     OR NEW.target_id IS DISTINCT FROM OLD.target_id
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.detected_at IS DISTINCT FROM OLD.detected_at
     OR NEW.origin_attestation_id IS DISTINCT FROM OLD.origin_attestation_id
     OR NEW.origin_policy_set_id IS DISTINCT FROM OLD.origin_policy_set_id
  THEN
    RAISE EXCEPTION 'The cause and time of a signal cannot be changed';
  END IF;

  RETURN NEW;
END
$$;

/**
 * A policy version stops being the current one → signal the assessments evaluated under it.
 *
 * As with schemas, both ways count: the version goes to `superseded`·`retired`, or another
 * version of the same `rule_set_id` becomes `effective`.
 *
 * **Only the latest assessment per project and gate.** An older assessment was already replaced
 * by a newer one; it is a judgment of its time, not something anyone relies on now (same rule as
 * 0024). The assessment row itself is never written — it is append-only, and a readiness result
 * that could be edited after the fact would be no record at all.
 */
CREATE OR REPLACE FUNCTION core.propagate_policy_to_assessments() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.state IS NOT DISTINCT FROM OLD.state THEN
    RETURN NEW;
  END IF;
  IF NEW.state NOT IN ('superseded', 'retired', 'effective') THEN
    RETURN NEW;
  END IF;

  INSERT INTO core.evidence_stale_signals (
    id, tenant_id, project_id, target_type, target_id, origin_policy_set_id, reason
  )
  SELECT gen_random_uuid(), latest.tenant_id, latest.project_id, 'compliance_assessment',
         latest.id, latest.policy_set_id,
         CASE WHEN NEW.state = 'effective' THEN
           format('Assessed under policy %s version %s; version %s is now effective',
                  NEW.rule_set_id, used.rule_set_version, NEW.rule_set_version)
         ELSE
           format('Assessed under policy %s version %s, which was %s',
                  NEW.rule_set_id, used.rule_set_version, NEW.state)
         END
  FROM (
    SELECT DISTINCT ON (a.project_id, a.gate_id)
           a.id, a.tenant_id, a.project_id, a.policy_set_id
    FROM core.compliance_assessments a
    WHERE a.tenant_id = NEW.tenant_id
    ORDER BY a.project_id, a.gate_id, a.generated_at DESC, a.id
  ) latest
  JOIN core.compliance_policy_sets used ON used.id = latest.policy_set_id
  WHERE used.tenant_id = NEW.tenant_id
    AND used.rule_set_id = NEW.rule_set_id
    AND CASE WHEN NEW.state = 'effective' THEN used.id <> NEW.id ELSE used.id = NEW.id END
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END
$$;

CREATE TRIGGER compliance_policy_sets_propagate_to_assessments
  AFTER INSERT OR UPDATE ON core.compliance_policy_sets
  FOR EACH ROW EXECUTE FUNCTION core.propagate_policy_to_assessments();

-- The policy trigger above picks each project's latest assessment per gate across the tenant.
-- This index serves that DISTINCT ON instead of a sort of every assessment in the tenant.
CREATE INDEX compliance_assessments_latest_idx
  ON core.compliance_assessments (tenant_id, project_id, gate_id, generated_at DESC, id);
