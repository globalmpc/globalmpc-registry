-- Both binding and suspension update the same recovery row. Whichever obtains
-- the row lock second sees the first decision, including after reinstatement.
CREATE FUNCTION core.cancel_suspended_wallet_recoveries() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,core,pg_temp AS $$
BEGIN
  UPDATE core.wallet_recoveries SET cancelled_at=now()
  WHERE tenant_id=NEW.tenant_id AND (approved_by=NEW.id OR subject_id=NEW.id)
    AND consumed_at IS NULL AND cancelled_at IS NULL;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.cancel_suspended_wallet_recoveries() FROM PUBLIC;
CREATE TRIGGER cancel_suspended_wallet_recoveries
AFTER UPDATE OF suspended_at ON core.subjects FOR EACH ROW
WHEN (OLD.suspended_at IS NULL AND NEW.suspended_at IS NOT NULL)
EXECUTE FUNCTION core.cancel_suspended_wallet_recoveries();

UPDATE core.wallet_recoveries r SET cancelled_at=now()
WHERE cancelled_at IS NULL AND consumed_at IS NULL AND EXISTS (
  SELECT 1 FROM core.subjects s WHERE s.tenant_id=r.tenant_id AND s.suspended_at IS NOT NULL
    AND (s.id=r.approved_by OR s.id=r.subject_id)
);
