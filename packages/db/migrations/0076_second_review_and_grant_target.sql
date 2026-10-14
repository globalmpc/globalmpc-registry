-- One follow-up per source receipt, and no role grant decided by its own target.
--
-- **One follow-up per receipt.** The second-review route read "is there already a follow-up?"
-- and then inserted one. Two concurrent reviews both read "no" and both inserted, so the
-- original had two successors — possibly one `confirmed_from_source` and one `conflicting`.
-- The route's read stays for the clear error message; this index is what decides the race.
-- `source_receipts` is append-only, so a follow-up is never replaced and one successor is the
-- whole rule.

CREATE UNIQUE INDEX source_receipts_one_follow_up_idx
  ON core.source_receipts (supersedes_receipt_id)
  WHERE supersedes_receipt_id IS NOT NULL;

-- **The target of a role grant does not decide it.** `role_grant_two_person` (0028) separates
-- the proposer from the decider, but the person receiving the role could still be the decider:
-- operator A proposes a role for operator B and B approves what B receives. Two people
-- appear on the record while one of them decided their own grant. The route refuses it first
-- with a reason; this constraint holds the rule for every other path.

ALTER TABLE core.role_grant_requests
  ADD CONSTRAINT role_grant_not_self_target CHECK (
    decided_by_subject_id IS NULL OR decided_by_subject_id <> subject_id
  );
