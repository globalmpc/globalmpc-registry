-- Account email on the subject — account authentication WP2, decision D6.
--
-- A person signs in by proving control of an email address (an emailed one-time code). The
-- address is therefore an identity namespace, and this migration fixes its rules:
--
-- | Case | Rule |
-- | --- | --- |
-- | Namespace | `core.normalize_email`: trimmed, lower-cased, NFC; exactly one `@`; a domain with at least one dot |
-- | Uniqueness | **Global**, across tenants (D6): one address, one subject, one tenant |
-- | Who sets it | Only invitation acceptance, the bootstrap CLI and a completed two-person email change. The application role cannot write the column at all |
-- | Service subjects | Never have one (services use service tokens, 0109) |
-- | Frozen or live | Live; the audit trail keeps a keyed hash of each value it held |
-- | What it authorises | **Nothing by itself.** It only says where a first-factor code goes |
--
-- Not in any public projection: nothing under `public.*`, no export and no Explorer read selects
-- this column, and the admin subject list is a tenant-private read.
--
-- `core.subjects.organization_id` records the organisation a person was invited into. It is
-- informational — role bindings still carry their own organisation and decide everything — but
-- an admin proposing the first role grant needs to know where the person belongs.

-- ---------------------------------------------------------------------------
-- Normalisation
-- ---------------------------------------------------------------------------

/**
 * The one canonical form of an email address, or an error for anything that is not one.
 *
 * The API normalises the same way before it hashes an address for rate limits and audit. Where
 * the two could disagree (case mapping outside ASCII depends on the database's collation), the
 * stored value is checked against this function, so a mismatch is refused rather than stored in
 * two spellings.
 */
CREATE FUNCTION core.normalize_email(p_email TEXT) RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = core, pg_temp
AS $$
DECLARE
  v TEXT := normalize(lower(btrim(p_email)), NFC);
  v_local TEXT;
  v_domain TEXT;
BEGIN
  IF length(v) > 254 OR length(v) - length(replace(v, '@', '')) <> 1 THEN
    RAISE EXCEPTION 'not an email address' USING ERRCODE = 'check_violation';
  END IF;
  v_local := split_part(v, '@', 1);
  v_domain := split_part(v, '@', 2);
  IF v_local !~ '^[^[:space:][:cntrl:]]+$'
     OR v_domain !~ '^[^.[:space:][:cntrl:]]+(\.[^.[:space:][:cntrl:]]+)+$' THEN
    RAISE EXCEPTION 'not an email address' USING ERRCODE = 'check_violation';
  END IF;
  RETURN v;
END
$$;

GRANT EXECUTE ON FUNCTION core.normalize_email(TEXT) TO mpc_app;

-- ---------------------------------------------------------------------------
-- Subject columns
-- ---------------------------------------------------------------------------

ALTER TABLE core.subjects
  ADD COLUMN email TEXT,
  ADD COLUMN organization_id UUID,
  ADD CONSTRAINT subjects_email_normalized
    CHECK (email IS NULL OR email = core.normalize_email(email)),
  ADD CONSTRAINT subjects_email_person_only
    CHECK (email IS NULL OR kind = 'person'),
  -- D6: one address belongs to one subject in one tenant. A plain UNIQUE spans every tenant.
  ADD CONSTRAINT subjects_email_key UNIQUE (email),
  ADD CONSTRAINT subjects_organization_same_tenant
    FOREIGN KEY (tenant_id, organization_id) REFERENCES core.organizations (tenant_id, id);

/**
 * The application role keeps every privilege it had on `core.subjects` **except** writing `email`
 * and `organization_id`.
 *
 * "Admins cannot attach an email to an existing subject" (plan §5) is a database rule, not a
 * route that happens not to exist: column privileges make an `UPDATE core.subjects SET email`
 * from the API connection fail, whatever code path issues it. The address is written only by the
 * SECURITY DEFINER functions of 0113/0114 (invitation acceptance, completed email change) and by
 * the bootstrap CLI over the migration connection.
 *
 * A column added to `core.subjects` later is not writable by the application until a migration
 * grants it — the failure is loud, and the grant is the place to decide it.
 */
REVOKE INSERT, UPDATE ON core.subjects FROM mpc_app;
GRANT INSERT (id, tenant_id, kind, display_name, created_at, version, assurance_level, governance_wallet_id)
  ON core.subjects TO mpc_app;
GRANT UPDATE (display_name, version, assurance_level, governance_wallet_id)
  ON core.subjects TO mpc_app;

-- ---------------------------------------------------------------------------
-- Lookup for the login path
-- ---------------------------------------------------------------------------

/**
 * The person subject an address belongs to, in any tenant.
 *
 * Before sign-in the tenant is unknown — finding it is the point — so RLS would hide every row
 * (the same reason as 0005 and 0108). Only the login functions in 0113 call this; the
 * application role is not granted it, so it cannot be used as a directory of who has an account.
 */
CREATE FUNCTION core.find_person_by_email(p_email TEXT)
RETURNS TABLE (subject_id UUID, tenant_id UUID)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = core, pg_temp
AS $$
  SELECT s.id, s.tenant_id
  FROM core.subjects s
  WHERE s.email = core.normalize_email(p_email) AND s.kind = 'person'
$$;

REVOKE EXECUTE ON FUNCTION core.find_person_by_email(TEXT) FROM PUBLIC;
