# Unified human roles

User authorization: replace internal human roles with three roles, not UI presets.
Keep two service identities, anonymous public access, and temporary break-glass
separate. No contract, chain authority, signed-report format or historical hash changes.

| Identity / case | Authority / time | Scope / priority |
| --- | --- | --- |
| project_member | Authenticated project participant; live grant | Enter project data and governance participation; organization/project scope and voting snapshot remain required |
| reviewer | Independent reviewer/approver; live grant plus credential/assignment | Curate, verify, approve and publish; valid expertise and per-person conflict checks outrank role membership |
| administrator | Platform administration; live grant | Users, security, operational draft/anchor jobs; cannot approve own grant or publish own draft |
| scan_service / cre_reporter | Scoped service credential | No human role becomes effective; humans cannot exercise a service role |
| public_reader | Unbound public fallback | Not assignable; no workspace mutation |
| break_glass | Independently approved expiring elevation | Not a standing assignable role; incident and expiry checks remain |
| Existing binding | Forward migration, preserve ID and explicit project/organization reach | Store original scope independently of consolidated role; existing revoked records and audit/signature history remain frozen |
| Pending old grant | Approval had not occurred | Withdraw rather than silently approve a broader consolidated role; resubmit under new names |
| Role merge | Deliberate broader job group | No automatic identity assurance increase, credential issuance, assignment, project membership or onchain key grant |

Mapping: project_admin, project_sponsor_operator, spv_representative,
execution_recorder and governance proposer/voter roles become project_member.
Data steward, four reviewer specialties, disclosure/gate approvers, issuer officer
and external regulated service provider become reviewer. MPC/security operators,
auditor and treasury signer become administrator. The consolidated groups carry
broader job permissions than each former specialty; this is an intentional policy
change, not a claim of identical action grants. Review and administration require
high assurance/passkey. Project membership requires identity-bound MFA; prior
voter-only sessions and stewards may need identity/passkey step-up, never an
automatic assurance upgrade.

Acceptance: exactly three grantable human roles and two service roles; server/DB
reject legacy/unknown new grants. Existing scope, tenancy, credential ownership,
assignment, author/reviewer independence, draft/publisher and role-grant person
separation survive. Governance remains bounded by proposal space and frozen vote
weight. Existing audit records, signatures, published hashes and revoked bindings
are not rewritten. Existing admin, review, publication, service, governance and
browser journeys must pass. Add only compact migration/boundary regressions;
update existing fixtures/assertions instead of adding redundant suites.

Independent human security review is required before merge. No deployment or
migration against a live database is authorized by this implementation task.

Focused evidence before PR: 1,387 unit tests, 144 API/migration tests in a fresh
isolated database and root/web typechecks passed. Upgrade coverage seeds the
preceding schema with real legacy grants, including an invalid unscoped project
voter and a revoked role, then checks live scope preservation, withdrawal of
unapproved grants, frozen audit history and non-superuser/NOBYPASSRLS isolation.
No test thresholds or scopes were reduced. Existing suites/fixtures were updated
for renamed roles; the only added test file holds two migration/boundary cases.

Role collapse also requires an explicit own-assignment guard on revoke/reassign:
reviewer now includes curation and signing, so another person must change the
assigned reviewer's assignment. Credential self-status changes and publication
self-approval retain their existing checks. Existing voting bindings carry an
explicit frozen namespace; former non-voters do not acquire snapshot voting
rights merely because their job label becomes project_member.

Deployment sequencing: apply migration137 and deploy matching API/web together.
Old API code does not understand new role names and fails closed during rollout.
A source-only rollback cannot restore old grants; use the reviewed DB restore/
roll-forward procedure. No production migration/deployment was performed here.
Full application coverage, browser journeys, CI and independent human security
review remain pending at this checkpoint.

Review refinements: tenant policy, credential, authority, connection, audit and account
administration require tenant-wide grants; a migrated organization steward cannot
administer global policy. Authority approval belongs to reviewer, independently
from its administrator registrant. Case management and assignment changes cannot
be performed by that case's active reviewer. Project members combine proposing
and execution-recording duties; project/organization reach still limits those
operations, while voting retains its distinct frozen namespace and holdings.

The first full local run exposed outdated role-denial fixtures and test cleanup
that deleted original grants after role names collapsed. These were corrected
without reducing test scope or thresholds. All 43 selected browser journeys then
passed against a separate synthetic database. Full coverage is being repeated.
An initial run also exhausted the host's per-user /tmp quota; verification was
moved to the project filesystem. No live/user database contents were deleted.

## Additive synthetic stage coverage

| Case | Identity / authority | Input and time scope | Expected outcome |
| --- | --- | --- | --- |
| New demo | Explicit develop/5611 seed, migration owner | Exact demo project; project-scoped catalog and stage policy | Real evaluator computes reviewed/required counts; fixture approval is labelled synthetic |
| Completed legacy demo | Existing completed seed provenance | Retain claims, signatures, user edits and published versions; add definitions and a new assessment | Coverage exists; unpinned legacy claims do not become newly reviewed evidence |
| Other project / tenant | Runtime application role with transaction-local RLS | Global definitions or definitions naming that exact project only | Demo policy/catalog cannot supply readiness, claims, signing versions or public live warnings elsewhere |
| Frozen publication | Historical approved snapshot | Compare current policy IDs through the same scoped selection used privately | No rewriting of frozen JSON, signatures or hashes |
| Retry | Seed advisory lock plus deterministic definition IDs | Existing definitions are checked, not replaced; one completion event per coverage seed | Additive and idempotent; no data deletion or human approval fabricated |

