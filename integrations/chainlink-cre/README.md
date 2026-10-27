# Registry → Chainlink CRE proof of concept

This standalone Go workflow uses the official CRE SDK 1.21.0 with its Cron, HTTP,
consensus, signed report and EVM capabilities. Its pinned Go module is independent
of application workspace dependencies. The only configured chain is local Anvil
(chain 31337); the handler rejects other chains.

The cron handler relays already-observed Registry status through its authenticated
project API using ordinary `source.collect` authorization. Source collection runs
separately through the existing authenticated collection API **before** relay.
This avoids duplicate side effects and in-flight idempotency conflicts between DON
nodes. Failed source lookups create Registry receipts and can become an unavailable
status; an API transport failure aborts relay instead of inventing a status. No
role or publication bypass is installed. CRE cannot create positive expert reviews
or approve a publication.

The Registry report API owns the durable sequence and observation clock. Health and
`observedAt` share one post-lock evaluation clock; `validUntil` is derived from that time.
A slow evaluation that spends its TTL returns retryable `503 CRE_OBSERVATION_EXPIRED`
without persisting a report or idempotency reservation, rather than assigning old health a
newer time. A failed execution may retry the same key for a new assessment. All nodes
use one idempotency key derived from the **scheduled trigger timestamp**, configured
record/domain and complete report request body (including TTL). Repeated node
requests retrieve the same report instead of independently generating timestamps
or consuming sequence numbers. Exact consensus on canonical validated JSON precedes
report signing. A previously issued report expires at `validUntil`, so consumers
must check freshness when reading it.

## Build and tests

Use Go **1.26.10 or newer**. The module requires this patched toolchain; Go's standard
automatic toolchain download can install it without changing the global Go version.
The application does not require Bun, a TypeScript SDK or Zod for this workflow.
From this directory:

```sh
cd workflow
go mod download
go test -count=1 ./...
go vet ./...
mkdir -p dist
GOOS=wasip1 GOARCH=wasm go build -o dist/workflow.wasm .
```

The build produces ignored `dist/workflow.wasm` through the actual Go SDK WASI entry
point. Tests use official `testutils.NewRuntime`, HTTP capability mocks and EVM
capability mocks, exercising the real handler, secret lookup, authenticated HTTP
request, deterministic consensus input, exact report ABI and delivery outcomes.
These do not prove execution on a DON or a real forwarder transaction. The separate
repository contract tests cover receiver identity, replay and freshness behavior.

For dependency analysis, install the official Go vulnerability tool outside this
repository and run it from the workflow directory:

```sh
go run golang.org/x/vuln/cmd/govulncheck@v1.9.0 -show verbose ./...
```

The patched toolchain and dependencies are pinned in `go.mod` and `go.sum`.
Do not suppress vulnerability findings or assume the application dependency audit
also covers this separate Go module.

## Local CRE simulation

Install the [official CRE CLI](https://docs.chain.link/cre/getting-started/cli-installation/macos-linux)
(validated here with CLI 1.39.0).

1. Start an isolated Registry API and Anvil. Deploy the receiver with its intended
   forwarder/workflow identity restrictions intact.
2. Copy `workflow/config.example.json` to `workflow/config.local.json`; replace the
   project ID, approved public key and deployed receiver. Collect the source via
   `POST /api/v1/source-connections/:connectionId/collect` using the ordinary
   `{projectId, queryBasis}` request and wait for its receipt before starting relay.
3. Inject `REGISTRY_BEARER_TOKEN` for an ordinary authorized Registry actor and
   `CRE_ETH_PRIVATE_KEY` for an **isolated local test account** through the environment
   or ignored `.env`. Never commit real credentials.
4. The CLI additionally requires an existing Chainlink account login or `CRE_API_KEY`,
   including for local simulation. With that access configured, from this directory:

```sh
cre workflow simulate workflow --target local --config workflow/config.local.json --non-interactive
```

Without `--broadcast`, this does not broadcast transactions. Explicit local-chain
broadcast requires the forwarder and workflow metadata expected by the receiver;
do not disable receiver identity checks to make a simulation pass. No DON deployment,
paid execution or public-chain transaction is part of this proof of concept.

API URLs require HTTPS. `allowLocalHttp: true` permits HTTP **only** for literal
`127.0.0.1`, `localhost` or `[::1]` in the isolated demo. Credentials, query strings,
fragments, encoded paths and unrelated API routes are rejected. The CRE HTTP
capability does not support redirects, and the handler rejects non-2xx responses.
Configure a direct endpoint. HTTP failures expose neither response bodies nor
transport errors containing secrets.

## Report protocol

Request: `POST /api/v1/projects/:projectId/cre-reports`, Bearer authentication,
`Idempotency-Key` header, JSON body `{publicKey, chainId, receiver, ttlSeconds}`.
Receiver addresses are lowercase in both request bodies and idempotency identities.
Collection is separate: `collectUrl` and `collectBody` in workflow configuration
are rejected rather than silently ignored.

The response contains exactly these fields. Unsigned integers are decimal strings
except `status`, which is a JSON integer:

```text
(uint256 chainId, address receiver, bytes32 recordId, uint64 registryVersion,
 bytes32 contentHash, uint64 observedAt, uint64 validUntil, uint64 sequence, uint8 status)
```

`recordId = keccak256(UTF8("mpc-registry:project:" + publicKey))`. Version and content
hash identify an approved immutable public version. Live status is separate:
1=current observation, 2=needs-review, 3=revoked, 5=unavailable. Status 4 is reserved
by the receiver; the API does not invent a business-expiry field or emit it.
`validUntil` is the report's transport deadline, not a licence or professional
approval expiry. A positive observation does not establish a passing stage or
guarantee unchanged health until that deadline. TTL is at most 3600 seconds.
Chain, receiver and record identity must match configuration before
signing. Forwarder transaction success alone is insufficient: receiver execution
must also succeed, and a 32-byte transaction hash must be returned.

Anvil's chain selector is the official registry value `7759470850252068959`.
The Go SDK's EVM capability accepts the selector directly; the included project
configuration maps it to local Anvil. No arbitrary chain selector is accepted.

## Verification boundary

Development validation covers 75 native SDK/protocol test cases across 12 top-level
tests (92.3% native statement coverage), `go vet`, and the real WASI build. The final
Go 1.26.10 plus patched `golang.org/x/sys` 0.44.0 vulnerability scan found no
vulnerabilities at symbol, package or module level.
The actual CLI simulation stopped before execution because no Chainlink login or
`CRE_API_KEY` was configured. DON consensus, deployed forwarder metadata, external
chain delivery and operating costs remain unverified. Contract checks and the
SDK test harness must be reported separately from live CRE evidence.

The upstream Go SDK retains its license in the downloaded module: MIT outside
the specifically identified OCR3 consensus directory, which has BUSL-1.1 terms.
This repository does not relicense upstream code.

Official references:

- [Go onchain report tutorial](https://docs.chain.link/cre/getting-started/part-4-writing-onchain-go)
- [HTTP capability](https://docs.chain.link/cre/reference/sdk/http-client-go)
- [Project configuration](https://docs.chain.link/cre/reference/project-configuration-go)
- [Go SDK](https://github.com/smartcontractkit/cre-sdk-go)
