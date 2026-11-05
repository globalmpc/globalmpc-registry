# Project workspace presentation

Acceptance: a project opens with named document/review/publication destinations, searchable expandable evidence items, and separate readiness/human-decision cards. Supporting identity, parties, registration, offering conditions and history remain accessible in one disclosure. No API, authorization or persisted-state changes.

| Case | Authority / time | Scope | Presentation |
| --- | --- | --- | --- |
| Evidence item | Server computed current assessment | Project, claim type and catalog version | Preserve status, grade, full signed scope, reasons and limitations |
| Stage | Server assessment and rule version | Project stage; item membership is not provided | Show stage results separately; never infer item membership or permission to proceed |
| Search/status filter | Local presentation only | Returned current items | Filter rows only; total coverage and stage results remain unchanged |
| Human decision | Recorded decision authority | Existing project gate | Separate from computed readiness and evidence |
| Public historical records | Existing approved snapshot | Existing public routes | No new interactive mode or data fetch on public screens |
| Project/session change | Existing authenticated read endpoint | Remount browser per project/session | Discard old pending results; no previous-project evidence displayed |

Security review: no new endpoint, mutation, external URL, file download or HTML injection. The existing readiness.read endpoint enforces project/tenant scope. Action visibility is convenience only. Public disclosure and historical ledger consumers retain their existing mode. Local component tests and browser checks cover presentation; CI supplies broader regression evidence.

## Anonymous project discovery

The landing page now lists project cards from the existing public allowlist endpoint, with server search and cursor pagination. Each card preserves publication status, version, publication date and revocation. The detail link uses the public key, never the private project identifier. Only the published ledger is browsable; live warnings remain a separate section. No private API is called to enrich missing public fields. Stage membership remains unavailable and is not inferred. Supporting product explanations remain accessible under a disclosure, with boundary copy visible outside it.

Focused public/navigation tests and web typecheck pass. The first detail-title implementation assumed a typed projection; validation caught that the API deliberately types this as unknown. Runtime object/string narrowing now handles absent projection fields. Search responses are guarded so an older request cannot replace a newer query or registry selection.
