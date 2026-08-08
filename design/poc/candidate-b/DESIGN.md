# Candidate B — Ledger, restated

The hybrid brief: Lume's type on Ledger, no scanlines, green swapped to blue.

Recipe, applied to the Ledger proof:

- **Type**: Lume's Outfit (300/400/500/700) replaces both Fraunces and Archivo.
  The `--serif` and `--grot` stacks resolve to Outfit; the italic Fraunces
  moments become weight-300 Outfit (no italic is vendored).
- **Texture**: both texture layers are gone — the full-page paper-grain noise
  overlay and the engraved cross-hatch behind the album art. The skyline
  silhouette is lifted from `#0f0d0a` to `#211d17` so it still reads against
  the plain dark ground.
- **Color**: the spot accent — Ledger's only accent color, used for URGENT
  advisories and the playing state — is now blue `#54b9ff` instead of
  vermillion `#e65f2e`.

Everything else — the masthead, double rules, tabular advisories, the bar-chart
footnote — is Ledger unchanged.

Render with `node design/poc/shot.js` (writes `shots/candidate-b.png`).
