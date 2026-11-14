# Registry design-system QA disposition — 2026-11-13

Canonical authority: [mustcompany/globalmpc-designsystem v0.3.0, 4b96172](https://github.com/mustcompany/globalmpc-designsystem/tree/4b96172bdb19e2cd67743d88fb6be6530b330f3a).
The Registry consumer copy is not the authority. This review covers the 2026-11-13 QA findings relevant to this repository.

| Finding | Disposition | Evidence / change |
| --- | --- | --- |
| FRONT-18 | Existing workspace rule retained | ADR-T11's1248px workspace shell already shares its width/gutter across header, main and footer. Marketing1280px is not a requirement for this workspace. |
| FRONT-26 | Updated | Canonical v0.3.0 token/rule sources and generated outputs, including `--mark`. SOURCE.json records source commit and integrity hashes. |
| FRONT-27 | Fixed | 28px mark-file height requires14px external clearance; gap8px + label margin6px now provides14px. |
| FRONT-28 | Fixed for supported tile sizes | Replace tightly cropped SVG favicon with a generated multi-size ICO. Artwork comes unchanged from the canonical mark; layout supplies the tile clearspace. All seven sizes are declared explicitly in metadata. |

The existing Registry country-neutral reference-case and steppe-token wording is preserved by the sync script.
Consumer package metadata and artwork infrastructure remain local; builds do not fetch the private source.
Homepage, Unity, Pre-Check-In, archived Pre-sale and security-agent changes are outside this PR.

## Reproduction and measurements

Anonymous local Next dev page at390px and1440px viewport widths, with no production credentials:
no horizontal overflow; product label stays hidden at the existing mobile breakpoint;
visible desktop wordmark-to-product gap14px; mark-file height28px.
The favicon metadata points to `/favicon.ico` and advertises all embedded sizes.
See [measurements](2026-11-13-registry-measurements.json) and the local screenshots.

| Tile | Drawn mark height | Minimum edge clearance | Canonical requirement |
| --- | --- | --- | --- |
|16px|16px|0px|Known source limitation: a24px mark cannot fit. No invented small variant. |
|24px|24px|0px|Keep24px mark below32px tile. |
|32px|24px|4px|At least0.15× mark height (3.6px). |
|48px|24px|12px|0.5× mark height. |
|64px|32px|16px|0.5× mark height. |
|128px|64px|32px|0.5× mark height. |
|256px|128px|64px|0.5× mark height. |

ICO entries were independently decoded and measured using Pillow alpha bounds.
`pnpm check:brand` independently regenerates the favicon and compares exact bytes, retains
the unmodified TopBar SVG-copy check, and verifies all pinned design-source hashes.
Regenerate with `node scripts/sync-brand-icon.mjs` after a canonical artwork update.
The16px limitation remains dependent on an upstream small-mark design; it is not reported as fully resolved.

## Validation

- `pnpm typecheck` passed; OpenAPI drift check and brand integrity check passed.
- `pnpm --dir design-system test`: 28 tests passed, including the existing country-neutral-token regression.
- Full `pnpm check` passed with a disposable local PostgreSQL17 instance: 258 suites and4093 tests passed, no skipped tests. The earlier DB-free run had1955 skipped tests and is not used as DB-validation evidence. Final typecheck and brand checks passed after the favicon metadata change.
- Local Chromium checked the anonymous public page at390/1440px and the emitted favicon metadata. This does not establish authenticated role journeys or production deployment behavior.

## Duno review corrections — 2026-11-13

Two actionable tooling bugs were reproduced before correction:

- A checkout path containing spaces and `#` percent-encoded the dependency lookup through URL.pathname. Favicon generation now uses fileURLToPath. The regression invokes the real favicon command in an isolated `Registry Workspace #1` checkout and compares the generated ICO bytes.
- Recursive copying retained deleted/renamed canonical files. Sync now replaces its four managed source directories, removes the three generated-output directories before regeneration, and applies country-neutral overrides independently of JSON filenames. A fixture renames color.json to colors.json, leaves obsolete input/output files, and verifies successful sync, deletion, deterministic repeat sync, and preservation of local README/artwork tooling.

Both regression tests failed on the previous implementation and pass after correction.
They are part of `pnpm check:brand`, so future full checks exercise both cases.
The initial corrected test fixture still referred to the renamed color.json; that fixture error was corrected to colors.json before the passing run.

Six secret-scan comments refer to file-integrity SHA-256 digests, verified against the files by check:brand. They are not credentials. The manifest now records each digest as an explicit sha256 field instead of placing it beside a token-named filename. No digest values or scan rules were suppressed to remove those false positives.
