-- Credential issuer link, credential status history, assignment independence record —
-- spec 02 §2.4 rules 1·2, §2.8, §2.9, 13 AC-15·AC-16, REQ-DAPP-018·042·044.
--
-- Additive only. Existing columns keep their meaning; later migrations may add triggers that
-- react to credential status changes.

/**
 * Which authority issued the credential.
 *
 * `issuer_reference` is free text ("AusIMM #123"). It names an issuer for a human to cross-check,
 * but nothing can ask it whether that issuer is accepted, suspended or recognized for the claim
 * types being reviewed (AC-15·AC-16). The link makes those questions answerable.
 *
 * Nullable: credentials registered before this migration have no link. Signing and assignment
 * treat a missing link as "issuer not accepted" — an unknown issuer is not a trusted one.
 */
ALTER TABLE core.credentials
  ADD COLUMN issuer_authority_id UUID,
  ADD CONSTRAINT credentials_issuer_authority_same_tenant
    FOREIGN KEY (tenant_id, issuer_authority_id) REFERENCES core.authorities (tenant_id, id);

CREATE INDEX credentials_issuer_authority_idx ON core.credentials (issuer_authority_id)
  WHERE issuer_authority_id IS NOT NULL;

/**
 * Credential status history.
 *
 * `current_status` holds only the present. An attestation keeps the status at signing time
 * (AC-17), but "when did this credential stop being valid, why, and who said so" lives nowhere
 * else. Append-only: a history that can be edited is not evidence.
 */
CREATE TABLE core.credential_status_events (
  id               UUID PRIMARY KEY,
  tenant_id        UUID NOT NULL REFERENCES core.tenants(id),
  credential_id    UUID NOT NULL,
  from_status      TEXT NOT NULL,
  to_status        TEXT NOT NULL
                     CHECK (to_status IN ('valid','expired','revoked','suspended','unknown')),
  reason           TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  actor_subject_id UUID,
  occurred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT credential_status_event_changes_status CHECK (from_status <> to_status),
  FOREIGN KEY (tenant_id, credential_id) REFERENCES core.credentials (tenant_id, id)
);

CREATE INDEX credential_status_events_credential_idx
  ON core.credential_status_events (credential_id, occurred_at DESC);

ALTER TABLE core.credential_status_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.credential_status_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON core.credential_status_events
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

GRANT SELECT, INSERT ON core.credential_status_events TO mpc_app;

CREATE OR REPLACE FUNCTION core.reject_credential_status_event_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Credential status history cannot be modified or deleted';
END
$$;

CREATE TRIGGER credential_status_events_append_only
  BEFORE UPDATE OR DELETE ON core.credential_status_events
  FOR EACH ROW EXECUTE FUNCTION core.reject_credential_status_event_mutation();

/**
 * Assignment independence record and revocation.
 *
 * `independence_reviewed` used to be written `true` by the route without any check. It now
 * records whether the server evaluated 02 §2.4 rules 1 and 2 and found nothing it could not
 * evaluate. `independence_basis` keeps what was compared, so the judgment can be reproduced
 * later (REQ-DAPP-018 "conflict/assignment audit reproduction").
 *
 * An assignment is never deleted. Replacing a reviewer revokes the old row with a reason and
 * adds a new one.
 */
ALTER TABLE core.assignments
  ADD COLUMN assigned_by        UUID,
  ADD COLUMN independence_basis JSONB,
  ADD COLUMN revoked_by         UUID,
  ADD COLUMN revoke_reason      TEXT,
  ADD CONSTRAINT assignments_assigned_by_same_tenant
    FOREIGN KEY (tenant_id, assigned_by) REFERENCES core.subjects (tenant_id, id),
  ADD CONSTRAINT assignments_revoked_by_same_tenant
    FOREIGN KEY (tenant_id, revoked_by) REFERENCES core.subjects (tenant_id, id),
  -- A revocation without a reason leaves "why was this reviewer removed" unanswerable.
  ADD CONSTRAINT assignment_revocation_needs_reason CHECK (
    revoked_at IS NULL OR (revoke_reason IS NOT NULL AND length(btrim(revoke_reason)) > 0)
  ) NOT VALID;

/**
 * One active assignment per case.
 *
 * Two active reviewers on one case would each be able to sign, and "the" reviewer of the case
 * would be whoever signed first. Reassignment revokes before it assigns.
 */
CREATE UNIQUE INDEX assignments_one_active_per_case
  ON core.assignments (case_id) WHERE revoked_at IS NULL;

/**
 * The status route's own grant.
 *
 * 0048 took UPDATE on credentials away until a route needed it. The status route does: it
 * writes only the status, the revocation stamp and the version, and every change leaves a
 * `credential_status_events` row. Lifting a suspension takes a second person (the route refuses
 * whoever suspended). The other columns stay without UPDATE.
 */
GRANT UPDATE (current_status, revoked_at, version) ON core.credentials TO mpc_app;
