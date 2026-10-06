-- Credential change propagation — spec 04 §4.10 invariant 18, 05 §5.5, AC-12 · AC-17 · AC-21.
--
-- The chain built so far starts at a source: authority → connection → claim → attestation
-- (0020 · 0023), then signals on assessments and public versions (0024). A change to the
-- **signer's credential** reached nothing. A reviewer whose licence was revoked yesterday still
-- backed every attestation they signed, and nothing asked anyone to look again.
--
-- **The past is not rewritten.** `credential_status_snapshot` keeps what the credential was at
-- signing, and the guard from 0003 already refuses to change it. The signature happened while the
-- credential was valid; that stays true. What changes is whether the attestation still applies
-- today, so the attestation moves to `stale_candidate` — the same re-review state a lost source
-- produces — and from there 0024 carries the signal to assessments and public versions.
--
-- **Which statuses count.** The ones `evaluateCredentialApplicability` (packages/domain) treats as
-- needing re-review: `expired`, `suspended`, `unknown`, `revoked`. `valid` does not.

/**
 * Move the active attestations signed with `p_credential` to re-review.
 *
 * **Only `active` moves**, as in 0023: `signed` is not yet in effect, `revoked`·`superseded` are
 * finished, and `disputed` is already with a person. Touching finished records blurs "what was
 * valid when". An attestation already in `stale_candidate` keeps its first reason.
 */
CREATE OR REPLACE FUNCTION core.mark_credential_attestations_stale(
  p_credential UUID,
  p_reason TEXT
) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  moved INTEGER;
BEGIN
  UPDATE core.verification_attestations a
  SET state = 'stale_candidate',
      stale_reason = p_reason
  WHERE a.credential_id = p_credential
    AND a.state = 'active';
  GET DIAGNOSTICS moved = ROW_COUNT;
  RETURN moved;
END
$$;

/**
 * credential → attestation propagation.
 *
 * Fires on a status change away from `valid`, on `revoked_at` being set, and on an expiry date
 * corrected into the past. A date that simply passes changes no row, so the worker sweep below
 * covers it.
 */
CREATE OR REPLACE FUNCTION core.propagate_credential_to_attestations() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  cause TEXT;
BEGIN
  IF NEW.current_status IN ('expired', 'suspended', 'unknown', 'revoked')
     AND NEW.current_status IS DISTINCT FROM OLD.current_status
  THEN
    cause := NEW.current_status;
  ELSIF NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL THEN
    cause := 'revoked';
  ELSIF NEW.expires_at IS NOT NULL
        AND NEW.expires_at <= now()
        AND NEW.expires_at IS DISTINCT FROM OLD.expires_at
  THEN
    cause := 'expired';
  ELSE
    RETURN NEW;
  END IF;

  PERFORM core.mark_credential_attestations_stale(
    NEW.id,
    format('Signing credential is now %s (credential %s); its status at signing is kept unchanged',
           cause, NEW.id)
  );

  RETURN NEW;
END
$$;

CREATE TRIGGER credentials_propagate_to_attestations
  AFTER UPDATE ON core.credentials
  FOR EACH ROW EXECUTE FUNCTION core.propagate_credential_to_attestations();

/**
 * Credential expiry sweep across tenants — called by the outbox worker.
 *
 * An expiry date passes without anyone touching the credential, so no trigger fires. The sweep
 * finds credentials past `expires_at` that still back active attestations and moves those
 * attestations to re-review.
 *
 * **The credential row is not written.** Its status belongs to whoever manages credentials; the
 * sweep only reads the date. Running it twice moves nothing new, because the attestations it
 * moved are no longer `active`.
 *
 * SECURITY DEFINER for the reason given for `core.sweep_document_expiry` (0045): the worker role
 * reads almost nothing of the evidence chain, and one function taking only a time is narrower than
 * granting it the tables the triggers reach. The tenant is set per iteration so rows written by
 * the triggers carry the right scope.
 */
CREATE OR REPLACE FUNCTION core.sweep_credential_expiry(p_now TIMESTAMPTZ)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  tenant RECORD;
  target RECORD;
  total INTEGER := 0;
BEGIN
  FOR tenant IN SELECT t.id FROM core.tenants t ORDER BY t.id LOOP
    PERFORM set_config('app.current_tenant', tenant.id::text, true);

    FOR target IN
      SELECT c.id, c.expires_at FROM core.credentials c
      WHERE c.tenant_id = tenant.id
        AND c.expires_at <= p_now
        AND EXISTS (
          SELECT 1 FROM core.verification_attestations a
          WHERE a.credential_id = c.id AND a.state = 'active'
        )
      ORDER BY c.id
    LOOP
      total := total + core.mark_credential_attestations_stale(
        target.id,
        format('Signing credential passed its expiry %s (credential %s); its status at signing is kept unchanged',
               target.expires_at, target.id)
      );
    END LOOP;
  END LOOP;

  RETURN total;
END
$$;

REVOKE ALL ON FUNCTION core.sweep_credential_expiry(TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.sweep_credential_expiry(TIMESTAMPTZ) TO mpc_worker;
