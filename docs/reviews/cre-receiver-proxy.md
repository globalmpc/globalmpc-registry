# CRE Receiver proxy

Target: BSC Testnet97. Deploy a UUPS ERC1967 proxy using the existing dev deployer
and admin. The5611 anchor and historical records remain unchanged.

| Boundary | Authority / time | Scope and result |
| --- | --- | --- |
| Initialize | Atomic proxy constructor call, once | Set code-bearing forwarder, admin, TTL and optional workflow binding; implementation initialization is disabled |
| Unregistered workflow | Both workflow ID and owner absent | Reject every report until the owner supplies both nonzero values; never accept zero metadata |
| Configure workflow | Current two-step owner | Change live workflow ID/owner together; prior observations and sequence ordering remain |
| Report identity | Pinned forwarder plus current workflow ID/owner | Authenticate before decoding; bind signed chain ID and receiver to block.chainid/address(this), the proxy |
| Observation | Registry sequence and signed snapshot | Preserve existing TTL, status, replay, rollback and hash-continuity checks |
| Upgrade | Current owner only, UUPS-compatible implementation | Proxy address and stored observations/configuration must survive; an unrelated caller cannot upgrade |
| Network | Explicit chain97 or isolated31337 | Deployment refuses5611/56; CRE chain/RPC configuration is separate from the unchanged anchor chain |

Acceptance: real proxy initialization, closed bootstrap, authorized configuration,
negative authorization/domain tests, upgrade preserving stored reports and replay
protection, and confirmed on-chain deployment/code/storage when gas is available.
Run full Foundry checks and focused CRE/API/UI tests, then CI. Independent human
security review remains required before merge; explicit user authorization covers
testnet deployment. The dev key is read from the ignored original .env.dev only.

Verification before deployment: 108 Foundry tests (including fuzz/invariants),
4,092 application tests with unchanged coverage thresholds, root and CRE SDK
typechecks, 16 isolated-database CRE API tests, real-proxy local API/Forwarder PoC,
4 telemetry smoke tests, OpenAPI generation and brand checks passed.
Initial setup retries resolved missing Foundry submodule/remapping and script-path
errors; no transaction was broadcast during those failures. CDK dependency fetch
timed out at the private package registry, so CDK compilation remains unverified.
Changed Solidity is formatted; an unrelated existing interface formatting issue
was left unchanged. Independent human security review and CI remain pending.

Deployment verified on BSC Testnet97: both transactions confirmed, exact runtime
bytecode matched tested artifacts, ERC1967 implementation slot, owner, Forwarder,
TTL, ERC165 support and implementation initialization lock verified. Read-only
on-chain simulation from the Forwarder rejects zero workflow metadata.
First broadcast was rejected before submission for a below-minimum RPC gas tip;
zero receipts/pending transactions were confirmed before retrying with explicit
legacy 1 gwei gas price. Both deployments then succeeded. No live CRE/DON run has
been performed; workflow registration and owner binding remain required.

## PR139 review correction: CRE RPC credentials

| Identity / case | Authority / state | Scope / priority |
| --- | --- | --- |
| CRE_CHAIN_RPC_URL configured | Trusted deployment input; live API setting | Secret reference in API only; never plain ECS environment, web or workers |
| CRE_CHAIN_RPC_URL absent | Existing API fallback rules | Omit optional secret; no new deployment requirement |

Expected correction: preserve CRE delivery behavior while keeping provider credentials
out of ECS task definitions. Verify rendered task definitions for credential-bearing
URLs and absent configuration; inspect existing CI for the updated revision.

## Reported public PR74 maintainability warnings

The duplicate standalone `.footer-inner { flex-wrap: wrap; }` is already absent
from PR139's base; wrapping remains in the base rule and the mobile media query
only adjusts gap. No additional CSS change is needed. WorkspaceShell now separates
route/session context, guarded project fetching and section-route matching into
small helpers. Navigation labels, destinations, permission filtering, identity
isolation, stale-response guards and route-change dismissal are preserved.

Final focused verification: 19 existing navigation/reference-experience tests and
web typechecking passed. Self-review compared fetch dependencies, identity guards
and all active-route aliases against the preceding implementation. No link names
or locations changed. CodeFactor has not yet measured this updated revision; CI
and external complexity confirmation remain pending.
