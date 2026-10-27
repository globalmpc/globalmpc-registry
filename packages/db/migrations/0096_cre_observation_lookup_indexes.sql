-- Public sequence allocation and source lookups must not scan append-only history while
-- holding the project's publication barrier. Index numeric sequence ordering, not lexical
-- JSON string ordering (where '9' sorts above '10').
CREATE INDEX cre_reports_public_sequence_order_idx ON core.cre_reports
  (tenant_id, project_id, ((report ->> 'sequence')::numeric) DESC);

-- Stored digests let ordinary equality predicates use indexes beneath tenant RLS.
-- Computing md5(query_basis::text) on table rows is not leakproof, so PostgreSQL cannot
-- push that expression through the security barrier for the application role.
ALTER TABLE core.source_observations ADD COLUMN query_scope_hash TEXT
  GENERATED ALWAYS AS (md5(query_basis::text)) STORED;
ALTER TABLE core.source_receipts ADD COLUMN query_scope_hash TEXT
  GENERATED ALWAYS AS (md5(query_basis::text)) STORED;

-- Keep large query identifiers out of btree keys. Hashes select candidates only: every
-- application lookup also checks exact JSONB equality, so collisions cannot merge scopes.
CREATE INDEX source_observations_scope_time_idx ON core.source_observations
  (tenant_id, project_id, connection_id, query_scope_hash, observed_at DESC, observation_sequence DESC)
  WHERE outcome <> 'out_of_order';
CREATE INDEX source_observations_success_scope_time_idx ON core.source_observations
  (tenant_id, project_id, connection_id, query_scope_hash, observed_at DESC, observation_sequence DESC)
  WHERE outcome IN ('baseline','unchanged','changed');
CREATE INDEX source_observations_scope_sequence_idx ON core.source_observations
  (tenant_id, project_id, connection_id, query_scope_hash, observation_sequence DESC)
  WHERE outcome <> 'out_of_order';

-- New query scopes have no observation baseline yet. Their upgrade fallback still needs an
-- indexed receipt probe, including a quick negative lookup when that query was never collected.
CREATE INDEX source_receipts_confirmed_scope_time_idx ON core.source_receipts
  (tenant_id, project_id, connection_id, query_scope_hash, received_at DESC, id DESC)
  WHERE result = 'confirmed_from_source' AND raw_hash IS NOT NULL
    AND channel_evidence ->> 'collector' = 'server_adapter';