Acceptance: all three existing scenarios gain numeric coverage via the existing evaluator.
Only the synthetic exploration requirement is seeded; no simulated mine is promoted to
production. Existing unstructured signed evidence stays frozen and may leave coverage
incomplete; new fixtures pin their catalog before signing. No signed gate decision,
lifecycle advancement, publication rewrite or onchain transaction is created by coverage.

The seed reports newly created assessments separately in `assessed`. Existing projects,
claims, signatures and registry versions remain unchanged during backfill. Normal catalog
queries hide scoped definitions; project queries, direct SQL claim/assessment inserts,
signing versions and public live warning selection all enforce the same bound project.
Project-bound definitions are restricted to original synthetic fixtures, not a general new
policy-authoring surface. The existing DB guard also prevents reclassifying a synthetic
project as real. Runtime workers need no new audit-table read privilege: provenance is
checked when the owner inserts definitions, and runtime matching uses immutable project kind.

Checkpoint: focused API/seed/ledger checks passed, including a newer same-jurisdiction demo
policy that must not affect another project's private stage or frozen public warnings.
An initial worker test exposed its intentional lack of audit SELECT; fixed without granting
that privilege. Broader checks and CI for this seed revision remain to be completed.

## Follow-up review boundaries

| Case | Authority / frozen inputs | Outcome |
| --- | --- | --- |
| Gate decider contributed evidence | Account subject UUID against contributors captured from the exact claim/review rows used by the assessment (including project context) | Deny both signature request and submission; same DB insert guard |
| Old assessment lacks contributor provenance | Historical signed hashes/results remain frozen | Require a fresh assessment before a new gate decision; never infer independent authorship from missing metadata |
| Evidence changes after assessment | Assessment contributor UUIDs remain frozen | New actors do not retroactively rewrite the old basis; reassessment records a new basis |
| Revoked legacy role | Historical old role name and consolidated role share a bootstrap history namespace | Refuse re-grant or a new first holder; keep the revoked row unchanged |
| Reviewer organization scope | Current binding scope, owning organization, jurisdiction and subject status | Picker must agree with signing access |
| Reviewer + administrator | An action must be allowed by an individual valid binding | Credential restoration/expiry use reviewer authority rather than the first alphabetic role |

Second review pass: contributor provenance includes manual receipt confirmers and
both receipt-linked and directly attached document uploaders. Assignment, drafting,
signature request and final cryptographic signature acceptance enforce the same
independence boundary; relayed signatures are checked against the assigned signer,
not the relay session. Gate assessments freeze these upstream contributors too.
Governance voting eligibility and project/jurisdiction authorization must both hold
on the same binding; a non-voting grant cannot complete a restricted voting grant.
Regression tests exercise historical drafts, actual signed direct/relayed attempts,
and mixed jurisdiction grants without disabling database guards.

## Complete project stage display

The reference demonstrates showing the whole stage journey. The user clarified
that the existing five supported stages must remain; the prototype's eight-stage
vocabulary is not adopted. Previously the UI displayed only configured assessments
and one focused stage, hiding the remainder of the journey.

| Case | Authority / frozen versus live | Display priority |
| --- | --- | --- |
| Project roadmap | Existing evaluator stage IDs and order | Always show Exploration, Resource definition, Feasibility, Permitting, Production |
| Assessed stage | Exact gate ID and existing snapshot counts/status | Show evidence coverage without claiming a human Go decision |
| No corresponding assessment | No inference from uploads, earlier/later stage or catalog totals | Show Not assessed, never fabricated zero, completion or Not reached decision |
| Public record | Approved snapshot only | Same roadmap with published assessment data; no private enrichment or extra requests |

Scope: presentation only; no new policies, transitions, hashes, claims or service
permissions. Lists, project requirements and public detail show all five even
without assessments. Existing diagnostics, missing evidence and N/A distinctions
remain. A regression asserts the full order and that a permitting assessment binds
to its own stage without inventing results for the remaining stages.

| Follow-up publication case | Authority / scope | Expected outcome |
| --- | --- | --- |
| Organization/project reviewer decides another project's draft | Resolve immutable project or verification subject before idempotency | Hide other-project drafts and refuse publish/reject and cached replay; independently permitted own-project decisions still work |
| Legacy promoted document has no receipt/catalog attachment | Active artifact set actually included by the signed evidence snapshot | Its uploader remains a contributor and cannot independently review it |

The full-stage display regression fails with the original component because the
Project stages list is absent. Complete affected browser files: evidence-ledger,
evidence-ledger-broken-chain, public-surface, workspace-screens, reference-experience,
project-progress-budget and readiness-policy-selection. Final five-stage verification
supersedes the intermediate prototype-based eight-stage display checks.

Publication/artifact follow-up: both regression cases fail on the prior code
(other-organization publication succeeds; own legacy-artifact assignment succeeds),
and all 217 focused API tests pass with the correction. Historical fixture setup
initially reused an upload content hash and then used a claim type outside the
credential scope; corrected the fixtures to reach the actual independence boundary.
No database guard or acceptance check was relaxed. Final full coverage and current
CI/re-review are being checked separately.


| Final contributor/publication case | Authority / history | Outcome |
| --- | --- | --- |
| Upload has no attributed uploader | Actual contributing upload rows, including direct attachments | Provenance is incomplete; gate assessment stores NULL and both gate boundaries require correction/reassessment |
| Artifact revoked after a case began | Case time is a conservative historical contributor boundary | Keep its uploader in draft/request/acceptance independence checks; new live assessments may omit the revoked standalone artifact |
| Fresh synthetic PUBLIC fixture | Save the real ledger after signing and before first publication | Publish that saved sanitized ledger; existing published versions remain immutable |
| Many claims share receipts | Distinct scoped tenant/project pairs | Each receipt enters contributor collection once, not once per claim |

