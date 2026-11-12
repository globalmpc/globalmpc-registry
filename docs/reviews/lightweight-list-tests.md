# Lightweight list regression fixtures

User scope: bulk-processing validation is not required. Reduce test-generated
work without deleting existing data, changing production code or dropping
functional/security assertions.

The capped-list suite previously seeded 10,000 uploads and walked 100 API pages.
It now creates 502 uploads and walks six pages: five full pages and one partial
page. 502 exceeds the 500-node graph cap even after an old focused node is added.
It also retains 501-impact truncation, the 200-row upload limit, timestamp ties,
sub-millisecond cursor precision, ordering, no duplicates/gaps, terminal cursor,
invalid input and the other capped lists. All 16 existing test cases remain.
Full walked ordering and the partial-page size now have explicit assertions.

Removed the bulk traversal timing summary and its per-page latency assertion
because the user explicitly excluded bulk-processing validation. This removes a
performance claim, not a functional acceptance criterion. No production
threshold, coverage setting or timeout is relaxed. No DELETE/TRUNCATE/reset or
production/configuration change is introduced. Existing rows are not removed;
fixtures use their own new tenant/project as before.

Focused before/after measurement on Node 24.22.1, same database and LOG_LEVEL=silent:
16/16 pass in both versions. Suite reported duration 1,223 ms -> 340 ms; cursor
case 499 ms -> 27 ms. These are single samples, not performance guarantees. Process
peak RSS was 321,680 KiB before and 349,296 KiB after; this does NOT demonstrate
reduced peak process memory. The proven saving is fixture rows/API calls and
observed test time. Full API imports remain a separate memory cost.

The first reduced fixture used 501 rows and exposed that focused graph selection
then includes all rows, so truncated correctly became false. Use 502 to preserve
that existing truncation case rather than weakening its assertion. No production
bug was inferred from that initial fixture failure.

Full verification uses a newly created isolated test database, leaving the prior
database and its existing rows untouched. The earlier manager scheduling PR 308
was closed; this change belongs to application PR 137.
