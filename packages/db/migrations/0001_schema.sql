-- MPC dApp — initial schema
--
-- Design basis: spec 04 (domain, state), 05 (data, Registry), 02 (authorization).
-- ADR-T03: single PostgreSQL data plane. ADR-T04: Drizzle (SQL-first).
--
-- Schema split:
--   core  — domain entities. The app role reads and writes.
--   chain — anchor batches, transactions, inclusion proofs.
--   audit — mutation history. The app role can only INSERT (enforced in 0003).

CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS chain;
CREATE SCHEMA IF NOT EXISTS audit;

-- ---------------------------------------------------------------------------
-- Enum
--
-- 13 §13.13: the canonical source result enum has exactly 12 values; API, events, UI, and
-- fixtures cannot merge them or add aliases. Fixed as a DB enum, not a CHECK constraint or
-- text, so violations are impossible even outside the application.
-- ---------------------------------------------------------------------------

CREATE TYPE core.source_result AS ENUM (
  'confirmed_from_source',
  'source_returned_no_record',
  'not_applicable',
  'access_not_authorized',
  'source_unavailable',
  'authentication_failed',
  'signature_invalid',
  'schema_changed',
  'stale',
  'conflicting',
  'manual_review_required',
  'legal_interpretation_required'
);

CREATE TYPE core.collection_method AS ENUM (
  'authenticated_api',
  'official_bulk_export',
  'verifiable_signed_document',
  'manual_official_registry_confirmation'
);

CREATE TYPE core.evidence_tier AS ENUM ('P1', 'P2', 'P3', 'P4', 'P5');

CREATE TYPE core.artifact_kind AS ENUM (
  'raw_source',
  'extracted_artifact',
  'normalized_observation',
  'interpretation',
  'public_projection'
);

CREATE TYPE core.verification_state AS ENUM (
  'unreviewed',
  'machine_checked',
  'analyst_checked',
  'independently_assured',
  'rejected'
);

CREATE TYPE core.attestation_type AS ENUM (
  'professional_signoff',
  'laboratory_accreditation',
  'independent_assurance',
  'legal_notarization',
  'cryptographic_attestation'
);

CREATE TYPE core.grade AS ENUM (
  'rejected',
  'unverified',
  'self_reported',
  'partially_verified',
  'verified'
);

CREATE TYPE core.readiness_status AS ENUM ('ok', 'watch', 'gap', 'not_evaluable');

CREATE TYPE core.gate_decision_value AS ENUM ('go', 'hold', 'rework', 'stop');

CREATE TYPE core.sensitivity AS ENUM (
  'public',
  'restricted',
  'confidential',
  'pii',
  'whistleblower'
);

CREATE TYPE core.confirmation_status AS ENUM (
  'confirmed',
  'pending',
  'rejected',
  'not_applicable'
);

CREATE TYPE core.at_lifecycle_state AS ENUM (
  'draft',
  'registered',
  'offering_open',
  'offering_closed',
  'active',
  'branch_vote',
  'continuing',
  'divested',
  'closure',
  'retired',
  'suspended'
);

CREATE TYPE core.verification_case_state AS ENUM (
  'draft',
  'assigned',
  'in_review',
  'changes_requested',
  'signed',
  'registered',
  'declined',
  'cancelled',
  'superseded',
  'revoked'
);

CREATE TYPE core.authority_state AS ENUM (
  'proposed',
  'under_review',
  'accepted',
  'suspended',
  'expired',
  'revoked',
  'superseded'
);

CREATE TYPE core.source_connection_state AS ENUM (
  'planned',
  'feasibility_checked',
  'access_confirmed',
  'tested',
  'active',
  'degraded',
  'disabled'
);

CREATE TYPE core.registry_type AS ENUM ('project', 'verification', 'asset');

CREATE TYPE core.registry_entry_status AS ENUM (
  'draft',
  'published',
  'revoked',
  'superseded'
);

CREATE TYPE core.assurance_level AS ENUM ('wallet_only', 'identity_bound', 'high_assurance');

