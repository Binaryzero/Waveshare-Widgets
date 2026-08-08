# Hybrid — the Meter instrument, restated

The brief, as clarified: Meter's interface, Lume's font on it, scan lines
removed from the background, the green background made blue, accent colors
left alone.

Recipe, applied to the Meter proof:

- **Type**: Lume's Outfit (300/400/500/700) replaces Rajdhani and IBM Plex
  Mono — both `--disp` and `--mono` stacks resolve to Outfit.
- **Scan lines**: the repeating scanline overlay is removed; the corner
  vignette stays.
- **Field**: every green-cast chrome value becomes a blue-cast equivalent —
  the bezel, the machined plate and its gradient, the page glow wash, the
  engineering-grid dots, all hairline rules, the plate etching, and the
  green-tinted readout neutrals (`--text`, `--muted`, `--dim`, and their
  hardcoded uses in the weather and transport glyphs). Per follow-up review
  the field is lifted a step lighter than Meter's darkness
  (`--bezel #070b12`, `--field #0f141b`).
- **Accent**: green phosphor on the blue field clashed, so per follow-up
  review the phosphor is re-pitched from green to cyan at the same
  saturation and brightness (`#4de8a4` → `#4dd4e8`), including every
  hardcoded data fill (album EQ, rings, spectrum floor). `--amber` and its
  alert roles are byte-for-byte what Meter used.

Render with `node design/poc/shot.js` (writes `shots/hybrid.png`).
