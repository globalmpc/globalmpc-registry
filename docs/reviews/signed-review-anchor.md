# Signed review commitments

| Case | Authority / namespace | Frozen input scope | Result |
| --- | --- | --- | --- |
| Existing v1 publication | Persisted version and original canonical rules | Existing bytes/root | Never rewrite or backfill |
| New project publication | Tenant actor with independent publish approval | Reviews whose claim scope intersects published ledger claim types, within same project/tenant | Commit sorted immutable review envelopes; explicit empty set if none |
| Verification publication | Exact attestation subject in tenant | That signed attestation only | Commit its envelope |
| Historical signing context | Stored signature-time envelope | Domain/message and acceptance basis recorded at signing | No reconstruction from current chain or current credentials |
| Legacy signature | No stored signing envelope | Existing signature plus frozen attestation snapshot | Mark context unavailable; never claim independent verification |
| Bundle export | Existing authenticated registry reader in same project | Published version's stored bundle | No public private evidence export |
| Live revocation | Current authority, separate from frozen proof | Existing health/revocation checks | Historical validity is not current approval |

Contract stores root/manifest hashes and needs no change. New leaf serialization v2
commits the public projection including an opaque review-bundle commitment. v1 hashing
remains byte-identical. Signing domain version remains 1. Independent human security
review is required before merge.

## Implementation

New publications use leaf serialization 2; canonical rules and v1 vectors stay
unchanged. Their public projection contains only the opaque bundle commitment and
string counts. The bundle is stored once in a tenant-scoped append-only table in
the same publication transaction, enforced by a deferred database trigger. It
contains complete signed review envelopes, the frozen case manifests and document
content-hash references. Project selection is constrained to ledger claim types;
verification records commit their exact attestation. Mixed-scope attestations keep
their complete signed scope so signatures remain verifiable.

New signature submissions preserve the exact domain/message and authority acceptance
basis. No existing signatures, publications, batches or roots are rewritten. Legacy
reviews without signing context are counted separately and never advertised as
independently verifiable. Current authority/revocation remains a separate live check.
A document hash reference is frozen with the publication; legacy signatures bind
artifact identifiers through their original snapshot, not a new retroactive document
hash signature. The bundle proves the publication's mapping as well as the stored
review; it does not change what the historical reviewer signed.

The private registry export returns the frozen bundle, public projection and exact
anchored leaf (retained when a batch is built). Before anchoring it returns the
prospective leaf. The workspace publication screen downloads this export; /verify
recomputes bundle/projection hashes and reviewer signatures locally and transfers
the resulting leaf hash into the existing inclusion proof comparison. The browser
still does not independently query the chain. No contract or CRE ABI change.

Verification evidence is recorded in the PR. Initial tests caught numeric counts
forbidden by canonical serialization; counts and envelope numbers are now decimal
strings. An early reused test DB had a development migration checksum mismatch;
verification moved to a new isolated database. Independent human security review,
CI and real deployment evidence remain required before merge/deploy.

Full-review follow-up covers receipt-backed documents, including same-tenant
receipts without a project ID referenced by the frozen manifest. Other projects'
receipts and uploads stay excluded. The local verifier accepts generated exports
without an inconsistent UI-only size cap. Import and manual edits invalidate old
proof results, including pending responses.

A catalog-backed browser journey now asserts one independently verified signature
and equality with the anchored inclusion leaf. Its first run exposed decimal-string
chain IDs being omitted from viem's inferred EIP-712 domain; verification now restores
the numeric domain value as bigint. The fixture signs with a numeric chain ID and
verifies the actual decimal-string export boundary. The corrected journey passed.
