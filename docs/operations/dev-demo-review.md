# Dev demo review record

Implementation base: `e0df7ded8fecbb546c4d076226c306970fe67b50`.
Companion workflow: manager `projects/mpc/globalmpc-registry-private/deploy.yaml`.

## Expected behavior and review

- Development/5611 is required by both CI launcher and container/CLI before any DB or storage
  access. Production receives neither seed environment nor object write permissions.
- Seed identities include the tenant namespace, version and scenario. A session advisory lock
  serializes deployments while transactions remain short enough for the scan worker to see the
  quarantined document. Global public keys also include the tenant UUID.
- A completed audit marker always wins over live state: changed names, revoked evidence and
  historical publications remain unchanged. Incomplete user-edited scenarios fail closed. Parent
  and restriction locks prevent newly added user evidence or restrictions entering a simulated
  review while it is being finalized.
- Generated text is quarantined, actually scanned, then copied to evidence storage. Promotion and
  all fixture review/publication rows commit together. Failed finalization leaves the original
  quarantine checkpoint for a later retry; it never resets its scan result.
- Review fixture identities have no email, passkeys, roles or sessions. A fresh, unfunded signing
  key signs the actual stored scope/payload/snapshot and is discarded; only its signing-wallet
  binding remains. The authority and credential cover only a synthetic claim type. Every review
  and public projection contains explicit simulation limitations; audit attributes deployment
  seeding, never a real person's approval.
- Existing claim catalogs, policies, readiness results, service tokens, real users and chain
  records are untouched. The seed requests no batch or blockchain transaction.
- The task role receives GetObject/PutObject only on quarantine/evidence prefixes in development.
  Credentials enter through existing task secret references; logs and failure handling omit SQL
  errors, keys, URLs and personal data. Child processes do not inherit bootstrap email/scan token.
- CI rejects failed launches, missing/nonzero exit codes and waiter failure; waiter failure
  requests termination of its owned ECS task. Source workflow generation retains the dev-only
  condition and runs the seed after service deployment.

## Evidence and counterexamples

Focused local tests cover application/worker rejection, a migration owner without superuser or
BYPASSRLS, absent scanner and resume, concurrent invocations, stable publications, object bytes
and hashes, signature recovery, preservation of user edits and other tenants, and no anchor
creation. Shell tests cover production refusal, credential encoding and inherited secrets.
Launcher tests cover launch failure, missing exit codes, waiter failure cleanup and private VPC
arguments. Manager engine tests and generated workflow inspection cover the companion change.

Initial failures were corrected rather than waived: document attachments without a catalog now
use normal artifact lineage; non-BYPASSRLS owners retain the required synthetic proposal history;
public keys include the tenant namespace; raw percent signs in passwords are explicitly encoded.

Full application checks and coverage are recorded with the final PR revision. CDK installation
currently cannot fetch the private `must-cdk` package through the unavailable internal Nexus;
its added synth tests have **not** passed locally. No checks or thresholds were weakened, and
no private-package stub was used as verification evidence.

Independent human security review, configured CI and an actual development seed task run remain
required before merge/deployment completion. A self-review and local API tests do not replace
that evidence.
