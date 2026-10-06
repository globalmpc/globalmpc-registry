-- Fix the return order of role bindings — 02 §2.7
--
-- `resolve_role_bindings` had no ORDER BY. Querying the same subject twice was not
-- guaranteed to return the same order, and a plan change could change it.
--
-- Order is visible in two places. Permission checks **allow if any binding passes**,
-- so order does not change the result. But audit records and the on-screen role list
-- use the order as is — the same action by the same person could be recorded under a
-- different role on each run.
--
-- Narrower bindings come first. A project binding reaches only that project and an
-- organization binding the whole organization, so an earlier binding never has a wider scope than a later one.
-- Then by role name — not because it means anything, but so the same input gives the same
-- output.

CREATE OR REPLACE FUNCTION core.resolve_role_bindings(p_subject_id UUID)
RETURNS TABLE (
  role            TEXT,
  organization_id UUID,
  project_id      UUID
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = core, pg_temp
AS $$
  SELECT r.role, r.organization_id, r.project_id
  FROM core.role_bindings r
  WHERE r.subject_id = p_subject_id
    AND r.revoked_at IS NULL
  ORDER BY (r.project_id IS NULL), r.role, r.project_id, r.organization_id
$$;
