# Hybrid — the Meter instrument, restated

The brief, as clarified: Meter's interface, Lume's font on it, scan lines
removed from the background, the green background made blue, accent colors
left alone.

Recipe, applied to the Meter proof:

- **Type**: Lume's Outfit (300/400/500/700) replaces Rajdhani and IBM Plex
  Mono — both `--disp` and `--mono` stacks resolve to Outfit.
- **Scan lines**: the repeating scanline overlay is removed; the corner
  vignette stays.
- **Field**: every green-cast chrome value becomes its blue-cast equivalent
  at the same darkness — the bezel, the machined plate and its gradient, the
  page glow wash (`rgba(77,232,164,.05)` → `rgba(77,164,232,.05)`), the
  engineering-grid dots, all hairline rules, the plate etching, and the
  green-tinted readout neutrals (`--text`, `--muted`, `--dim`, and their
  hardcoded uses in the weather and transport glyphs).
- **Accents untouched**: `--phos` phosphor green and `--amber`, and every
  `rgba(77,232,164,…)` data fill (album EQ, rings, spectrum floor), are
  byte-for-byte what Meter used.

Render with `node design/poc/shot.js` (writes `shots/hybrid.png`).