Final five-stage UI suite passed all 527 web tests and 35 complete browser tests.
Contributor regressions cover valid direct and relayed signatures of a historical
uploader draft after revocation, missing upload attribution at both gate boundaries,
and fresh PUBLIC 1/1 coverage without exposing private claim IDs. Fresh generated
fixtures attribute their upload to the explicit synthetic proposer; existing human
or completed fixture uploads are not rewritten. Typecheck also uses a safe status
lookup with an unknown-status fallback.

## Target scope and historical manual confirmation audit

| Case | Identity / authority / time | Input / priority |
| --- | --- | --- |
| Registry draft/revoke | Current subject role binding; organization/project grants stay scoped | Resolve immutable subject project before idempotency. The policy also rejects project-only grants when a target project was omitted |
| Anchor build/resubmit | May include several projects and expose operational state | Require unrestricted tenant authority on the same administrator binding before replay or chain writes |
| Anchor operational listing | Mixed-project submission/failure history | Require tenant authority; public proofs remain available through public endpoints |
| Stale-signal decision | Signal project is authoritative | Resolve under tenant RLS/row lock, authorize that project; projectless historical signals require tenant authority |
| Projectless manual second review | A tenant-level source record | Same source.collect permission plus tenant authority; project-bound receipts retain project authorization |
| Legacy manual receipt | Confirmers may be absent in pre-0021 rows preserved by NOT VALID constraints | Count missing first confirmer, missing second confirmer for confirmed manual results, and same-person double confirmation as incomplete provenance; never rewrite old receipts |
| Other source channels | Automatic API/export/signed-document receipts need not name manual confirmers | Do not turn their optional NULL confirmer fields into a failure |

Audit inventory: all tenantResource callers across API routes, action policy tenant
requirements, scoped list filters, pre-replay checks, and the shared contributor
collector's claim/upload/receipt channels. Tenant configuration uses the existing
explicit policy requirements; project creation separately checks the owning
organization; project-filtered read lists retain their existing scope filters.
No additional service privilege, migration, signed format or historical hash change.
Verification will reproduce the original failures, exercise own/other organization
and replay contrasts, actual pre-0021 upgrade history under non-superuser RLS,
and unaffected automatic receipt collection before full checks and re-review.

Connected evidence-input audit also found that receipt-project validation applied only
to catalog-bound claims. New unstructured claim writes/corrections now validate the
same project binding; existing rows and signed hashes remain untouched. Contributor
collection still follows explicit legacy receipt references, including projectless
ones, so historical loose links cannot silently drop their actors. Receipt IDs are
deduplicated before reading confirmer provenance.

The second-review domain check was missing a refusal for an attributed-second/unattributed-first
pair during this audit. The API now returns SECOND_REVIEW_AUTHOR_UNKNOWN with a
new-confirmation action and writes no follow-up, rather than presenting unknown
first authorship as a valid two-person confirmation. Manual history is never
retroactively attributed. Existing known-first/different-second review remains valid.

Anchor operational reads now have a separate tenant-scoped anchor.read action,
including the route contract and navigation. The page performs no fetch/poll without
that action and keys private state by account/tenant/loading identity, preventing
late responses from the previous cookie-session identity appearing after a switch.
This preserves read-only tenant reviewers while keeping limited administrators out.
Affected browser inventory includes public-surface, workspace-screens, golden-path,
evidence-ledger/broken-chain, anchor-chain and reference-experience. The final chrome
specs retain accessible-name, menu and signed-in/out assertions.

Initial focused checks exposed a test POST using the wrong draft route and a JSON
fixture serialization issue; corrected both. The new identity-only lookup initially
changed an invalid Verification Registry subject from 422 to 404; restored its
existing error contract. A jurisdiction-limited tenant binding also needed to be
excluded from global authority in both authorization and server-computed actions.
The historical/automatic receipt contrasts now pass under runtime RLS. Original
code reproduces six targeted failures (including cross-project legacy links); the
old anchor page fails the new account-switch/poll regression too. Focused API/domain
296 tests, web 528 tests and root/web typechecks pass. The only OpenAPI diff adds
anchor.read to the existing GET anchor-batches operation; no route or role was added.

## Historical receipt recovery (follow-up decision table)

| Identity / case | Authority and time basis | Input scope | Result / priority |
| --- | --- | --- | --- |
| Current claim replaces an unknown manual source | Authenticated claim correction appends a successor; source receipts remain immutable | Current claims' receipts and active project artifacts' receipts | New assessments can recover after attributed replacement; an unknown source still in use blocks independence |
| New verification case | Tenant-scoped API freezes evidence at assignment | Version 3 manifest: selected claims, active project artifacts and their referenced receipts | Assignment, draft and both signing boundaries use the complete frozen scope; later unrelated sources do not poison it |
| Existing case without a manifest | Historical hash and its version 1/2 interpretation are preserved | Historical broad receipt scope remains conservative | Unknown historical provenance stays blocked; create a new case over corrected evidence |
| Source contributor / reviewer | Subject UUID within authenticated tenant; actual assigned signer is authoritative | All claim authors, document uploaders and manual confirmers in the frozen case, including claims outside an attestation subset | A known conflict or unknown provenance cannot be waived by selecting a smaller signing scope |
| Migration / retries | API uses withTenant and runtime mpc_app RLS grants; owner applies additive migration | Nullable immutable manifest; no historical backfill | Preserve old hashes, receipts and publications; no privileged runtime access or contract/wire serialization change |

