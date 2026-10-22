# Claim type catalog

The catalog records versioned field definitions for project verification items. It does not
confirm evidence, change a grade or readiness result, or restrict existing claim submissions.
Existing free-text claim types and historical claims continue to work unchanged. No example
catalog entry is automatically registered or approved.

## Propose and approve

An enrolled `mpc_operator` proposes a definition with
`POST /api/v1/review-registry/claim-types/proposals`:

```json
{
  "claimType": "mining_licence",
  "displayName": "Mining licence",
  "description": "Licence evidence fields",
  "definition": {
    "fields": [
      { "key": "number", "label": "Licence number", "type": "string", "required": true }
    ]
  },
  "effectiveFrom": "2026-01-01T00:00:00Z",
  "rationale": "Record the agreed field definition"
}
```

This is a payload example, not an approved business standard. Field types are `string`,
`number`, `boolean`, and `date`. Definitions contain 1–50 fields with distinct keys.
Claim type and field keys start with a lowercase letter and contain only lowercase letters,
digits, and underscores, with at most 100 characters. Unknown properties, executable
expressions, and external schema references are rejected. Description is optional and
normalizes to null when omitted. `effectiveFrom` must be a real UTC instant in years
0001–9999, with no fraction or at most three fractional digits (millisecond precision).
Impossible dates and higher fractional precision are rejected instead of normalized or truncated.

A different person holding `reviewer_assurance` decides with
`POST /api/v1/review-registry/claim-types/proposals/{proposalId}/decision`, supplying
`{"decision":"approve","reason":"Definition reviewed"}` or `reject`. Mutations require
an `Idempotency-Key`; decisions also require `If-Match` with the proposal's current ETag
version. Having both roles does not permit self-approval. Concurrent proposals for the
same item conflict; concurrent decisions materialize at most one catalog version.

Proposal list/detail endpoints use the same base path and remain restricted by
`review_registry.read`. Their permission is separate from catalog reading; giving a user
catalog access does not expose credential or other review proposals.

## Read approved definitions

Authenticated workspace readers with `registry.read` can read their tenant's catalog:

- `GET /api/v1/claim-types?limit=50`: latest effective approved version per claim type.
  The response contains `items` and `nextCursor`. Pass a non-null `nextCursor` as `cursor`
  on the next request. The maximum page size is 100. Pagination is a live view, not a
  snapshot across requests.
- `GET /api/v1/claim-types/{claimType}/versions/{catalogVersion}`: one effective approved
  historical version. Unknown, future-effective, and other-tenant versions return 404.

Responses also contain `requestId` and `asOf`. Pending and rejected proposals never appear
in these read endpoints. Approval creates an immutable version; later revisions append rows
without rewriting history. `catalogVersion` counts approved versions starting at 1.
Proposal `itemVersion` counts proposal attempts, including rejected attempts, and need not
match it. A new version's effective date cannot precede the preceding approved version's
date. Future-effective versions are hidden until their effective date.

## Follow-up scope

Catalog-based claim input and validation, richer jurisdiction-specific field types, item
status calculations, stage policies, and Explorer changes require separate changes. This
foundation does not change document types, project facts, or lifecycle transitions.
