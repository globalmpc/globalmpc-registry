# `@mpc/cre-workflow` — Registry → Chainlink CRE proof of concept

A TypeScript Chainlink CRE workflow built on the official `@chainlink/cre-sdk` **1.23.0**
(pinned). It uses the Cron, HTTP, consensus, signed-report and EVM capabilities. The only
configured chain is local Anvil (chain 31337); the workflow rejects every other chain.
It runs on a CRE DON, not on our servers, so it lives under `packages/` as a deployable
artifact (see the placement rule in `CONTRIBUTING.md`). Request and report shapes come
from `@mpc/api-contract/cre`, the same schemas the API route uses.

This replaces the earlier standalone Go workflow (`cre-sdk-go` 1.21.0). It keeps the Go
workflow's behaviour; the differences are listed under [Changes from the Go workflow](#changes-from-the-go-workflow).

**Status: proof of concept. Live CRE execution has never been verified.**

## What the workflow does

The cron handler relays already-observed Registry status through the authenticated project
API using ordinary `source.collect` authorization. Source collection runs separately through
the existing authenticated collection API **before** relay. That avoids duplicate side effects
and in-flight idempotency conflicts between DON nodes. Failed source lookups create Registry
receipts and can become an unavailable status. An API transport failure aborts relay instead
of inventing a status. No role or publication bypass is installed. CRE cannot create positive
expert reviews or approve a publication.

1. Validate the configuration (again, in the handler) and the scheduled trigger time.
2. Derive one idempotency key from the **scheduled trigger time**, the configured record and
   domain, and the complete request body (including TTL). The workflow never reads a clock.
3. Fetch `REGISTRY_BEARER_TOKEN` in DON mode. A missing or malformed secret stops the run
   before any HTTP call.
4. In node mode, `POST` the report request with a 10-second timeout and caching off, validate
   the response strictly, and return canonical JSON.
5. Reach exact (identical) consensus on that canonical JSON, validate it again, ABI-encode it
   and only then request a signed report.
6. Write the report to the receiver. Success requires `TX_STATUS_SUCCESS`, a successful
   receiver execution and a 32-byte transaction hash.

The Registry report API owns the durable sequence and observation clock. Health and
`observedAt` share one post-lock evaluation clock; `validUntil` is derived from that time.
A slow evaluation that spends its TTL returns retryable `503 CRE_OBSERVATION_EXPIRED`
without persisting a report or an idempotency reservation. A failed execution may retry the
same key for a new assessment. Repeated node requests retrieve the same report instead of
generating timestamps or consuming sequence numbers. A previously issued report expires at
`validUntil`, so consumers must check freshness when reading it.

## Configuration

`config.example.json` holds every field; unknown fields (including the rejected
`collectUrl`/`collectBody`) fail the configuration.

- `reportUrl` must be HTTPS and must be exactly
  `/api/v1/projects/<uuid>/cre-reports`. `allowLocalHttp: true` permits HTTP **only** for
  literal `127.0.0.1`, `localhost` or `[::1]` in the isolated demo. User info, query strings
  (including a bare `?`), fragments, percent-encoding, dot segments and ports outside
  1–65535 are rejected. The CRE HTTP capability does not follow redirects and the workflow
  rejects non-2xx responses, so configure a direct endpoint.
- `chainName`/`chainId` must be `anvil-devnet`/`31337`; the receiver must be a nonzero
  20-byte address and is canonicalised to lowercase.
- `ttlSeconds` is 1–3600, `gasLimit` a positive uint64, `schedule` 1–100 UTF-8 bytes and
  `publicKey` 1–200 UTF-8 bytes. The configuration document is at most 16 KiB and must be a
  single JSON document.

## Tests and build

```sh
pnpm --filter @mpc/cre-workflow test        # also part of `pnpm test:unit` and coverage
pnpm --filter @mpc/cre-workflow typecheck   # TypeScript 5.9 (what cre-compile uses)
pnpm --filter @mpc/cre-workflow build:wasm  # needs Bun >= 1.2.21; not run in CI
```

The tests use the SDK's own test runtime (`@chainlink/cre-sdk/test`) with its HTTP and EVM
capability mocks, so they exercise the real handler, secret lookup, node-mode request,
identical consensus, report generation and delivery outcomes. The SDK harness imports
`bun:test`; `vitest.config.ts` aliases it to Vitest and the root Vitest config extends that
file. These tests do not prove execution on a DON or a real forwarder transaction. The
separate contract tests cover receiver identity, replay and freshness.

Typecheck runs three projects. `tsconfig.src.json` checks `src/` **without Node types**, so
only the globals the CRE runtime provides (declared by the SDK) type-check and Node APIs such
as `fetch`, `setTimeout`, `process` or `node:fs` fail; `test/node/runtime-types.test.ts`
proves that. `tsconfig.json` checks the SDK-harness tests with Node types, and `test/node/`
holds Node-only tests (including the zod audit-exception lockfile guard) that import nothing
from the SDK.

`build:wasm` runs the SDK's `cre-compile`, which typechecks the workflow, checks runtime
compatibility and determinism, bundles with Bun and compiles to WASM with Javy. Bun is not a
repository dependency: install Bun **1.2.21 or newer** separately. The output
`dist/workflow.wasm` is ignored. `cre-compile` loads the TypeScript compiler API, so
`pnpm-workspace.yaml` links this package's TypeScript 5.9.3 into the SDK; the root
TypeScript 7 has no JavaScript API.

