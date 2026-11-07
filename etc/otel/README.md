# Isolated telemetry runtime

This npm project is installed separately from the application's pnpm workspace into
`/opt/otel` by both service Dockerfiles. Regenerate its lockfile with npm and verify
with `npm ci --ignore-scripts` and `npm test` after installing the root workspace.

## GCP metadata compatibility pin

`gcp-metadata@8.1.4` pins `gaxios@7.1.3`. That patch alone introduces a `rimraf@5`
chain with old glob/minimatch dependencies. The scoped npm override uses the next
patch, `gaxios@7.1.4`, which removes that chain while retaining the gaxios 7 API.
OpenTelemetry SDK and instrumentation versions stay pinned. No advisory is ignored.

The override applies only to this exact metadata version, so a future metadata
major cannot be forced to consume the wrong gaxios major. Remove it when the
metadata package advances to an upstream version that no longer pins 7.1.3.
The separate `/etc/otel` Dependabot entry keeps this runtime in weekly update checks.

## OpenTelemetry SDK 3

SDK 0.300 and auto-instrumentation 0.82 use stable SDK packages 3.x and API 1.10.
The console bridge imports Logs, SeverityNumber and context from the main API;
the old standalone api-logs package no longer exists. API 1.10 is an explicit
runtime dependency rather than an accidental transitive import. The telemetry
smoke tests exercise actual trace/log export, protected origins and signal drain.

## Process termination contract

The preload never replaces `process.exit`: startup refusals must terminate immediately,
without running the next statement or queued work. Explicit immediate exits can drop
buffered telemetry, as with Node's normal output semantics.

Natural worker shutdown flushes on `beforeExit`. The API drains HTTP and database work,
then awaits the optional `globalThis[Symbol.for('mpc.telemetry.shutdown')]` hook before
its explicit exit. The hook is idempotent and bounded to two seconds, including collector
outages. With telemetry disabled the hook is absent. Signal handling without an application
listener also uses the bounded flush before terminating; application signal listeners keep
ownership of their own drain sequence.
