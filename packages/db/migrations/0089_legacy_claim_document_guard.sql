-- Legacy review hashes omit document attachments. Preserve already stored rows and
-- historical snapshot bytes, but forbid creating further unauthenticated links.
CREATE FUNCTION core.guard_legacy_claim_documents() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.catalog_entry_id IS NULL AND cardinality(NEW.document_upload_ids)>0 THEN
    RAISE EXCEPTION 'Claim document attachments require a catalog entry' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER legacy_claim_document_guard BEFORE INSERT ON core.claims
  FOR EACH ROW EXECUTE FUNCTION core.guard_legacy_claim_documents();
