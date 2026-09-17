-- Document impact relations.
--
-- A mining project carries many documents that rest on one another: a drilling report rests on
-- the exploration license, an assay certificate on the lab's accreditation. When one of them is
-- replaced or expires, the ones resting on it need a second look. Nothing recorded those
-- dependencies, so the only way to find the affected documents was to remember them.
--
-- Which document types exist is not known up front, so relations are declared by people: a user
-- links two documents, or an operator declares a type rule that links documents as they arrive.
-- The database then carries a replacement or an expiry along those links.
--
-- **Why not `core.lineage_edges`.** That table holds evidence lineage; its ends have no foreign
-- keys and its unique key has no tenant, so it could hold a link across the tenant boundary.
-- Document links need composite keys like every other table here. The storage model is the one
-- OD-19 chose: an adjacency table walked with a recursive query, no graph database.
--
-- **Nothing is taken down or rewritten automatically.** An impact asks for a second look; it is
-- not a finding that the document is wrong. Same rule as the evidence signals in 0024.

-- ---------------------------------------------------------------------------
-- Document profile on uploads
-- ---------------------------------------------------------------------------

ALTER TABLE core.object_uploads
  /**
   * What the document is, in the uploader's words ("exploration license").
   *
   * Free text on purpose. There is no settled list of document types, and a fixed list chosen
   * here would be a decision nobody made. Type rules compare it case-insensitively.
   */
  ADD COLUMN document_type TEXT,
  /** Last day the document is valid, when it has one (licenses, permits, accreditations). */
  ADD COLUMN valid_until DATE,
  /**
   * The earlier upload this one replaces.
   *
   * The replacement takes effect when this upload is promoted — an unscanned file must not
   * retire the version people rely on.
   */
  ADD COLUMN supersedes_upload_id UUID,
  ADD CONSTRAINT upload_document_type_shape CHECK (
    document_type IS NULL
    OR (document_type = btrim(document_type) AND length(document_type) BETWEEN 1 AND 80)
  ),
  ADD CONSTRAINT upload_not_superseding_itself CHECK (supersedes_upload_id IS DISTINCT FROM id),
  ADD CONSTRAINT upload_project_scope_key UNIQUE (tenant_id, project_id, id);

-- A version replaces a document in the same project only.
ALTER TABLE core.object_uploads
  ADD CONSTRAINT upload_supersedes_same_project
    FOREIGN KEY (tenant_id, project_id, supersedes_upload_id)
    REFERENCES core.object_uploads (tenant_id, project_id, id);

-- One live successor per document. Two would fork the document, and nobody could say which one
-- the dependents should follow. A successor that failed scanning or was rejected frees the slot.
CREATE UNIQUE INDEX object_uploads_one_live_successor
  ON core.object_uploads (supersedes_upload_id)
  WHERE supersedes_upload_id IS NOT NULL AND state NOT IN ('scanned_infected', 'rejected');

/**
 * Which document an upload replaces is set once, and a version chain never loops.
 *
 * With a loop (A replaces B, B replaces A) there is no current version, and every "which one do
 * the dependents follow" answer would be arbitrary. The project-wide lock serializes the check:
 * two updates that each close half of a loop would otherwise both pass.
 */
CREATE OR REPLACE FUNCTION core.protect_upload_supersedes() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.supersedes_upload_id IS NOT NULL
     AND NEW.supersedes_upload_id IS DISTINCT FROM OLD.supersedes_upload_id
  THEN
    RAISE EXCEPTION 'Which document an upload replaces cannot be changed once set. Upload a new version instead'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.supersedes_upload_id IS NOT NULL AND OLD.supersedes_upload_id IS NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('core.object_uploads.supersedes:' || NEW.project_id::text, 0)
    );

    IF EXISTS (
      WITH RECURSIVE chain(id) AS (
        SELECT NEW.supersedes_upload_id
        UNION
        SELECT u.supersedes_upload_id
        FROM core.object_uploads u
        JOIN chain c ON u.id = c.id
        WHERE u.supersedes_upload_id IS NOT NULL
      )
      SELECT 1 FROM chain WHERE id = NEW.id
    ) THEN
      RAISE EXCEPTION 'That document is already a later version of this one'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'upload_supersedes_no_loop';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER object_upload_supersedes_immutable
  BEFORE UPDATE ON core.object_uploads
  FOR EACH ROW EXECUTE FUNCTION core.protect_upload_supersedes();

