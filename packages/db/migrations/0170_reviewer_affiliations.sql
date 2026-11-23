-- Review independence reads every affiliation of the person being judged.
--
-- Rule 2 (a reviewer bound to the operating organization through any role is not independent of
-- it) and the credential's holder organization read another person's role bindings. Under the
-- tenant every member of the single tenant saw all of them. Since 0169 `core.role_bindings`
-- shows a caller only bindings in its own project reach, so a project-scoped decider (a dispute
-- resolver, a reviewer of one project) would miss the subject's binding on a project it cannot
-- reach, read too few organizations, and could call a reviewer of the operator independent.
--
-- These helpers answer exactly what the independence rules need, about one named subject, from
-- all of that subject's live bindings, without returning any binding, role or project:
--   * `subject_affiliated_organizations` — the organizations of the subject's unrevoked bindings;
--   * `subject_holder_organization` — the organization of its earliest-granted unrevoked binding
--     (the credential holder organization, `review-registry.holderOrganization`).
-- Only a live actor gets an answer. Anyone else gets the empty answer, which the callers already
-- treat as "unknown organization", and unknown never establishes independence.
--
-- Organization ids are Registry reference data every live actor can list; what this reveals is
-- which organizations a person acts for, which any member of the former single tenant could read.
-- Like the other definers that read past the caller's reach (0131), they run with
-- `row_security = off`, so an owner that does not bypass RLS fails instead of answering short.

CREATE FUNCTION core.subject_affiliated_organizations(p_subject_id UUID) RETURNS UUID[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, core, pg_temp SET row_security = off AS $$
  SELECT CASE WHEN core.actor_live() THEN COALESCE((
    SELECT array_agg(DISTINCT b.organization_id ORDER BY b.organization_id)
    FROM core.role_bindings AS b
    WHERE b.subject_id = p_subject_id AND b.revoked_at IS NULL AND b.organization_id IS NOT NULL
  ), '{}') ELSE '{}' END
$$;
REVOKE EXECUTE ON FUNCTION core.subject_affiliated_organizations(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.subject_affiliated_organizations(UUID) TO mpc_app;

CREATE FUNCTION core.subject_holder_organization(p_subject_id UUID) RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, core, pg_temp SET row_security = off AS $$
  SELECT b.organization_id
  FROM core.role_bindings AS b
  WHERE core.actor_live() AND b.subject_id = p_subject_id AND b.revoked_at IS NULL
  ORDER BY b.granted_at, b.id
  LIMIT 1
$$;
REVOKE EXECUTE ON FUNCTION core.subject_holder_organization(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.subject_holder_organization(UUID) TO mpc_app;
