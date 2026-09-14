-- 공개 이력의 입도 결정 — spec 05 §5.7.
--
-- `0027`은 정정·철회 둘만 공개하고 나머지 넷(credential 철회 · suspension ·
-- pause · dispute)을 `notCovered`로 남겼다. 무엇을 어느 입도로 공개할지가
-- 정해지지 않았고, **공개는 되돌릴 수 없으므로**(05 §5.7) 개발자가 정하지
-- 않았다(D-41).
--
-- **결정 (2026-09-09, 사용자 지시): "일어났다 + 언제 + 어느 기록"만 공개한다.**
--
-- 내용과 당사자는 공개하지 않는다. 근거:
--
-- - 사건이 **있었다는 사실**은 이미 공개된 기록(registry entry)에 붙는 것이고,
--   그 기록 자체가 공개돼 있으므로 새로 드러나는 주체가 없다.
-- - **내용**(정지 사유·법적 근거·이의 사유·상세)은 되돌릴 수 없게 공개되며,
--   나중에 넓히는 것은 가능하지만 좁히는 것은 불가능하다. 좁은 쪽에서 시작한다.
-- - **당사자**(누가 정지시켰는가·누가 이의를 냈는가·어느 기관이 요구했는가)는
--   개인·조직 식별이며 OD-17·OD-18이 미해소인 상태에서 공개하지 않는다.
--
-- 이 규칙에 따라 셋이 들어오고 하나가 남는다.
--
-- | 종류 | 들어오나 | 이유 |
-- |---|---|---|
-- | suspension | **들어온다** | 대상이 공개된 project registry entry다. 사유·행위자는 뺀다 |
-- | pause | **들어온다** | 대상이 같은 project entry다. `legal_basis`·`authority`는 뺀다 |
-- | dispute | **들어온다** | case→project로 공개 entry에 붙는다. `reason_code`·`detail`은 뺀다 |
-- | credential_revocation | **남는다** | "어느 기록"이 **사람**이다. 위 규칙으로는 표현할 수 없다 |
--
-- credential 철회는 입도를 못 정해서가 아니라 **이 규칙이 그것을 배제하기
-- 때문에** 빠진다. `notCovered`의 사유를 그렇게 고친다.

-- 반환 열이 바뀌므로 CREATE OR REPLACE로 안 된다.
DROP FUNCTION IF EXISTS core.public_disclosure_events(INTEGER, TIMESTAMPTZ, UUID);

/**
 * 공개 이력.
 *
 * **커서 열이 `entry_version_id`에서 `event_id`로 바뀐다.** 새 세 종류는
 * registry version이 아니라 전이·제한·이의 행이라 version id가 없다. 이름이
 * 실제 값과 다르면 다음 사람이 그 열로 version을 조회한다.
 *
 * registry version에서 온 것만 `entry_version_id`·`entry_version`·
 * `public_projection`·`superseded_by_id`를 갖는다. 나머지는 NULL이다 —
 * 응답이 스스로 "이 종류에는 그 값이 없다"를 말한다.
 */
