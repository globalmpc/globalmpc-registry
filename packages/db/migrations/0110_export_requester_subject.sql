-- Project exports name their requester by subject only — account authentication WP1.
--
-- `requested_by_wallet` recorded the wallet the requester signed in with. A requester now signs in
-- with an account, not a wallet, so new jobs leave it empty; `requested_by_subject_id` (already
-- required since 0067) is the requester. Jobs written before keep the wallet they recorded.

ALTER TABLE core.project_exports ALTER COLUMN requested_by_wallet DROP NOT NULL;
