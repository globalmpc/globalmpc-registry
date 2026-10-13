-- Registry publication in two steps, by two people — spec 02 §2.8, 05 §5.7·§5.9, 07 §7.2.
--
-- **Why:** one request used to publish. Whoever held `registry.publish` sent the projection,
-- the source snapshot hash, the commercial-reuse status and five person-identifier booleans,
-- and the route stored what it was told. 02 §2.8 asks for "Data Owner + Disclosure Approver"
-- on a public projection, and 07 §7.2 separates creating a version from publishing it. A
-- published version is anchored and cannot be taken back, so the step that makes it public is
-- the one that needs a second person.
--
-- **A draft is not a `registry_entry_versions` row.** Several public functions treat any
-- version with a projection as public material (`public_projects` in the disclosure feed,
-- among others). Keeping the draft in its own table means none of them has to learn a new
-- status, and a draft can never reach an anchor batch. The published version is still written
-- to `registry_entry_versions` exactly as before — the anchor leaf does not change.
--
-- **Two-person rule, enforced here** — the same as `role_grant_two_person` (0028) and
-- `registry_proposal_two_person` (0043). Rejecting needs no second person: turning a draft
-- down publishes nothing.
--
-- **The person-identifier safeguards are a record, not booleans.** 05 §5.9: a natural-person
-- identifier anchored in a public projection cannot be undone even by crypto-shredding, so the
-- lawful basis, purpose, retention and the irreversibility acknowledgement are recorded with
-- who and when at drafting, and the explicit publication approval is the approver's own act.

CREATE TYPE core.registry_draft_state AS ENUM ('pending', 'published', 'rejected');

CREATE TABLE core.registry_publication_drafts (
  id                         UUID PRIMARY KEY,
  tenant_id                  UUID NOT NULL REFERENCES core.tenants(id),
  -- The asset registry needs R6 (OD-07). The route refuses it; this refuses it too.
  registry_type              core.registry_type NOT NULL CHECK (registry_type <> 'asset'),
  subject_id                 UUID NOT NULL,
  public_key                 TEXT NOT NULL CHECK (length(btrim(public_key)) > 0),
  -- Already checked against the allowlist and the subject's current values when drafted.
  projection                 JSONB NOT NULL CHECK (jsonb_typeof(projection) = 'object'),
  -- Both computed by the server from the subject's evidence; neither is taken from the client.
  source_snapshot_hash       TEXT NOT NULL CHECK (source_snapshot_hash ~ '^0x[0-9a-f]{64}$'),
  commercial_reuse           TEXT NOT NULL
                               CHECK (commercial_reuse IN ('confirmed', 'unconfirmed', 'prohibited')),
  published_as_commercial_basis BOOLEAN NOT NULL DEFAULT false,
  policy_version             TEXT NOT NULL CHECK (length(btrim(policy_version)) > 0),
  schema_version             TEXT NOT NULL CHECK (length(btrim(schema_version)) > 0),

  contains_person_level_identifier BOOLEAN NOT NULL DEFAULT false,
  lawful_basis               TEXT,
  purpose                    TEXT,
  retention                  TEXT,
  irreversibility_acknowledged_at TIMESTAMPTZ,

  proposed_by_subject_id     UUID NOT NULL,
  proposed_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  state                      core.registry_draft_state NOT NULL DEFAULT 'pending',
  decided_by_subject_id      UUID,
  decided_at                 TIMESTAMPTZ,
  decision_reason            TEXT,
  -- The approver's explicit approval of the person-level identifiers themselves (AC-32).
  person_identifier_publication_approved BOOLEAN NOT NULL DEFAULT false,
  -- The version publication created.
  entry_version_id           UUID,
  -- Row version for If-Match.
  version                    INTEGER NOT NULL DEFAULT 1,

  /**
   * Two-person rule — enforced by the DB.
   *
   * Blocking only in the application means rechecking with every new route. Here, no path
   * lets the person who drafted a projection also be the one who makes it public.
   */
  CONSTRAINT registry_draft_two_person CHECK (
    state <> 'published' OR decided_by_subject_id <> proposed_by_subject_id
  ),
  -- A person-level identifier needs every safeguard on record before the draft even exists.
  -- `IS NOT NULL` is spelled out: a CHECK whose expression is NULL passes.
  CONSTRAINT registry_draft_person_identifier_record CHECK (
    NOT contains_person_level_identifier
    OR (lawful_basis IS NOT NULL AND length(btrim(lawful_basis)) > 0
        AND purpose IS NOT NULL AND length(btrim(purpose)) > 0
        AND retention IS NOT NULL AND length(btrim(retention)) > 0
        AND irreversibility_acknowledged_at IS NOT NULL)
  ),
  CONSTRAINT registry_draft_person_identifier_approval CHECK (
    state <> 'published' OR NOT contains_person_level_identifier
    OR person_identifier_publication_approved
  ),
  CONSTRAINT registry_draft_decision_shape CHECK (
    (state = 'pending'
      AND decided_by_subject_id IS NULL AND decided_at IS NULL
      AND decision_reason IS NULL AND entry_version_id IS NULL
      AND NOT person_identifier_publication_approved)
    OR (state = 'rejected'
      AND decided_by_subject_id IS NOT NULL AND decided_at IS NOT NULL
      AND decision_reason IS NOT NULL AND length(btrim(decision_reason)) > 0
      AND entry_version_id IS NULL)
    OR (state = 'published'
      AND decided_by_subject_id IS NOT NULL AND decided_at IS NOT NULL
      AND entry_version_id IS NOT NULL)
  ),
  CONSTRAINT registry_drafts_tenant_scope_key UNIQUE (tenant_id, id),
  -- One draft per published version. Publishing twice cannot point two drafts at one version.
  CONSTRAINT registry_drafts_entry_version_key UNIQUE (entry_version_id),
  CONSTRAINT registry_drafts_proposer_same_tenant
    FOREIGN KEY (tenant_id, proposed_by_subject_id) REFERENCES core.subjects (tenant_id, id),
  CONSTRAINT registry_drafts_decider_same_tenant
    FOREIGN KEY (tenant_id, decided_by_subject_id) REFERENCES core.subjects (tenant_id, id),
  CONSTRAINT registry_drafts_entry_version_same_tenant
    FOREIGN KEY (tenant_id, entry_version_id)
    REFERENCES core.registry_entry_versions (tenant_id, id)
);

