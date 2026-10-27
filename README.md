# MPC Registry

[![Build and coverage](https://github.com/globalmpc/globalmpc-registry/actions/workflows/public-quality.yml/badge.svg?branch=main)](https://github.com/globalmpc/globalmpc-registry/actions/workflows/public-quality.yml)
[![CodeFactor](https://www.codefactor.io/repository/github/globalmpc/globalmpc-registry/badge)](https://www.codefactor.io/repository/github/globalmpc/globalmpc-registry)
[![App coverage](https://img.shields.io/codecov/c/github/globalmpc/globalmpc-registry/main?flag=app&label=App%20coverage)](https://app.codecov.io/gh/globalmpc/globalmpc-registry)
[![Contract coverage](https://img.shields.io/codecov/c/github/globalmpc/globalmpc-registry/main?flag=contracts&label=Contract%20coverage)](https://app.codecov.io/gh/globalmpc/globalmpc-registry)
[![CodeQL](https://github.com/globalmpc/globalmpc-registry/actions/workflows/public-codeql.yml/badge.svg?branch=main)](https://github.com/globalmpc/globalmpc-registry/actions/workflows/public-codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/globalmpc/globalmpc-registry/badge)](https://scorecard.dev/viewer/?uri=github.com/globalmpc/globalmpc-registry)

MPC is developing infrastructure for mining real-world assets (RWAs).

This repository contains the evidence registry and review workspace for that project,
with **BNB Smart Chain (BSC)** as its intended production network. Project teams organize
supporting evidence, reviewers sign their findings, and approvers decide which records
can be published. A public Explorer lets readers inspect published records and their proofs.

**Status:** In development. Contracts have not been deployed on BSC mainnet or testnet.

## Technology Stack

- **Blockchain:** BNB Smart Chain; local Anvil for development.
- **Smart contracts:** Solidity 0.8.28, OpenZeppelin 5.6.1.
- **Frontend:** Next.js, React, TypeScript, viem.
- **Backend:** Fastify, PostgreSQL, S3-compatible storage, ClamAV in a separate scanner container.
- **Development:** Foundry 1.8.5, forge-std 1.17.0, pnpm 10.33.0.

## Supported Networks

- **BNB Smart Chain Mainnet (Chain ID: 56)** — intended production network; deployment pending.
- **Local Anvil (Chain ID: 31337)** — development and automated testing.

## Contract Addresses

| Network | Contract | Address |
|---|---|---|
| BNB Smart Chain Mainnet | RegistryAnchorV1 | Not deployed |

Local contract addresses are created during development and CI runs. They are not BSC
addresses. The mainnet address and BscScan verification link will be added after deployment.

## BNB Chain Configuration

BNB Smart Chain is set as the target network in these files:

- [`apps/api/src/config.ts`](apps/api/src/config.ts) — `CHAIN_ID` accepts only 56 (BSC mainnet)
  or 31337 (local chain); any other value stops the API at startup.
- [`apps/api/src/bootstrap.ts`](apps/api/src/bootstrap.ts) — applies the same 56-or-31337 rule
  when the registry is initialized.
- [`contracts/foundry.toml`](contracts/foundry.toml) — declares a `bsc` RPC endpoint read from
  `BSC_RPC_URL`.
- [`docs/operations/mainnet-contract.md`](docs/operations/mainnet-contract.md) — the BSC mainnet (Chain ID 56)
  deployment procedure and the decisions it waits on.
- [`.env.example`](.env.example) — defaults to the local chain (31337) for development.

## Current Features

- **Project workspace:** register mining-asset projects and organize documents, source
  receipts and supporting claims.
- **Review and approval:** wallet authentication, signed evidence reviews, readiness
  assessments and separate human approval decisions.
- **Registry publication:** versioned public records with revocation and supersession history.
- **On-chain proof workflow:** Merkle batching, anchor submission, confirmation tracking
  and inclusion proofs, exercised on the local chain.
- **Explorer and audit:** inspect published records, verify proofs and trace recorded actions.

The workflow is:

`Project registration → Evidence → Signed review → Approval → Publication → Anchor → Public proof`

Anchoring proves that a published record was included in a batch. It does not independently
verify the underlying mining asset or confer ownership or regulatory approval.

## Run Locally

Requires a patched Node.js release: 22.23.4+, 24.22.1+, or 26.12.1+ within the supported release lines; pnpm 10.33.0, Foundry 1.8.5 and Docker Compose. Docker and CI use Node.js 22.23.4, which includes the October 2026 eMudhra CA security fix.

```bash
pnpm install --frozen-lockfile
git submodule update --init --recursive
docker compose -f docker/docker-compose.yml up --build
```

Open **http://localhost:3000**. Compose starts the web app, API, background workers,
PostgreSQL, object storage, file scanner and local Anvil chain. The initial stack has no
published project records or deployed anchor contract.

See the [deployment guide](docs/operations/deployment.md) for configuration locations,
secret injection, observability and worker operation. The same guide links the backup,
restore and release rollback procedures.

## Next Steps

- Complete staging validation and production configuration.
- Deploy and verify RegistryAnchorV1 on BNB Smart Chain mainnet.
- Record the deployed address and verification link above.

Asset token issuance, trading and custody are outside this registry's current functionality.