`cre-compile` fetches the Javy compiler on first use (`v8.1.0` from the
`bytecodealliance/javy` GitHub releases, via the SDK's Javy plugin). The SDK checks the
download against the `.sha256` file published **in the same release**, not against a hash
pinned in this repository, so it guards against corruption rather than a compromised
release. It then reuses `~/.cache/javy/<version>/` without checking again. Treat
`build:wasm` as a local, developer-machine build only; do not run it in CI or use its
output for deployment without verifying the Javy binary independently.

## Local CRE simulation (not yet performed)

Install the [official CRE CLI](https://docs.chain.link/cre/getting-started/cli-installation/macos-linux).

1. Start an isolated Registry API and Anvil. Deploy the receiver with its forwarder and
   workflow identity restrictions intact.
2. Copy `config.example.json` to `config.local.json` (ignored) and set the project ID,
   approved public key and deployed receiver. Collect the source via
   `POST /api/v1/source-connections/:connectionId/collect` with the ordinary
   `{projectId, queryBasis}` request and wait for its receipt before relaying.
3. Provide `REGISTRY_BEARER_TOKEN` for an ordinary authorized Registry actor and
   `CRE_ETH_PRIVATE_KEY` for an **isolated local test account** through the environment or
   an ignored `.env`. Never commit real credentials.
4. The CLI requires a Chainlink account login or `CRE_API_KEY`, even for local simulation.
   With that access, from this directory (`workflow.yaml` points at `./src/main.ts`):

```sh
cre workflow simulate . --target local --config config.local.json --non-interactive
```

Without `--broadcast` no transaction is broadcast. Local-chain broadcast needs the forwarder
and workflow metadata that the receiver expects; never disable receiver identity checks to
make a simulation pass. No DON deployment, paid execution or public-chain transaction is part
of this proof of concept. The CLI layout and command above have not been run against this
package.

## Report protocol

Request: `POST /api/v1/projects/:projectId/cre-reports`, Bearer authentication,
`Content-Type: application/json`, `Idempotency-Key` header, JSON body
`{publicKey, chainId, receiver, ttlSeconds}` with a lowercase receiver.

The response must contain exactly these nine fields (at most 16 KiB). Unsigned integers are
decimal strings except `status`, a JSON integer:

```text
(uint256 chainId, address receiver, bytes32 recordId, uint64 registryVersion,
 bytes32 contentHash, uint64 observedAt, uint64 validUntil, uint64 sequence, uint8 status)
```

This static tuple encodes to 288 bytes, as `contracts/src/RegistryStatusReceiver.sol`
requires. `recordId = keccak256(UTF8("mpc-registry:project:" + publicKey))`. Chain, receiver
and record identity must equal the configuration before signing; the content hash must be
nonzero lowercase hex; `0 < validUntil − observedAt ≤ ttlSeconds ≤ 3600`. Status values
1–5 are passed through unchanged and never invented: 1=current observation,
2=needs-review, 3=revoked, 5=unavailable; 4 is reserved by the receiver and not emitted by
the API. `validUntil` is a transport deadline, not a licence or professional-approval expiry.

Anvil's chain selector is the official registry value `7759470850252068959`.

### Idempotency key

`cre-<keccak256(json)>-report`, where `json` is the array
`[reportUrl, publicKey, chainId, lowercaseReceiver, ttlSeconds, "<seconds>", nanos]`
serialised with **Go `encoding/json` escaping** (`<`, `>`, `&`, U+2028 and U+2029 written as
`\u00xx`/`\u2028`/`\u2029`). Replicating Go keeps the key space identical to the previous
workflow, so a scheduled run retried across the migration reuses the same Registry
reservation instead of creating a second report. `test/golden.test.ts` pins vectors captured
from the Go workflow. Strings containing lone UTF-16 surrogates have no UTF-8 form and are
rejected in the configuration rather than hashed differently from the API.

## Changes from the Go workflow

- HTTP timeout is 10 seconds (the CRE capability maximum) instead of 20.
- Every error is a fixed message. Thrown HTTP, secret, consensus, signing and EVM capability
  errors are replaced, because node-mode errors are forwarded to consensus and logs. No
  credential, response body or transport error text reaches an error or log.
- Validation is equal or stricter: the report receiver, record ID and hashes must already be
  lowercase (the API contract emits only lowercase); configuration field names are
  case-sensitive; the URL scheme must be lowercase; hosts must be plain DNS/IPv4 names or a
  bracketed IPv6 literal that the WHATWG URL parser accepts; an empty port (`host:`) and
  dot segments are rejected; `allowLocalHttp` must be a boolean when present. A JSON number
  written as `2.0` for `status` is accepted as `2` (Go rejected it); the canonical consensus
  JSON is identical either way.

## Licence

`@chainlink/cre-sdk` is licensed under the **Business Source License 1.1**, not an
open-source licence. Its Additional Use Grant reads "Any uses listed and defined in this
repository", but the SDK repository lists and defines no such uses, so whether production use
is granted is ambiguous. The licence converts to MIT on the Change Date, **20 May 2029** (or
four years after a version's first publication, if earlier). The maintainers accepted this
ambiguity for this proof of concept; reassess it before any production deployment. A built
`dist/workflow.wasm` contains SDK code and is subject to that licence. This repository does
not relicense upstream code.

## Verification boundary

Local evidence: SDK-harness tests of the handler and protocol, Go golden vectors, typecheck
and a local `cre-compile` WASM build. DON consensus, deployed forwarder metadata, external
chain delivery, CLI simulation and operating costs remain unverified. Report contract checks
and the SDK test harness separately from any live CRE evidence.

Official references:

- [TypeScript SDK](https://github.com/smartcontractkit/cre-sdk-typescript)
