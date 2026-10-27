# Registry source observations and CRE proof of concept

This development proof of concept connects our Registry API to CRE and a separate external
status consumer. It needs no government API: source-change detection is a separate optional
upstream feature, exercised with a mock source. CRE remains a technology candidate; this work
does not change the November MVP dates or authorize a production deployment.

## Decision basis

| Case | Authority and scope | Result |
| --- | --- | --- |
| First successful source observation | Tenant/project/connection/exact query | Establish a comparison baseline; do not create a professional review |
| Same source response | Same scope and successful baseline | Retain the existing evidence state |
| Changed response or a recognized missing record | Claims bound to earlier receipts in that exact scope | Require re-review; do not automatically revoke a public record |
| Source unavailable or unrecognized response | Observation outcome only | Preserve the successful baseline; never interpret failure as record absence |
| Published version and live warning | Disclosure-approved immutable content plus current health | Preserve the version/hash and report adverse current state separately |
| Unpublished or unrelated project | Existing application authorization | Reject report generation |
| Valid CRE report | Pinned forwarder/workflow, destination chain and receiver, record identity | Accept a strictly newer observation; reject replay, stale data and version/hash rollback |
| No fresh report | Consumer transport validity window | Stop treating a cached positive status as current |

The source identity, source response and CRE execution do not establish legal validity,
professional approval or investment suitability. Positive review and publication retain
their existing human permissions. The receiver performs no token or financial action.

## Scope

Use the existing authenticated source collector and its source-access/SSRF protections.
Store append-only observations and propagate relevant changes through existing stale
evidence handling. An authenticated report request returns only public record identity,
approved version/hash and bounded current status. Its idempotency key fixes the response
across the nodes participating in one CRE execution.

The CRE workflow requests a report, then writes the encoded report to an isolated consumer.
Source collection runs separately using the existing authenticated API. Combining collection
with a report inside every DON node would race the collector's in-flight reservation and
could prevent adverse-state delivery when collection fails. The relay observes stored
Registry health independently of collection availability.

It never changes RegistryAnchor or approved Merkle roots.
Mock source, local chain, capability tests, CLI simulation and real DON deployment are
separate verification claims. No live authority integration is claimed without its access
and usage conditions, and no DON deployment is claimed without platform access.

## Status and freshness

| Value | Meaning |
| --- | --- |
| 1 | A current observation of an approved public version with no reported health warning |
| 2 | Re-review required, including current evidence invalidation or suspension |
| 3 | The selected public version has been revoked |
| 4 | Reserved receiver status for a future explicitly supported business-expiry report; the current API does not emit it |
| 5 | Current health cannot be established, including a missing approved ledger or unavailable relevant source |

`observedAt` is the whole-second value of the same post-lock clock used to evaluate health,
not the later response time. If evaluation has already spent the requested TTL, the API
returns retryable `503 CRE_OBSERVATION_EXPIRED` and rolls back the report and idempotency
reservation; retrying that key can produce a new assessment. `validUntil` is the transport observation's
TTL, not a mining licence expiry or an invented professional-approval period. Status 1 does
not establish a passing stage, professional approval, legal validity or factual truth. Changes
after observation can remain unseen until the next report or TTL expiry. The consumer's
`isCurrent` checks both the reported status and that transport deadline.

Reports bind the destination chain, receiver, public record key, approved version/hash,
observation time and a per-project sequence. A single execution's idempotency key returns
the same stored report on concurrent requests and retries, even if its TTL later expires.
Use a new scheduled execution to observe changed state. Fresh reports cannot roll back a
version or change the content hash of the same version. They can carry an adverse state
without changing the approved bytes or waiting for another publication approval.

Source comparisons currently compare successful response hashes conservatively. Formatting
changes can therefore require review; this is not a field-specific semantic-diff engine.
Source failures never become proof that a record was withdrawn. The pre-existing connection
health policy may require an authorized reconciliation after an outage; observation recovery
does not silently reactivate a connection or clear a human review requirement.

## Trust and deployment boundary

The report API retains normal session, project authorization, tenant isolation, auditing and
idempotency. Only the flat public status fields cross the relay; source documents, query
identifiers, tenant IDs, reviewer identities and credentials do not enter the contract report.
The dedicated consumer pins the trusted forwarder, workflow ID and workflow owner, then checks
the destination, sequence, version/hash continuity and TTL. A trusted workflow can still report
incorrect data: neither these checks nor CRE establish the source's factual truth.

The workflow is deliberately restricted to Anvil chain 31337. Production CRE credentials,
official source access, BSC rollout, contract authority and legal/data-residency decisions are
separate prerequisites. The official Go SDK is isolated under `integrations/chainlink-cre/`;
its tests/build are explicit local checks, not an added CI workflow. See its README for the
workflow configuration, toolchain and CLI commands.

## Reproduce the local Registry-to-consumer demonstration

Use a supported patched Node release, pnpm, PostgreSQL and Foundry. Create a fresh local
database whose name starts with `cre_poc_`; the script refuses remote database hosts,
other names and connection-query overrides before running migrations. For example, with
the repository's local PostgreSQL already available on port 55432:

```sh
createdb --host=127.0.0.1 --port=55432 --username=postgres cre_poc_registry
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/cre_poc_registry
(cd contracts && forge build)
pnpm exec tsx scripts/ops/cre-registry-poc.ts
```

Put `anvil` on PATH or set `ANVIL_BIN` to its executable. The script starts and stops its
own loopback Anvil instance on an OS-assigned port; it accepts no external RPC. It seeds
synthetic catalog/review fixtures, signs in through the normal API, collects a mock source,
computes a ledger, and publishes with a different authorized disclosure approver. It then
uses actual API reports and transactions to demonstrate current → needs-re-review → revoked,
exact TTL expiry, replay rejection and unchanged approved content hashes.

The local forwarder and professional signatures are synthetic fixtures. This command does
not run CRE or authenticate a DON signature. Test the real Go SDK workflow separately using
the commands in [`integrations/chainlink-cre/README.md`](../integrations/chainlink-cre/README.md).
The official CLI currently requires a Chainlink login/API key even for simulation; without
that access, WASM compilation, SDK capability tests and local consumer transactions remain
distinct evidence rather than a claimed live CRE execution.

The script leaves the isolated database for inspection. After its connections have closed,
remove only the database you created when no longer needed. Never reuse a production database
or relax the consumer's workflow identity checks to make a simulation pass.
