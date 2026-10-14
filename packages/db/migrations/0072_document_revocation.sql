-- Document revocation (the correction and revocation journey of spec 03).
--
-- A promoted document can turn out to be wrong: a forged certificate, a document issued in error,
-- one signed with a key that later leaked. Until now the only way to take it out of use was to
-- upload a replacement, which says "there is a newer version", not "this one must not be relied
-- on". Revocation says the second thing.
--
-- **Kept, marked, never deleted.** The upload row stays with its hash, storage key and history —
-- what was relied on, and when, must stay answerable. Revocation is three columns set once and a
-- trigger that refuses to unset or edit them. Undoing a revocation is not a path: if it was a
-- mistake, the document is uploaded again as a new version of the revoked one.
--
-- **A separate fact, not an upload state.** `state` is the scan-and-promote lifecycle; a revoked
-- document did pass its scan and was promoted. Folding revocation into `state` would also end the
-- promoted successor relation (`core.document_successor` looks for `promoted`), and a revoked
-- successor would silently hand "current version" back to the version it replaced — an older
-- document becoming current again without anyone deciding so.
--
-- **Impacts travel the same way a replacement's do.** The revoked document's links are walked
-- (`core.document_impact_targets`), what rests on it is asked for a second look with cause
-- `revoked`, and claims verified against it are marked stale, which reaches reviews and public
-- records through 0023/0024. The links themselves stay: a corrected version that replaces the
-- revoked one takes them over through the supersede trigger in 0045.
--
-- **No longer active evidence.** The evidence artifact made at promotion is marked revoked too, so
-- new evidence snapshots leave it out (`artifacts.revoked_at`). The artifact row, its hash and
-- anything already anchored stay as they were.
--
-- **Nothing rests on it any more.** Type rules skip it, expiry checks skip it, and it is not
-- recorded as needing a second look when a change further up reaches it (the change still travels
-- through it to what rests on it). The routes refuse new links, profile edits and confirmation
-- evidence that name it.

ALTER TYPE core.document_impact_cause ADD VALUE IF NOT EXISTS 'revoked';

ALTER TABLE core.object_uploads
  ADD COLUMN revoked_at TIMESTAMPTZ,
  ADD COLUMN revoked_by UUID,
  /**
   * Why, in the words of the person revoking. Free text on purpose: there is no settled list of
   * revocation reasons, and a fixed list chosen here would be a decision nobody made.
   */
  ADD COLUMN revocation_reason TEXT,
  ADD CONSTRAINT upload_revocation_complete CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL
        AND length(btrim(coalesce(revocation_reason, ''))) BETWEEN 1 AND 1000)
  ),
  -- Only a document someone could rely on is revoked. An unscanned, infected or rejected file was
  -- never one; it is rejected, not revoked.
  ADD CONSTRAINT upload_revoked_only_when_promoted CHECK (revoked_at IS NULL OR state = 'promoted'),
  ADD CONSTRAINT upload_revoker_same_tenant
    FOREIGN KEY (tenant_id, revoked_by) REFERENCES core.subjects (tenant_id, id);

/**
 * A revocation is set once and stays as it was set, with the document as it was when revoked.
 *
 * Unsetting it would put a document that was found wrong back into use without a record of who
 * decided that; editing the reason would rewrite why it was taken out. The profile fields freeze
 * too — a revoked document's type, validity and predecessor are part of what was revoked.
 */
CREATE OR REPLACE FUNCTION core.protect_upload_revocation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NULL THEN
    RETURN NEW;
  END IF;

  IF (NEW.revoked_at, NEW.revoked_by, NEW.revocation_reason)
     IS DISTINCT FROM (OLD.revoked_at, OLD.revoked_by, OLD.revocation_reason)
  THEN
    RAISE EXCEPTION 'A document revocation cannot be undone or edited. Upload a corrected version instead'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF (NEW.document_type, NEW.valid_until, NEW.supersedes_upload_id)
     IS DISTINCT FROM (OLD.document_type, OLD.valid_until, OLD.supersedes_upload_id)
  THEN
    RAISE EXCEPTION 'A revoked document cannot be changed (revocation stands). Upload a corrected version instead'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER object_upload_revocation_immutable
  BEFORE UPDATE ON core.object_uploads
  FOR EACH ROW EXECUTE FUNCTION core.protect_upload_revocation();

