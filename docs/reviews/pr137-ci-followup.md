# PR 137 CI follow-up

Reviewed run 42978108945 at application HEAD 79ef308f.

| Failure | Evidence | Response |
| --- | --- | --- |
| Browser golden path | Both attempts timed out at golden-path.spec.ts:224 waiting for disabled Recompute; other complete specs seed additional stage/publication policies | Explicitly select the seeded publication policy on both Readiness and Gate Decision pages; retain the multi-policy UI requirement |
| Database/coverage | Five test timeouts, one 10s fixture-hook timeout, and a later registry assertion containing a late chain-204 entry after a timed-out test; 4,089 tests passed, six failed and two skipped | Investigate under coverage and rerun on stable source; do not weaken timeouts, assertions or coverage floor |
| CodeQL JavaScript | Query process killed with exit 137; job memory.events oom_kill increased from 0 to 1 and host swap was exhausted | Confirmed runner OOM, not a reported code vulnerability; rerun without reducing analysis scope and inspect results |

The browser fix only selects the policy intended by the existing scenario. It
changes no production behavior, privileges, signed decisions or fixture policies.
The prior narrow six-scenario run omitted the earlier evidence-ledger spec that
adds a stage policy; it therefore did not establish shared-fixture order safety.
Verification now includes those complete specs together with the policy-selection
spec, against the built-server mode used by CI. The full failed browser shard is
then checked by CI. No arbitrary first-policy fallback is added to production.

The DB timeouts establish incomplete verification, not a confirmed application
regression or a proven infrastructure root cause. The late registry entry is
consistent with timed-out asynchronous test work continuing into the next test;
the original timeout must be resolved before interpreting that assertion alone.
