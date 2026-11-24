# Development demo data

Development deployments run an additive seed task **after** migration and service deployment.
It supplies the original three synthetic projects (input pending, reviewed evidence and published evidence),
plus five published examples with evidence coverage at stages 1–5.
The seed gives each scenario a fictional mine name and mineral. Published keys remain permanent. After
migration 0138, a completed v1 demo can receive project-bound coverage definitions and one new
assessment. A later deploy also resumes an unfinished seed; new demo versions use new keys.

| Case | Authority / time | Input scope | Outcome / priority |
| --- | --- | --- | --- |
| Environment | Deployment configuration and chain ID | `develop`, opBNB testnet 5611 only | Refuse other environments before connecting to storage or DB |
| Owner | Configured owning organization in the Registry | Existing Registry; no real account is created or changed | Ambiguous or missing owner fails closed |
| Scenario identity | Stable v1 project key and seed audit markers | Seed-owned project only | Preserve user edits and revocations. Only untouched legacy fixture identities qualify for a profile correction. |
| Partial run | Registry-wide advisory lock, committed start marker | Generated quarantined document | Resume after actual scan worker success; infection or timeout fails the seed task |
| Incomplete scenario edited by a user | Locked project and restriction scope | Project metadata, claims, documents, facts and restrictions | Stop without adding reviews or publication; only untouched partial fixtures resume |
| Review | Explicit synthetic fixture with a fresh, discarded signing key | Demo claim only; separate fixture identities, no login methods or role grants | Store a cryptographically signed simulation, never an official-source confirmation or human approval |
| Publication | Canonical hashing and current project identity | Public synthetic projection and mandatory limitations | Keep published payloads, assessment dates, hashes and anchor proofs immutable. Link metadata corrections as successor versions. |
| Chain | Existing API anchor request and anchor worker | Published versions selected by the service | Seed requests no anchor and holds no funded signing key |

The migration owner creates labelled **fixture records**, not real professional approvals.
The fixture people have no email, passkey, session or roles. No authentication bypass or test
support function is installed. No existing mining policy, claim catalog version or authority is changed. New catalog versions
and the synthetic stage policies are bound to the exact seed-owned demo project. They
cannot apply to another demo or a normal project.
The generated document is plain text and still goes through the deployed scan worker.

`DEMO-V1-INPUT-<ns>`, `DEMO-V1-REVIEW-<ns>`, and `DEMO-V1-PUBLIC-<ns>`
and `DEMO-V1-STAGE-1-<ns>` through `DEMO-V1-STAGE-5-<ns>`
are reserved for this seed. `<ns>` is the suffix of an existing seeded `DEMO-V1-INPUT-` project —
seeds before 0169 used the deployment's then-only tenant UUID, so a rerun recognises them — or
`registry` on a Registry seeded afresh. A collision with an existing non-seed project is an error.
The owner organization must already exist. Set `DEMO_OWNER_ORGANIZATION_NAME` when there is more than one operator organization.

The CI task must stop on task launch failures, missing exit codes, scan failures and timeouts.
A seed failure fails its CI step; it does not roll back services that were already deployed.
Task logs contain scenario keys and counts, not database URLs, signing keys or personal data.

The application change supplies `docker/seed-demo-task.sh`, the seed CLI, and dev-only object
permissions on the existing migration task. The companion manager change is
`projects/mpc/globalmpc-registry-private/deploy.yaml`: after service deployment it runs
`scripts/ops/run-dev-demo-task.py` only for `develop`. The existing deploy role already launches
the same task family for migrations; no new CI administrator credential or funded key is needed.
The generated shared workflow must be released before automatic seeding takes effect. Its file
guard permits releasing that workflow before rolling out an application version with the seed.

Public publication and blockchain anchoring are separate. A user requests an anchor in the
workspace; the API creates the Merkle batch, then the anchor worker submits and confirms it.
The seed does not create batches, move chains, change spend caps or submit transactions.

## Project stages and evidence coverage