/**
 * A revocation takes effect: ask what rests on the document for a second look.
 *
 * In a trigger rather than the route so no path can revoke without it — same rule as the
 * supersede trigger in 0045. The revoked document's own open impacts stay open: they are answered
 * when a corrected version replaces it. Its evidence artifact stops counting as evidence.
 */
CREATE OR REPLACE FUNCTION core.apply_document_revocation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    UPDATE core.artifacts SET revoked_at = NEW.revoked_at
    WHERE id = NEW.promoted_artifact_id AND revoked_at IS NULL;
    PERFORM core.record_document_impacts(NEW.id, 'revoked', NULL);
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER object_uploads_apply_revocation
  AFTER UPDATE ON core.object_uploads
  FOR EACH ROW EXECUTE FUNCTION core.apply_document_revocation();

-- ---------------------------------------------------------------------------
-- 0045 functions, now aware of revocation
-- ---------------------------------------------------------------------------

/**
 * Record the impacts of one change to `p_origin` — as in 0045, plus:
 *
 * - a revoked document is not recorded as needing a second look; nobody should rest on it;
 * - claims verified against a revoked document are marked stale with that reason.
 */
CREATE OR REPLACE FUNCTION core.record_document_impacts(
  p_origin UUID,
  p_cause core.document_impact_cause,
  p_successor UUID
) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  origin_row core.object_uploads%ROWTYPE;
  inserted INTEGER := 0;
  step INTEGER;
BEGIN
  SELECT * INTO origin_row FROM core.object_uploads WHERE id = p_origin;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  -- One INSERT for the whole change. The notification trigger runs once per statement; two
  -- statements (the expired document, then what rests on it) would notify twice for one change.
  INSERT INTO core.document_impacts (
    tenant_id, project_id, upload_id, origin_upload_id, successor_upload_id,
    cause, depth, via_upload_id, via_kind, origin_valid_until
  )
  SELECT origin_row.tenant_id, origin_row.project_id, candidate.upload_id, p_origin, p_successor,
         p_cause, candidate.depth, candidate.via_upload_id, candidate.via_kind,
         CASE WHEN p_cause = 'expired' THEN origin_row.valid_until END
  FROM (
    -- An expired document needs a second look itself. A replaced or revoked one does not: a new
    -- version is the answer.
    SELECT p_origin AS upload_id, 0 AS depth, NULL::UUID AS via_upload_id,
           NULL::core.document_link_kind AS via_kind
    WHERE p_cause = 'expired'
    UNION ALL
    SELECT t.upload_id, t.depth, t.via_upload_id, t.via_kind
    FROM core.document_impact_targets(p_origin) t
    JOIN core.object_uploads target ON target.id = t.upload_id
    WHERE target.state NOT IN ('scanned_infected', 'rejected')
      AND target.revoked_at IS NULL
  ) candidate
  ON CONFLICT (upload_id, origin_upload_id, cause, origin_valid_until) DO NOTHING;
  GET DIAGNOSTICS step = ROW_COUNT;
  inserted := inserted + step;

  -- The first stale time is the record; rows already marked keep theirs.
  UPDATE core.claims c
  SET stale_since = now(),
      stale_reason = CASE p_cause::text
        WHEN 'superseded' THEN
          format('Evidence document was replaced by a new version (upload %s)', p_successor)
        WHEN 'revoked' THEN
          format('Evidence document was revoked (upload %s)', p_origin)
        ELSE
          format('Evidence document passed its validity date %s (upload %s)',
                 origin_row.valid_until, p_origin)
      END
  FROM core.source_receipts r
  WHERE c.source_receipt_id = r.id
    AND r.tenant_id = origin_row.tenant_id
    AND r.channel_evidence ->> 'documentUploadId' = p_origin::text
    AND c.stale_since IS NULL;

  RETURN inserted;
