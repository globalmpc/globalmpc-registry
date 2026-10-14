-- Project parties and registration requests — spec 04 §4.2, 05 §5.6, 07 §7.2.
--
-- The Project Registry names the project's parties (sponsor/operator, host-country SPV or
-- rights holder, project-specific issuer), but no table held them: the Project context owned
-- `Party` on paper only. A party is a statement about a legal entity, so it is tracked the same
-- way as a project fact — confirmed/pending/rejected/not_applicable plus evidence — and a
-- submitted party starts as `pending`. Submitting a party is not confirming it: a project party
-- naming itself proves only that it said so (05 §5.11).

CREATE TABLE core.project_parties (
  id                      UUID PRIMARY KEY,
  tenant_id               UUID NOT NULL REFERENCES core.tenants(id),
  project_id              UUID NOT NULL,
  party_role              TEXT NOT NULL
                            CHECK (party_role IN ('sponsor_operator', 'host_country_spv', 'issuer')),
  legal_name              TEXT NOT NULL CHECK (length(btrim(legal_name)) > 0),
  -- The entity may or may not be an organization in this tenant. When it is, the link is kept.
  organization_id         UUID,
  jurisdiction            TEXT,
  status                  core.confirmation_status NOT NULL DEFAULT 'pending',
  evidence_kind           TEXT CHECK (evidence_kind IN ('upload', 'source_receipt', 'attestation')),
  evidence_ref            UUID,
  as_of                   DATE,
  submitted_by_subject_id UUID NOT NULL,
  submitted_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  version                 INTEGER NOT NULL DEFAULT 1,

  CONSTRAINT project_parties_tenant_scope_key UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES core.projects (tenant_id, id),
  FOREIGN KEY (tenant_id, organization_id) REFERENCES core.organizations (tenant_id, id),
  FOREIGN KEY (tenant_id, submitted_by_subject_id) REFERENCES core.subjects (tenant_id, id),
  CONSTRAINT project_parties_evidence_pairs
    CHECK ((evidence_ref IS NULL) = (evidence_kind IS NULL)),
  CONSTRAINT project_parties_confirmed_requires_evidence
    CHECK (status <> 'confirmed' OR evidence_ref IS NOT NULL)
);

CREATE INDEX project_parties_project_idx ON core.project_parties (project_id, party_role);

-- A party that turned out wrong is marked `rejected`, not removed: the record that it was once
-- claimed is part of the project's history.
CREATE TRIGGER project_parties_no_delete
  BEFORE DELETE ON core.project_parties
  FOR EACH ROW EXECUTE FUNCTION core.reject_delete();

CREATE TABLE core.project_party_versions (
  id                     UUID PRIMARY KEY,
  tenant_id              UUID NOT NULL REFERENCES core.tenants(id),
  party_id               UUID NOT NULL,
  version                INTEGER NOT NULL CHECK (version >= 1),
  status                 core.confirmation_status NOT NULL,
  evidence_kind          TEXT CHECK (evidence_kind IN ('upload', 'source_receipt', 'attestation')),
  evidence_ref           UUID,
  as_of                  DATE,
  reason                 TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  recorded_by_subject_id UUID NOT NULL,
  recorded_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (party_id, version),
  FOREIGN KEY (tenant_id, party_id) REFERENCES core.project_parties (tenant_id, id),
  FOREIGN KEY (tenant_id, recorded_by_subject_id) REFERENCES core.subjects (tenant_id, id),
  CONSTRAINT project_party_versions_evidence_pairs
    CHECK ((evidence_ref IS NULL) = (evidence_kind IS NULL)),
  CONSTRAINT project_party_versions_confirmed_requires_evidence
    CHECK (status <> 'confirmed' OR evidence_ref IS NOT NULL)
);

CREATE TRIGGER project_party_versions_no_update
  BEFORE UPDATE ON core.project_party_versions
  FOR EACH ROW EXECUTE FUNCTION core.reject_history_mutation();

CREATE TRIGGER project_party_versions_no_delete
  BEFORE DELETE ON core.project_party_versions
  FOR EACH ROW EXECUTE FUNCTION core.reject_history_mutation();

/**
 * Registration requests — 07 §7.2, 02 §2.3 ("Project Registry: project parties request").
 *
 * A request asks for the Project Registry workflow to start. It does not publish anything and
 * carries no state of its own: whether it has been answered is read from the registry (a
 * project-registry version published after the request), so the two cannot disagree.
 */
CREATE TABLE core.project_registration_requests (
  id                      UUID PRIMARY KEY,
  tenant_id               UUID NOT NULL REFERENCES core.tenants(id),
  project_id              UUID NOT NULL,
  note                    TEXT NOT NULL CHECK (length(btrim(note)) > 0),
  requested_by_subject_id UUID NOT NULL,
  requested_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  FOREIGN KEY (tenant_id, project_id) REFERENCES core.projects (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by_subject_id) REFERENCES core.subjects (tenant_id, id)
);

CREATE INDEX project_registration_requests_project_idx
  ON core.project_registration_requests (project_id, requested_at DESC);

CREATE TRIGGER project_registration_requests_no_update
  BEFORE UPDATE ON core.project_registration_requests
  FOR EACH ROW EXECUTE FUNCTION core.reject_history_mutation();

CREATE TRIGGER project_registration_requests_no_delete
  BEFORE DELETE ON core.project_registration_requests
  FOR EACH ROW EXECUTE FUNCTION core.reject_history_mutation();

ALTER TABLE core.project_parties ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.project_parties FORCE ROW LEVEL SECURITY;
CREATE POLICY project_parties_tenant ON core.project_parties FOR ALL
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

ALTER TABLE core.project_party_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.project_party_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY project_party_versions_tenant ON core.project_party_versions FOR ALL
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

ALTER TABLE core.project_registration_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.project_registration_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY project_registration_requests_tenant ON core.project_registration_requests FOR ALL
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

GRANT SELECT, INSERT, UPDATE ON core.project_parties TO mpc_app;
GRANT SELECT, INSERT ON core.project_party_versions TO mpc_app;
GRANT SELECT, INSERT ON core.project_registration_requests TO mpc_app;