Acceptance: reproduce unknown-source refusal, append attributed replacement and claim correction,
then verify a fresh case and readiness decision can proceed while old cases remain unchanged.
Check frozen source scope after later receipt/artifact changes, subset signing, runtime tenant
isolation and version 1/2 hash compatibility. Human independent security approval remains required.

The effective scope also retains artifacts linked to an explicitly selected receipt even if
revoked: a claim still relying on that source cannot discard its uploader by revoking the
artifact. An obsolete receipt leaves live scope only after its claims are corrected and its
otherwise-active artifacts are revoked. New version 3 manifests freeze the exact IDs and claim
fingerprints, validate against their stored hash, and cannot be replaced or cleared. Case hash,
project and schema are immutable for these new cases. Legacy version 1/2 bytes remain unchanged.
The public registry serialization and contract signing types are unchanged.

The adjacent audit found two more incomplete scopes: subset attestations omitted authors of
other case claims, and a project with no claims omitted contributors to active artifacts.
Both now use the whole relevant case/project scope. The regressions cover current and historical
cases, attributed replacement with actual signing, frozen old assessments, later irrelevant
artifacts, runtime other-tenant exclusion and reproducible version 1/2/3 bytes. The original
collector fails the subset and empty-project cases, and separately fails recovery after a claim
correction and artifact revocation. Focused checks: 179 API tests passed and root/web typecheck
passed. One initial new fixture used `id` instead of the second-review response's `receiptId`;
that fixture was corrected before the final passing checks. Broader verification is recorded below.

Receipt and artifact queries still scale with the relevant tenant/project evidence; no bulk-load
performance claim is made. No original data, signed history, publication or check was removed.


| Live affiliation follow-up | Authority / time basis | Expected result |
| --- | --- | --- |
| Assigned reviewer later gains an operator organization binding | Current subject/credential affiliation at draft, request and acceptance; evidence stays frozen | Refuse all three boundaries, including relayed signing; permit retry after conflicting binding revocation |

The connected signing audit also found that operator affiliation was only checked at assignment.
It is now rechecked against current active bindings and the credential's organization at all
three attestation boundaries, independently of the relay's session. This preserves live
separation of duties when roles change after a signature request.

## Standing review and legacy-time boundaries

| Case | Authority / time basis | Input scope | Priority |
| --- | --- | --- | --- |
| A standing attestation contributes to a requirement | Its complete frozen case remains authoritative even if an upload is later revoked | Union live claim/project contributors with every distinct used attestation case and its reviewer | Preserve known contributors; incomplete provenance in any used case blocks the new gate assessment |
| An attestation does not intersect any current requirement claim | Not an input to the assessment facts | Do not add an unrelated historical case or reviewer | Avoid poisoning an assessment with an unused review |
| Legacy case without a manifest | Immutable evidence creation times versus the case's creation time | Exclude later artifacts and receipts; retain evidence revoked after assignment | Later unrelated work cannot make an old reviewer self-assuring; original hashes stay unchanged |

Verify actual raw-upload revocation after a real signature at both gate boundaries, unknown
provenance retained through a standing historical review, and later legacy evidence exclusion
through draft/request/signature. Equal creation timestamps are included conservatively; version
3 manifests remove that reconstruction ambiguity for new cases. No historical rows are rewritten.

Both follow-up regressions fail when their respective corrections are removed. The existing
gate-contributor test now signs a case with an unbound raw upload, revokes the upload through
the actual API, proves the signed review still stands, and refuses its uploader at request and
submission. A new parameterized legacy test checks known/unknown historical uploaders, later
unrelated manual receipts/artifacts, preserved revoked contributors, actual signing with known
provenance, and a NULL gate basis for an incomplete standing review. An unused historical
review does not poison assessment completeness. Focused 108 tests passed. Cases are deduplicated
before reading historical contributors; work remains linear in distinct used cases.

## Jurisdiction-limited administrator follow-up

| Case | Identity / live authority | Scope | Expected result |
| --- | --- | --- | --- |
| Existing emergency elevation loses its unrestricted administrator binding | Re-resolved subject bindings on every request | Tenant scope, no project and NULL jurisdiction are all required on the same administrator binding | A remaining regional binding cannot synthesize unrestricted break_glass authority |
| Reciprocal administrator revocations with a regional third holder | Current account/MFA eligibility under the serialized tenant revocation lock | Count only unrestricted tenant administrators | At most one reciprocal revocation succeeds; retain a real role-grant approver |

Audit the parallel authority predicates in grant decisions, session list/action filtering,
emergency requests/decisions, organization scope resolution and owner-only bootstrap. Regional
bindings remain usable for authorized project work, while tenant administration stays global.

Both omitted jurisdiction predicates are now aligned with `admin.role.approve` tenant authority.
The existing elevation test covers organization and regional replacement grants; the existing
serialized reciprocal-revocation test includes a third region-limited administrator with a
working account/MFA and proves it cannot propose global revocations. Original code grants the
regional elevation and accepts both reciprocal decisions (200/200); fixed code drops elevation,
refuses quarantine and retains one unrestricted approver (200/422). Focused 93 tests passed.
No matching omission was found in the audited centralized action predicates, role grant routes,
organization project mapping or owner-only bootstrap history guards.

## Orphan originals and evaluated applicability