END
$$;

/** Expiry of one document, as of `p_today` — as in 0045; a revoked document is not checked. */
CREATE OR REPLACE FUNCTION core.detect_document_expiry(p_upload UUID, p_today DATE)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  target core.object_uploads%ROWTYPE;
BEGIN
  SELECT * INTO target FROM core.object_uploads WHERE id = p_upload;
  IF NOT FOUND
     OR target.valid_until IS NULL
     OR target.valid_until >= p_today
     OR target.state IN ('scanned_infected', 'rejected')
     OR target.revoked_at IS NOT NULL
     OR core.document_successor(target.id) IS NOT NULL
  THEN
    RETURN 0;
  END IF;

  RETURN core.record_document_impacts(target.id, 'expired', NULL);
END
$$;

/** Apply one type rule — as in 0045; a revoked document is linked by no rule. */
CREATE OR REPLACE FUNCTION core.apply_document_link_rule(
  p_rule UUID,
  p_subject UUID,
  p_upload UUID
) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  rule core.document_link_rules%ROWTYPE;
  pair RECORD;
  created INTEGER := 0;
  step INTEGER;
BEGIN
  SELECT * INTO rule FROM core.document_link_rules WHERE id = p_rule AND retired_at IS NULL;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  FOR pair IN
    SELECT up.tenant_id, up.project_id, up.id AS upstream, down.id AS downstream
    FROM core.object_uploads up
    JOIN core.object_uploads down
      ON down.tenant_id = up.tenant_id
     AND down.project_id = up.project_id
     AND down.id <> up.id
    WHERE up.tenant_id = rule.tenant_id
      AND lower(up.document_type) = lower(rule.upstream_type)
      AND lower(down.document_type) = lower(rule.downstream_type)
      AND up.state NOT IN ('scanned_infected', 'rejected')
      AND down.state NOT IN ('scanned_infected', 'rejected')
      AND up.revoked_at IS NULL
      AND down.revoked_at IS NULL
      AND core.document_successor(up.id) IS NULL
      AND core.document_successor(down.id) IS NULL
      AND (p_upload IS NULL OR up.id = p_upload OR down.id = p_upload)
    ORDER BY up.project_id, up.uploaded_at, down.uploaded_at
  LOOP
    IF rule.kind = 'depends_on'
       AND core.document_link_would_cycle(pair.upstream, pair.downstream)
    THEN
      CONTINUE;
    END IF;

    INSERT INTO core.document_links (
      tenant_id, project_id, upstream_upload_id, downstream_upload_id, kind, origin,
      rule_id, created_by
    ) VALUES (
      pair.tenant_id, pair.project_id, pair.upstream, pair.downstream, rule.kind, 'rule',
      rule.id, p_subject
    )
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS step = ROW_COUNT;
    created := created + step;
  END LOOP;

  RETURN created;
END
$$;

/** One notification per change — as in 0045, with wording for a revocation. */
CREATE OR REPLACE FUNCTION core.notify_document_impacts() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO core.notifications (tenant_id, kind, audience_role, project_id, summary, link)
  SELECT i.tenant_id, 'document_impact', 'data_steward', i.project_id,
         format('%s document(s) need a second look: a document they rest on was %s',
                count(*),
                CASE i.cause::text WHEN 'superseded' THEN 'replaced by a new version'
                                   WHEN 'revoked' THEN 'revoked'
                                   ELSE 'past its validity date' END),
         '/w/projects/' || i.project_id || '/impacts'
  FROM inserted i
  GROUP BY i.tenant_id, i.project_id, i.origin_upload_id, i.cause;
  RETURN NULL;
END
$$;