/**
 * Only one pending draft per registry key, within a tenant.
 *
 * With two open, the order they are published in decides which one supersedes the other, and
 * an approver reading one cannot see what the other changes. Keyed by tenant: another tenant's
 * pending draft is invisible under RLS, so a refusal pointing at it could not be acted on. A key
 * two tenants both claim is settled at publish (`REGISTRY_KEY_TAKEN`).
 */
CREATE UNIQUE INDEX registry_drafts_one_pending_idx
  ON core.registry_publication_drafts (tenant_id, registry_type, public_key)
  WHERE state = 'pending';

CREATE INDEX registry_drafts_subject_idx
  ON core.registry_publication_drafts (tenant_id, subject_id, proposed_at DESC);

/**
 * What was drafted never changes, and a decision is final.
 *
 * A draft is inserted as `pending` — a row born published would skip the second person. After
 * that only the decision columns move, once. A correction is a new draft.
 */
CREATE OR REPLACE FUNCTION core.guard_registry_publication_draft() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'pending' THEN
      RAISE EXCEPTION 'A registry draft must be created as pending. Publishing is a separate step'
        USING ERRCODE = 'raise_exception';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state <> 'pending' THEN
    RAISE EXCEPTION 'A decided registry draft cannot be modified. Create a new draft'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF (NEW.tenant_id, NEW.registry_type, NEW.subject_id, NEW.public_key, NEW.projection,
      NEW.source_snapshot_hash, NEW.commercial_reuse, NEW.published_as_commercial_basis,
      NEW.policy_version, NEW.schema_version, NEW.contains_person_level_identifier,
      NEW.lawful_basis, NEW.purpose, NEW.retention, NEW.irreversibility_acknowledged_at,
      NEW.proposed_by_subject_id, NEW.proposed_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.registry_type, OLD.subject_id, OLD.public_key, OLD.projection,
      OLD.source_snapshot_hash, OLD.commercial_reuse, OLD.published_as_commercial_basis,
      OLD.policy_version, OLD.schema_version, OLD.contains_person_level_identifier,
      OLD.lawful_basis, OLD.purpose, OLD.retention, OLD.irreversibility_acknowledged_at,
      OLD.proposed_by_subject_id, OLD.proposed_at) THEN
    RAISE EXCEPTION 'A registry draft cannot be modified after it is created. Create a new draft'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER registry_publication_drafts_guard
  BEFORE INSERT OR UPDATE ON core.registry_publication_drafts
  FOR EACH ROW EXECUTE FUNCTION core.guard_registry_publication_draft();

CREATE TRIGGER registry_publication_drafts_no_delete
  BEFORE DELETE ON core.registry_publication_drafts
  FOR EACH ROW EXECUTE FUNCTION core.reject_delete();

ALTER TABLE core.registry_publication_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.registry_publication_drafts FORCE ROW LEVEL SECURITY;

CREATE POLICY registry_publication_drafts_tenant ON core.registry_publication_drafts FOR ALL
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

GRANT SELECT, INSERT, UPDATE ON core.registry_publication_drafts TO mpc_app;

-- ---------------------------------------------------------------------------
-- Stale propagation reaches Verification Registry entries — AC-21.
--
-- A Verification Registry entry now points at the signed attestation it publishes, not at the
-- project, so matching entries by `subject_id = project` no longer finds it. When an
-- attestation turns `stale_candidate`, its own published entries get a signal as well as the
-- project's. Same rule as before: **a public record is never taken down automatically** — only
-- a signal is left; a person with `registry.revoke` decides.
-- ---------------------------------------------------------------------------

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

  -- Published Registry versions of the project and of this attestation. **Never taken down
  -- automatically** — leave a signal only.
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
    AND (
      (e.registry_type = 'project' AND e.subject_id = target_project)
      OR (e.registry_type = 'verification' AND e.subject_id = NEW.id)
    )
    AND v.status = 'published'
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END
$function$;
