# Document-rich development fixtures

Expected journey: anonymous visitors open a new synthetic project and see named
review items for actual uploaded synthetic documents. Four items belong to each
stage; review coverage differs between stage 1, 3 and 5 projects.

| Identity / authority | State and input scope | Decision |
| --- | --- | --- |
| Deployment owner and configured tenant | Develop / chain 5611 | Existing owner guard and withTenant apply |
| Original and completed fixtures | Frozen published versions | Preserve records, signatures and user edits |
| New DOCUMENTS projects | Seed-owned stable IDs and audit markers | Add 20 scanned uploads and catalog-bound claims per project |
| Unreviewed document | Uploaded and promoted without attestation | Normal evaluator reports unmet review requirements |
| Public representation | Explicit synthetic public catalog/assessment | Publish review metadata, no private originals or storage keys |
| Retry | Existing untouched quarantined uploads | Resume scan; completed marker prevents duplicate publication |

Focused DB-backed seed tests exercise the scanner callback, all three public API
responses (20 items each, 4/12/20 reviewed), computed stages, no duplicate publication,
and exact preservation of older published rows. These run with a NOBYPASSRLS
non-superuser owner fixture as required by the existing deployment seed contract.
No schema or application authorization changes. Existing original fixture tests
remain in scope. UI layout is unchanged; browser review of the richer data remains
a separate verification step. Initial API typecheck exposed fixture typing errors under reused dependencies.
A clean frozen-lockfile installation resolved these; API typecheck and all nine
DB-backed seed tests passed again. CI and live deployment evidence remain pending.
