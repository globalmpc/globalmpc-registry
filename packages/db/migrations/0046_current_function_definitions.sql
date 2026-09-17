-- Current function definitions and object comments.
--
-- Databases migrated from earlier revisions of 0001-0040 keep the function bodies and object
-- comments those revisions created. This migration redefines them with the definitions a fresh
-- install produces, so every database runs the same code. Each statement is the output of
-- pg_get_functiondef for the function as defined by migrations 0001-0045; security attributes,
-- search_path settings and signatures are unchanged, and CREATE OR REPLACE keeps existing
-- grants and triggers.

CREATE OR REPLACE FUNCTION audit.reject_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'audit.events is append-only: % rejected', TG_OP
    USING ERRCODE = 'raise_exception';
END
$function$;

CREATE OR REPLACE FUNCTION core.check_connection_authority_accepted()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  authority_state core.authority_state;
BEGIN
  IF NEW.state <> 'active' THEN
    RETURN NEW;
  END IF;

  SELECT a.state INTO authority_state
  FROM core.authorities a WHERE a.id = NEW.authority_id;

  IF authority_state IS DISTINCT FROM 'accepted' THEN
    RAISE EXCEPTION 'A connection to an authority that is not accepted (%) cannot become active', authority_state;
  END IF;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.notify_evidence_stale()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO core.notifications (tenant_id, kind, audience_role, project_id, summary, link)
  VALUES (
    NEW.tenant_id, 'evidence_stale', 'data_steward', NEW.project_id,
    'Evidence became stale: ' || NEW.reason,
    '/w/work'
  );
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION core.notify_readiness_gap()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.status <> 'gap' THEN
    RETURN NEW;
  END IF;

  INSERT INTO core.notifications (tenant_id, kind, audience_role, project_id, summary, link)
  VALUES (
    NEW.tenant_id, 'readiness_gap', 'data_steward', NEW.project_id,
    'Readiness assessment found a gap',
    '/w/projects/' || NEW.project_id || '/readiness'
  );
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION core.notify_registry_revoked()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  target_key TEXT;
  target_project UUID;
