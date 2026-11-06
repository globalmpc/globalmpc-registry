# Registry workspace UI guide

Use the shared brand rules in `design-system/docs/patterns.md`, `tokens.md`, `logo.md` and `voice.md`. Edit their source under `design-system/content/` or `tokens/`, not generated documentation. The reference at https://mpc-registry-design.vercel.app/ establishes the desired density and hierarchy; its prototype controls and sample results are not application requirements.

This is an application, so adapt marketing section spacing to compact work sections. Keep existing design tokens, typography, restrained copper accents, thin rules and one shared content width. Use whitespace and headings before introducing another box. Keep dialogs and urgent notices visually distinct from ordinary sections.

## Screen acceptance criteria

- One clear page title and a short statement of the task. Avoid paragraphs explaining implementation.
- Show the primary list or current task before reference statistics, administrative setup or history.
- One primary search for a collection. Keep key/proof lookup and other specialist searches together under advanced tools.
- One main navigation hierarchy. Project work uses Overview, Documents/evidence, Review and Publication; subtools stay within the active area.
- Keep lists compact and scannable. Preserve status, date, version, revocation and material limitations; never infer missing stage/result totals.
- Use context to reveal the next action. Preserve entered drafts when showing another section. Do not hide blockers, errors, pending approvals or the scope of a consequential action.
- Keep technical hashes, raw payloads and reproducibility data secondary where the existing contract permits it. Never present evidence readiness as a human approval.
- Header popovers are mutually exclusive. Click outside or Escape dismisses them; keyboard users can return to the trigger.
- Use native links for navigation and buttons for actions. Visible labels, focus state and status cues must work without colour alone.
- At 390px, keep the screen usable without page-wide horizontal scrolling. A local table/tab scroller is acceptable when its content needs it. Check opened menus and dialogs too.
- Always review initial, loading, empty, error, selected-item, saved and return-navigation states. A successful build is not usability evidence.

## Verification and evidence

Review representative desktop/mobile screenshots alongside the reference and trace the real task. Component tests cover interaction contracts; browser tests cover actual visibility and navigation. Mocked API screenshots establish presentation only. State separately which authenticated/persisted/external-service journeys were exercised and which remain pending. Do not call all screens reviewed merely because a global stylesheet changed.

## When a control moves

Treat a relocation as an interaction-contract change. Before requesting review, enumerate all consumers by destination and meaning, not only by the previous button label. Search links, accessible labels, test IDs, shared helpers, standalone journeys, retries and opt-in chain/mobile projects. Include every return visit that recreates a closed disclosure.

For the current navigation, the consumer map is: Account → shared sign-in helper, role visibility and direct sign-out journeys; Workspace → global navigation and project pickers; footer More → public destinations and legal navigation in both anonymous and signed-in states; advanced lookup → public search, Golden path and chain confirmation; project tools/details → document status, fact/party forms, applicability changes and lifecycle badges. Shared E2E disclosure helpers open menus idempotently. Typecheck/test discovery do not verify visibility: run the changed real-browser consumers, including a return visit and the opposite sign-in state where applicable.
