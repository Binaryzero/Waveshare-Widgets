# Candidate B — Ledger, restated

The other reading of the hybrid brief: *"the font from Lume on everything with
Ledger but without the scanline and swap the green to blue."* Ledger is the
named base here; it has no scanline and no green, so the nearest equivalents
were treated as the targets.

Recipe, applied to the Ledger proof:

- **Type**: Lume's Outfit (300/400/500/700) replaces both Fraunces and Archivo.
  The `--serif` and `--grot` stacks resolve to Outfit; the italic Fraunces
  moments become weight-300 Outfit (no italic is vendored).
- **Texture**: the engraved cross-hatch behind the album art — Ledger's closest
  thing to a scanline — is removed. The skyline silhouette is lifted from
  `#0f0d0a` to `#211d17` so it still reads against the plain dark ground.
- **Color**: unchanged. Ledger's accent is vermillion, not green, and swapping
  the paper's own palette would stop it being Ledger.

Everything else — the masthead, double rules, tabular advisories, the bar-chart
footnote — is Ledger unchanged.

Render with `node design/poc/shot.js` (writes `shots/candidate-b.png`).
