-- Last hop of propagation — AC-21, spec 10 §175.
--
-- 0023 connected `connection → claim → attestation`. What remains is
-- `attestation → assessment → Registry version`, and **the earlier method cannot be
-- used.**
--
--   - `compliance_assessments` is append-only (`assessment_no_update`).
--   - `registry_entry_versions` content is immutable after publication
--     (`registry_version_immutable_after_publish`).
--
-- Both constraints are intentional. Assessment results and public records must not be rewritable later.
-- So **leave a signal instead of changing state.**
--
-- **Why no automatic revoke:** taking down a public Registry record changes what the world
-- sees. If a public record disappeared automatically whenever one connection dropped,
-- a source outage would become record deletion. A human decides (`registry.revoke`).

CREATE TYPE core.stale_signal_target AS ENUM (
  'compliance_assessment',
  'registry_entry_version'
);

CREATE TYPE core.stale_signal_resolution AS ENUM (
  -- Not yet reviewed by a human.
  'open',
  -- Corrected with a new version.
  'superseded',
  -- Public record taken down.
  'revoked',
  -- Checked and judged to have no impact. A reason is kept with it.
  'dismissed'
);

/**
 * Signal that evidence went stale — AC-21.
 *
 * Records only **the fact that "the evidence this output rested on went stale"**, without
 * changing the target. Append-only; the outcome closes it via the same row's resolution.
 *
 * An open signal means **re-review is needed**, not that the record is
 * wrong. Without that distinction a source outage becomes a denial of the record.
 */
CREATE TABLE core.evidence_stale_signals (
  id            UUID PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES core.tenants(id),
  project_id    UUID REFERENCES core.projects(id),
  target_type   core.stale_signal_target NOT NULL,
  target_id     UUID NOT NULL,
  /** Where it started. The chain must be traceable backward. */
  origin_attestation_id UUID,
  origin_claim_id       UUID,
  reason        TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  resolution    core.stale_signal_resolution NOT NULL DEFAULT 'open',
  resolved_at   TIMESTAMPTZ,
  resolved_by   UUID REFERENCES core.subjects(id),
  /** Why it was judged so. Needed especially for `dismissed`. */
  resolution_note TEXT,

  -- Prevent duplicate signals for the same target and cause. Piled-up open signals
  -- obscure what needs attention.
  UNIQUE (target_type, target_id, origin_attestation_id),

  CONSTRAINT stale_signal_resolution_needs_note CHECK (
    resolution = 'open'
    OR (resolved_at IS NOT NULL
        AND resolution_note IS NOT NULL
        AND length(btrim(resolution_note)) > 0)
  )
);

CREATE INDEX evidence_stale_signals_open_idx
  ON core.evidence_stale_signals (tenant_id, project_id)
  WHERE resolution = 'open';

ALTER TABLE core.evidence_stale_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.evidence_stale_signals FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON core.evidence_stale_signals
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

-- Signals are never deleted. They can only be closed.
GRANT SELECT, INSERT, UPDATE ON core.evidence_stale_signals TO mpc_app;

CREATE OR REPLACE FUNCTION core.reject_stale_signal_delete() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '근거 신호는 삭제할 수 없다. resolution으로 닫는다';
END
$$;

CREATE TRIGGER evidence_stale_signals_no_delete
  BEFORE DELETE ON core.evidence_stale_signals
  FOR EACH ROW EXECUTE FUNCTION core.reject_stale_signal_delete();

/**
 * A closed signal cannot be reopened, nor can its cause change.
 *
 * If a decision could be reverted, "what was known when, and how it was judged" is lost.
 * If it needs another look, a new signal is created.
 */
CREATE OR REPLACE FUNCTION core.protect_stale_signal() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.resolution <> 'open' THEN
    RAISE EXCEPTION '이미 닫힌 신호는 바꿀 수 없다 (현재: %)', OLD.resolution;
  END IF;

  IF NEW.target_type IS DISTINCT FROM OLD.target_type
     OR NEW.target_id IS DISTINCT FROM OLD.target_id
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.detected_at IS DISTINCT FROM OLD.detected_at
     OR NEW.origin_attestation_id IS DISTINCT FROM OLD.origin_attestation_id
  THEN
    RAISE EXCEPTION '신호의 원인과 시점은 바꿀 수 없다';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER evidence_stale_signals_protect
  BEFORE UPDATE ON core.evidence_stale_signals
  FOR EACH ROW EXECUTE FUNCTION core.protect_stale_signal();

/**
 * attestation → assessment · Registry version propagation.
 *
 * When an attestation becomes `stale_candidate`, leave signals on that project's **active
 * assessment** and **published Registry versions**.
 *
 * Why per project: `compliance_assessments` does not point to attestations directly
 * (`requirement_results` is JSON, not a link). With no exact chain, **cast
 * wide** — a signal on something unrelated is better than missing something
 * related. When a human closes it as `dismissed`, that judgment is recorded too.
 */
CREATE OR REPLACE FUNCTION core.propagate_attestation_to_signals() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  target_project UUID;
BEGIN
  IF NEW.state <> 'stale_candidate' OR OLD.state = 'stale_candidate' THEN
    RETURN NEW;
  END IF;

  SELECT c.project_id INTO target_project
  FROM core.verification_cases c WHERE c.id = NEW.case_id;

  IF target_project IS NULL THEN
    RETURN NEW;
  END IF;

  -- Signal only the latest assessment. Past assessments are judgments of their time and
  -- are not up for review now.
  INSERT INTO core.evidence_stale_signals (
    id, tenant_id, project_id, target_type, target_id,
    origin_attestation_id, reason
  )
  SELECT gen_random_uuid(), NEW.tenant_id, target_project,
         'compliance_assessment', a.id, NEW.id,
         coalesce(NEW.stale_reason, '근거 attestation이 재검토 대상이 됐다')
  FROM core.compliance_assessments a
  WHERE a.project_id = target_project
  ORDER BY a.generated_at DESC
  LIMIT 1
  ON CONFLICT DO NOTHING;

  -- Published Registry version. **Never taken down automatically** — leave a signal only;
  -- a human with the `registry.revoke` permission decides supersede·revoke.
  INSERT INTO core.evidence_stale_signals (
    id, tenant_id, project_id, target_type, target_id,
    origin_attestation_id, reason
  )
  SELECT gen_random_uuid(), NEW.tenant_id, target_project,
         'registry_entry_version', v.id, NEW.id,
         coalesce(NEW.stale_reason, '근거 attestation이 재검토 대상이 됐다')
  FROM core.registry_entry_versions v
  JOIN core.registry_entries e ON e.id = v.entry_id
  WHERE e.tenant_id = NEW.tenant_id
    AND e.subject_id = target_project
    AND v.status = 'published'
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END
$$;

CREATE TRIGGER attestations_propagate_to_signals
  AFTER UPDATE ON core.verification_attestations
  FOR EACH ROW EXECUTE FUNCTION core.propagate_attestation_to_signals();