/** The promoted upload that replaced this one, if any. */
CREATE OR REPLACE FUNCTION core.document_successor(p_upload UUID) RETURNS UUID
LANGUAGE sql STABLE AS $$
  SELECT s.id FROM core.object_uploads s
  WHERE s.supersedes_upload_id = p_upload AND s.state = 'promoted'
  LIMIT 1
$$;

-- ---------------------------------------------------------------------------
-- Links
-- ---------------------------------------------------------------------------

CREATE TYPE core.document_link_kind AS ENUM (
  -- The downstream document rests on the upstream one. A change keeps travelling: whatever rests
  -- on the downstream document is affected too.
  'depends_on',
  -- The downstream document cites the upstream one. It is flagged, and the change stops there.
  -- If every link carried a change onward, one citation could shake the whole project.
  'references'
);

CREATE TYPE core.document_link_origin AS ENUM (
  'user',
  'rule',
  -- Moved from the previous version when a new version took effect.
  'carried_over'
);

/**
 * Operator-declared type rules: documents of `downstream_type` rest on documents of
 * `upstream_type`.
 *
 * Tenant-wide, which is why only a tenant-wide role manages them — an organization-scoped role
 * would otherwise write links into other organizations' projects.
 */
CREATE TABLE core.document_link_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES core.tenants(id),
  upstream_type   TEXT NOT NULL,
  downstream_type TEXT NOT NULL,
  kind            core.document_link_kind NOT NULL,
  note            TEXT,
  created_by      UUID NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at      TIMESTAMPTZ,
  retired_by      UUID,
  retirement_note TEXT,

  CONSTRAINT document_link_rule_type_shape CHECK (
    upstream_type = btrim(upstream_type) AND length(upstream_type) BETWEEN 1 AND 80
    AND downstream_type = btrim(downstream_type) AND length(downstream_type) BETWEEN 1 AND 80
  ),
  -- A type resting on itself has no direction; every document of that type would link to every other.
  CONSTRAINT document_link_rule_types_differ CHECK (lower(upstream_type) <> lower(downstream_type)),
  CONSTRAINT document_link_rule_retirement_complete CHECK (
    (retired_at IS NULL AND retired_by IS NULL AND retirement_note IS NULL)
    OR (retired_at IS NOT NULL AND retired_by IS NOT NULL
        AND length(btrim(coalesce(retirement_note, ''))) > 0)
  ),
  CONSTRAINT document_link_rule_tenant_scope_key UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES core.subjects (tenant_id, id),
  FOREIGN KEY (tenant_id, retired_by) REFERENCES core.subjects (tenant_id, id)
);

CREATE UNIQUE INDEX document_link_rules_active_pair
  ON core.document_link_rules (tenant_id, lower(upstream_type), lower(downstream_type))
  WHERE retired_at IS NULL;

