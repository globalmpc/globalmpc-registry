-- Unauthenticated public **list·search** — spec 11 §11.2·§11.3.
--
-- Why the number moved back: first written as `0026`, but another change took that number
-- first (`0026_role_binding_order.sql`). The already-shared one keeps the number; the one
-- not yet pushed moves. This file depends on none of the preceding ones, so
-- moving it later does not break ordering.
--
-- **Why it is needed:** the public lookup from 0009 requires already knowing
-- `(registry_type, public_key)`. So the public Explorer has no way to ask "what exists".
-- A UI alone would have no data to show.
--
-- The boundary is the same as 0009. The only difference is that it **scans many entries**, so
-- this function's job is to keep the boundary from leaking during that scan.
--
-- 1. Only `status IN ('published','revoked','superseded')`. Drafts are never exposed.
-- 2. Returns only the `public_projection` column.
-- 3. Does not return tenant_id — records from many tenants appear in one list, but
--    which tenant owns which cannot be told. That is the intent of the public Registry.
-- 4. Pins `search_path`.
--
-- **Only the latest version per entry.** History belongs to the detail lookup (0009).
-- Listing every version would show the same project on multiple rows.
--
-- **Ordering and pagination are keyset.** OFFSET returns the same page twice or skips one
-- when rows are added at the front. The public list keeps growing, so that drift
-- actually happens. The sort key is `(published_at, entry_id)`, and both are returned so
-- the client can build the next cursor.

CREATE FUNCTION core.public_registry_list(
  p_registry_type      TEXT,
  p_query              TEXT,
  p_status             TEXT,
  p_limit              INTEGER,
  p_after_published_at TIMESTAMPTZ,
  p_after_entry_id     UUID
)
RETURNS TABLE (
  entry_id          UUID,
  public_key        TEXT,
  entry_version_id  UUID,
  version           INTEGER,
  status            core.registry_entry_status,
  public_projection JSONB,
  published_at      TIMESTAMPTZ,
  -- Sort key used by the keyset cursor. It may differ from `published_at`, so
  -- (NULL guard) it is returned separately — a caller building the cursor from published_at
  -- would get misaligned pages.
  sort_at           TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ,
  superseded_by_id  UUID
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = core, pg_temp
AS $$
  WITH latest AS (
    SELECT DISTINCT ON (e.id)
           e.id  AS entry_id,
           e.public_key,
           v.id  AS entry_version_id,
           v.version,
           v.status,
           v.public_projection,
           -- published_at is filled at publish time, but a NULL sort key breaks the
           -- keyset. Defensively fall back to created_at.
           COALESCE(v.published_at, v.created_at) AS sort_at,
           v.published_at,
           v.revoked_at,
           v.superseded_by_id
    FROM core.registry_entry_versions v
    JOIN core.registry_entries e ON e.id = v.entry_id
    WHERE e.registry_type = p_registry_type::core.registry_type
      AND v.status IN ('published', 'revoked', 'superseded')
      AND v.public_projection IS NOT NULL
    ORDER BY e.id, v.version DESC
  ),
  -- User-supplied `%`·`_` are literal characters, not wildcards. Unescaped,
  -- a bare `%` matches everything, which is a bypass rather than a search.
  needle AS (
    SELECT CASE
             WHEN p_query IS NULL OR btrim(p_query) = '' THEN NULL
             ELSE '%' || replace(replace(replace(p_query, '\', '\\'), '%', '\%'), '_', '\_') || '%'
           END AS pattern
  )
  SELECT latest.entry_id,
         latest.public_key,
         latest.entry_version_id,
         latest.version,
         latest.status,
         latest.public_projection,
         latest.published_at,
         latest.sort_at,
         latest.revoked_at,
         latest.superseded_by_id
  FROM latest, needle
  WHERE (p_status IS NULL OR latest.status = p_status::core.registry_entry_status)
    AND (
      needle.pattern IS NULL
      OR latest.public_key ILIKE needle.pattern
      OR latest.public_projection->>'projectName' ILIKE needle.pattern
      OR latest.public_projection->>'projectKey'  ILIKE needle.pattern
      OR latest.public_projection->>'hostCountry' ILIKE needle.pattern
      OR EXISTS (
           SELECT 1
           FROM jsonb_array_elements_text(
                  CASE WHEN jsonb_typeof(latest.public_projection->'mineral') = 'array'
                       THEN latest.public_projection->'mineral'
                       ELSE '[]'::jsonb END
                ) AS m(value)
           WHERE m.value ILIKE needle.pattern
         )
    )
    -- keyset. Ordering is descending, so "after the cursor" means a smaller value.
    AND (
      p_after_published_at IS NULL
      OR latest.sort_at < p_after_published_at
      OR (latest.sort_at = p_after_published_at AND latest.entry_id < p_after_entry_id)
    )
  ORDER BY latest.sort_at DESC, latest.entry_id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100)
$$;

-- The list scans by sort key. The same index helps pick the latest version per entry.
CREATE INDEX registry_entry_versions_public_list_idx
  ON core.registry_entry_versions (entry_id, version DESC)
  WHERE status IN ('published', 'revoked', 'superseded');

REVOKE EXECUTE ON FUNCTION core.public_registry_list(TEXT, TEXT, TEXT, INTEGER, TIMESTAMPTZ, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.public_registry_list(TEXT, TEXT, TEXT, INTEGER, TIMESTAMPTZ, UUID) TO mpc_app;