| Case | Authority / time basis | Input scope | Result / priority |
| --- | --- | --- | --- |
| Raw artifact has neither a source receipt nor a same-project upload record | No actor is inferred from a nearby claim or the current operator | Live/frozen scoped raw artifacts | Provenance is incomplete; old signatures and records are preserved, new independent decisions fail closed |
| A requirement evaluates as not applicable | The existing policy evaluator's `applicable` result is authoritative | Exclude standing reviews used only by that requirement | An excluded historical case cannot poison contributor completeness |
| Applicability is unknown | The evaluator keeps `applicable=true` rather than inventing an exemption | Retain conservative scope | Unknown applicability must not become an N/A permission bypass |

Use the evaluator after constructing facts so predicate semantics are not duplicated. Keep live
claim/project contributors and used frozen review cases separate. Missing historical origin is
never backfilled by guessing; verified source records or explicit owner retirement of legacy
metadata must precede a fresh case. Already-signed incomplete cases remain conservative.

The inner upload join now requires the artifact's project as well as tenant, and orphan raw
artifacts are counted separately from upload rows with NULL authors. Receipt-backed originals
remain attributable without an upload row. The existing recovery regression now contrasts
receipt-backed and orphan originals, refuses draft/gate boundaries for the orphan, preserves its
frozen incomplete case after explicit owner retirement, and completes a fresh signed case.
The historical unknown-uploader test varies only the requirement's applicability, proving an
N/A review does not block a real signed gate decision while the applicable contrast does.
Both regressions fail against the previous implementation; focused 115 tests passed. Historical
orphan retirement in that fixture is an explicit owner operation, not a newly exposed API or an
automatic attribution/backfill.

## Independent dispute resolution and disposition priority

| Case | Identity / authority | Frozen / live scope | Result / priority |
| --- | --- | --- | --- |
| Raise a dispute | Project member, reviewer or administrator with project access | Adds an objection; no positive judgement | Keep broadly available |
| Resolve a dispute | Reviewer role with project access; not the original signer, a recorded disputant, an evidence contributor or currently affiliated operator | Complete frozen case provenance plus live organization bindings | Independent administrative disposition; it creates no professional signature and needs no reassignment of an already-signed case |
| Cached resolution replay | Recheck role, target scope and independence before idempotency lookup | Current actor over the same immutable target | An ineligible account cannot borrow an earlier resolver's result |
| Multiple dispute outcomes | Lock the attestation before its disputes, matching dispute creation lock order | All dispositions on that attestation, serialized | Any upheld/unknown disposition blocks restoration; only all-dismissed and no unresolved disputes can restore a currently disputed attestation |
| Resolver opens another person's case | Project-scoped case list supplies only latest non-draft attestation ID/state | Persisted metadata; explicit case selection loads disputes | A second reviewer can finish the real UI journey after sign-in/refresh; no signature or validity is fabricated from UI state |

Verify member creation/denied resolution, independent reviewer success, author/signer/disputant
refusal, cached replay, mixed outcome priority, concurrent dismissals and a real second-account
browser resolution. Audit other request/decision action reuse alongside this path.

Resolution now has its own reviewer-only action and checks frozen contributors, original signer,
all recorded disputants and current operator affiliations before cached replay and again under
the attestation lock. An existing evidence barrier uses nonblocking acquisition to avoid a
row/advisory-lock inversion with evidence writers; a busy resolution leaves no partial writes and
can retry with the same key. An upheld or unknown prior outcome blocks restoration, concurrent
dismissals serialize correctly, and responses retain an already-stale/revoked state instead of
claiming an activation that did not occur.

A project-scoped case summary adds optional latest non-draft ID/state only, ordered by creation
and UUID. This is an indexed metadata lookup in the existing list request; no evaluation or
per-row HTTP request is added. Dispute details load only after explicit case selection. Tests cover
tied timestamps/reversed insertion and ignore a newer unsigned draft. The UI can reopen saved
disputes after another reviewer signs in, separates creation/resolution controls and clears prior
selection on account/project changes without inventing signature or credential validity.

Affected browser inventory: `review-lifecycle.spec.ts` (two-account adjudication) and the existing
`golden-path.spec.ts` / evidence-ledger specs using the shared workbench/seed. Added one labelled
independent reviewer fixture; existing users and assurance controls retain their meaning.
The complete review-lifecycle spec passed both tests with the actual new-account login and
persisted-case path. Focused API/contract/UI checks passed 212 tests; the original implementation
fails member resolution, mixed-outcome priority, concurrent dismissal and stale-response cases.
Initial concurrency polling reused PostgreSQL's transaction statistics snapshot; moving that
observation to fresh owner queries fixed the harness. UI mocks were corrected to create a dispute
only after POST, matching the new persisted-read path. No production check was suppressed.

The adjacent action-reuse audit confirmed claim curation remains reviewer-only, party requests
remain separate from confirmed facts, and document-impact closure is source-document bookkeeping
rather than restoration of a professional attestation. No further matching permission expansion
was found in those paths. Independent human security approval is still required.

Follow-up connected-flow decisions and verification:

| Case | Authority / frozen state | Input scope | Expected priority |
| --- | --- | --- | --- |
| Signed claim receives an objection | Existing subject-scoped dispute permission; signed bytes stay frozen | Every claim in that attestation's signed scope, plus all remaining standing attestations | Disputed attestation ceases supporting the live verification state and grade |
| Independent reviewer dismisses an objection | Separate resolver authority above; rationale and original signature retained | Same signed scope | Restore support only when every objection is dismissed and the attestation actually returns to active; stale/revoked/upheld remain blocking |
| Another case is assigned/opened | Current account/project and explicitly selected case | Selected case only | Clear previous draft, request, signature and dispute target before showing the new context |

