# Readiness policy selection

The Readiness and Gate Decision pages submit a demo policy UUID. Deployment demo
projects are separate input/review/public snapshots and create no readiness or
stage policies. A tenant without that UUID receives Policy set not found.

| Case | Authority and time | Inputs | Expected result |
| --- | --- | --- | --- |
| Options | Authenticated tenant and readiness.recompute project scope | Existing project host country, matching-jurisdiction effective policies with effective_from <= now | Return only this tenant's live policy metadata |
| Missing/other tenant project | RLS and project authorization | Requested project UUID | Refuse without returning policy metadata |
| Several policies | Explicit user choice, labelled gate/jurisdiction/version | Server-supplied policy IDs | No arbitrary first-policy default |
| One policy | Sole eligible option | Optional gate scope from the decision page | Preselect the actual UUID |
| No policy | Approved registry records | Empty options | Disable recomputation and show registry setup guidance |
| Historical assessments | Existing immutable assessment and signed decision contracts | Selected policy only affects a new recomputation | Preserve stored hashes, past results and approval separation |
| Gate decision | Route gate ID and explicit selected policy | Policies for that gate | Discard assessment when selection changes |

Acceptance covers a random non-demo policy, absent/draft/future/other-tenant
policies, authorization, account/project changes and both UI entry points.

## Initial verification

The original UI fails the two new regression cases for real policy selection and
missing-policy guidance. The revised UI passes all 523 web tests. Direct API tests
reproduce the exact Policy set not found response for the old seed UUID and
successfully assess with the returned non-demo UUID. They verify anonymous,
wrong-role, wrong-project and other-tenant requests under a non-superuser,
NOBYPASSRLS application role. The four new API cases and seven selection UI cases
pass. Typecheck and OpenAPI generation pass.

Initial test setup exposed an invalid test-fixture project reference and a shared
component's unnecessary session-provider dependency. Both were corrected before
publication. The first browser run used an organization UUID as a project UUID in
the new test and failed its two cases. The corrected browser test owns a project
created in its isolated E2E database and is being rerun with complete affected specs.

The deployment's live trace ID and account were not accessed. The diagnosis is
from the matching API error and reproducible code path. This change supplies
selection and setup guidance; authorized reviewers still define and approve actual
stage requirements through the existing registry workflow.


## Browser and review follow-up

The corrected complete browser run passed all six tests across
`golden-path.spec.ts`, `readiness-policy-selection.spec.ts`, and
`reference-experience.spec.ts`. It covers real account switching, claim review and
signing, non-demo policy selection on both readiness entry points, missing-gate
setup guidance, the registry destination, and anonymous publication. No retries
were needed in the corrected run.

Duno identified one UX inconsistency: only Requirements supplied policy setup
permission to the shared empty-stage notice. All four workspace callers now pass
the current actor's registry-read capability. Focused ledger, project, registration,
decision and document UI checks passed (42 tests). The independent human security
review remains required for the endpoint.

The first full check detected the required primary-layer mapping was missing for
the new route. Added its Data & Oracle mapping; all 17 platform contract tests now
pass. No rule or threshold was changed. Full verification is rerun on the correction.


The next review requested project jurisdiction scoping. Options now use the
project's host_country_iso3, matching the existing evidence-stage policy discovery,
and exclude other-jurisdiction policies even in the same tenant and gate. This
changes discovery only and preserves explicit legacy recomputation contracts.
The API fixture adds a same-tenant, same-gate ZAF policy and proves its exclusion
for the MNG project. Removed redundant per-handler UUID validation, relying on the
existing request-context check that returns 400 before the handler; the malformed
UUID regression executes that real middleware.

Primary connected-flow review also found the Readiness result's decision link
still named the demo publication gate. It now uses the selected policy's gate,
with a regression for stage.exploration. The focused policy-selection and project
registration suite passes all 14 tests. Existing publication navigation remains
explicitly labelled for publication.

## Deliberate legacy evaluation contract

The options endpoint recommends policies for the current host country and current
time; it does not redefine the existing POST evaluation contract. The legacy POST
accepts an explicitly supplied, tenant-visible policy with state `effective`, reads
that policy's own jurisdiction profile, and records the policy ID and evaluation
time in the immutable assessment. Its existing jurisdiction-profile tests explicitly
exercise synthetic profile namespaces independent of the project's ISO3 country.
It does not currently reject a future effective_from or another profile key.

This PR deliberately preserves that broader contract rather than silently changing
existing direct API clients or historical interpretation. Discovery is therefore a
UI recommendation filter, not a new security boundary. Tenant, project, role,
idempotency, immutable-result and separate signed-decision authorization continue
to be enforced by the existing handlers. A future change that makes policy
time/jurisdiction eligibility mandatory on POST must define migration and gate
semantics and add direct negative tests; this remains a limitation for the human
security reviewer to assess before merge. The picker alone must not be described
as enforcing that broader policy eligibility rule.
