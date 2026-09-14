-- Unauthenticated public governance and public history — spec 11 §11.2·§11.3.
--
-- The boundary is the same as 0009·0026. What differs is **what counts as public**, so
-- the reasoning is recorded here.

-- ---------------------------------------------------------------------------
-- Public governance
-- ---------------------------------------------------------------------------
--
-- **Only protocol space is public.** Proposals in `project` space are internal decisions
-- of a specific project, with no basis for disclosure. Protocol space changes the rules of the
-- protocol itself; if that is not public it cannot be called governance.
--
-- **No `draft`.** A draft is not yet proposed — the same reason Registry drafts
-- are not exposed.
--
-- **No voters.** Aggregates only. Individual voters are subjects and link to natural-person
-- identifiers (AC-32). Aggregates are the basis of the outcome; a voter list is not.

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
  voter_count           BIGINT
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
         COALESCE(t.weight_abstain, 0), COALESCE(t.voter_count, 0)
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

-- Path taken. The current state alone makes "ended without quorum" and "cancelled" look
-- the same (same reason as 0017). `actor_subject_id` is not exposed.
CREATE FUNCTION core.public_protocol_proposal_transitions(p_proposal_id UUID)
RETURNS TABLE (
  from_state     core.proposal_state,
  to_state       core.proposal_state,
  reason         TEXT,
  occurred_at    TIMESTAMPTZ,
  tally_snapshot JSONB
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = core, pg_temp
AS $$
  SELECT t.from_state, t.to_state, t.reason, t.occurred_at, t.tally_snapshot
  FROM core.governance_transitions t
  JOIN core.governance_proposals p ON p.id = t.proposal_id
  WHERE t.proposal_id = p_proposal_id
    AND p.space = 'protocol'
    AND p.state <> 'draft'
  ORDER BY t.occurred_at ASC
$$;

-- ---------------------------------------------------------------------------
-- Public history — corrections and revocations
-- ---------------------------------------------------------------------------
--
-- **Re-exposes only already-public facts as a time series.** Nothing new becomes public here —
-- 0009 already returns `revoked`·`superseded` public versions in the detail lookup.
-- The only difference is ordering by "what happened when" instead of "in which record".
--
-- **Credential revocation, suspension, pause, and dispute are not here.** Those four live in
-- tables outside the public projection, and what to disclose at what granularity is undecided.
-- Undecided matters are not decided here (D-41).

CREATE FUNCTION core.public_disclosure_events(
  p_limit       INTEGER,
  p_after_at    TIMESTAMPTZ,
  p_after_id    UUID
)
RETURNS TABLE (
  event_kind        TEXT,
  occurred_at       TIMESTAMPTZ,
  registry_type     core.registry_type,
  public_key        TEXT,
  entry_version_id  UUID,
  version           INTEGER,
  public_projection JSONB,
  superseded_by_id  UUID
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = core, pg_temp
AS $$
  WITH events AS (
    SELECT
      CASE WHEN v.status = 'revoked' THEN 'revocation' ELSE 'source_correction' END AS event_kind,
      -- For a revocation the event time is revoked_at; for a supersede, the successor version's publish time.
      COALESCE(v.revoked_at, next_version.published_at, v.published_at, v.created_at) AS occurred_at,
      e.registry_type,
      e.public_key,
      v.id AS entry_version_id,
      v.version,
      v.public_projection,
      v.superseded_by_id
    FROM core.registry_entry_versions v
    JOIN core.registry_entries e ON e.id = v.entry_id
    LEFT JOIN core.registry_entry_versions next_version
      ON next_version.id = v.superseded_by_id
    WHERE v.status IN ('revoked', 'superseded')
      AND v.public_projection IS NOT NULL
  )
  SELECT events.event_kind, events.occurred_at, events.registry_type, events.public_key,
         events.entry_version_id, events.version, events.public_projection,
         events.superseded_by_id
  FROM events
  WHERE p_after_at IS NULL
     OR events.occurred_at < p_after_at
     OR (events.occurred_at = p_after_at AND events.entry_version_id < p_after_id)
  ORDER BY events.occurred_at DESC, events.entry_version_id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100)
$$;

REVOKE EXECUTE ON FUNCTION core.public_protocol_proposals(INTEGER, TIMESTAMPTZ, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.public_protocol_proposal_transitions(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.public_disclosure_events(INTEGER, TIMESTAMPTZ, UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION core.public_protocol_proposals(INTEGER, TIMESTAMPTZ, UUID) TO mpc_app;
GRANT EXECUTE ON FUNCTION core.public_protocol_proposal_transitions(UUID) TO mpc_app;
GRANT EXECUTE ON FUNCTION core.public_disclosure_events(INTEGER, TIMESTAMPTZ, UUID) TO mpc_app;
