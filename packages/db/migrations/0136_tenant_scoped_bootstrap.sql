-- Bootstrap establishes a tenant before calling this function. Its existing body locks the
-- scoped subject before opening a window; an out-of-scope subject fails with no_data_found.
-- Keep its migration-owner-only EXECUTE ACL. Application/worker roles gain no new privileges.
-- SECURITY INVOKER prevents this operation from inheriting a superuser/owner bypass and
-- row_security=on permits an ordinary table owner to obey FORCE RLS instead of erroring.
ALTER FUNCTION core.open_bootstrap_enrolment_window(uuid) SECURITY INVOKER;
ALTER FUNCTION core.open_bootstrap_enrolment_window(uuid) SET row_security = on;
