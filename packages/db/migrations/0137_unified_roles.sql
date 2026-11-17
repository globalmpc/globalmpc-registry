-- Consolidate standing human roles. This migration is explicitly cross-tenant and
-- runs only under the migration owner; runtime access remains transaction-local RLS.
-- Historical revoked bindings, audit events, signed payloads and publications are frozen.
CREATE TEMP TABLE role_transition (old_role TEXT PRIMARY KEY, new_role TEXT NOT NULL, scope_kind TEXT NOT NULL) ON COMMIT DROP;
INSERT INTO role_transition VALUES
  ('project_admin', 'project_member', 'organization'),
  ('project_sponsor_operator', 'project_member', 'organization'),
  ('spv_representative', 'project_member', 'organization'),
  ('execution_recorder', 'project_member', 'organization'),
  ('protocol_proposer', 'project_member', 'none'),
  ('protocol_voter', 'project_member', 'none'),
  ('project_proposer', 'project_member', 'organization'),
  ('project_voter', 'project_member', 'none'),
  ('data_steward', 'reviewer', 'organization'),
  ('reviewer_cp_qp', 'reviewer', 'tenant'),
  ('reviewer_lab', 'reviewer', 'tenant'),
  ('reviewer_legal', 'reviewer', 'tenant'),
  ('reviewer_assurance', 'reviewer', 'tenant'),
  ('disclosure_approver', 'reviewer', 'tenant'),
  ('gate_approver', 'reviewer', 'tenant'),
  ('issuer_officer', 'reviewer', 'organization'),
  ('external_regulated_service_provider', 'reviewer', 'tenant'),
  ('mpc_operator', 'administrator', 'tenant'),
  ('security_operator', 'administrator', 'tenant'),
  ('auditor', 'administrator', 'tenant'),
  ('treasury_signer', 'administrator', 'tenant');
ALTER TABLE core.role_bindings ADD COLUMN scope_kind TEXT
  CHECK (scope_kind IN ('tenant','organization','none'));
ALTER TABLE core.role_grant_requests ADD COLUMN scope_kind TEXT
  CHECK (scope_kind IN ('tenant','organization','none'));

ALTER TABLE core.role_bindings ADD COLUMN governance_scope TEXT
  CHECK (governance_scope IN ('protocol','project','none'));
ALTER TABLE core.role_grant_requests ADD COLUMN governance_scope TEXT
  CHECK (governance_scope IN ('protocol','project','none'));

-- Record the one-time reinterpretation before changing live grants. No old audit row changes.
INSERT INTO audit.events (tenant_id, project_id, command, resource_type, resource_id,
  before_version, after_version, reason, correlation_id, detail)
SELECT b.tenant_id, b.project_id, 'authorization.role.consolidated', 'role_binding', b.id,
  b.version, b.version+1, 'Three human roles; existing project reach preserved',
  'migration:0137_unified_roles', jsonb_build_object('previousRole', b.role,
    'role', m.new_role, 'scopeKind', m.scope_kind)
FROM core.role_bindings b JOIN role_transition m ON m.old_role=b.role
WHERE b.revoked_at IS NULL;

-- Only this migration-owner transaction may reinterpret live role identities.
ALTER TABLE core.role_bindings DISABLE TRIGGER role_bindings_guard;
UPDATE core.role_bindings b SET role=m.new_role, scope_kind=m.scope_kind,
  governance_scope=CASE
    WHEN b.role='protocol_voter' THEN 'protocol'
    WHEN b.role='project_voter' AND b.project_id IS NOT NULL THEN 'project'
    ELSE 'none' END,
  version=b.version+1
FROM role_transition m WHERE b.role=m.old_role AND b.revoked_at IS NULL;
ALTER TABLE core.role_bindings ENABLE TRIGGER role_bindings_guard;

-- Notifications are delivery records, not signed/audit history. Keep undelivered
-- role-addressed messages reachable under the new audience, with project filtering unchanged.
UPDATE core.notifications n SET audience_role=m.new_role
FROM role_transition m WHERE n.audience_role=m.old_role;

-- An unapproved request for an old specialty is not consent to the broader new role.
UPDATE core.role_grant_requests g SET state='withdrawn', decided_at=now(),
  decision_reason='Role model changed; submit a new request for the consolidated role', version=g.version+1
WHERE state='pending' AND role IN (SELECT old_role FROM role_transition);

