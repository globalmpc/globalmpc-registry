<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Navigation and accessible-name changes

- Before renaming or moving a link, button, menu or heading, search its old accessible name, destination and shared helpers across `src`, `test` and **all** `e2e` files. Inventory the affected consumers before selecting verification; do not stop at the tests already edited in the PR.
- Distinguish a navigation link's name from the destination heading. Update only the intended surface; a renamed link does not imply the page title changed.
- Run the complete affected browser spec files against the final UI, including signed-out and signed-in navigation, role visibility, menu dismissal and destination assertions. A grep-selected regression proves only that case, not the rest of its spec. For public/workspace chrome, include `public-surface.spec.ts` and `workspace-screens.spec.ts`, plus any other consumers discovered by the search.
- Keep user-facing accessible-name and destination assertions. Do not replace them with href-only selectors or derive all expected labels from production navigation constants just to make renames pass; retain an independent assertion of the intended copy and journey.
- For relocated always-visible links, verify access without opening their former menu. Preserve the original authorization and negative-role checks.
- Record the affected-spec inventory, before/after reproduction, complete-spec results and any unexecuted scope in the review evidence before requesting re-review.

Regression reference: PR #136 renamed the footer's `Proof Verifier` link to
`Verify a proof`, but only some navigation tests were updated. The unchanged
signed-in journey in `e2e/workspace-screens.spec.ts` still used the old accessible
name. Passing selected reference journeys did not establish whole-chrome coverage.

## List enrichment and request budgets

- Trace each per-row fetch through its API handler and database/service work before adding list enrichment. Record list size, worst-case simultaneous visible rows, repeat loads, and whether results are live computations or persisted snapshots.
- Visibility deferral is not a request budget. For expensive row reads, prefer a batched or authoritative summary; otherwise require explicit user demand and enforce a shared concurrency bound that survives row/filter remounts, without caching private results across identities. A concurrency cap does not bound total automatic evaluations; measure both.
- Test more rows than the concurrency limit with deferred responses. Verify actual peak requests, cancellation of queued rows, account/project changes, rapid filter replacement, failures and 429. Do not treat a single-row success as scalability evidence.
- Unmounting a row does not prove the server stopped its work. Do not release a running request's budget early; discard stale results and remove queued work. Preserve transport timeouts.
- Rate-limited optional summaries must leave the list and project navigation usable. Stop queued/automatic request waves, avoid per-row retry loops, and test recovery in the same mounted row after cooldown without replaying obsolete work. Keep an explicit retry control; verify clicks during cooldown produce no network request and a later click succeeds.
- Before re-review, revisit the full changed flow for correctness, authorization, failure recovery, workload scaling and accessibility; do not limit the audit to the last comment's category. Record any remaining O(N) work or unverified load assumption explicitly.
