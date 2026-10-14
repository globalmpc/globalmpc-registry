-- Stakeholder/obligation event history and claim derivations — spec 12 §12.7, 04 §4.2.
--
-- **Stakeholder and obligation events.** R5 includes "stakeholder/obligation event history within
-- the approved scope": relationship, consent, obligation and dispute events with their evidence.
-- Nothing recorded them, so the only history of a consent or an obligation was whatever the
-- current fact said. Events are append-only; a correction is a new event that names the one it
-- supersedes. They stay in the restricted workspace — publishing any of them needs a disclosure
-- approval that this table does not grant.
--
-- **Claim derivations.** 04 §4.2 requires a derived calculation to carry its formula, input claim
-- ids, unit, as-of and author. Lineage edges held the inputs but not the formula or who wrote it,
-- so a derived value could not be recomputed or attributed.

CREATE TABLE core.project_stakeholder_events (
  id                     UUID PRIMARY KEY,
  tenant_id              UUID NOT NULL REFERENCES core.tenants(id),
  project_id             UUID NOT NULL,
  category               TEXT NOT NULL
                           CHECK (category IN ('relationship', 'consent', 'obligation', 'dispute')),
  summary                TEXT NOT NULL CHECK (length(btrim(summary)) > 0),
  occurred_on            DATE NOT NULL,
  status                 core.confirmation_status NOT NULL,
  evidence_kind          TEXT CHECK (evidence_kind IN ('upload', 'source_receipt', 'attestation')),
  evidence_ref           UUID,
  supersedes_id          UUID,
  recorded_by_subject_id UUID NOT NULL,
  recorded_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT project_stakeholder_events_tenant_scope_key UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES core.projects (tenant_id, id),
  FOREIGN KEY (tenant_id, recorded_by_subject_id) REFERENCES core.subjects (tenant_id, id),
  FOREIGN KEY (tenant_id, supersedes_id) REFERENCES core.project_stakeholder_events (tenant_id, id),
  CONSTRAINT project_stakeholder_events_evidence_pairs
    CHECK ((evidence_ref IS NULL) = (evidence_kind IS NULL)),
  CONSTRAINT project_stakeholder_events_confirmed_requires_evidence
    CHECK (status <> 'confirmed' OR evidence_ref IS NOT NULL)
);

-- One correction per event. Two corrections of the same event would leave two "current" rows.
CREATE UNIQUE INDEX project_stakeholder_events_single_successor
  ON core.project_stakeholder_events (supersedes_id) WHERE supersedes_id IS NOT NULL;

CREATE INDEX project_stakeholder_events_project_idx
  ON core.project_stakeholder_events (project_id, occurred_on DESC);

CREATE TRIGGER project_stakeholder_events_no_update
  BEFORE UPDATE ON core.project_stakeholder_events
  FOR EACH ROW EXECUTE FUNCTION core.reject_history_mutation();

CREATE TRIGGER project_stakeholder_events_no_delete
  BEFORE DELETE ON core.project_stakeholder_events
  FOR EACH ROW EXECUTE FUNCTION core.reject_history_mutation();

CREATE TABLE core.claim_derivations (
  id                UUID PRIMARY KEY,
  tenant_id         UUID NOT NULL REFERENCES core.tenants(id),
  claim_id          UUID NOT NULL,
  formula           TEXT NOT NULL CHECK (length(btrim(formula)) > 0),
  input_claim_ids   UUID[] NOT NULL CHECK (array_length(input_claim_ids, 1) >= 1),
  unit              TEXT,
  as_of             DATE,
  author_subject_id UUID NOT NULL,
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A claim has one derivation. A different formula is a different claim.
  UNIQUE (claim_id),
  FOREIGN KEY (tenant_id, claim_id) REFERENCES core.claims (tenant_id, id),
  FOREIGN KEY (tenant_id, author_subject_id) REFERENCES core.subjects (tenant_id, id),
  CONSTRAINT claim_derivations_not_self CHECK (NOT (claim_id = ANY (input_claim_ids)))
);

CREATE TRIGGER claim_derivations_no_update
  BEFORE UPDATE ON core.claim_derivations
  FOR EACH ROW EXECUTE FUNCTION core.reject_history_mutation();

CREATE TRIGGER claim_derivations_no_delete
  BEFORE DELETE ON core.claim_derivations
  FOR EACH ROW EXECUTE FUNCTION core.reject_history_mutation();

ALTER TABLE core.project_stakeholder_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.project_stakeholder_events FORCE ROW LEVEL SECURITY;
CREATE POLICY project_stakeholder_events_tenant ON core.project_stakeholder_events FOR ALL
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

ALTER TABLE core.claim_derivations ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.claim_derivations FORCE ROW LEVEL SECURITY;
CREATE POLICY claim_derivations_tenant ON core.claim_derivations FOR ALL
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

GRANT SELECT, INSERT ON core.project_stakeholder_events TO mpc_app;
GRANT SELECT, INSERT ON core.claim_derivations TO mpc_app;
