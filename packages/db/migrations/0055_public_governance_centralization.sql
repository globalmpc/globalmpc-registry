-- Public proposal disclosure and centralization disclosure — spec 09 §9.4, §9.11, 11 §11.3
--
-- Same boundary as 0027: public routes know no tenant, so each public read is a SECURITY
-- DEFINER function that returns only what was chosen for disclosure.
--
-- 1. The public protocol proposal now carries its conflict disclosure and execution mode
--    (0054). 09 §9.4 lists public disclosure among the proposal fields; a disclosure only the
--    workspace can read discloses nothing to the holders who vote.
--
-- 2. Centralization disclosure (REQ-DAPP-023). 09 §9.11 requires the UI to show the current
--    stage and the powers still centralized; at the first stage "every admin is disclosed".
--    Holders are **counted, not named** — the count shows how concentrated a power is; names
--    link to natural persons (AC-32) and add nothing to that.

-- The return type changes, so the function is recreated rather than replaced.
DROP FUNCTION core.public_protocol_proposals(INTEGER, TIMESTAMPTZ, UUID);

CREATE FUNCTION core.public_protocol_proposals(
  p_limit            INTEGER,
  p_after_created_at TIMESTAMPTZ,
  p_after_id         UUID
)
RETURNS TABLE (
  id                    UUID,
  proposal_type         TEXT,
  title                 TEXT,
  rationale             TEXT,
  state                 core.proposal_state,
  quorum_numerator      INTEGER,
  quorum_denominator    INTEGER,
  threshold_numerator   INTEGER,
  threshold_denominator INTEGER,
  voting_opens_at       TIMESTAMPTZ,
  voting_closes_at      TIMESTAMPTZ,
  created_at            TIMESTAMPTZ,
  weight_for            NUMERIC,
  weight_against        NUMERIC,
  weight_abstain        NUMERIC,
  voter_count           BIGINT,
  conflict_disclosure   TEXT,
  execution_mode        TEXT
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = core, pg_temp
AS $$
  SELECT p.id, p.proposal_type, p.title, p.rationale, p.state,
         p.quorum_numerator, p.quorum_denominator,
         p.threshold_numerator, p.threshold_denominator,
         p.voting_opens_at, p.voting_closes_at, p.created_at,
         COALESCE(t.weight_for, 0), COALESCE(t.weight_against, 0),
         COALESCE(t.weight_abstain, 0), COALESCE(t.voter_count, 0),
         p.conflict_disclosure, p.execution_mode
  FROM core.governance_proposals p
  LEFT JOIN LATERAL (
    SELECT SUM(v.weight) FILTER (WHERE v.choice = 'for')     AS weight_for,
           SUM(v.weight) FILTER (WHERE v.choice = 'against') AS weight_against,
           SUM(v.weight) FILTER (WHERE v.choice = 'abstain') AS weight_abstain,
           COUNT(*)                                          AS voter_count
    FROM core.governance_votes v
    WHERE v.proposal_id = p.id
  ) t ON true
  WHERE p.space = 'protocol'
    AND p.state <> 'draft'
    AND (
      p_after_created_at IS NULL
      OR p.created_at < p_after_created_at
      OR (p.created_at = p_after_created_at AND p.id < p_after_id)
    )
  ORDER BY p.created_at DESC, p.id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100)
$$;

/**
 * Active holders of each governance and operations power.
 *
 * Only the listed roles — the ones that propose, vote, administer, record execution, sign
 * treasury transactions, or respond to incidents. Counting every role would publish the size
 * of each company's review team, which is not a governance fact.
 *
 * A revoked binding is not a current power, so it is not counted.
 */
CREATE FUNCTION core.public_governance_role_holders()
RETURNS TABLE (role TEXT, active_holders BIGINT)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = core, pg_temp
AS $$
  SELECT r.role, COUNT(DISTINCT b.subject_id)
  FROM unnest(ARRAY[
    'mpc_operator', 'security_operator', 'protocol_proposer', 'protocol_voter',
    'project_proposer', 'project_voter', 'execution_recorder', 'treasury_signer'
  ]) AS r(role)
  LEFT JOIN core.role_bindings b ON b.role = r.role AND b.revoked_at IS NULL
  GROUP BY r.role
  ORDER BY r.role
$$;

/**
 * Anchor contracts this service has submitted to, and the Safes it sent proposals to.
 *
 * Both are already public on chain; this lists the ones this service's own records name so a
 * reader can check who holds the submission right there.
 */
CREATE FUNCTION core.public_anchor_authority()
RETURNS TABLE (chain_id INTEGER, contract_address TEXT, safe_addresses TEXT[])
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = chain, core, pg_temp
AS $$
  SELECT c.chain_id, c.contract_address,
         COALESCE(
           ARRAY(
             SELECT DISTINCT p.safe_address FROM chain.anchor_proposals p
             WHERE p.chain_id = c.chain_id AND p.contract_address = c.contract_address
             ORDER BY p.safe_address
           ),
           ARRAY[]::TEXT[]
         )
  FROM (
    SELECT DISTINCT t.chain_id, t.contract_address
    FROM chain.transactions t
    WHERE t.contract_address IS NOT NULL
  ) c
  ORDER BY c.chain_id, c.contract_address
$$;

REVOKE EXECUTE ON FUNCTION core.public_protocol_proposals(INTEGER, TIMESTAMPTZ, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.public_governance_role_holders() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.public_anchor_authority() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION core.public_protocol_proposals(INTEGER, TIMESTAMPTZ, UUID) TO mpc_app;
GRANT EXECUTE ON FUNCTION core.public_governance_role_holders() TO mpc_app;
GRANT EXECUTE ON FUNCTION core.public_anchor_authority() TO mpc_app;
