# Candidate A — Meter, restated

One reading of the hybrid brief: *"the font from Lume on everything with Ledger
but without the scanline and swap the green to blue."*

Recipe, applied to the Meter proof:

- **Type**: Lume's Outfit (300/400/500/700) replaces Rajdhani and IBM Plex Mono
  everywhere — both `--disp` and `--mono` stacks resolve to Outfit.
- **Texture**: the CRT scanline overlay is removed. The corner vignette stays;
  it is the only remaining atmosphere layer.
- **Color**: phosphor green `#4de8a4` becomes blue `#54b9ff` — in the tokens
  (`--phos`, `--phos-rgb`) and in the hardcoded SVG fills (album-art EQ bars,
  gauge rings). Amber `#ffae52` is untouched: it was the *warning* accent, not
  the green, and the brief only reassigned the green.

Everything else — grid, tile anatomy, index numerals, rail charts, the
`PLINTH · MFD-1280 · REV A` plate — is Meter unchanged.

Render with `node design/poc/shot.js` (writes `shots/candidate-a.png`).