CREATE TABLE core.document_links (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL REFERENCES core.tenants(id),
  project_id           UUID NOT NULL,
  /** The document rested on. */
  upstream_upload_id   UUID NOT NULL,
  /** The document that rests on it — the one to look at again when upstream changes. */
  downstream_upload_id UUID NOT NULL,
  kind                 core.document_link_kind NOT NULL,
  origin               core.document_link_origin NOT NULL,
  rule_id              UUID,
  carried_from_link_id UUID,
  note                 TEXT,
  /** NULL only for links the database created itself (carried over). */
  created_by           UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at           TIMESTAMPTZ,
  /** NULL when the database removed it (the document was replaced). */
  removed_by           UUID,
  removal_reason       TEXT,

  CONSTRAINT document_link_not_self CHECK (upstream_upload_id <> downstream_upload_id),
  CONSTRAINT document_link_rule_origin CHECK ((origin = 'rule') = (rule_id IS NOT NULL)),
  CONSTRAINT document_link_carry_origin CHECK (
    (origin = 'carried_over') = (carried_from_link_id IS NOT NULL)
  ),
  CONSTRAINT document_link_person_origin CHECK (origin = 'carried_over' OR created_by IS NOT NULL),
  CONSTRAINT document_link_removal_reason CHECK (
    (removed_at IS NULL AND removed_by IS NULL AND removal_reason IS NULL)
    OR (removed_at IS NOT NULL AND length(btrim(coalesce(removal_reason, ''))) > 0)
  ),
  CONSTRAINT document_link_tenant_scope_key UNIQUE (tenant_id, id),
  -- Both ends in the same project and tenant. FK checks bypass RLS, so the keys carry the scope.
  CONSTRAINT document_link_upstream_same_project
    FOREIGN KEY (tenant_id, project_id, upstream_upload_id)
    REFERENCES core.object_uploads (tenant_id, project_id, id),
  CONSTRAINT document_link_downstream_same_project
    FOREIGN KEY (tenant_id, project_id, downstream_upload_id)
    REFERENCES core.object_uploads (tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, rule_id) REFERENCES core.document_link_rules (tenant_id, id),
  FOREIGN KEY (tenant_id, carried_from_link_id) REFERENCES core.document_links (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES core.subjects (tenant_id, id),
  FOREIGN KEY (tenant_id, removed_by) REFERENCES core.subjects (tenant_id, id)
);

-- One active link per ordered pair. Two kinds on the same pair would give two answers to
-- "does the change travel on".
CREATE UNIQUE INDEX document_links_active_pair
  ON core.document_links (upstream_upload_id, downstream_upload_id)
  WHERE removed_at IS NULL;
CREATE INDEX document_links_downstream_idx
  ON core.document_links (downstream_upload_id) WHERE removed_at IS NULL;
CREATE INDEX document_links_project_idx
  ON core.document_links (tenant_id, project_id) WHERE removed_at IS NULL;

CREATE OR REPLACE FUNCTION core.reject_document_link_delete() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A document link cannot be deleted. Remove it with a reason';
END
$$;

CREATE TRIGGER document_links_no_delete
  BEFORE DELETE ON core.document_links
  FOR EACH ROW EXECUTE FUNCTION core.reject_document_link_delete();

/**
 * A link can be removed once, and nothing else about it changes.
 *
 * Editing a link in place would erase what the relation was when an impact was recorded.
 */
CREATE OR REPLACE FUNCTION core.protect_document_link() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'A removed document link cannot be changed. Create a new link instead';
  END IF;

  IF (NEW.tenant_id, NEW.project_id, NEW.upstream_upload_id, NEW.downstream_upload_id,
      NEW.kind, NEW.origin, NEW.rule_id, NEW.carried_from_link_id, NEW.note,
      NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.project_id, OLD.upstream_upload_id, OLD.downstream_upload_id,
      OLD.kind, OLD.origin, OLD.rule_id, OLD.carried_from_link_id, OLD.note,
      OLD.created_by, OLD.created_at)
  THEN
    RAISE EXCEPTION 'A document link can only be removed, not edited';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER document_links_protect
  BEFORE UPDATE ON core.document_links
  FOR EACH ROW EXECUTE FUNCTION core.protect_document_link();

/**
 * Would a `depends_on` link from `p_upstream` to `p_downstream` close a loop?
 *
 * It would if `p_upstream` already rests, through other documents, on `p_downstream`. Only
 * `depends_on` paths count — a citation does not carry a change onward, so it cannot loop.
 */
CREATE OR REPLACE FUNCTION core.document_link_would_cycle(p_upstream UUID, p_downstream UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE reach(upload_id) AS (
    SELECT p_downstream
    UNION
    SELECT l.downstream_upload_id
    FROM core.document_links l
    JOIN reach r ON l.upstream_upload_id = r.upload_id
    WHERE l.removed_at IS NULL AND l.kind = 'depends_on'
  )
  SELECT EXISTS (SELECT 1 FROM reach WHERE upload_id = p_upstream)
$$;

/**
 * Reject loops.
 *
 * With a loop, "what rests on what" has no answer, and a change would come back to where it
 * started. The project-wide lock serializes link inserts: two links checked in parallel could each
 * pass on their own and close a loop together.
 */
CREATE OR REPLACE FUNCTION core.reject_document_link_cycle() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('core.document_links:' || NEW.project_id::text, 0));

  IF NEW.kind = 'depends_on'
     AND core.document_link_would_cycle(NEW.upstream_upload_id, NEW.downstream_upload_id)
  THEN
    RAISE EXCEPTION 'This link would make a document rest on itself through other documents'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'document_link_no_cycle';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER document_links_no_cycle
  BEFORE INSERT ON core.document_links
  FOR EACH ROW EXECUTE FUNCTION core.reject_document_link_cycle();

/**
 * Apply one type rule — to every current document of the tenant, or only to pairs involving
 * `p_upload`.
 *
 * Row by row on purpose: each loop iteration checks for a loop against the links inserted
 * before it. A single INSERT … SELECT checks every row against the same starting snapshot, so
 * two links that close a loop only together would both pass the check and fail the insert.
 * A pair that would close a loop, or already has a link, is skipped.
 */
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

/** Apply every active rule that names this document's type. Called when a type is set. */
CREATE OR REPLACE FUNCTION core.apply_document_link_rules_for(p_upload UUID, p_subject UUID)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  doc_type TEXT;
  doc_tenant UUID;
  rule RECORD;
  created INTEGER := 0;
BEGIN
  SELECT document_type, tenant_id INTO doc_type, doc_tenant
  FROM core.object_uploads WHERE id = p_upload;
  IF doc_type IS NULL THEN
    RETURN 0;
  END IF;

  FOR rule IN
    SELECT r.id FROM core.document_link_rules r
    WHERE r.tenant_id = doc_tenant
      AND r.retired_at IS NULL
      AND (lower(r.upstream_type) = lower(doc_type) OR lower(r.downstream_type) = lower(doc_type))
    ORDER BY r.created_at
  LOOP
    created := created + core.apply_document_link_rule(rule.id, p_subject, p_upload);
  END LOOP;

  RETURN created;
END
$$;

-- ---------------------------------------------------------------------------
-- Impacts
-- ---------------------------------------------------------------------------

CREATE TYPE core.document_impact_cause AS ENUM (
  -- A new version of a document it rests on took effect.
  'superseded',
  -- A document it rests on (or the document itself) is past its validity date.
  'expired'
);

CREATE TYPE core.document_impact_resolution AS ENUM (
  'open',
  -- A new version of this document took effect. Only the database sets this.
  'revised',
  -- Checked; the document still holds as it is. A reason is kept.
  'no_change_needed',
  -- The link does not apply to this change. A reason is kept, and the link is worth fixing.
  'not_applicable'
);

/**
 * A document that needs a second look, and why.
 *
 * Append-only; a person's judgment closes it through the same row. Closed rows are not
 * reopened — "what was known when, and how it was judged" would be lost. The unique key keeps a
 * closed impact from being raised again by the next sweep.
 */
CREATE TABLE core.document_impacts (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL REFERENCES core.tenants(id),
  project_id           UUID NOT NULL,
  upload_id            UUID NOT NULL,
  origin_upload_id     UUID NOT NULL,
  successor_upload_id  UUID,
  cause                core.document_impact_cause NOT NULL,
  /** Links between the origin and this document on the shortest route. 0 = the origin itself. */
  depth                INTEGER NOT NULL CHECK (depth BETWEEN 0 AND 64),
  /** The document just above this one on that route. Enough for a screen to draw the tree. */
  via_upload_id        UUID,
  via_kind             core.document_link_kind,
  detected_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  /**
   * For `expired`, the validity date that passed. A date corrected in place that passes again
   * is a new impact, not the one already recorded.
   */
  origin_valid_until   DATE,

  resolution           core.document_impact_resolution NOT NULL DEFAULT 'open',
  resolved_at          TIMESTAMPTZ,
  /** NULL only for `revised`, which the database sets when the new version takes effect. */
  resolved_by          UUID,
  revised_by_upload_id UUID,
  resolution_note      TEXT,

  UNIQUE NULLS NOT DISTINCT (upload_id, origin_upload_id, cause, origin_valid_until),
  CONSTRAINT document_impact_tenant_scope_key UNIQUE (tenant_id, id),
  CONSTRAINT document_impact_expired_date CHECK ((cause = 'expired') = (origin_valid_until IS NOT NULL)),
  CONSTRAINT document_impact_origin_depth CHECK ((depth = 0) = (upload_id = origin_upload_id)),
  -- A replaced document is not asked to look at itself; its successor is the answer.
  CONSTRAINT document_impact_self_only_when_expired CHECK (depth > 0 OR cause = 'expired'),
  CONSTRAINT document_impact_route CHECK (
    (depth = 0 AND via_upload_id IS NULL AND via_kind IS NULL)
    OR (depth > 0 AND via_upload_id IS NOT NULL AND via_kind IS NOT NULL)
  ),
  CONSTRAINT document_impact_successor CHECK ((cause = 'superseded') = (successor_upload_id IS NOT NULL)),
  CONSTRAINT document_impact_closed_needs_note CHECK (
    (resolution = 'open' AND resolved_at IS NULL AND resolved_by IS NULL
       AND revised_by_upload_id IS NULL AND resolution_note IS NULL)
    OR (resolution = 'revised' AND resolved_at IS NOT NULL AND revised_by_upload_id IS NOT NULL
       AND length(btrim(coalesce(resolution_note, ''))) > 0)
    OR (resolution IN ('no_change_needed', 'not_applicable') AND resolved_at IS NOT NULL
       AND resolved_by IS NOT NULL AND revised_by_upload_id IS NULL
       AND length(btrim(coalesce(resolution_note, ''))) > 0)
  ),
  CONSTRAINT document_impact_upload_same_project
    FOREIGN KEY (tenant_id, project_id, upload_id)
    REFERENCES core.object_uploads (tenant_id, project_id, id),
  CONSTRAINT document_impact_origin_same_project
    FOREIGN KEY (tenant_id, project_id, origin_upload_id)
    REFERENCES core.object_uploads (tenant_id, project_id, id),
  CONSTRAINT document_impact_successor_same_project
    FOREIGN KEY (tenant_id, project_id, successor_upload_id)
    REFERENCES core.object_uploads (tenant_id, project_id, id),
  CONSTRAINT document_impact_via_same_project
    FOREIGN KEY (tenant_id, project_id, via_upload_id)
    REFERENCES core.object_uploads (tenant_id, project_id, id),
  CONSTRAINT document_impact_revision_same_project
    FOREIGN KEY (tenant_id, project_id, revised_by_upload_id)
    REFERENCES core.object_uploads (tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, resolved_by) REFERENCES core.subjects (tenant_id, id)
);

CREATE INDEX document_impacts_open_idx
  ON core.document_impacts (tenant_id, project_id) WHERE resolution = 'open';
CREATE INDEX document_impacts_upload_idx ON core.document_impacts (upload_id);

CREATE OR REPLACE FUNCTION core.reject_document_impact_delete() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A document impact cannot be deleted. Close it with a resolution';
END
$$;

CREATE TRIGGER document_impacts_no_delete
  BEFORE DELETE ON core.document_impacts
  FOR EACH ROW EXECUTE FUNCTION core.reject_document_impact_delete();

CREATE OR REPLACE FUNCTION core.protect_document_impact() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.resolution <> 'open' THEN
    RAISE EXCEPTION 'A closed document impact cannot be changed (current: %)', OLD.resolution;
  END IF;

  IF (NEW.tenant_id, NEW.project_id, NEW.upload_id, NEW.origin_upload_id,
      NEW.successor_upload_id, NEW.cause, NEW.depth, NEW.via_upload_id, NEW.via_kind,
      NEW.detected_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.project_id, OLD.upload_id, OLD.origin_upload_id,
      OLD.successor_upload_id, OLD.cause, OLD.depth, OLD.via_upload_id, OLD.via_kind,
      OLD.detected_at)
  THEN
    RAISE EXCEPTION 'The cause and time of a document impact cannot be changed';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER document_impacts_protect
  BEFORE UPDATE ON core.document_impacts
  FOR EACH ROW EXECUTE FUNCTION core.protect_document_impact();

/**
 * Documents that rest on `p_origin`, directly or through others.
 *
 * `depends_on` keeps travelling; `references` is flagged and stops. Each document appears once,
 * at its shortest distance, with the document just above it on that route.
 *
 * The walk carries (document, depth, document above) instead of whole paths. Whole paths grow
 * exponentially on diamond-shaped graphs; these triples are bounded by links × the depth cap.
 */
CREATE OR REPLACE FUNCTION core.document_impact_targets(p_origin UUID)
RETURNS TABLE (
  upload_id UUID,
  depth INTEGER,
  via_upload_id UUID,
  via_kind core.document_link_kind
)
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE walk(upload_id, depth, via_upload_id, via_kind, travels_on) AS (
    SELECT l.downstream_upload_id, 1, l.upstream_upload_id, l.kind, l.kind = 'depends_on'
    FROM core.document_links l
    WHERE l.upstream_upload_id = p_origin AND l.removed_at IS NULL
    UNION
    SELECT l.downstream_upload_id, w.depth + 1, l.upstream_upload_id, l.kind,
           l.kind = 'depends_on'
    FROM walk w
    JOIN core.document_links l
      ON l.upstream_upload_id = w.upload_id AND l.removed_at IS NULL
    WHERE w.travels_on
      AND w.depth < 64
      AND l.downstream_upload_id <> p_origin
  )
  SELECT DISTINCT ON (w.upload_id) w.upload_id, w.depth, w.via_upload_id, w.via_kind
  FROM walk w
  ORDER BY w.upload_id, w.depth, w.via_kind
$$;

/**
 * Record the impacts of one change to `p_origin`.
 *
 * Also marks the claims whose receipt was verified against this very document. That joins the
 * existing chain (0023 → attestation → 0024 signals), so a replaced or expired document reaches
 * reviews and public records the same way a lost source connection does.
 *
 * Documents already failed or rejected are skipped: nobody relies on them.
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
    -- An expired document needs a second look itself. A replaced one does not: its successor
    -- is the answer.
    SELECT p_origin AS upload_id, 0 AS depth, NULL::UUID AS via_upload_id,
           NULL::core.document_link_kind AS via_kind
    WHERE p_cause = 'expired'
    UNION ALL
    SELECT t.upload_id, t.depth, t.via_upload_id, t.via_kind
    FROM core.document_impact_targets(p_origin) t
    JOIN core.object_uploads target ON target.id = t.upload_id
    WHERE target.state NOT IN ('scanned_infected', 'rejected')
  ) candidate
  ON CONFLICT (upload_id, origin_upload_id, cause, origin_valid_until) DO NOTHING;
  GET DIAGNOSTICS step = ROW_COUNT;
  inserted := inserted + step;

  -- The first stale time is the record; rows already marked keep theirs.
  UPDATE core.claims c
  SET stale_since = now(),
      stale_reason = CASE p_cause
        WHEN 'superseded' THEN
          format('Evidence document was replaced by a new version (upload %s)', p_successor)
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

/**
 * A new version takes effect.
 *
 * Fires when an upload that replaces another becomes `promoted` (or is marked as a replacement
 * after promotion). In that order:
 *
 *   1. record who rested on the previous version — walked before the links move;
 *   2. close the previous version's own open impacts as `revised`: the new version answers them;
 *   3. carry the previous version's links over to the new one;
 *   4. remove the previous version's links, with the reason.
 *
 * In a trigger rather than the promote route so no path can promote a version without it.
 */
CREATE OR REPLACE FUNCTION core.apply_document_supersede() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  previous UUID := NEW.supersedes_upload_id;
BEGIN
  IF NEW.state <> 'promoted' OR previous IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'promoted' AND OLD.supersedes_upload_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  PERFORM core.record_document_impacts(previous, 'superseded', NEW.id);

  UPDATE core.document_impacts
  SET resolution = 'revised',
      resolved_at = now(),
      revised_by_upload_id = NEW.id,
      resolution_note = format('Replaced by a new version (upload %s)', NEW.id)
  WHERE upload_id = previous AND resolution = 'open';

  -- Links that already touch the new version are left to the person who made them. A carried
  -- link that would close a loop is skipped rather than failing the promotion.
  INSERT INTO core.document_links (
    tenant_id, project_id, upstream_upload_id, downstream_upload_id, kind, origin,
    carried_from_link_id, note
  )
  SELECT moved.tenant_id, moved.project_id, moved.upstream, moved.downstream, moved.kind,
         'carried_over', moved.id, moved.note
  FROM (
    SELECT l.id, l.tenant_id, l.project_id, l.kind, l.note,
           CASE WHEN l.upstream_upload_id = previous THEN NEW.id ELSE l.upstream_upload_id END
             AS upstream,
           CASE WHEN l.downstream_upload_id = previous THEN NEW.id ELSE l.downstream_upload_id END
             AS downstream
    FROM core.document_links l
    WHERE l.removed_at IS NULL
      AND (l.upstream_upload_id = previous OR l.downstream_upload_id = previous)
      AND l.upstream_upload_id <> NEW.id
      AND l.downstream_upload_id <> NEW.id
  ) moved
  WHERE NOT (moved.kind = 'depends_on'
             AND core.document_link_would_cycle(moved.upstream, moved.downstream))
  ON CONFLICT DO NOTHING;

  UPDATE core.document_links
  SET removed_at = now(),
      removal_reason = format('Moved to the new version (upload %s)', NEW.id)
  WHERE removed_at IS NULL
    AND (upstream_upload_id = previous OR downstream_upload_id = previous);

  RETURN NEW;
END
$$;

CREATE TRIGGER object_uploads_apply_supersede
  AFTER UPDATE ON core.object_uploads
  FOR EACH ROW EXECUTE FUNCTION core.apply_document_supersede();

/**
 * Expiry of one document, as of `p_today`.
 *
 * `valid_until` is the last valid day, so the document is expired from the day after. A document
 * already replaced is not checked — its successor is the one people rely on.
 *
 * Runs with the caller's rights: the API calls it inside the tenant's transaction.
 */
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
     OR core.document_successor(target.id) IS NOT NULL
  THEN
    RETURN 0;
  END IF;

  RETURN core.record_document_impacts(target.id, 'expired', NULL);
END
$$;

/**
 * Expiry sweep across tenants — called by the outbox worker.
 *
 * **Why SECURITY DEFINER.** The worker role reads uploads and nothing else of the evidence chain.
 * Recording an impact reaches claims, attestations, signals, and notifications through the
 * triggers; granting the worker all of that would widen a role that bypasses RLS. One function
 * that takes only a date is narrower. It is not executable by the API role.
 *
 * The tenant is set per iteration so the rows written carry the right scope even where the
 * function owner is subject to row-level security.
 */
CREATE OR REPLACE FUNCTION core.sweep_document_expiry(p_today DATE)
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
      SELECT u.id FROM core.object_uploads u
      WHERE u.tenant_id = tenant.id
        AND u.valid_until < p_today
        AND u.state NOT IN ('scanned_infected', 'rejected')
    LOOP
      total := total + core.detect_document_expiry(target.id, p_today);
    END LOOP;
  END LOOP;

  RETURN total;
END
$$;

REVOKE ALL ON FUNCTION core.sweep_document_expiry(DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.sweep_document_expiry(DATE) TO mpc_worker;

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------

ALTER TYPE core.notification_kind ADD VALUE IF NOT EXISTS 'document_impact';

/**
 * One notification per change, not per affected document.
 *
 * Replacing one license can flag dozens of documents; one notification each would bury the
 * others in the list. Statement-level with a transition table, so a sweep that finds nothing new
 * sends nothing.
 */
CREATE OR REPLACE FUNCTION core.notify_document_impacts() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO core.notifications (tenant_id, kind, audience_role, project_id, summary, link)
  SELECT i.tenant_id, 'document_impact', 'data_steward', i.project_id,
         format('%s document(s) need a second look: a document they rest on was %s',
                count(*),
                CASE i.cause WHEN 'superseded' THEN 'replaced by a new version'
                             ELSE 'past its validity date' END),
         '/w/projects/' || i.project_id || '/impacts'
  FROM inserted i
  GROUP BY i.tenant_id, i.project_id, i.origin_upload_id, i.cause;
  RETURN NULL;
END
$$;

CREATE TRIGGER document_impacts_notify
  AFTER INSERT ON core.document_impacts
  REFERENCING NEW TABLE AS inserted
  FOR EACH STATEMENT EXECUTE FUNCTION core.notify_document_impacts();

-- ---------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------

ALTER TABLE core.document_link_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.document_link_rules FORCE ROW LEVEL SECURITY;
ALTER TABLE core.document_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.document_links FORCE ROW LEVEL SECURITY;
ALTER TABLE core.document_impacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.document_impacts FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON core.document_link_rules
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());
CREATE POLICY tenant_isolation ON core.document_links
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());
CREATE POLICY tenant_isolation ON core.document_impacts
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

-- Never deleted; removal and resolution are updates.
GRANT SELECT, INSERT, UPDATE ON core.document_link_rules TO mpc_app;
GRANT SELECT, INSERT, UPDATE ON core.document_links TO mpc_app;
GRANT SELECT, INSERT, UPDATE ON core.document_impacts TO mpc_app;