BEGIN
  IF NEW.status <> 'revoked' OR OLD.status = 'revoked' THEN
    RETURN NEW;
  END IF;

  SELECT e.public_key, p.id INTO target_key, target_project
  FROM core.registry_entries e
  LEFT JOIN core.projects p ON p.id = e.subject_id
  WHERE e.id = NEW.entry_id;

  INSERT INTO core.notifications (tenant_id, kind, audience_role, project_id, summary, link)
  VALUES (
    NEW.tenant_id, 'registry_revoked', 'mpc_operator', target_project,
    'Public record revoked: ' || coalesce(target_key, '(no key)'),
    '/w/registries'
  );
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION core.notify_review_assigned()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  target_project UUID;
BEGIN
  SELECT c.project_id INTO target_project
  FROM core.verification_cases c WHERE c.id = NEW.case_id;

  INSERT INTO core.notifications (tenant_id, kind, subject_id, project_id, summary, link)
  VALUES (
    NEW.tenant_id, 'review_assigned', NEW.subject_id, target_project,
    'Review assigned',
    '/w/projects/' || target_project || '/verification'
  );
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION core.propagate_attestation_to_signals()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  target_project UUID;
BEGIN
  IF NEW.state <> 'stale_candidate' OR OLD.state = 'stale_candidate' THEN
    RETURN NEW;
  END IF;

  SELECT c.project_id INTO target_project
  FROM core.verification_cases c WHERE c.id = NEW.case_id;

  IF target_project IS NULL THEN
    RETURN NEW;
  END IF;

  -- Signal only the latest assessment. Past assessments are judgments of their time and
  -- are not up for review now.
  INSERT INTO core.evidence_stale_signals (
    id, tenant_id, project_id, target_type, target_id,
    origin_attestation_id, reason
  )
  SELECT gen_random_uuid(), NEW.tenant_id, target_project,
         'compliance_assessment', a.id, NEW.id,
         coalesce(NEW.stale_reason, 'Underlying attestation needs re-review')
  FROM core.compliance_assessments a
  WHERE a.project_id = target_project
  ORDER BY a.generated_at DESC
  LIMIT 1
  ON CONFLICT DO NOTHING;

  -- Published Registry version. **Never taken down automatically** — leave a signal only;
  -- a human with the `registry.revoke` permission decides supersede·revoke.
  INSERT INTO core.evidence_stale_signals (
    id, tenant_id, project_id, target_type, target_id,
    origin_attestation_id, reason
  )
  SELECT gen_random_uuid(), NEW.tenant_id, target_project,
         'registry_entry_version', v.id, NEW.id,
         coalesce(NEW.stale_reason, 'Underlying attestation needs re-review')
  FROM core.registry_entry_versions v
  JOIN core.registry_entries e ON e.id = v.entry_id
  WHERE e.tenant_id = NEW.tenant_id
    AND e.subject_id = target_project
    AND v.status = 'published'
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.propagate_claim_to_attestations()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.stale_since IS NULL OR OLD.stale_since IS NOT NULL THEN
    RETURN NEW;
  END IF;

  UPDATE core.verification_attestations a
  SET state = 'stale_candidate',
      stale_reason = format('Underlying claim became stale: %s', NEW.stale_reason)
  WHERE a.tenant_id = NEW.tenant_id
    AND a.state = 'active'
    AND NEW.id = ANY (a.claim_scope);

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.propagate_connection_to_claims()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  marked INTEGER;
BEGIN
  IF NEW.state NOT IN ('degraded', 'disabled') OR OLD.state = NEW.state THEN
    RETURN NEW;
  END IF;

  WITH affected AS (
    UPDATE core.claims c
    SET stale_since = now(),
        stale_reason = format('Source connection became %s (connection %s)',
                              NEW.state, NEW.connection_key)
    FROM core.source_receipts r
    WHERE c.source_receipt_id = r.id
      AND r.connection_id = NEW.id
      -- Leave already-marked rows as is. The first stale time is the record.
      AND c.stale_since IS NULL
    RETURNING c.id
  )
  SELECT count(*) INTO marked FROM affected;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.protect_eligible_weight()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.eligible_weight_source IS NOT NULL
     AND (NEW.eligible_weight IS DISTINCT FROM OLD.eligible_weight
          OR NEW.eligible_weight_source IS DISTINCT FROM OLD.eligible_weight_source) THEN
    RAISE EXCEPTION 'The fixed quorum basis cannot be changed';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.protect_published_registry_version()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  IF NEW.public_projection     IS DISTINCT FROM OLD.public_projection
     OR NEW.content_hash       IS DISTINCT FROM OLD.content_hash
     OR NEW.source_snapshot_hash IS DISTINCT FROM OLD.source_snapshot_hash
     OR NEW.policy_version     IS DISTINCT FROM OLD.policy_version
     OR NEW.schema_version     IS DISTINCT FROM OLD.schema_version
     OR NEW.serialization_version IS DISTINCT FROM OLD.serialization_version
     OR NEW.version            IS DISTINCT FROM OLD.version
     OR NEW.entry_id           IS DISTINCT FROM OLD.entry_id
  THEN
    RAISE EXCEPTION
      'A published registry version cannot be overwritten. Correct it with a new version and supersede'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.protect_signed_attestation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.state = 'draft' THEN
    RETURN NEW;
  END IF;

  IF NEW.evidence_snapshot_hash IS DISTINCT FROM OLD.evidence_snapshot_hash
     OR NEW.payload_hash        IS DISTINCT FROM OLD.payload_hash
     OR NEW.limitations         IS DISTINCT FROM OLD.limitations
     OR NEW.findings            IS DISTINCT FROM OLD.findings
     OR NEW.citations           IS DISTINCT FROM OLD.citations
     OR NEW.signature           IS DISTINCT FROM OLD.signature
     OR NEW.signed_at           IS DISTINCT FROM OLD.signed_at
     OR NEW.signer_wallet_address IS DISTINCT FROM OLD.signer_wallet_address
     OR NEW.claim_scope         IS DISTINCT FROM OLD.claim_scope
     OR NEW.credential_status_snapshot IS DISTINCT FROM OLD.credential_status_snapshot
  THEN
    RAISE EXCEPTION
      'A signed attestation body cannot be modified. Correct it with a new version that supersedes it'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.protect_snapshot_block()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.snapshot_block IS NOT NULL
     AND NEW.snapshot_block IS DISTINCT FROM OLD.snapshot_block THEN
    RAISE EXCEPTION 'The snapshot block cannot be changed once set';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.protect_stale_signal()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.resolution <> 'open' THEN
    RAISE EXCEPTION 'A closed signal cannot be changed (current: %)', OLD.resolution;
  END IF;

  IF NEW.target_type IS DISTINCT FROM OLD.target_type
     OR NEW.target_id IS DISTINCT FROM OLD.target_id
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.detected_at IS DISTINCT FROM OLD.detected_at
     OR NEW.origin_attestation_id IS DISTINCT FROM OLD.origin_attestation_id
  THEN
    RAISE EXCEPTION 'The cause and time of a signal cannot be changed';
  END IF;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.protect_upload_identity()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.object_key IS DISTINCT FROM OLD.object_key
     OR NEW.byte_size  IS DISTINCT FROM OLD.byte_size
     OR NEW.tenant_id  IS DISTINCT FROM OLD.tenant_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
  THEN
    RAISE EXCEPTION 'The identity of an uploaded object cannot be modified. Upload a new object instead'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.public_disclosure_events(p_limit integer, p_after_at timestamp with time zone, p_after_id uuid)
 RETURNS TABLE(event_id uuid, event_kind text, occurred_at timestamp with time zone, registry_type core.registry_type, public_key text, entry_version_id uuid, entry_version integer, public_projection jsonb, superseded_by_id uuid, from_state text, to_state text, resolved_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION core.public_hash_lookup(p_hash text)
 RETURNS TABLE(matched_on text, registry_type text, public_key text, entry_version_id uuid, version integer, status text, merkle_root text, transaction_hash text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'core', 'chain', 'pg_temp'
AS $function$
  SELECT CASE
           WHEN l.leaf_hash = p_hash THEN 'leaf_hash'
           WHEN b.merkle_root = p_hash THEN 'merkle_root'
           WHEN b.batch_id = p_hash THEN 'batch_id'
           ELSE 'transaction_hash'
         END,
         e.registry_type::text,
         e.public_key,
         v.id,
         v.version,
         v.status::text,
         b.merkle_root,
         latest_tx.tx_hash
  FROM chain.anchor_batch_leaves l
  JOIN chain.anchor_batches b ON b.id = l.batch_id
  JOIN core.registry_entry_versions v ON v.id = l.entry_version_id
  JOIN core.registry_entries e ON e.id = v.entry_id
  -- Displays the most recent submission. Lookups by a replaced earlier tx hash reach the same batch.
  LEFT JOIN LATERAL (
    SELECT t.tx_hash FROM chain.transactions t
    WHERE t.batch_id = b.id ORDER BY t.created_at DESC LIMIT 1
  ) latest_tx ON true
  WHERE (
          l.leaf_hash = p_hash
       OR b.merkle_root = p_hash
       OR b.batch_id = p_hash
       OR EXISTS (
            SELECT 1 FROM chain.transactions t
            WHERE t.batch_id = b.id AND t.tx_hash = p_hash
          )
        )
    AND v.status IN ('published', 'revoked', 'superseded')
    AND v.public_projection IS NOT NULL
  ORDER BY e.public_key, v.version DESC
  LIMIT 50
$function$;

CREATE OR REPLACE FUNCTION core.public_inclusion_proof(p_entry_version_id uuid)
 RETURNS TABLE(leaf_hash text, batch_row_id uuid, merkle_root text, external_batch_id text, transaction_state text, transaction_hash text, block_number bigint, policy_version text, schema_version text, serialization_version text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'core', 'chain', 'pg_temp'
AS $function$
  SELECT l.leaf_hash, l.batch_id, b.merkle_root, b.batch_id,
         t.state::text, t.tx_hash, t.block_number,
         v.policy_version, v.schema_version, v.serialization_version
  FROM chain.anchor_batch_leaves l
  JOIN chain.anchor_batches b ON b.id = l.batch_id
  JOIN core.registry_entry_versions v ON v.id = l.entry_version_id
  LEFT JOIN LATERAL (
    SELECT state, tx_hash, block_number FROM chain.transactions
    WHERE batch_id = b.id ORDER BY created_at DESC LIMIT 1
  ) t ON true
  WHERE l.entry_version_id = p_entry_version_id
    -- Proofs are not provided for unpublished versions.
    AND v.status IN ('published', 'revoked', 'superseded')
$function$;

CREATE OR REPLACE FUNCTION core.public_registry_list(p_registry_type text, p_query text, p_status text, p_limit integer, p_after_published_at timestamp with time zone, p_after_entry_id uuid)
 RETURNS TABLE(entry_id uuid, public_key text, entry_version_id uuid, version integer, status core.registry_entry_status, public_projection jsonb, published_at timestamp with time zone, sort_at timestamp with time zone, revoked_at timestamp with time zone, superseded_by_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION core.reject_anchor_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'An anchor batch cannot be modified or deleted. Corrections are revoke/supersede events'
    USING ERRCODE = 'raise_exception';
END
$function$;

CREATE OR REPLACE FUNCTION core.reject_assessment_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION
    'A readiness assessment cannot be modified or deleted. Recompute with a new input or rule version'
    USING ERRCODE = 'raise_exception';
END
$function$;

CREATE OR REPLACE FUNCTION core.reject_authority_version_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'Authority history cannot be modified or deleted';
END
$function$;

CREATE OR REPLACE FUNCTION core.reject_delete_governance()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION '% cannot be deleted', TG_TABLE_NAME;
END
$function$;

CREATE OR REPLACE FUNCTION core.reject_delete()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION '% cannot be deleted. Use revoke or supersede', TG_TABLE_NAME
    USING ERRCODE = 'raise_exception';
END
$function$;

CREATE OR REPLACE FUNCTION core.reject_stale_signal_delete()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'An evidence signal cannot be deleted. Close it with a resolution';
END
$function$;

CREATE OR REPLACE FUNCTION core.reject_vote_after_close()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  proposal_state core.proposal_state;
BEGIN
  SELECT state INTO proposal_state
  FROM core.governance_proposals WHERE id = NEW.proposal_id;

  IF proposal_state <> 'voting' THEN
    RAISE EXCEPTION 'Voting is not open (proposal state: %)', proposal_state;
  END IF;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.reject_weight_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'A snapshotted weight cannot be modified';
END
$function$;

COMMENT ON CONSTRAINT object_uploads_draft_tier_only ON core.object_uploads IS 'OD-18 draft decision: sensitive levels are not accepted until a secured route exists. When the secured route is built, replace this constraint with a per-level storage path decision.';
