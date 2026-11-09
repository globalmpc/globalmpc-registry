# Changelog

## 0.2.1

- `css/utilities.css`: the `.copper-shimmer` highlight now mixes `--gold` with `var(--foreground)` instead of the named colour `white`, so no named colour is left in the utilities. `dist/` rebuilt.
- Nothing else changed from 0.2.0. Consumers that took 0.2.0 only need to resync `utilities.css`.

## 0.2.0

- `css/utilities.css`: replaced every literal `oklch(...)` colour with design tokens (`var(--copper)`, `var(--gold)`, `var(--positive)`, `var(--border)`) or `color-mix()` against them. Affects `.grid-lines`, `.grid-pan`, `.copper-gradient`, `.glow-copper`, `.copper-shimmer` and the `live-dot` keyframes. Palette changes in `tokens/color.json` now flow through to the utilities.
- Visible effect: the copper stops move slightly to the token values (for example `oklch(0.72 0.13 55)` is now `--copper`, `oklch(0.68 0.13 50)`), and the shimmer highlight is now `--gold` mixed with `--foreground` (no named colour left in the mix).
- `dist/` rebuilt from source; version strings in generated files now read 0.2.0.

## 0.1.0

- Initial release.