The existing shared claim reassessment service now runs atomically on the two actual standing
changes, using deterministic claim order and the existing nonblocking evidence barrier. It records
provenance causes without editing signed content or erasing history. A real API regression creates
an isolated claim, signs it, raises two objections and dismisses them separately: support drops on
the first objection and returns only after the last dismissal. The original route fails this test
because `analyst_checked` survives the dispute. Fixed focused checks passed 126 API/integrity/UI
tests and typechecking. The first focused run exposed an accidental test-helper parameter rename
in an unrelated conflict fixture; it was corrected and the complete focused files rerun.
A UI regression also confirms assigning a new case removes the previous signature/dispute target.

The subsequent Duno scenario assumed a signed case can be reassigned before its attestation is
disputed. Connected-flow verification rejects that premise: final signature sets the case to
`signed`; both revocation and reassignment call the locked assignment/case guard, which permits
only assigned/in_review/changes_requested. Neither dispute nor its resolution reopens the case.
Signed-case transitions cannot return to an assignable state. The original-assignee UI exclusion
therefore agrees with the server for supported persisted states; a separate independent resolver
need not be assigned to the case (the two-account browser journey already proves this).
Expanded the existing signed-assignment test rather than adding a speculative API field: both
assignment mutations return 409 CASE_NOT_REASSIGNABLE before and after a real API dispute, and
the case summary still identifies the original reviewer and attestation. Complete integrity/UI
files passed 69 tests. This follow-up changes tests/documentation only; production code remains
1d596113, whose full 4,131-test coverage and 12-browser-test results remain applicable.

Next review decisions (credential affiliation and in-flight UI context):

| Case | Authority / time basis | Scope | Expected result |
| --- | --- | --- | --- |
| Resolver/reviewer has a live operator credential but a different role organization | Current subject UUID; live active role organizations plus currently valid credential organizations; selected signing credential also counts | Same tenant and project owner | Operator affiliation blocks independent adjudication/assignment/signing regardless of the selected role organization |
| A saved dispute mutation is pending and another case is clicked | Existing account/project reset boundary; active mutation owns selected case context | Current workbench | Case switches are disabled while busy so a response cannot repopulate a different case |
| Consolidated reviewer may sign, or assurance temporarily narrows signing | Effective action/assurance policy | Current session | No false lack-of-permission notice when attestation.sign is allowed; keep precise assurance guidance when narrowed |

Implemented one shared organization lookup for assignment, signing and dispute resolution: active
role bindings plus currently valid, non-revoked, already-issued, unexpired credential organizations;
the selected signing credential's organization also stays in its existing basis. No credential or
role record is deleted. A resolver with an operator credential and unrelated role organization is
rejected, including cached replay; expiry is evaluated live. The existing signing-affiliation test
now covers a second operator credential added after assignment/signature request, not just a role
binding, and verifies normal signing recovers after affiliation withdrawal. UI selection is disabled
while busy and signing guidance uses the actual action plus existing assurance narrowing; removed
the repeated legacy-role copy. Focused 129 API/integrity/UI tests and typechecking passed. Before
fixing, the three targeted credential, delayed-response and permission-notice regressions all failed
on the previous production implementation. No warning/coverage policy was weakened.

Restoration and receipt-file decisions before the next correction:

| Case | Frozen vs live authority | Scope | Priority / outcome |
| --- | --- | --- | --- |
| Last objection dismissed after credential/schema/evidence invalidation | Keep original signed bytes and objection verdict; re-evaluate current basis under the existing evidence/configuration barrier | Original case and signed assignment, complete evidence scope | Record the dismissal but retain re-review status instead of restoring invalid professional support |
| Receipt references an unpromoted scanned document | Receipt channel evidence is part of original source provenance; uploader identity is a subject UUID | Same tenant/project receipt-backed file, including legacy projectless receipts within the claim project | Include uploader even without direct claim attachments or promotion; absent/missing/unknown upload attribution makes provenance incomplete |

The live-basis check now runs before the final dismissal can restore support, under the existing
configuration/project barrier. It reuses canonical authority/credential scope checks and verifies
credential dates/status, original assignment and signer independence, schema currency, policy/method
versions, review expiry and the complete case's claim/artifact/upload health. It does not compare
live grades to pre-signing grades: grade changes are derived outcomes, not evidence edits. An invalid
basis records the genuine dismissal and moves disputed → stale_candidate, with reasons and normal
stale propagation, rather than either activating invalid support or forcing a fabricated upheld
verdict. Existing revoked/superseded/stale states retain priority. The state machine explicitly
permits this re-review transition. UI explains reassessment and labels the credential result as its
at-signing result, preserving the distinction from live applicability.

Receipt contributors now traverse channel_evidence.documentUploadId even for unpromoted scanned
files. A tenant/project-scoped LEFT JOIN makes absent or unknown upload attribution incomplete;
legacy projectless receipts can only resolve files in the claim project. Direct document references
also retain unknown/missing attribution, and missing pinned receipts/artifacts fail closed. No
receipt or signed manifest is edited. Real API regressions upload as the reviewer, scan clean, create
both signed-document and bulk-export receipts as another person, submit receipt-linked claims with
no direct attachments, refuse self-assignment, then prove unknown attribution blocks drafting.
Six real-signature regressions cover revoked/expired credentials, retired/new schemas, stale claims
and changed policies while disputed; all preserve signed bytes and record the dismissal without
restoring analyst_checked. All eight targeted cases fail on the previous implementation. Focused
five complete API/channel/integrity/domain/UI files passed 247 tests; root/web typechecks passed.
The first new schema-clone fixture lacked an explicit PostgreSQL text cast; fixed the fixture and
reran all focused files. No production guard or threshold was weakened.

