-- 무인증 공개 거버넌스와 공개 이력 — spec 11 §11.2·§11.3.
--
-- 경계는 0009·0026과 같다. 다른 것은 **무엇을 공개로 볼 것인가**이므로 그
-- 판단 근거를 여기 적는다.

-- ---------------------------------------------------------------------------
-- 공개 거버넌스
-- ---------------------------------------------------------------------------
--
-- **protocol space만 공개한다.** `project` space의 제안은 특정 프로젝트의 내부
-- 의사결정이며 공개 대상이라는 근거가 없다. protocol space는 프로토콜 자체의
-- 규칙을 바꾸는 것이고, 그것이 공개되지 않으면 거버넌스라고 부를 수 없다.
--
-- **`draft`는 내지 않는다.** 아직 제안되지 않은 초안이다 — Registry의 draft를
-- 내지 않는 것과 같은 이유다.
--
-- **투표자를 내지 않는다.** 집계만 낸다. 개별 투표자는 subject이고 자연인
-- 식별자로 이어진다(AC-32). 집계는 판정 근거이지만 명단은 아니다.

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

-- 지나온 경로. 현재 상태만으로는 "정족수 미달로 끝났다"와 "취소됐다"가 결과만
-- 같아 보인다(0017의 같은 이유). `actor_subject_id`는 내지 않는다.
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
-- 공개 이력 — 정정과 철회
-- ---------------------------------------------------------------------------
--
-- **이미 공개된 사실만 시계열로 다시 낸다.** 여기서 새로 공개되는 것은 없다 —
-- `revoked`·`superseded`인 공개 version은 0009가 이미 상세 조회로 반환한다.
-- 다른 것은 "어느 기록에서" 대신 "언제 무슨 일이"로 정렬한다는 점뿐이다.
--
-- **credential 철회·suspension·pause·dispute는 여기 없다.** 그 넷은 공개
-- projection 밖의 테이블에 있고, 무엇을 어느 입도로 공개할지가 정해진 바 없다.
-- 정해지지 않은 것을 여기서 정하지 않는다(D-41).

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
      -- 철회는 revoked_at, 대체는 후속 version의 게시 시각이 사건 시각이다.
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
