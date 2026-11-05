# Shared screen design review

The reference uses a restrained header, one clear heading, a compact search and rows separated by fine rules. The previous app repeated bordered panels at every nesting level. This change applies the same section, table, typography, spacing and mobile treatment through the root stylesheet to all page routes. Modal panels keep their distinct surface and padding.

Project navigation now shares four primary areas across overview, files, document status/detail, claims, verification, readiness, decisions, publication and CRE. Contextual tools stay within the active area; overview tools are disclosed on demand. Document status puts the actual document list before supporting counts and administrative declarations. Public project lists use the same compact row layout. Existing forms, permissions, destructive confirmations, error/warning notices, signed data and approval boundaries remain intact.

| Identity / case | Authority / time | Scope | Result |
| --- | --- | --- | --- |
| Project navigation | Current route only | Project URL; no data inference | Documents and claims share one area; review/readiness/decisions share an area; publication/CRE share an area |
| Assessment and human decision | Existing server responses | Existing authenticated project | Remain separately labelled; layout never changes status |
| Public results | Existing approved projection | Existing public endpoints | Same status, version, revocation and limitations |
| Modal and failure state | Existing component logic | No persistence or authorization change | Retain visible surface, validation and warnings |

Verification: web component/regression suites and typecheck; browser desktop/mobile checks of public routes and the project overview with mocked API responses. These checks do not establish live deployment, persisted workflows or real external-service behavior; CI browser/DB checks remain required. The route inventory below records shared visual coverage, not a claim that every authenticated journey was manually executed.

## Route inventory

- `/account/email-change`
- `/asset-registry`
- `/auth/mfa`
- `/auth/oidc/[provider]/callback`
- `/connect`
- `/disclosures`
- `/explorer`
- `/explorer/projects`
- `/explorer/projects/[publicKey]`
- `/explorer/search`
- `/explorer/verifications`
- `/governance`
- `/invitations/accept`
- `/legal`
- `/`
- `/verify`
- `/w/access-pending`
- `/w/access-requests`
- `/w/activity`
- `/w/admin`
- `/w/anchors`
- `/w/audit`
- `/w/authorities`
- `/w/data-room`
- `/w/governance`
- `/w/identity/upgrade`
- `/w/integrations`
- `/w/notifications`
- `/w/projects`
- `/w/projects/[id]`
- `/w/projects/[id]/access-requests`
- `/w/projects/[id]/claims/[claimId]`
- `/w/projects/[id]/cre`
- `/w/projects/[id]/data-room`
- `/w/projects/[id]/documents`
- `/w/projects/[id]/documents/[uploadId]`
- `/w/projects/[id]/gates/[gateId]`
- `/w/projects/[id]/impacts`
- `/w/projects/[id]/publication`
- `/w/projects/[id]/readiness`
- `/w/projects/[id]/verification`
- `/w/projects/new`
- `/w/readiness`
- `/w/registries`
- `/w/settings`
- `/w/verification`
- `/w/work`

## Verification result

461 web tests across 36 files, web typecheck and production build passed. Mocked-API browser checks covered 11 public/authentication routes plus the project overview at desktop and 390px mobile widths without horizontal overflow or page errors. The invitation missing-token screen intentionally uses a notice instead of an h1; the initial smoke harness incorrectly waited for h1. Initial generic governance/disclosure mocks lacked required fields; corrected to match their contracts before rerunning successfully. The first push failed with a GitHub Internal Server Error and succeeded on retry.

## Reference composition follow-up

The public header now matches the reference composition: mark, MPC wordmark, product subtitle and sign-in. Secondary public destinations move to the footer. The landing page uses the reference title position, 1248px inner content measure, muted subtitle, three inline outline-icon summaries, one 576px search input and 80px project rows. Displayed record fields remain actual public API fields; prototype stage/result totals are not manufactured. A side-by-side screenshot compares reference and implementation at 1440px. Header/footer menus dismiss on outside interaction and Escape. Anonymous, authenticated and missing-token footer states remain distinct.