An additional restoration counterexample distinguishes schema creation from activation: a draft
created earlier may become active later. Creation order cannot establish current schema authority.
When multiple active versions share the schema key, restoration now fails closed as ambiguous;
retire superseded versions explicitly rather than guessing from created_at. The added old-draft
activation regression reproduces the incorrect activation on the first restoration implementation.
The previous cad47559 full suite passed 259 files / 4,142 tests (95.85% lines); its four affected
browser specs passed five tests. CI's earlier browser failure was a single ambiguous global
"Not assessed" selector after adding the full five-stage roadmap (127 other tests passed).
The existing workspace registration test now asserts all five ordered stage labels and each
unassessed status; its complete 18-test browser spec passed. No test was removed or weakened.

Next correction decisions: assignment conflict status has the same authority as at signing;
`disclosed_resolved` is a completed conflict review, so only `unresolved` blocks restoration.
Client case-list metadata is a view of persisted mutation results: signing, raising an objection
and resolving it must update both the selected case and cached list entry, so switching cases
cannot discard the saved attestation or resurrect an old disposition. The saved path still does
not fabricate original signature/credential-validity details.

Implemented the same non-unresolved conflict rule used at signing and one shared client metadata
update for all three attestation mutations. Signing also updates the cached case's signed state;
opening saved metadata still does not fabricate past signature details. One complete UI journey
signs A, visits B and reopens A, then repeats the switch after dispute creation and dismissal,
checking both current disposition and retained outcome. The existing two-objection standing test
now runs for both none and disclosed_resolved. Both targeted regressions fail on d42032bc; fixed
five complete API/channel/integrity/domain/UI files passed 250 tests and root/web typechecks passed.
The d42032bc broad runs were interrupted before these source edits and are excluded as current
verification; full checks will run on the fixed commit. Original data and all recorded verdicts
remain intact. No unrelated test cases or thresholds were removed.

Activation tracking and unknown-organization decisions before migration 0141:

| Identity / case | Authority and time basis | Input scope | Outcome / priority |
| --- | --- | --- | --- |
| Resolver has neither an active binding organization nor a current credential organization | Subject UUID; same live affiliation sources as signing | Tenant/project owner | Unknown is not independent; fail closed |
| Several schema versions were already active when signing | Frozen per-attestation activation epoch; live active schema and tenant/schema-key activation clock | Same tenant and schema key, not creation time or version-string order | Existing versions alone do not block restoration |
| A version activates/re-activates after signing, even from an older draft or after later deletion | DB-triggered monotonic clock; observed under existing tenant configuration/project barrier | Same tenant/schema key | Re-review; retain original signature and dismissal |
| Signature predates activation tracking | New nullable epoch remains NULL; never infer or backfill history | Original signed row | Unknown current replacement history requires re-review |
| API reads clock / trigger advances clock | mpc_app_login → mpc_app, withTenant transaction context; SELECT only and FORCE RLS | Own tenant only | Other tenant invisible; direct clock writes denied; privileged trigger writes chronology only, never expands consumer visibility |

The schema trigger's narrowly privileged clock write is not a cross-tenant consumer: its tenant/key
come from the row already authorized by schema RLS. Consumers retain ordinary tenant-scoped SELECT.
The existing configuration barrier serializes activation and capture; failures roll back nonce and
mutation writes so the same signing/dispute key can retry. Clock rows survive schema-version removal.

Implemented migration 0141 with a per-tenant/schema-key monotonic activation clock and nullable,
immutable per-signature epoch. Activation/re-activation advances the retained family clock; multiple
versions active before signing remain valid for restoration. No existing epoch or signature is
backfilled. Signing captures chronology under the configuration/project barrier; both signing and
resolution roll back cleanly on contention and retry with the same key. Unknown resolver/signing
organization fails closed using the shared live affiliation sources. The clock table has FORCE RLS,
tenant USING/WITH CHECK, and only SELECT grants for mpc_app; the narrowly privileged trigger owns
chronology writes. A transaction-only probe changed its owner to NOSUPERUSER/NOBYPASSRLS and proved
an actual mpc_app schema activation still writes epoch 1 without bypass; the probe was rolled back.
Tests also prove own/foreign tenant isolation with identical schema keys, other-tenant activation
exclusion, context cleanup, direct-write refusal, and frozen signed epochs. Targeted prior predicates
fail the unknown-organization and already-active-version regressions. Fixed five complete focused
files passed 255 tests; typechecks passed. The first organization fixture attempted an immutable
binding rewrite; it now revokes/grants, preserving history. A fresh disposable DB tested the final
uncommitted migration candidate; earlier disposable databases were retained, not rewritten.

The final workspace assertion separates the five-stage evidence roadmap from gate-assessment
records. In a combined browser run, tenant definitions can legitimately yield an incomplete
evidence assessment on a new project, so requiring every evidence stage to say "Not assessed" was
incorrect. All five ordered labels plus the specific absence of a gate assessment and no-pass
boundary copy are retained. The corrected complete five-spec browser run passed 23 tests; the first
combined run's failure and two wrapper working-directory mistakes are excluded, not reported as
application failures or passing evidence. Full production verification at 680a61f3 passed 259 files /
4,145 tests, 95.86% lines; migration 0141/current fixes require fresh full and rollback verification.

