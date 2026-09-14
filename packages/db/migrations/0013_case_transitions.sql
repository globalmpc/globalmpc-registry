-- Review case state history and attestation disputes — spec 04 §4.2·§4.4
--
-- Until now a case's state held only the current value. That cannot tell two things.
--
-- 1. **Why it reached this state** — without a place to record what `changes_requested`
--    asks to fix, the reviewer has to ask again.
-- 2. **Which path it took** — a case reassigned after rejection and one that proceeded from
--    the start look the same by current state alone.
--
-- History is never deleted. Even if the state goes back, the path taken remains.

CREATE TABLE core.verification_case_transitions (
  id            UUID PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES core.tenants(id),
  case_id       UUID NOT NULL,
  from_state    core.verification_case_state NOT NULL,
  to_state      core.verification_case_state NOT NULL,
  -- Do not store a state change without a reason. The DB rejects it, independent of API validation.
  reason        TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  actor_subject_id UUID,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, case_id) REFERENCES core.verification_cases (tenant_id, id)
);

CREATE INDEX verification_case_transitions_case_idx
  ON core.verification_case_transitions (case_id, occurred_at DESC);

/**
 * Attestation dispute.
 *
 * **The signature is never deleted.** The judgment at signing time remains, and the dispute
 * is added as a new fact. Deleting the signature loses "who judged what, and when" —
 * indistinguishable from hiding a flawed review.
 */
CREATE TABLE core.attestation_disputes (
  id            UUID PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES core.tenants(id),
  attestation_id UUID NOT NULL,
  reason_code   TEXT NOT NULL,
  detail        TEXT NOT NULL CHECK (length(btrim(detail)) > 0),
  raised_by_subject_id UUID,
  raised_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Even when resolved, the dispute record remains. Only resolved_at is filled.
  resolved_at   TIMESTAMPTZ,
  resolution    TEXT,
  FOREIGN KEY (tenant_id, attestation_id)
    REFERENCES core.verification_attestations (tenant_id, id)
);

CREATE INDEX attestation_disputes_attestation_idx
  ON core.attestation_disputes (attestation_id, raised_at DESC);

ALTER TABLE core.verification_case_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.verification_case_transitions FORCE ROW LEVEL SECURITY;
ALTER TABLE core.attestation_disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.attestation_disputes FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON core.verification_case_transitions
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

CREATE POLICY tenant_isolation ON core.attestation_disputes
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

-- State history is append-only. Withholding UPDATE·DELETE is the control.
GRANT SELECT, INSERT ON core.verification_case_transitions TO mpc_app;
-- Disputes need UPDATE to mark resolution. Deletion never happens.
GRANT SELECT, INSERT, UPDATE ON core.attestation_disputes TO mpc_app;

-- Bump the case version on every state transition. If-Match checks this value.
-- Enforcing it in a trigger keeps versions consistent even if the application forgets.
CREATE OR REPLACE FUNCTION core.bump_case_version() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER verification_cases_version_bump
  BEFORE UPDATE ON core.verification_cases
  FOR EACH ROW EXECUTE FUNCTION core.bump_case_version();

-- A disputed attestation cannot change its signed body. The 0003 immutability
-- trigger already blocks post-signature edits, but state transitions must be allowed, so
-- re-check here: payload_hash stays the same even after going to disputed and back.
