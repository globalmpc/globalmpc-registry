# Development demo data

Development deployments run an additive seed task **after** migration and service deployment.
It supplies three synthetic projects: input pending, reviewed evidence and published evidence.
Existing completed scenarios are never refreshed, repaired, republished or renamed. A later
deploy resumes only a seed that did not finish. New demo versions use new project keys.

| Case | Authority / time | Input scope | Outcome / priority |
| --- | --- | --- | --- |
| Environment | Deployment configuration and chain ID | `develop`, opBNB testnet 5611 only | Refuse other environments before connecting to storage or DB |
| Tenant / owner | Existing tenant and configured owning organization | Existing workspace; no tenant or real account is created or changed | Ambiguous or missing owner fails closed |
| Scenario identity | Stable v1 project key and seed audit markers | Seed-owned project only | Completed marker wins over current values: preserve user edits and revocations |
| Partial run | Per-tenant advisory lock, committed start marker | Generated quarantined document | Resume after actual scan worker success; infection or timeout fails the seed task |
| Incomplete scenario edited by a user | Locked project and restriction scope | Project metadata, claims, documents, facts and restrictions | Stop without adding reviews or publication; only untouched partial fixtures resume |
| Review | Explicit synthetic fixture with a fresh, discarded signing key | Demo claim only; separate fixture identities, no login methods or role grants | Store a cryptographically signed simulation, never an official-source confirmation or human approval |
| Publication | Canonical hashing and current project identity | Public synthetic projection and mandatory limitations | Insert once; never change a published version, readiness result or anchor |
| Chain | Existing API anchor request and anchor worker | Published versions selected by the service | Seed requests no anchor and holds no funded signing key |

The migration owner creates labelled **fixture records**, not real professional approvals.
The fixture people have no email, passkey, session or roles. No authentication bypass or test
support function is installed. No mining policy, claim catalog or existing authority is changed.
The generated document is plain text and still goes through the deployed scan worker.

`DEMO-V1-INPUT-<tenant UUID>`, `DEMO-V1-REVIEW-<tenant UUID>`, and `DEMO-V1-PUBLIC-<tenant UUID>`
are reserved for this seed. The tenant suffix keeps public keys unique across workspaces. A collision
with an existing non-seed project is an error. The owner must already exist in the scan worker's
tenant. Set `DEMO_OWNER_ORGANIZATION_NAME` when there is more than one operator organization.

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