Current 636ff38b runtime checks passed all 23 affected browser tests, type/OpenAPI/brand checks,
and migration 0137–0141 populated-copy upgrade/restore/roll-forward. The complete application run
passed 4,149/4,150 tests: the sole failure required registering the new SECURITY DEFINER function
in the mandatory audit inventory. Classified it as SAME_TENANT with the RLS-authorized row scope
and documented it in the threat model; all four complete inventory checks passed. This is an
inventory completion, not a warning exception or an application behavior change. A clean full
coverage run will verify the final test/documentation follow-up.

Authority race decision before migration 0142: credential issuers and source authorities are
configuration inputs even when they have no source connections. Their writes must participate
in the same tenant configuration barrier as credentials/schemas/policies. A writer already in
progress makes signing/restoration fail fast with no partial writes; retry after commit must see
the suspended authority. If validation holds the barrier first, configuration writes follow it
in transaction order. Do not mix an unlocked authority read with renewal of professional support.
The clean 0baeefa2 coverage rerun was stopped before adding this correction and is excluded.

Migration 0142 adds authorities to the existing configuration write/truncate barrier without a
new privilege or reader. A real two-transaction API regression uses an accepted credential issuer
with no source connections, holds its suspension uncommitted, and attempts both final signing and
last-objection dismissal. Before the migration restoration incorrectly returns 200; afterward both
operations return retryable 503 with nonce/dispute writes rolled back. After issuer suspension
commits, the same keys yield a recorded stale_candidate dismissal and a blocked final signature;
the isolated claim stays unreviewed. This covers both current-basis consumers, not just the reported
restoration line. Six complete focused files passed 260 tests; root/web typechecks passed.

Restoration follow-up decisions: the original signer must still have known independent affiliation,
not merely lack a known operator match. Share the same nonempty/non-operator predicate with signing
and adjudication. A retained directly attached document uses the ledger's UTC-day validity rules
(today remains valid; yesterday is expired), replacement/open-impact and upstream invalidation
checks even when no source receipt exists to propagate claim.stale_since. Keep signed history and
record the genuine verdict; invalid current support stays in re-review. c91118cd broad runs were
stopped before these edits and excluded from final-head evidence.

Shared one nonempty/non-operator organization predicate across signing, original-signer restoration
and independent adjudication. Restoration's upload health now matches the ledger's UTC-day expiry,
replacement/open-impact and upstream invalidation conditions for direct as well as receipt-backed
documents. A real dynamically assigned/signed review loses its sole known organization through
revoke/grant, and dismissal correctly records stale_candidate while preserving signed history.
Separate isolated-tenant structured-claim tests directly attach a promoted upload with no receipt
or stale_since: expiry today restores normally, expiry yesterday requires re-review. The old code
fails both negative regressions while the valid-day boundary passes. Six complete focused files
passed 263 tests; root/web types passed. New fixture setup initially omitted the deferred catalog
approval transaction and a required valueText; corrected the fixtures without relaxing validation.
Migration 0137–0142 populated-copy upgrade/restore/roll-forward also passed; migration files did not
change in this follow-up. c91118cd broad runs were stopped before source edits, not counted as final.

Fresh demo signatures now capture loadSchemaActivationEpoch in the same generation transaction
that already owns configuration writes. Production attestation producers were checked: unsigned
API drafts retain NULL until final signing, final signing captures its epoch, and fresh dev-demo
signed inserts now do likewise. Existing/reused signed fixtures are not updated or backfilled.
Extended the existing real-signature/idempotent seed test to require both fresh REVIEW/PUBLIC epochs
to match their current family clocks. It fails on the previous seed (the other six seed tests still
pass) and passes after the fix. Seven complete focused files passed 270 tests and root/web types
passed. The already-fixed signer-organization finding on an earlier revision was reported again;
its shared predicate and real regression remain in 97cfc884.

Role-affiliation race decision before migration 0143: active role grants/revocations are live
organization inputs and must share the tenant configuration barrier. The actual affiliation reads
already occur inside signing/restoration's barrier; add the missing writer participation. Preserve
subject-row → configuration ordering: signing holds subject FOR SHARE, and second-person role
approval takes subject FOR NO KEY UPDATE before inserting a binding. Do not move signing's subject
lock behind the barrier and create an inversion. Request-session permission resolution remains the
existing once-per-request contract; live organizational facts are serialized at the decision.

Final-signing assignment decision: a typed signature request freezes the original assignment ID,
not perpetual authority to use a subsequently revoked assignment. Revocation committed before the
final decision must be observed. Test the same assignment/case row locks used by the curator route;
do not let an earlier unlocked join cache the old revoked_at while its final case write waits.

Migration 0143 adds role-binding writes to the existing configuration barrier, including
TRUNCATE rejection. A real two-transaction grant to the operator organization blocks both final
signing and independent dispute resolution with retryable 503, consumes neither request nor
verdict, and rejects the now-conflicted actors after commit. Revoking the conflicting grants
allows the same requests to finish without changing historical bindings.

Final signing now locks the draft, assignment and case before reading their live decision state.
The corrected regression tests reproduce both prior defects (HTTP 200): a curator revokes the
assignment while signing waits, and a cancelled case reuses a previously issued signature request.
Both now reject acceptance and preserve the draft/cancelled state. The existing suspension race
now asserts the corresponding earlier lock boundary: a suspension committed while signing waits
on the attestation is observed before acceptance. Historical signed records remain unchanged.
Six complete focused files passed 205 tests; root/web typechecks passed. Initial fixture attempts
used an out-of-scope transition helper, stale case version and incorrect unsigned-wallet default;
these were corrected, and the old-code reproduction rerun successfully for both real defects.
