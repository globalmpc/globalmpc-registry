-- Public history granularity decision — spec 05 §5.7.
--
-- `0027` disclosed only corrections and revocations, leaving the other four (credential revoke ·
-- suspension · pause · dispute) as `notCovered`. What to disclose at which granularity was
-- undecided, and **disclosure is irreversible** (05 §5.7), so developers did not
-- decide it (D-41).
--
-- **Decision (2026-09-09, user instruction): disclose only "it happened + when + which record".**
--
-- Content and parties are not disclosed. Rationale:
--
-- - The **fact that an event occurred** attaches to an already public record (registry entry),
--   and that record is itself public, so no new subject is revealed.
-- - **Content** (suspension reason · legal basis · dispute reason · details) is disclosed
--   irreversibly; widening later is possible, narrowing is not. Start narrow.
-- - **Parties** (who suspended · who disputed · which authority demanded it)
--   identify persons·organizations and are not disclosed while OD-17·OD-18 remain unresolved.
--
-- Under this rule three kinds come in and one stays out.
--
-- | Kind | Included | Reason |
-- |---|---|---|
-- | suspension | **included** | Target is a public project registry entry. Reason·actor are omitted |
-- | pause | **included** | Target is the same project entry. `legal_basis`·`authority` are omitted |
-- | dispute | **included** | Attached to the public entry via case→project. `reason_code`·`detail` are omitted |
-- | credential_revocation | **excluded** | "Which record" is a **person**. The rule above cannot express it |
--
-- Credential revocation is excluded not because its granularity is undecided but **because this
-- rule excludes it.** The `notCovered` reason is updated accordingly.

-- The return columns change, so CREATE OR REPLACE does not work.
DROP FUNCTION IF EXISTS core.public_disclosure_events(INTEGER, TIMESTAMPTZ, UUID);

/**
 * Public history.
 *
 * **The cursor column changes from `entry_version_id` to `event_id`.** The three new kinds are
 * transition·restriction·dispute rows, not registry versions, so they have no version id. If
 * the name differed from the actual value, the next person would look up versions by that column.
 *
 * Only rows from registry versions carry `entry_version_id`·`entry_version`·
 * `public_projection`·`superseded_by_id`. Others are NULL —
 * the response itself says "this kind has no such value".
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
   * Public project registry entries.
   *
   * **This is the gate for the three new kinds.** Suspensions·restrictions·disputes of a project
   * with no version carrying a public projection are not exposed — exposing them would reveal
   * that a private project exists.
   */
  public_projects AS (
    SELECT DISTINCT e.subject_id AS project_id, e.public_key
    FROM core.registry_entries e
    JOIN core.registry_entry_versions v ON v.entry_id = e.id
    WHERE e.registry_type = 'project'
      AND v.public_projection IS NOT NULL
  ),

  events AS (
    -- 1) corrections·revocations — carried over unchanged from `0027`.
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

    -- 2) suspension — both suspend and reinstate. `reason`·`actor_subject_id` are not exposed.
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
     * 3) pause — disclosure restriction (material-information blackout).
     *
     * `draft` has not taken effect yet and `superseded` was replaced by another row.
     * Only those that have taken effect are exposed. `legal_basis`·`authority`·`subject_scope`·
     * `restricted_action_types` are **content and parties**, so they are not exposed.
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
     * 4) dispute — a dispute attached to an attestation.
     *
     * An attestation is not bound directly to a public registry entry (nothing guarantees that a
     * verification entry's `subject_id` points to a case). It is attached to the public project
     * entry via the case's `project_id` — that is "which record" under this
     * rule. `reason_code`·`detail`·`raised_by_subject_id` are omitted.
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
