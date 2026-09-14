# Security Policy

## Reporting a vulnerability

**Do not open a public issue, pull request, or discussion.** Report privately through
**Security → Report a vulnerability** (GitHub private vulnerability reporting) on this repository.

Please include:

- affected component and commit
- reproduction steps (minimal input)
- expected impact

We will follow up inside the advisory. Please keep details private until a fix is released.

## Scope

| In scope | Path |
|---|---|
| Smart contracts | `contracts/src/` |
| API · Web · Worker | `apps/` |
| Shared packages | `packages/` |
| Deployment configuration | `Dockerfile`, `docker-compose.yml`, `deploy/` |

Out of scope:

- `contracts/lib/` — vendored third-party libraries (OpenZeppelin, forge-std). Report upstream.
- `deploy/local-secrets/` — publicly known local-only defaults (anvil default account key, MinIO default credentials).

## Supported versions

Only the latest commit on `main` is supported.
