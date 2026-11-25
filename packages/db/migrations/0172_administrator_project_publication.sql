-- Check only the current actor's authenticated session without granting access to session rows.
-- Current human-role resolution accepts a verified email-code session. Identity assurance is
-- a subject property checked by the trigger below. Recovery-limited sessions cannot publish.
CREATE FUNCTION core.registry_publication_session_live(p_session_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, core, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM core.sessions AS session
    WHERE session.id = p_session_id
      AND session.subject_id = core.current_actor()
      AND session.revoked_at IS NULL
      AND session.expires_at > now()
      AND COALESCE(session.last_seen_at, session.issued_at) > now() - interval '30 minutes'
      AND session.first_factor <> 'siwe_legacy'
      AND NOT session.recovery_limited
      AND NOT EXISTS (
        SELECT 1 FROM core.session_factor_proofs AS proof
        LEFT JOIN core.webauthn_credentials AS credential ON credential.id = proof.webauthn_credential_id
        LEFT JOIN core.totp_authenticators AS totp ON totp.id = proof.totp_authenticator_id
        WHERE proof.id = session.second_factor_proof_id
          AND (credential.revoked_at IS NOT NULL OR totp.revoked_at IS NOT NULL)
      )
      AND (session.oidc_transaction_id IS NULL OR EXISTS (
        SELECT 1 FROM core.oidc_login_transactions AS login
        JOIN core.external_identities AS identity ON identity.id = login.identity_id
        WHERE login.id = session.oidc_transaction_id AND identity.revoked_at IS NULL
      ))
  )
$$;

REVOKE ALL ON FUNCTION core.registry_publication_session_live(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.registry_publication_session_live(uuid) TO mpc_app;

ALTER TABLE core.registry_publication_drafts
  ADD COLUMN administrator_publication_prepared boolean NOT NULL DEFAULT false;

-- A scoped administrator may publish their own project draft without personal identifiers.
-- The existing draft guard still enforces a pending insert, immutable input, and a final decision.
CREATE FUNCTION core.guard_registry_draft_self_publication() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, core, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.administrator_publication_prepared IS DISTINCT FROM OLD.administrator_publication_prepared THEN
    RAISE EXCEPTION 'Publication preparation cannot be modified after a draft is created'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.state <> 'published' OR NEW.decided_by_subject_id IS DISTINCT FROM NEW.proposed_by_subject_id THEN
    RETURN NEW;
  END IF;

  IF NEW.administrator_publication_prepared
    AND NEW.registry_type = 'project'
    AND NOT NEW.contains_person_level_identifier
    AND NEW.decided_by_subject_id = core.current_actor()
    AND core.actor_live()
    AND NEW.projection - ARRAY[
      'stableId', 'projectKey', 'projectName', 'hostCountry', 'mineral',
      'status', 'version', 'asOf', 'sourceAge', 'staleStatus',
      'limitations', 'legalEffect', 'disclaimerCodes', 'evidenceLedger'
    ] = '{}'::jsonb
    AND NEW.projection->'sourceAge' = 'null'::jsonb
    AND NEW.projection->>'staleStatus' = 'unknown'
    AND (NEW.projection->>'asOf')::timestamptz = NEW.proposed_at
    AND NEW.projection->'limitations' = '[
      "This record is the result of checking submitted material; it is not a judgement on commercial viability or completeness of rights",
      "It does not include site due diligence"
    ]'::jsonb
    AND NEW.projection->'disclaimerCodes' = '["DISC-VERIFICATION-SCOPE", "DISC-NO-GUARANTEE"]'::jsonb
    AND core.registry_publication_session_live(
      NULLIF(current_setting('app.registry_publication_session_id', true), '')::uuid
    )
    AND EXISTS (
      SELECT 1
      FROM core.role_bindings AS binding
      JOIN core.projects AS project ON project.id = NEW.subject_id
      JOIN core.subjects AS subject ON subject.id = binding.subject_id
        AND subject.kind = 'person' AND subject.assurance_level = 'high_assurance'
      WHERE binding.subject_id = NEW.decided_by_subject_id
        AND binding.role = 'administrator'
        AND NEW.projection->>'version' = project.version::text
        AND NEW.projection->>'status' = CASE WHEN project.lifecycle_state = 'draft' THEN 'registered' ELSE project.lifecycle_state::text END
        AND binding.revoked_at IS NULL
        AND (binding.jurisdiction IS NULL OR project.host_country_iso3::text = ANY(binding.jurisdiction))
        AND (
          binding.project_id = project.id
          OR (binding.project_id IS NULL AND COALESCE(binding.scope_kind, 'registry') = 'registry')
          OR (binding.project_id IS NULL AND binding.scope_kind = 'organization'
            AND binding.organization_id = project.owner_organization_id)
        )
    )
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'This draft must be published by a different reviewer'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'registry_draft_two_person';
END;
$$;

CREATE TRIGGER registry_draft_self_publication
  BEFORE INSERT OR UPDATE ON core.registry_publication_drafts
  FOR EACH ROW EXECUTE FUNCTION core.guard_registry_draft_self_publication();

ALTER TABLE core.registry_publication_drafts ENABLE ALWAYS TRIGGER registry_draft_self_publication;

-- Roll forward if self-published decisions already exist. Restoring the previous CHECK
-- would fail for those immutable rows. Restoring a pre-migration backup instead requires
-- reconciling any publications and external anchors made since the backup.
ALTER TABLE core.registry_publication_drafts
  DROP CONSTRAINT registry_draft_two_person,
  ADD CONSTRAINT registry_draft_publication_separation CHECK (
    state <> 'published'
    OR decided_by_subject_id <> proposed_by_subject_id
    OR (administrator_publication_prepared AND registry_type = 'project' AND NOT contains_person_level_identifier)
  );