CREATE FUNCTION core.check_standing_role() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role NOT IN ('project_member','reviewer','administrator','scan_service','cre_reporter') THEN
    RAISE EXCEPTION 'Unknown standing role' USING ERRCODE='check_violation';
  END IF;
  IF NEW.scope_kind IS NULL THEN
    NEW.scope_kind := CASE WHEN NEW.role='project_member' THEN 'organization' ELSE 'tenant' END;
  END IF;
  IF NEW.role='project_member' AND NEW.scope_kind='tenant' THEN
    RAISE EXCEPTION 'Project membership cannot grant tenant-wide project access' USING ERRCODE='check_violation';
  END IF;
  IF NEW.governance_scope IS NULL THEN
    NEW.governance_scope := CASE WHEN NEW.role <> 'project_member' THEN 'none'
      WHEN NEW.project_id IS NOT NULL THEN 'project' ELSE 'protocol' END;
  END IF;
  IF NEW.governance_scope <> 'none' AND NEW.role <> 'project_member'
     OR NEW.governance_scope='project' AND NEW.project_id IS NULL
     OR NEW.governance_scope='protocol' AND NEW.project_id IS NOT NULL THEN
    RAISE EXCEPTION 'Invalid governance namespace' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER role_binding_known_role BEFORE INSERT ON core.role_bindings
FOR EACH ROW EXECUTE FUNCTION core.check_standing_role();
CREATE TRIGGER role_grant_known_role BEFORE INSERT ON core.role_grant_requests
FOR EACH ROW EXECUTE FUNCTION core.check_standing_role();

CREATE FUNCTION core.protect_role_scope() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.scope_kind IS DISTINCT FROM OLD.scope_kind
     OR NEW.governance_scope IS DISTINCT FROM OLD.governance_scope THEN
    RAISE EXCEPTION 'Role scope cannot be rewritten; revoke and grant again';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER role_bindings_scope_guard BEFORE UPDATE ON core.role_bindings
FOR EACH ROW EXECUTE FUNCTION core.protect_role_scope();
CREATE TRIGGER role_grant_scope_guard BEFORE UPDATE ON core.role_grant_requests
FOR EACH ROW EXECUTE FUNCTION core.protect_role_scope();

DROP FUNCTION core.resolve_role_bindings(UUID);
CREATE FUNCTION core.resolve_role_bindings(p_subject_id UUID)
RETURNS TABLE(role TEXT, organization_id UUID, project_id UUID, jurisdiction TEXT[], scope_kind TEXT, governance_scope TEXT)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path=core,pg_temp SET row_security=off AS $$
  SELECT r.role,r.organization_id,r.project_id,r.jurisdiction,
    COALESCE(r.scope_kind, CASE WHEN r.role='project_member' THEN 'organization' ELSE 'tenant' END), COALESCE(r.governance_scope,'none')
  FROM core.role_bindings r
  WHERE r.subject_id=p_subject_id AND r.revoked_at IS NULL
  ORDER BY (r.project_id IS NULL), r.role, r.project_id, r.organization_id
$$;
REVOKE EXECUTE ON FUNCTION core.resolve_role_bindings(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.resolve_role_bindings(UUID) TO mpc_app;

CREATE OR REPLACE FUNCTION core.notify_document_impacts()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO core.notifications (tenant_id, kind, audience_role, project_id, summary, link)
  SELECT i.tenant_id, 'document_impact', 'reviewer', i.project_id,
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
$function$

;

CREATE OR REPLACE FUNCTION core.notify_evidence_stale()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.target_type = 'project_lifecycle' THEN
    INSERT INTO core.notifications (tenant_id, kind, audience_role, project_id, summary, link)
    VALUES (
      NEW.tenant_id, 'evidence_stale', 'reviewer', NEW.project_id,
      'Suspension to consider: ' || NEW.reason,
      '/w/projects/' || NEW.project_id
    );
    RETURN NEW;
  END IF;

  INSERT INTO core.notifications (tenant_id, kind, audience_role, project_id, summary, link)
  VALUES (
    NEW.tenant_id, 'evidence_stale', 'reviewer', NEW.project_id,
    'Evidence became stale: ' || NEW.reason,
    '/w/work'
  );
  RETURN NEW;
END;
$function$

;

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
    NEW.tenant_id, 'readiness_gap', 'reviewer', NEW.project_id,
    'Readiness assessment found a gap',
    '/w/projects/' || NEW.project_id || '/readiness'
  );
  RETURN NEW;
END;
$function$

;

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
    NEW.tenant_id, 'registry_revoked', 'administrator', target_project,
    'Public record revoked: ' || coalesce(target_key, '(no key)'),
    '/w/registries'
  );
  RETURN NEW;
END;
$function$

;

CREATE OR REPLACE FUNCTION core.public_governance_role_holders()
 RETURNS TABLE(role text, active_holders bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
AS $function$
  SELECT r.role, COUNT(DISTINCT b.subject_id)
  FROM unnest(ARRAY[
    'administrator', 'reviewer', 'project_member']) AS r(role)
  LEFT JOIN core.role_bindings b ON b.role = r.role AND b.revoked_at IS NULL
  GROUP BY r.role
  ORDER BY r.role
$function$

;

