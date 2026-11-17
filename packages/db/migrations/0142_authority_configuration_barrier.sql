-- Issuers are validation inputs even without source connections. Serialize their writes with
-- signing, dispute restoration and publication, using the existing tenant configuration barrier.
CREATE TRIGGER aaaa_ledger_publication_barrier BEFORE INSERT OR UPDATE OR DELETE ON core.authorities
  FOR EACH ROW EXECUTE FUNCTION core.guard_ledger_input_write('configuration');
CREATE TRIGGER ledger_publication_no_truncate BEFORE TRUNCATE ON core.authorities
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();
