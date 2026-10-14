-- Project reference label and recorded fact confirmations — spec 04 §4.2, 05 §5.10, 11 §11.5.
--
-- `core.project_facts` held the confirmed/pending/rejected/not_applicable matrix, but nothing
-- wrote to it: there was no route, so the matrix could only be filled by hand in the database,
-- and a hand-filled row leaves no trace of who decided or on what basis. This migration makes a
-- fact a **recorded confirmation**: every change is a new immutable version naming who recorded
-- it, why, and which evidence it rests on. `project_facts` stays as the current projection that
-- the offering gate already reads.
--
-- `confirmed` requires evidence. Recording "confirmed" with nothing behind it is the failure the
-- offering gate reports as `unsupported`; the database now refuses it instead of reporting it.

-- ---------------------------------------------------------------------------
-- Reference label — 05 §5.10
-- ---------------------------------------------------------------------------

ALTER TABLE core.projects DROP CONSTRAINT projects_reference_status_check;
ALTER TABLE core.projects ADD CONSTRAINT projects_reference_status_check
  CHECK (reference_status IN ('none', 'official_reference', 'synthetic_test_project'));

/**
 * A synthetic test project stays synthetic, and nothing becomes synthetic later.
 *
 * 05 §5.10: synthetic fixtures and the official reference do not inherit relationships, rights,
 * or readiness from each other. Relabelling a fixture as real (or a real project as a fixture)
 * would carry its whole history across that line, so the label is fixed at creation.
 */
CREATE FUNCTION core.keep_synthetic_label() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.reference_status = 'synthetic_test_project') <> (NEW.reference_status = 'synthetic_test_project') THEN
    RAISE EXCEPTION 'synthetic_test_project is fixed at creation (% -> %)',
      OLD.reference_status, NEW.reference_status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER projects_synthetic_label_fixed
  BEFORE UPDATE OF reference_status ON core.projects
  FOR EACH ROW EXECUTE FUNCTION core.keep_synthetic_label();

-- ---------------------------------------------------------------------------
-- Evidence on the current fact
-- ---------------------------------------------------------------------------

ALTER TABLE core.project_facts
  /**
   * What `evidence_ref` points at. A bare UUID cannot be checked: the route resolves it against
   * this kind, in this project, before accepting it.
   */
  ADD COLUMN evidence_kind TEXT
    CHECK (evidence_kind IN ('upload', 'source_receipt', 'attestation')),
  ADD COLUMN recorded_by_subject_id UUID,
  ADD COLUMN recorded_at TIMESTAMPTZ,
  ADD CONSTRAINT project_facts_recorder_same_tenant
    FOREIGN KEY (tenant_id, recorded_by_subject_id) REFERENCES core.subjects (tenant_id, id),
  ADD CONSTRAINT project_facts_evidence_kind_pairs
    CHECK ((evidence_ref IS NULL) = (evidence_kind IS NULL)) NOT VALID,
  -- NOT VALID: rows written before this migration are left for review rather than rewritten.
  -- Every new write is checked.
  ADD CONSTRAINT project_facts_confirmed_requires_evidence
    CHECK (status <> 'confirmed' OR evidence_ref IS NOT NULL) NOT VALID;

-- ---------------------------------------------------------------------------
-- Version history
-- ---------------------------------------------------------------------------

CREATE TABLE core.project_fact_versions (
  id                     UUID PRIMARY KEY,
  tenant_id              UUID NOT NULL REFERENCES core.tenants(id),
  project_id             UUID NOT NULL,
  fact_key               TEXT NOT NULL,
  version                INTEGER NOT NULL CHECK (version >= 1),
  status                 core.confirmation_status NOT NULL,
  evidence_kind          TEXT CHECK (evidence_kind IN ('upload', 'source_receipt', 'attestation')),
  evidence_ref           UUID,
  as_of                  DATE,
  -- A confirmation without a reason leaves nothing to judge later.
  reason                 TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  recorded_by_subject_id UUID NOT NULL,
  recorded_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (project_id, fact_key, version),
  FOREIGN KEY (tenant_id, project_id) REFERENCES core.projects (tenant_id, id),
  FOREIGN KEY (tenant_id, recorded_by_subject_id) REFERENCES core.subjects (tenant_id, id),
  CONSTRAINT project_fact_versions_evidence_pairs
    CHECK ((evidence_ref IS NULL) = (evidence_kind IS NULL)),
  CONSTRAINT project_fact_versions_confirmed_requires_evidence
    CHECK (status <> 'confirmed' OR evidence_ref IS NOT NULL)
);

CREATE INDEX project_fact_versions_project_idx
  ON core.project_fact_versions (project_id, fact_key, version DESC);

/**
 * Versions are never rewritten. A correction is the next version.
 *
 * Shared by the party and stakeholder-event histories in 0069/0070: all three are records of
 * what someone stated at a time, and overwriting one would make the current state unexplainable.
 */
CREATE FUNCTION core.reject_history_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % rejected', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'raise_exception';
END
$$;

CREATE TRIGGER project_fact_versions_no_update
  BEFORE UPDATE ON core.project_fact_versions
  FOR EACH ROW EXECUTE FUNCTION core.reject_history_mutation();

CREATE TRIGGER project_fact_versions_no_delete
  BEFORE DELETE ON core.project_fact_versions
  FOR EACH ROW EXECUTE FUNCTION core.reject_history_mutation();

ALTER TABLE core.project_fact_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.project_fact_versions FORCE ROW LEVEL SECURITY;

CREATE POLICY project_fact_versions_tenant ON core.project_fact_versions FOR ALL
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

GRANT SELECT, INSERT ON core.project_fact_versions TO mpc_app;
