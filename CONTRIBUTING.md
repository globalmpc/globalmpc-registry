# Contributing

## Before you start

This repository describes a **pre-issuance financial product**. A wrong sentence is
a compliance problem, not just bad prose — prohibited-language linting
(`pnpm check:copy`) runs as a CI gate over UI copy and API messages.

The specification documents themselves are not published. Notation such as
`spec 05 §5.3` or `OD-17` in comments is explained in
[`docs/spec-sections.md`](docs/spec-sections.md). The rule in this repository is that
comments are written **so that you never need the specification to read them**.

## Invariants

The guarantees listed under "What this repository enforces" in `README.md` are held
by **tests, database constraints, and contract invariants**, not by documentation.
Changes that unwind them are not accepted — if you believe one must change, open an
issue with the reasoning first.

In particular:

- No path that alters a readiness result
- No path that changes a finalized anchor root
- No trading, custody, or order path — hiding one behind a permission counts too
- Nothing blocked by an open decision (`OD-nn`) is opened with an arbitrary default
- Changing canonical serialization or the Merkle format makes already-anchored roots
  irreproducible. If it must change, bump `serializationVersion`

## Development

```sh
pnpm install --frozen-lockfile
docker compose up -d                       # Postgres · MinIO · anvil

DATABASE_URL="postgres://postgres@localhost:5432/mpc_test" pnpm test
pnpm check                                 # must pass before a PR
```

`pnpm check` covers typecheck · tests · OpenAPI drift · prohibited language · brand
assets · README counts · compose volume paths. Contracts: `cd contracts && forge test`.

**A green run without `DATABASE_URL` is not green**: tenant-isolation and append-only
tests are silently skipped.

## Pull request

- One PR does one thing. Do not mix cleanup with behaviour changes
- If you change behaviour, include **a test that fails when that behaviour is wrong**
- If you change the test count, sync the README with `pnpm check:counts --write`
- Comments state **why**, not what. The code already says what
- Commit messages explain in the body what changed and why

## Security

Do not report vulnerabilities in issues, pull requests, or discussions — use the
private process in [`SECURITY.md`](SECURITY.md).

## License

Contributions are released under the [Apache License 2.0](LICENSE). The MPC name
and logos are not covered — see [`TRADEMARK.md`](TRADEMARK.md).
