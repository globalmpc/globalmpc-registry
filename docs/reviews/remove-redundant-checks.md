# Remove unneeded measurement and duplicate browser checks

The user explicitly excludes bulk-processing validation and asks to remove
meaningless checks, particularly DB and browser tests. Existing data must not be
deleted. This change removes test source and duplicate test work only; it adds no
DB cleanup, production changes, skipped tests, or coverage/security threshold changes.
The optional PERF_MAX_P95_MS performance-only gate is removed with its measurement
suite under the user's explicit scope; this is no longer a performance certification.

## Removed and retained contracts

| Removed work | Why it is unnecessary for this scope | Meaningful verification retained |
| --- | --- | --- |
| throughput.test.ts, six cases | 150 requests for timing; three probes only reject 5xx and could pass on 401/403/422; final expect(true).toBe(true) is unconditional | projects.test.ts validates creation, persistence, audit, authorization and idempotency; email-auth.test.ts validates code issuance; registry.test.ts validates public lookup; metrics.test.ts now asserts a real 200 project-list request produces a 2xx metric |
| performance-measurements.test.ts, four cases | Repeated 1k/10k Merkle builds and 200 proofs per size, 2,000 random votes read 30 times, 20 readiness assessments; timings are printed without a performance acceptance criterion | canonical Merkle/vector tests validate determinism, odd/single/rejected inputs and proofs; governance tests validate tally/quorum; readiness tests validate persisted assessments and gate inputs |
| Three browser copy-only cases | Static landing/legal text has no server-dependent behavior; separate browser contexts repeat page startup | Existing React rendering test now asserts every original text/basis; real signed-out entry, sign-in links, legal navigation and rendered support visibility stay in Playwright |
| One separate sink-copy browser case | Same authenticated admin visit is already required by the sink creation journey | Original copy assertions run in the actual sink creation/state browser test |

The twelve-MiB browser upload is retained: it crosses a real ten-MiB proxy
boundary and verifies same-origin streaming/quarantine, rather than load volume.
Role visibility, account changes, actual API requests, tenant isolation, signatures,
retry/concurrency, proof verification and accessibility/browser layout checks are
retained. No tests are removed simply for being expensive or failing.

Before removal the ten measurement cases pass, demonstrating that the removal is
an intentional acceptance-scope change rather than concealment of a failure.
Baseline command on Node 24.22.1: both files passed 10/10 in 2.61s process wall time
(max RSS 387,912 KiB). The improvement claimed is removed work, not a measured
reduction in the whole-suite peak memory.

Focused retained contracts pass 180 tests across projects, governance, readiness,
email auth, metrics, canonical Merkle/vectors and navigation-shell. Browser scope
is the complete public-surface.spec.ts and workspace-screens.spec.ts files; no
renamed links or production UI changes. Full coverage retains the full production
source denominator and 90% floor. All verification runs use isolated test databases.
