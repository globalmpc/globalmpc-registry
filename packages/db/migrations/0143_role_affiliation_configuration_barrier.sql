-- Role organizations are live review-affiliation inputs. Serialize grants and revocations
-- with signing, dispute adjudication/restoration and publication using the same tenant barrier.
CREATE TRIGGER aaaa_ledger_publication_barrier BEFORE INSERT OR UPDATE OR DELETE ON core.role_bindings
  FOR EACH ROW EXECUTE FUNCTION core.guard_ledger_input_write('configuration');
CREATE TRIGGER ledger_publication_no_truncate BEFORE TRUNCATE ON core.role_bindings
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();