The roadmap always shows the five supported stages: Exploration, Resource definition,
Feasibility, Permitting and Production. Evidence coverage belongs within each stage;
it is not a signed gate decision or a declaration that the project has reached that
stage. Stages absent from the assessment show Not assessed. The prototype's eight-stage
vocabulary is not adopted; the existing evaluator stage IDs and order are preserved.

Migration 0138 keeps normal definitions global and permits project-bound definitions only for
an original synthetic demo. Their project scope and reviewed catalog content are immutable.
The private evaluator and public current-warning comparison share the same stage-policy selector.
Catalog entry selection, claim writes, readiness requests and signing policy versions enforce
that scope too. General catalog lists do not include demo-only definitions.

The existing dev seed task adds a labelled exploration requirement and computes a new ledger
assessment using the normal evaluator. Fresh input is `0/1`; fresh reviewed/public fixtures are
`1/1`. No production-stage rules, gate approval, lifecycle advance or anchor is synthesized.
The task logs newly assessed project keys in `assessed`, separately from created/skipped projects.
The coverage seed runs once per project and does not override subsequent human policy changes.

Completed older demos receive numeric coverage without changing their old claims, signatures or
published versions. Their unstructured claims were never pinned to the new catalog, so they
remain `0/1` until new catalog-bound evidence is entered and reviewed. The seed does not relabel
old signatures as approving new evidence. Use the normal **Refresh progress** action after later
changes. Existing published snapshots remain frozen.

Deploy the matching API/web with migration 0138, then run the existing dev demo task. No new
GitHub Manager setting or secret is required. Production/staging remain refused by the seed.

Do not seed scoped rows while an old API or worker is still serving. A source-only rollback
to code that ignores project scope is unsafe; restore the pre-upgrade database or retain
scope-aware consumers. The seed does not run as part of schema migration or service startup.

The five stage examples use project-bound synthetic requirements and the real evaluator.
Each has one synthetic reviewed item; later stages require a grade that this item does not
meet. The resulting public snapshot, not a UI override, supplies the five-segment progress bar.
These are evidence coverage examples, not real mine progress or signed gate decisions. Existing
published versions without coverage remain unchanged; the new examples are separate projects.

## Document-rich examples

Development seed tasks also opt into `DOCUMENTS-1`, `DOCUMENTS-3` and `DOCUMENTS-5`.
These are new projects: each contains 20 synthetic text documents and 20 catalog-bound
review items, grouped as four requirements per supported stage. They cover licences,
geology, drilling, assays, feasibility, permitting and operational reports. Projects
have respectively 4, 12 and 20 reviewed items; remaining documents are present but
have no synthetic professional sign-off. Every upload must receive a clean scan
before promotion. The normal evaluator supplies their stage 1, 3 and 5 coverage.

A completed legacy project receives a new profile only if its owner, original name, mineral,
country, lifecycle and version still match the seed. Restrictions and publication drafts take
precedence. For a public project, the seed checks the original published version, audit marker
and content hash, then appends v2 under the same key. It copies the previously public snapshot,
including its original assessment date and document titles. It does not publish private updates
or carry an earlier version’s proof forward. The task reports corrected keys in `updatedProfiles`. Existing links and v1 proofs still resolve. Completed document examples
are skipped on retry; untouched incomplete examples resume their quarantined uploads.
The fixtures publish only labelled synthetic assessment metadata, never repository
internal documentation or private originals. No real mining documents were found in
the first-party seed assets, so document bodies are generated illustrative text.

The dev seed CLI accepts `DEMO_INCLUDE_DOCUMENTS=false` to omit the document-rich
examples (default `true`). `DEMO_SCAN_TIMEOUT_MS` controls each scenario's scan wait
(default 240000 ms; integer range 1000–240000). Invalid settings fail before seeding.
A timeout remains a visible failure and the next run resumes; it is not reported as
successful seeding. Repeated runs preserve completed profiles.

The CI task waiter allows up to six ten-minute windows for a fresh seed across
all eleven scenarios (at most 44 minutes of scan waiting at the configured cap).
Only waiter exhaustion is retried; AWS errors stop the owned task immediately.
