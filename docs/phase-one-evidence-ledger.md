# Catalog claims and evidence assessments

A data steward can select an approved, effective claim definition in a project's Data Room,
enter its declared fields, and link scanned supporting documents. The saved claim pins that
catalog entry and version. Later definition changes do not rewrite old claims. Numbers are
stored as decimal strings to retain precision; boolean fields retain an explicit false value.
The source reference describes where the asserted value was found. Recording a claim does
not verify it.
The optional claim as-of date records the UTC calendar date the claim describes. Leave it
blank when unknown; an undated claim cannot satisfy a policy's freshness requirement.
Future dates are not current evidence and cannot establish an evidence stage.

Existing free-text claims remain accessible through the legacy entry path. They are not
silently converted into catalog claims or counted as satisfying a catalog requirement.
Corrections preserve the existing version history and require another review.
Scanned, clean uploads can be attached while evidence is being prepared. A linked upload
must be promoted before it contributes to a reviewed item; a signed review alone does not
complete that document lifecycle step.

## Current assessment

The Data Room displays a current evidence assessment separately from manual project
confirmations, readiness, and human gate decisions. Each catalog item can be missing,
unreviewed, reviewed, in need of another review, conflicting, rejected, or explicitly not
applicable. A current scoped review and supporting evidence are necessary for a reviewed
item. Conflicts and evidence or review validity failures take precedence over old passing
results. The interface shows the evidence grade, reviewed item scope, and review limitations
instead of presenting a review as legal or operating approval. Current signed reviews show
a pseudonymous reviewer handle, qualification type, attestation type, signing time, and
limitations. The public summary does not disclose names, wallet addresses, or internal IDs.

Only effective stage rules are evaluated. Without applicable rules, no evidence stage is
established. Missing requirements remain visible. Assessments do not open a publication gate
or grant permission to proceed. Manual confirmation history is retained separately.
Authorized project members can record a catalog item's not-applicable decision, or withdraw
it with a pending decision, in the project's Confirmed/Pending Matrix. These exact catalog
keys retain version history and require a reason. Catalog-only decisions do not write the
legacy gate facts. Changing an approved exclusion produces a separate current warning;
the approved summary remains unchanged.
The displayed evidence stage is the highest effective stage whose own policy passes.
Stage policies are evaluated independently rather than as sequential approvals; an earlier
gap remains visible even when a later policy passes. Policies must explicitly include any
prerequisites they require.

## Publication and proof

Drafting a public project record freezes an evidence assessment. A different disclosure
approver reviews and publishes the draft through the existing approval path. The Explorer
shows that approved assessment with its timestamp and limitations.

A separately labeled current warning section can flag changed validity or conflicts for
already published items. This section does not replace the approved assessment or change
its canonical hash, Merkle leaf, or proof. A proof confirms integrity and inclusion; it does
not establish the factual truth, legal validity, or current fitness of evidence.

## Verification

The browser evidence-ledger scenario exercises project registration, upload, independent
scan, catalog entry, signed review, independent publication approval, public lookup and
proof verification. It then expires a supporting document and checks that the current
warning changes while the approved assessment and proof remain unchanged. With
`E2E_CHAIN=1`, it also waits for confirmation by the local chain worker. Without that mode,
the browser test verifies the Merkle path but does not claim chain confirmation.

The test catalog and exploration rule are synthetic fixtures proposed and approved through
the ordinary API. They are not authoritative mining criteria and are not installed as
production defaults.
