-- The review registries take rows only from an approved proposal — spec 02 §2.8.
--
-- **Why:** `0002_rls.sql` grants `mpc_app` SELECT, INSERT and UPDATE on every tenant table, and
-- `core.credentials`, `core.attestation_schemas` and `core.compliance_policy_sets` are three of
-- them. The two-person rule added in `0043_registry_proposals.sql` lives on the proposal table,
-- so it holds only for callers that go through the approval route. A bug in any other route —
-- or one hijacked app session — can write a trusted registry row with a plain INSERT and nobody
-- proposed or approved it. Everything downstream treats such a row as reviewed: a credential
-- lets its holder sign, an active schema is signable, an effective policy set decides readiness.
--
-- **The rule is stated where the row is written,** not where it is asked for. `0043` already
-- refuses a proposal that was born approved or decided by its own proposer; this migration makes
-- the registry row itself unreachable without such a proposal.
--
-- **Deferred, because approval writes the row first.** `routes/review-registry.ts` inserts the
-- registry row and then sets `state = 'approved'` with `materialized_id` in the same
-- transaction. An immediate trigger would see the proposal still `pending` and reject the one
-- path that is allowed. A deferred constraint trigger asks the question at COMMIT, when the
-- transaction has finished saying what it did.
--
-- **The seed path stays.** `apps/api/src/bootstrap-registry.ts` runs on a superuser connection
-- that bypasses RLS and writes the same rows for a fresh environment where nobody can approve
-- yet (`0043`, `0028`). The check exempts exactly that: a role that bypasses row-level security
-- is not the application. `mpc_app` does not bypass it, and that is the role the API connects
-- with.
--
-- The exemption is an attribute, not a role name, because the seed connection is whatever
-- `DATABASE_URL` the deployment hands the CLI — `bootstrap-registry-cli.ts` does not create or
-- require a named role, and pinning one here would break a deployment that seeds with a
-- different superuser. What that leaves open is a *second* RLS-bypassing role being granted
-- INSERT on these tables later — `mpc_worker` already bypasses RLS (`0012`) and simply has no
-- INSERT here. That is not left to reading: a test in `packages/db/test/schema.test.ts` fails
-- if any non-superuser role that bypasses RLS ever holds INSERT on the three tables.

CREATE OR REPLACE FUNCTION core.require_registry_approval() RETURNS TRIGGER
LANGUAGE plpgsql
-- Pinned, as every other security-relevant function here is (0005, 0009, 0010, 0026, ...). The
-- function runs with invoker rights and the invoking role is the one being checked, so an
-- unpinned path would let that same session put a decoy `pg_roles` ahead of `pg_catalog` and
-- report itself as the seed connection.
SET search_path = core, pg_temp
AS $$
DECLARE
  seeding BOOLEAN;
  approved BOOLEAN;
BEGIN
  -- The seed path is a superuser/BYPASSRLS connection. The application is not.
  SELECT rolsuper OR rolbypassrls INTO seeding FROM pg_roles WHERE rolname = current_user;
  IF COALESCE(seeding, false) THEN
    RETURN NULL;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM core.registry_proposals p
    WHERE p.tenant_id = NEW.tenant_id
      AND p.kind = TG_ARGV[0]::core.registry_kind
      AND p.state = 'approved'
      AND p.materialized_id = NEW.id
  ) INTO approved;

  IF NOT approved THEN
    RAISE EXCEPTION
      'A % row is written only by approving a proposal that points at it (id %)',
      TG_ARGV[0], NEW.id
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER credentials_require_approval
  AFTER INSERT ON core.credentials
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION core.require_registry_approval('credential');

CREATE CONSTRAINT TRIGGER attestation_schemas_require_approval
  AFTER INSERT ON core.attestation_schemas
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION core.require_registry_approval('attestation_schema');

CREATE CONSTRAINT TRIGGER compliance_policy_sets_require_approval
  AFTER INSERT ON core.compliance_policy_sets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION core.require_registry_approval('policy_set');

/**
 * UPDATE is taken away rather than guarded.
 *
 * No route updates these three tables — the only UPDATEs in the tree are in the bootstrap CLI,
 * on its superuser connection. A privilege nothing uses is a privilege that can only be used by
 * mistake: a status flipped to `valid`, a schema moved to `active`, a policy set made
 * `effective`, each of which changes what the system will sign or publish without a second
 * person seeing it. When a route needs one of these transitions it comes back with a proposal
 * kind and its own grant.
 */
REVOKE UPDATE ON core.credentials, core.attestation_schemas, core.compliance_policy_sets
  FROM mpc_app;
