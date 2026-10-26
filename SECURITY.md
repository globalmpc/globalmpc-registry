# Security Policy

## Reporting a vulnerability

Report privately through **Security → Report a vulnerability** on the public mirror,
[globalmpc/globalmpc-registry](https://github.com/globalmpc/globalmpc-registry).
This requires private vulnerability reporting to be enabled on that repository. If the option
is unavailable, arrange a private reporting channel with the maintainers before sharing details.

**Do not disclose vulnerabilities in public issues, pull requests or discussions.** Include
the affected component and commit, reproduction steps, and expected impact. Keep sensitive
details private until a fix and coordinated disclosure are agreed with the maintainers.

## Scope

| In scope | Path |
|---|---|
| Smart contracts and deployment scripts | `contracts/src/`, `contracts/script/` |
| API, web and workers | `apps/` |
| Shared packages | `packages/` |
| Dependency and build configuration | Package manifests, lockfiles, `.gitmodules`, `contracts/foundry.toml`, CI workflows |
| Deployment configuration | `docker/`, `config/`, `packages/db/sql/` |

OpenZeppelin is installed by pnpm; forge-std is a Git submodule. Report defects in upstream
libraries to their maintainers. Vulnerabilities in this project's integration, configuration
or use of those libraries remain in scope here.

The known development values in `config/local-secrets/` are not leaked production credentials.
Their exposure as real production credentials or use in a production deployment is in scope.

## Supported versions

The latest `main` revision is supported. The public repository mirrors this project; include
the commit from the checkout you tested when reporting an issue. BSC contracts are not yet
deployed, so there is no supported on-chain deployment address.