CREATE TYPE chain.transaction_state AS ENUM (
  'created',
  'signed',
  'submitted',
  'included',
  'confirmed',
  'replaced',
  'reverted',
  'reorged',
  'dropped',
  'failed',
  'reconciliation_required'
);

-- ---------------------------------------------------------------------------
-- Identity & Tenancy
--
-- 02 §2.9: authentication / identity binding / credential / role binding /
-- Assignment and authorization are separate records. The user row has no role
-- column.
-- ---------------------------------------------------------------------------

CREATE TABLE core.tenants (
  id            UUID PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  version       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE core.organizations (
  id          UUID PRIMARY KEY,
  tenant_id   UUID NOT NULL REFERENCES core.tenants(id),
  legal_name  TEXT NOT NULL,
  jurisdiction TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  version     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE core.subjects (
  id          UUID PRIMARY KEY,
  tenant_id   UUID NOT NULL REFERENCES core.tenants(id),
  kind        TEXT NOT NULL CHECK (kind IN ('person', 'service')),
  display_name TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  version     INTEGER NOT NULL DEFAULT 1
);

-- A wallet is a login method. On its own it grants only public read and governance
-- participation (OD-04).
CREATE TABLE core.wallet_identities (
  id              UUID PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES core.tenants(id),
  subject_id      UUID REFERENCES core.subjects(id),
  wallet_address  TEXT NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  chain_id        INTEGER NOT NULL,
  assurance_level core.assurance_level NOT NULL DEFAULT 'wallet_only',
  bound_at        TIMESTAMPTZ,
  disabled_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  version         INTEGER NOT NULL DEFAULT 1,
  UNIQUE (wallet_address, chain_id)
);

-- Lost-key recovery (AC-27): disable the old key and bind a new one.
-- Past signatures are preserved regardless of wallet state.
CREATE INDEX wallet_identities_subject_idx ON core.wallet_identities (subject_id)
  WHERE disabled_at IS NULL;

CREATE TABLE core.credentials (
  id                    UUID PRIMARY KEY,
  tenant_id             UUID NOT NULL REFERENCES core.tenants(id),
  subject_id            UUID NOT NULL REFERENCES core.subjects(id),
  organization_id       UUID REFERENCES core.organizations(id),
  issuer_reference      TEXT NOT NULL,
  credential_type       TEXT NOT NULL,
  credential_scope      TEXT[] NOT NULL DEFAULT '{}',
  jurisdiction          TEXT[] NOT NULL DEFAULT '{}',
  issued_at             TIMESTAMPTZ NOT NULL,
  expires_at            TIMESTAMPTZ,
  revoked_at            TIMESTAMPTZ,
  current_status        TEXT NOT NULL DEFAULT 'valid'
                          CHECK (current_status IN ('valid','expired','revoked','suspended','unknown')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  version               INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE core.role_bindings (
  id              UUID PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES core.tenants(id),
  subject_id      UUID NOT NULL REFERENCES core.subjects(id),
  organization_id UUID REFERENCES core.organizations(id),
  project_id      UUID,
  role            TEXT NOT NULL,
  granted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ,
  version         INTEGER NOT NULL DEFAULT 1
);

-- ---------------------------------------------------------------------------
-- Project
-- ---------------------------------------------------------------------------

CREATE TABLE core.projects (
  id                    UUID PRIMARY KEY,
  tenant_id             UUID NOT NULL REFERENCES core.tenants(id),
  project_key           TEXT NOT NULL,
  name                  TEXT NOT NULL,
  host_country_iso3     CHAR(3) NOT NULL,
  minerals              TEXT[] NOT NULL DEFAULT '{}',
  reference_status      TEXT NOT NULL DEFAULT 'none'
                          CHECK (reference_status IN ('none','official_reference')),
  lifecycle_state       core.at_lifecycle_state NOT NULL DEFAULT 'draft',
  -- State to return to after suspension (§4.3). NULL unless suspended.
  prior_lifecycle_state core.at_lifecycle_state,
  owner_organization_id UUID NOT NULL REFERENCES core.organizations(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  version               INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, project_key),
  CONSTRAINT prior_state_only_when_suspended CHECK (
    (lifecycle_state = 'suspended') = (prior_lifecycle_state IS NOT NULL)
  )
);

-- 04 §4.2: unconfirmed fields are tracked as confirmed/pending/rejected/
-- not_applicable + evidence reference, not as nullable text.
CREATE TABLE core.project_facts (
  id            UUID PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES core.tenants(id),
  project_id    UUID NOT NULL REFERENCES core.projects(id),
  fact_key      TEXT NOT NULL,
  status        core.confirmation_status NOT NULL,
  evidence_ref  UUID,
  as_of         DATE,
  note          TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  UNIQUE (project_id, fact_key)
);

-- ---------------------------------------------------------------------------
-- Trust & Authority
-- ---------------------------------------------------------------------------

CREATE TABLE core.authorities (
  id                     UUID PRIMARY KEY,
  tenant_id              UUID NOT NULL REFERENCES core.tenants(id),
  name                   TEXT NOT NULL,
  jurisdiction           TEXT NOT NULL,
  -- 05 §5.11: every AuthoritySource carries both proves and does_not_prove.
  proves                 TEXT[] NOT NULL,
  does_not_prove         TEXT[] NOT NULL,
  recognized_scope       TEXT[] NOT NULL,
  verification_method    TEXT NOT NULL,
  public_disclosure_level core.sensitivity NOT NULL,
  valid_from             DATE NOT NULL,
  valid_until            DATE,
  state                  core.authority_state NOT NULL DEFAULT 'proposed',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  version                INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT authority_must_state_limits CHECK (
    array_length(does_not_prove, 1) IS NOT NULL
  )
);

-- ---------------------------------------------------------------------------
-- Source Integration
-- ---------------------------------------------------------------------------

CREATE TABLE core.source_connections (
  id                UUID PRIMARY KEY,
  tenant_id         UUID NOT NULL REFERENCES core.tenants(id),
  authority_id      UUID NOT NULL REFERENCES core.authorities(id),
  connection_key    TEXT NOT NULL,
  collection_method core.collection_method NOT NULL,
  access_basis      TEXT NOT NULL,
  -- API secrets, tokens, and private keys are never stored. Only references (05 §5.12).
  secret_reference  TEXT,
  state             core.source_connection_state NOT NULL DEFAULT 'planned',
  last_success_at   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  version           INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, connection_key)
);

CREATE TABLE core.source_receipts (
  id                     UUID PRIMARY KEY,
  tenant_id              UUID NOT NULL REFERENCES core.tenants(id),
  project_id             UUID REFERENCES core.projects(id),
  connection_id          UUID NOT NULL REFERENCES core.source_connections(id),
  authority_id           UUID NOT NULL REFERENCES core.authorities(id),
  collection_method      core.collection_method NOT NULL,
  result                 core.source_result NOT NULL,
  query_basis            JSONB NOT NULL,
  endpoint_or_document_ref TEXT NOT NULL,
  authentication_method  TEXT NOT NULL,
  raw_hash               TEXT NOT NULL CHECK (raw_hash ~ '^0x[0-9a-f]{64}$'),
  raw_object_key         TEXT,
  source_schema_version  TEXT NOT NULL,
  adapter_version        TEXT NOT NULL,
  normalization_version  TEXT,
  terms_license          TEXT NOT NULL,
  commercial_reuse       TEXT NOT NULL DEFAULT 'unconfirmed'
                           CHECK (commercial_reuse IN ('confirmed','unconfirmed','prohibited')),
  disclosure_permission  core.sensitivity NOT NULL,
  received_at            TIMESTAMPTZ NOT NULL,
  as_of                  TIMESTAMPTZ NOT NULL,
  effective_at           TIMESTAMPTZ,
  freshness_status       TEXT NOT NULL,
  correlation_id         TEXT NOT NULL,
  limitations            TEXT[] NOT NULL DEFAULT '{}',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX source_receipts_project_idx ON core.source_receipts (project_id, as_of DESC);
CREATE INDEX source_receipts_result_idx ON core.source_receipts (result);

-- ---------------------------------------------------------------------------
-- Evidence
-- ---------------------------------------------------------------------------

CREATE TABLE core.artifacts (
  id              UUID PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES core.tenants(id),
  project_id      UUID NOT NULL REFERENCES core.projects(id),
  kind            core.artifact_kind NOT NULL,
  -- Invariant 17: raw source, normalized fact, and interpretation are separate
  -- immutable versions. Rows are never overwritten.
  content_hash    TEXT NOT NULL CHECK (content_hash ~ '^0x[0-9a-f]{64}$'),
  object_key      TEXT,
  source_receipt_id UUID REFERENCES core.source_receipts(id),
  sensitivity     core.sensitivity NOT NULL,
  as_of           TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_by   UUID REFERENCES core.artifacts(id),
  revoked_at      TIMESTAMPTZ
);

CREATE INDEX artifacts_project_kind_idx ON core.artifacts (project_id, kind);

CREATE TABLE core.claims (
  id                UUID PRIMARY KEY,
  tenant_id         UUID NOT NULL REFERENCES core.tenants(id),
  project_id        UUID NOT NULL REFERENCES core.projects(id),
  claim_type        TEXT NOT NULL,
  -- Numbers are stored as decimal string + unit + as-of date (ADR-T07, 05 §5.9).
  value_text        TEXT NOT NULL,
  unit              TEXT,
  as_of             DATE,
  source_coordinate JSONB NOT NULL,
  evidence_tier     core.evidence_tier,
  verification_state core.verification_state NOT NULL DEFAULT 'unreviewed',
  grade             core.grade NOT NULL DEFAULT 'unverified',
  excluded_by_rule  BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  version           INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX claims_project_type_idx ON core.claims (project_id, claim_type);

-- 05 §5.5: lineage starts as adjacency edges + recursive CTE (ADR-T03).
CREATE TABLE core.lineage_edges (
  id            UUID PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES core.tenants(id),
  from_id       UUID NOT NULL,
  to_id         UUID NOT NULL,
  relation_type TEXT NOT NULL CHECK (relation_type IN (
    'derived_from','supports','contradicts','attests_to','interprets',
    'supersedes','revokes','used_by_assessment','used_by_decision','published_in_registry'
  )),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (from_id, to_id, relation_type)
);

CREATE INDEX lineage_from_idx ON core.lineage_edges (from_id);
CREATE INDEX lineage_to_idx ON core.lineage_edges (to_id);

CREATE TABLE core.claim_conflicts (
  id            UUID PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES core.tenants(id),
  claim_id      UUID NOT NULL REFERENCES core.claims(id),
  conflict_type TEXT NOT NULL,
  resolved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------

CREATE TABLE core.attestation_schemas (
  id                    UUID PRIMARY KEY,
  tenant_id             UUID NOT NULL REFERENCES core.tenants(id),
  schema_key            TEXT NOT NULL,
  schema_version        TEXT NOT NULL,
  attestation_type      core.attestation_type NOT NULL,
  required_evidence     TEXT[] NOT NULL DEFAULT '{}',
  accepted_authority_types TEXT[] NOT NULL DEFAULT '{}',
  mandatory_limitations TEXT[] NOT NULL DEFAULT '{}',
  jurisdiction_profile  TEXT NOT NULL,
  state                 TEXT NOT NULL DEFAULT 'draft'
                          CHECK (state IN ('draft','approved','active','superseded','retired')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, schema_key, schema_version)
);

CREATE TABLE core.verification_cases (
  id              UUID PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES core.tenants(id),
  project_id      UUID NOT NULL REFERENCES core.projects(id),
  schema_id       UUID NOT NULL REFERENCES core.attestation_schemas(id),
  state           core.verification_case_state NOT NULL DEFAULT 'draft',
  evidence_snapshot_hash TEXT CHECK (evidence_snapshot_hash ~ '^0x[0-9a-f]{64}$'),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  version         INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE core.assignments (
  id                UUID PRIMARY KEY,
  tenant_id         UUID NOT NULL REFERENCES core.tenants(id),
  case_id           UUID NOT NULL REFERENCES core.verification_cases(id),
  subject_id        UUID NOT NULL REFERENCES core.subjects(id),
  credential_id     UUID NOT NULL REFERENCES core.credentials(id),
  -- 02 §2.4 rules 1·2: a submitter cannot be an independent assurer of the same evidence,
  -- and the operator and assigned reviewer cannot share an organization or control relationship.
  independence_reviewed BOOLEAN NOT NULL DEFAULT false,
  conflict_status   TEXT NOT NULL DEFAULT 'none'
                      CHECK (conflict_status IN ('none','disclosed_resolved','unresolved')),
  assigned_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at        TIMESTAMPTZ
);

CREATE TABLE core.verification_attestations (
  id                        UUID PRIMARY KEY,
  tenant_id                 UUID NOT NULL REFERENCES core.tenants(id),
  case_id                   UUID NOT NULL REFERENCES core.verification_cases(id),
  assignment_id             UUID NOT NULL REFERENCES core.assignments(id),
  credential_id             UUID NOT NULL REFERENCES core.credentials(id),
  schema_id                 UUID NOT NULL REFERENCES core.attestation_schemas(id),
  attestation_type          core.attestation_type NOT NULL,
  claim_scope               UUID[] NOT NULL,
  evidence_snapshot_hash    TEXT NOT NULL CHECK (evidence_snapshot_hash ~ '^0x[0-9a-f]{64}$'),
  findings                  JSONB NOT NULL DEFAULT '[]'::jsonb,
  citations                 JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- AC-01: limitations cannot be an empty string. Enforced by a DB constraint, not
  -- only by application validation.
  limitations               TEXT NOT NULL CHECK (btrim(limitations) <> ''),
  -- AC-17: preserves the credential state at signing time. This value does not change
  -- when the current state changes.
  credential_status_snapshot JSONB NOT NULL,
  method_version            TEXT NOT NULL,
  policy_version            TEXT NOT NULL,
  payload_hash              TEXT NOT NULL CHECK (payload_hash ~ '^0x[0-9a-f]{64}$'),
  signature                 TEXT NOT NULL,
  signer_wallet_address     TEXT NOT NULL CHECK (signer_wallet_address ~ '^0x[0-9a-f]{40}$'),
  signed_at                 TIMESTAMPTZ NOT NULL,
  valid_until               TIMESTAMPTZ,
  state                     TEXT NOT NULL DEFAULT 'signed'
                              CHECK (state IN ('draft','signed','active','stale_candidate','superseded','revoked','disputed')),
  supersedes_id             UUID REFERENCES core.verification_attestations(id),
  revokes_id                UUID REFERENCES core.verification_attestations(id),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT claim_scope_not_empty CHECK (array_length(claim_scope, 1) >= 1)
);

CREATE INDEX attestations_case_idx ON core.verification_attestations (case_id);

-- ---------------------------------------------------------------------------
-- Readiness & Decision
-- ---------------------------------------------------------------------------

CREATE TABLE core.compliance_policy_sets (
  id                   UUID PRIMARY KEY,
  tenant_id            UUID NOT NULL REFERENCES core.tenants(id),
  rule_set_id          TEXT NOT NULL,
  rule_set_version     TEXT NOT NULL,
  gate_id              TEXT NOT NULL,
  jurisdiction_profile TEXT NOT NULL,
  effective_from       TIMESTAMPTZ NOT NULL,
  retroactive          BOOLEAN NOT NULL DEFAULT false,
  superseded_by        UUID REFERENCES core.compliance_policy_sets(id),
  definition           JSONB NOT NULL,
  state                TEXT NOT NULL DEFAULT 'draft'
                         CHECK (state IN ('draft','approved','effective','superseded','retired')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, rule_set_id, rule_set_version)
);

-- 07 §7.2: there is no path to PATCH a readiness result. An UPDATE trigger also blocks it
-- (0003_guards.sql). A recalculation is a new row.
CREATE TABLE core.compliance_assessments (
  id                   UUID PRIMARY KEY,
  tenant_id            UUID NOT NULL REFERENCES core.tenants(id),
  project_id           UUID NOT NULL REFERENCES core.projects(id),
  gate_id              TEXT NOT NULL,
  policy_set_id        UUID NOT NULL REFERENCES core.compliance_policy_sets(id),
  input_snapshot_hash  TEXT NOT NULL CHECK (input_snapshot_hash ~ '^0x[0-9a-f]{64}$'),
  evaluated_as_of      TIMESTAMPTZ NOT NULL,
  status               core.readiness_status NOT NULL,
  requirement_results  JSONB NOT NULL,
  -- AC-11: the same (input_snapshot_hash, policy_set_id) yields the same result hash.
  canonical_result_hash TEXT NOT NULL CHECK (canonical_result_hash ~ '^0x[0-9a-f]{64}$'),
  generated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX assessments_project_idx ON core.compliance_assessments (project_id, generated_at DESC);

CREATE TABLE core.gate_decisions (
  id                     UUID PRIMARY KEY,
  tenant_id              UUID NOT NULL REFERENCES core.tenants(id),
  project_id             UUID NOT NULL REFERENCES core.projects(id),
  gate_id                TEXT NOT NULL,
  decision               core.gate_decision_value NOT NULL,
  -- A human decision always takes an assessment as input (§4.2).
  input_assessment_id    UUID NOT NULL REFERENCES core.compliance_assessments(id),
  evidence_snapshot_hash TEXT NOT NULL CHECK (evidence_snapshot_hash ~ '^0x[0-9a-f]{64}$'),
  decision_authority     TEXT NOT NULL,
  decision_maker_subject_id UUID NOT NULL REFERENCES core.subjects(id),
  rationale              TEXT NOT NULL CHECK (btrim(rationale) <> ''),
  assumptions            TEXT[] NOT NULL DEFAULT '{}',
  conditions             TEXT[] NOT NULL DEFAULT '{}',
  signature              TEXT NOT NULL,
  signed_at              TIMESTAMPTZ NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Registry & Publication
-- ---------------------------------------------------------------------------

CREATE TABLE core.registry_entries (
  id            UUID PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES core.tenants(id),
  registry_type core.registry_type NOT NULL,
  subject_id    UUID NOT NULL,
  public_key    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (registry_type, public_key)
);

CREATE TABLE core.registry_entry_versions (
  id                   UUID PRIMARY KEY,
  tenant_id            UUID NOT NULL REFERENCES core.tenants(id),
  entry_id             UUID NOT NULL REFERENCES core.registry_entries(id),
  version              INTEGER NOT NULL,
  status               core.registry_entry_status NOT NULL DEFAULT 'draft',
  -- Only projections that pass the disclosure allowlist go here (05 §5.7).
  public_projection    JSONB,
  content_hash         TEXT CHECK (content_hash ~ '^0x[0-9a-f]{64}$'),
  source_snapshot_hash TEXT NOT NULL CHECK (source_snapshot_hash ~ '^0x[0-9a-f]{64}$'),
  policy_version       TEXT NOT NULL,
  schema_version       TEXT NOT NULL,
  serialization_version TEXT NOT NULL DEFAULT '1',
  previous_version_id  UUID REFERENCES core.registry_entry_versions(id),
  published_at         TIMESTAMPTZ,
  revoked_at           TIMESTAMPTZ,
  superseded_by_id     UUID REFERENCES core.registry_entry_versions(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entry_id, version),
  CONSTRAINT published_requires_projection CHECK (
    status <> 'published' OR (public_projection IS NOT NULL AND content_hash IS NOT NULL)
  )
);

CREATE TABLE core.disclosure_restrictions (
  id                     UUID PRIMARY KEY,
  tenant_id              UUID NOT NULL REFERENCES core.tenants(id),
  project_id             UUID NOT NULL REFERENCES core.projects(id),
  subject_scope          UUID[] NOT NULL,
  restricted_action_types TEXT[] NOT NULL,
  legal_basis            TEXT NOT NULL,
  authority              TEXT NOT NULL,
  state                  TEXT NOT NULL DEFAULT 'draft'
                           CHECK (state IN ('draft','active','released','superseded')),
  effective_at           TIMESTAMPTZ,
  released_at            TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Chain
-- ---------------------------------------------------------------------------

CREATE TABLE chain.anchor_batches (
  id                UUID PRIMARY KEY,
  tenant_id         UUID NOT NULL REFERENCES core.tenants(id),
  batch_id          TEXT NOT NULL UNIQUE CHECK (batch_id ~ '^0x[0-9a-f]{64}$'),
  merkle_root       TEXT NOT NULL CHECK (merkle_root ~ '^0x[0-9a-f]{64}$'),
  manifest_hash     TEXT NOT NULL CHECK (manifest_hash ~ '^0x[0-9a-f]{64}$'),
  manifest_object_key TEXT NOT NULL,
  schema_version    TEXT NOT NULL,
  record_count      INTEGER NOT NULL CHECK (record_count > 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE chain.anchor_batch_leaves (
  batch_id            UUID NOT NULL REFERENCES chain.anchor_batches(id),
  leaf_hash           TEXT NOT NULL CHECK (leaf_hash ~ '^0x[0-9a-f]{64}$'),
  entry_version_id    UUID NOT NULL REFERENCES core.registry_entry_versions(id),
  leaf_index          INTEGER NOT NULL,
  PRIMARY KEY (batch_id, leaf_hash)
);

CREATE TABLE chain.transactions (
  id                UUID PRIMARY KEY,
  tenant_id         UUID NOT NULL REFERENCES core.tenants(id),
  batch_id          UUID REFERENCES chain.anchor_batches(id),
  intent_key        TEXT NOT NULL,
  chain_id          INTEGER NOT NULL,
  contract_address  TEXT CHECK (contract_address ~ '^0x[0-9a-f]{40}$'),
  tx_hash           TEXT CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  nonce             BIGINT,
  state             chain.transaction_state NOT NULL DEFAULT 'created',
  block_number      BIGINT,
  confirmations     INTEGER NOT NULL DEFAULT 0,
  replaced_by_id    UUID REFERENCES chain.transactions(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  version           INTEGER NOT NULL DEFAULT 1,
  -- One logical intent has at most one active transaction (§7.7).
  UNIQUE (intent_key, chain_id)
);

-- ---------------------------------------------------------------------------
-- Outbox / Inbox / Idempotency
-- 07 §7.5: the domain transaction and the outbox insert run in the same transaction.
-- ---------------------------------------------------------------------------

CREATE TABLE core.outbox (
  id              UUID PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES core.tenants(id),
  event_type      TEXT NOT NULL,
  schema_version  INTEGER NOT NULL DEFAULT 1,
  aggregate_id    UUID NOT NULL,
  aggregate_version INTEGER NOT NULL,
  project_id      UUID,
  payload         JSONB NOT NULL,
  correlation_id  TEXT NOT NULL,
  causation_id    TEXT,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at    TIMESTAMPTZ
);

CREATE INDEX outbox_unpublished_idx ON core.outbox (occurred_at) WHERE published_at IS NULL;

CREATE TABLE core.inbox (
  event_id        UUID NOT NULL,
  handler_version TEXT NOT NULL,
  processed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, handler_version)
);

CREATE TABLE core.idempotency_keys (
  key               TEXT NOT NULL,
  tenant_id         UUID NOT NULL REFERENCES core.tenants(id),
  request_hash      TEXT NOT NULL,
  response_status   INTEGER,
  response_snapshot JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (key, tenant_id)
);

-- ---------------------------------------------------------------------------
-- Audit
-- 02 §2.7: every mutation records actor, effective role, before/after version, reason, and
-- correlation ID. Append-only; not even an application admin can delete.
-- ---------------------------------------------------------------------------

CREATE TABLE audit.events (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL,
  project_id      UUID,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_subject_id UUID,
  actor_wallet    TEXT,
  effective_role  TEXT,
  command         TEXT NOT NULL,
  resource_type   TEXT NOT NULL,
  resource_id     UUID,
  before_version  INTEGER,
  after_version   INTEGER,
  reason          TEXT,
  correlation_id  TEXT NOT NULL,
  request_ip      INET,
  signature_or_tx TEXT,
  detail          JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX audit_events_tenant_time_idx ON audit.events (tenant_id, occurred_at DESC);
CREATE INDEX audit_events_resource_idx ON audit.events (resource_type, resource_id);
