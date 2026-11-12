# CRE dev workspace decision record

| Case | Authority and identity | Frozen/live state | Input and priority |
| --- | --- | --- | --- |
| View reports | Existing cre.report permission, tenant + project scope | Persisted observations | Same read permission as report generation; deny anonymous, other tenant/project |
| Generate observation | Existing operator/steward/cre_reporter policy | Approved public version/hash frozen, health live | Existing POST and idempotency; no publication or MFA bypass |
| Inspect receiver | Authorized project, configured chain RPC only | Live contract read | Address must belong to this project's recorded report on configured chain; no caller-supplied RPC |
| Report vs delivery | Database is authority for generation; receiver for chain state | Never infer delivery from a generated report | RPC errors mean unknown; compare all ABI fields before calling a report matched |
| Chain | Exact allowlisted chain/name pairs | Report chain and receiver bound | 31337 local,97 BSC Testnet or5611 opBNB testnet; reject mismatches/mainnet |

Acceptance: project navigation exposes CRE; operator sees publication prerequisite, creates an observation for configured chain and receiver, can refresh durable report history and check receiver state. UI never calls report generation a CRE execution or chain delivery. Credentials stay in HttpOnly cookies or CRE secret storage, never configuration downloads. Independent human security review is required before merge.

External prerequisites remain: deployed receiver with real forwarder/workflow identity, CRE platform capability for 5611, service credential with cre_report scope, and a Registry endpoint reachable by the executor. Receiver proxy deployment is documented in `contracts/README.md`; exposing the API and live CRE execution are separate operations.
