-- Actor-based row-level security for project-owned records: expand phase.
--
-- The Registry is one shared instance. Organizations and projects, not tenants, decide what a
-- person may reach. This migration adds that decision to the database next to the existing
-- tenant policy, without changing how any current consumer behaves:
--
--   * `app.actor_subject_id` names the authenticated person or service subject of the request
--     transaction (`withActor`). The API sets it only after resolving a live session.
--   * A role binding reaches projects exactly as the API's `visibleProjectScope` decides:
--       - a project binding reaches that project;
--       - an organization binding (`scope_kind = 'organization'`) reaches the projects that
--         organization owns;
--       - a Registry-wide binding (`scope_kind = 'tenant'`, no project) reaches every project;
--       - `scope_kind = 'none'` without a project reaches none;
--       - a jurisdiction list narrows every kind to projects hosted in those jurisdictions.
--     Revoked bindings and suspended subjects reach nothing.
--   * The new `actor_project_scope` policy is permissive, so it is OR-ed with `tenant_isolation`.
--     Running versions set only `app.current_tenant` and keep their current reach; `withActor`
--     clears `app.current_tenant`, so an actor transaction gets only the actor arm. A later
--     contract migration drops `tenant_isolation` once no consumer sets the tenant.
--
-- The database decides project reach only. Role-action permission, assurance level, sensitivity,
-- assignment and conflict rules stay in the API decision (02 §2.1); passing RLS is not passing
-- authorization. The reach here is therefore never wider than the API's and may be equal to it.

CREATE FUNCTION core.current_actor() RETURNS UUID
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.actor_subject_id', true), '')::uuid
$$;

-- Live bindings of the current actor with their effective scope. Reads role bindings, subjects
-- and projects before any project is known, so it must not be filtered by the caller's RLS:
-- reading nothing would silently narrow a person to no projects, and under an owner that does not
-- bypass RLS `row_security = off` fails loudly instead (see 0131).
CREATE FUNCTION core.actor_live_bindings()
RETURNS TABLE(organization_id UUID, project_id UUID, jurisdiction TEXT[], scope_kind TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, core, pg_temp SET row_security = off AS $$
  SELECT b.organization_id, b.project_id, b.jurisdiction,
    COALESCE(b.scope_kind, CASE WHEN b.role = 'project_member' THEN 'organization' ELSE 'tenant' END)
  FROM core.role_bindings AS b
  JOIN core.subjects AS s ON s.id = b.subject_id
  WHERE b.subject_id = core.current_actor()
    AND b.revoked_at IS NULL
    AND s.suspended_at IS NULL
$$;

-- Whether the actor holds an unrestricted Registry-wide binding.
CREATE FUNCTION core.actor_registry_wide() RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, core, pg_temp SET row_security = off AS $$
  SELECT EXISTS (
    SELECT FROM core.actor_live_bindings() AS b
    WHERE b.project_id IS NULL AND b.scope_kind = 'tenant' AND b.jurisdiction IS NULL
  )
$$;

-- Projects the actor reaches through project, organization or jurisdiction-limited bindings.
CREATE FUNCTION core.actor_project_ids() RETURNS UUID[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, core, pg_temp SET row_security = off AS $$
  SELECT COALESCE(array_agg(DISTINCT p.id), '{}')
  FROM core.actor_live_bindings() AS b
  JOIN core.projects AS p ON
       b.project_id = p.id
    OR (b.project_id IS NULL AND b.scope_kind = 'tenant')
    OR (b.project_id IS NULL AND b.scope_kind = 'organization'
        AND b.organization_id = p.owner_organization_id)
  WHERE b.jurisdiction IS NULL OR p.host_country_iso3::text = ANY(b.jurisdiction)
$$;

-- Whether the actor's bindings reach a project row with these values. Used for the project row
-- itself, judged on the values being written: an id-based check would read the reach from before
-- the statement and let a member hand its project to another organization. An organization
-- binding also reaches a project its organization is creating, before the id is in any list.
CREATE FUNCTION core.actor_reaches_project(p_id UUID, p_owner_organization_id UUID, p_host_country TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, core, pg_temp SET row_security = off AS $$
  SELECT EXISTS (
    SELECT FROM core.actor_live_bindings() AS b
    WHERE (b.jurisdiction IS NULL OR p_host_country = ANY(b.jurisdiction))
      AND (b.project_id = p_id
        OR (b.project_id IS NULL AND b.scope_kind = 'tenant')
        OR (b.project_id IS NULL AND b.scope_kind = 'organization'
            AND b.organization_id = p_owner_organization_id))
  )
$$;

REVOKE EXECUTE ON FUNCTION core.actor_live_bindings(), core.actor_registry_wide(),
  core.actor_project_ids(), core.actor_reaches_project(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.current_actor(), core.actor_registry_wide(),
  core.actor_project_ids(), core.actor_reaches_project(UUID, UUID, TEXT) TO mpc_app;

-- The Registry's single legacy tenant, for rows written by actor transactions while the
-- tenant column still exists. More than one tenant means the instance has not been
-- consolidated, and guessing one would file a record under the wrong owner.
CREATE FUNCTION core.registry_tenant() RETURNS UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, core, pg_temp SET row_security = off AS $$
DECLARE
  v_ids UUID[];
BEGIN
  SELECT array_agg(id) INTO v_ids FROM core.tenants;
  IF coalesce(cardinality(v_ids), 0) <> 1 THEN
    RAISE EXCEPTION 'REGISTRY_TENANT_AMBIGUOUS: expected one legacy tenant, found %',
      coalesce(cardinality(v_ids), 0) USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN v_ids[1];
END
$$;
REVOKE EXECUTE ON FUNCTION core.registry_tenant() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.registry_tenant() TO mpc_app;

-- Projects are judged on the row's own values, before and after a write.
CREATE POLICY actor_project_scope ON core.projects
  USING (core.actor_reaches_project(id, owner_organization_id, host_country_iso3::text))
  WITH CHECK (core.actor_reaches_project(id, owner_organization_id, host_country_iso3::text));
ALTER TABLE core.projects ALTER COLUMN tenant_id SET DEFAULT core.registry_tenant();

-- Records that always belong to one project. Records reached through a parent, records that may
-- have no project, and account records follow in their own migrations.
DO $$
DECLARE
  v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'artifacts', 'claims', 'compliance_assessments', 'cre_reports',
    'disclosure_restriction_events', 'disclosure_restrictions', 'document_impacts',
    'document_links', 'document_requirements', 'evidence_ledger_snapshots',
    'gate_decision_signature_requests', 'gate_decisions', 'object_uploads',
    'project_fact_versions', 'project_facts', 'project_lifecycle_transitions',
    'project_parties', 'project_registration_requests', 'project_stakeholder_events',
    'registry_review_bundles', 'source_observations', 'verification_cases'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY actor_project_scope ON core.%I '
      'USING ((SELECT core.actor_registry_wide()) OR project_id = ANY((SELECT core.actor_project_ids())::uuid[])) '
      'WITH CHECK ((SELECT core.actor_registry_wide()) OR project_id = ANY((SELECT core.actor_project_ids())::uuid[]))',
      v_table);
    EXECUTE format('ALTER TABLE core.%I ALTER COLUMN tenant_id SET DEFAULT core.registry_tenant()', v_table);
  END LOOP;
END
$$;