CREATE FUNCTION core.public_disclosure_events(
  p_limit       INTEGER,
  p_after_at    TIMESTAMPTZ,
  p_after_id    UUID
)
RETURNS TABLE (
  event_id          UUID,
  event_kind        TEXT,
  occurred_at       TIMESTAMPTZ,
  registry_type     core.registry_type,
  public_key        TEXT,
  entry_version_id  UUID,
  entry_version     INTEGER,
  public_projection JSONB,
  superseded_by_id  UUID,
  from_state        TEXT,
  to_state          TEXT,
  resolved_at       TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = core, pg_temp
AS $$
  WITH
  /**
   * 공개된 project registry entry.
   *
   * **이것이 새 세 종류의 게이트다.** 공개 projection을 가진 version이 하나도
   * 없는 프로젝트의 정지·제한·이의는 나가지 않는다 — 나가면 비공개 프로젝트의
   * 존재 자체가 드러난다.
   */
  public_projects AS (
    SELECT DISTINCT e.subject_id AS project_id, e.public_key
    FROM core.registry_entries e
    JOIN core.registry_entry_versions v ON v.entry_id = e.id
    WHERE e.registry_type = 'project'
      AND v.public_projection IS NOT NULL
  ),

  events AS (
    -- 1) 정정·철회 — `0027`에서 그대로 온다.
    SELECT
      v.id AS event_id,
      CASE WHEN v.status = 'revoked' THEN 'revocation' ELSE 'source_correction' END AS event_kind,
      COALESCE(v.revoked_at, next_version.published_at, v.published_at, v.created_at) AS occurred_at,
      e.registry_type,
      e.public_key,
      v.id AS entry_version_id,
      v.version AS entry_version,
      v.public_projection,
      v.superseded_by_id,
      NULL::TEXT AS from_state,
      NULL::TEXT AS to_state,
      NULL::TIMESTAMPTZ AS resolved_at
    FROM core.registry_entry_versions v
    JOIN core.registry_entries e ON e.id = v.entry_id
    LEFT JOIN core.registry_entry_versions next_version
      ON next_version.id = v.superseded_by_id
    WHERE v.status IN ('revoked', 'superseded')
      AND v.public_projection IS NOT NULL

    UNION ALL

    -- 2) suspension — 멈춤과 복귀 양쪽. `reason`·`actor_subject_id`는 안 나간다.
    SELECT
      t.id,
      'suspension',
      t.occurred_at,
      'project'::core.registry_type,
      p.public_key,
      NULL::UUID, NULL::INTEGER, NULL::JSONB, NULL::UUID,
      t.from_state::TEXT,
      t.to_state::TEXT,
      NULL::TIMESTAMPTZ
    FROM core.project_lifecycle_transitions t
    JOIN public_projects p ON p.project_id = t.project_id
    WHERE 'suspended' IN (t.from_state::TEXT, t.to_state::TEXT)

    UNION ALL

    /**
     * 3) pause — 공시 제한(material-information blackout).
     *
     * `draft`는 아직 발효되지 않았고 `superseded`는 다른 행으로 대체됐다.
     * 발효된 적 있는 것만 나간다. `legal_basis`·`authority`·`subject_scope`·
     * `restricted_action_types`는 **내용과 당사자**라 나가지 않는다.
     */
    SELECT
      r.id,
      'pause',
      COALESCE(r.effective_at, r.created_at),
      'project'::core.registry_type,
      p.public_key,
      NULL::UUID, NULL::INTEGER, NULL::JSONB, NULL::UUID,
      NULL::TEXT, NULL::TEXT,
      r.released_at
    FROM core.disclosure_restrictions r
    JOIN public_projects p ON p.project_id = r.project_id
    WHERE r.state IN ('active', 'released')

    UNION ALL

    /**
     * 4) dispute — attestation에 붙은 이의.
     *
     * attestation은 공개 registry entry에 직접 매이지 않는다(verification
     * entry의 `subject_id`가 case를 가리킨다는 보장이 없다). case가 갖는
     * `project_id`로 공개된 project entry에 붙인다 — 그것이 이 규칙의
     * "어느 기록"이다. `reason_code`·`detail`·`raised_by_subject_id`는 빠진다.
     */
    SELECT
      d.id,
      'dispute',
      d.raised_at,
      'project'::core.registry_type,
      p.public_key,
      NULL::UUID, NULL::INTEGER, NULL::JSONB, NULL::UUID,
      NULL::TEXT, NULL::TEXT,
      d.resolved_at
    FROM core.attestation_disputes d
    JOIN core.verification_attestations a ON a.id = d.attestation_id
    JOIN core.verification_cases c ON c.id = a.case_id
    JOIN public_projects p ON p.project_id = c.project_id
  )

  SELECT events.event_id, events.event_kind, events.occurred_at, events.registry_type,
         events.public_key, events.entry_version_id, events.entry_version,
         events.public_projection, events.superseded_by_id,
         events.from_state, events.to_state, events.resolved_at
  FROM events
  WHERE p_after_at IS NULL
     OR events.occurred_at < p_after_at
     OR (events.occurred_at = p_after_at AND events.event_id < p_after_id)
  ORDER BY events.occurred_at DESC, events.event_id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100)
$$;

REVOKE EXECUTE ON FUNCTION core.public_disclosure_events(INTEGER, TIMESTAMPTZ, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.public_disclosure_events(INTEGER, TIMESTAMPTZ, UUID) TO mpc_app;
