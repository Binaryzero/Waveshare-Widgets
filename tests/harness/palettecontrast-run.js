#!/usr/bin/env node
// Issue #217 — muted text must stay legible on the GLASS settings sheets, not just on the
// opaque surface. #propSheet / #stylePanel paint `--surface` at 94% opacity over the
// user's wallpaper (a sibling behind the glass, not an ancestor), so `.ps-help`, the
// field labels and the hints render over `--surface` COMPOSITED with whatever the
// wallpaper is — and a `--text-muted` tuned to exactly 4.5:1 on the opaque surface drops
// below it once a bright (or dark) wallpaper bleeds through the 6% that is not surface.
//
// This drives WWPalette.derive (the JS port; PaletteEngine.cs is its C# twin, kept in
// lockstep) over a battery of themes and measures muted where it is actually painted:
// against `--surface` composited over BOTH pure white and pure black at the sheet alpha —
// the bracket the rendered page cannot fall outside of, whatever the wallpaper. The
// pre-fix engine repairs muted only against the opaque surface, so this suite FAILS
// against it (several themes land in the 4.2–4.6 band once composited) and passes once
// the derive repairs against the composited extremes.
//
// Node, not a browser: this is pure derive+contrast arithmetic, and the point is to sweep
// many themes deterministically. contrast.js already proves the RENDERED sheet composites
// this way (its bracket cites the same "4.50:1 → 3.74:1 over a bright wallpaper" case).
'use strict';
const fs = require('fs');
const path = require('path');

const SHELL = path.resolve(__dirname, '..', '..', 'src', 'Plinth', 'Shell');

// Load palette.js the way the settings window does — an IIFE that hangs WWPalette off a
// window object. No DOM is touched by derive(), so a bare object is enough.
const win = {};
new Function('window', fs.readFileSync(path.join(SHELL, 'palette.js'), 'utf8'))(win);
const derive = win.WWPalette && win.WWPalette.derive;

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  if (!ok) failures++;
};

if (typeof derive !== 'function') {
  console.log('  FAIL palette.js did not export WWPalette.derive');
  process.exit(1);
}

// ---- WCAG contrast, identical to palette.js / PaletteEngine.cs -----------------------
const hexToRgb = (h) => { const v = parseInt(h.replace('#', ''), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };
const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const contrast = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };

// The sheet is `--surface` at this opacity over the wallpaper (shell.css #propSheet /
// #stylePanel). The browser composites source-over in float, so match that — no rounding
// of the composite, unlike the 8-bit muted colour itself.
const SHEET_ALPHA = 0.94;
const overWallpaper = (surface, wallpaper) => [0, 1, 2].map((i) => surface[i] * SHEET_ALPHA + wallpaper[i] * (1 - SHEET_ALPHA));
const WHITE = [255, 255, 255], BLACK = [0, 0, 0];
const AA_NORMAL = 4.5;
const round2 = (n) => Math.round(n * 100) / 100;

// Worst-case muted contrast on the glass sheet: the lower of "over a white wallpaper" and
// "over a black wallpaper". Reported and asserted to 2 decimals, because muted is an 8-bit
// colour and a float target of exactly 4.5 is only reachable to within quantisation — the
// same tolerance the opaque repair has always carried.
function mutedOnGlass(spec) {
  const tokens = derive(spec);
  const surface = hexToRgb(tokens['--surface']);
  const muted = hexToRgb(tokens['--text-muted']);
  const onWhite = contrast(muted, overWallpaper(surface, WHITE));
  const onBlack = contrast(muted, overWallpaper(surface, BLACK));
  return { surface: tokens['--surface'], muted: tokens['--text-muted'],
    opaque: round2(contrast(muted, surface)), onWhite: round2(onWhite), onBlack: round2(onBlack),
    worst: round2(Math.min(onWhite, onBlack)) };
}

// A spread of themes: the stock dark, colored darks (the regime where a near-black surface
// is lightened most, relatively, by a 6% white bleed), a light theme (where a black
// wallpaper is the biting extreme instead), and a mid-tone. Every one of these clears 4.5
// on its opaque surface; the question is whether it still does behind the glass.
const THEMES = [
  { name: 'stock-dark', accent: '#4dd4e8', background: '#070b12', text: '#dde2e8' },
  { name: 'olive-dark', accent: '#8fbf5f', background: '#141d0c', text: '#e8ecdd' },
  { name: 'forest-dark', accent: '#5fd08a', background: '#16220f', text: '#e6ecdf' },
  { name: 'maroon-dark', accent: '#ff6268', background: '#1e0f10', text: '#f0e2e2' },
  { name: 'teal-dark', accent: '#4dd4e8', background: '#0c1a1c', text: '#dfeaea' },
  { name: 'slate-mid', accent: '#7aa2c0', background: '#2a2f36', text: '#e2e7ee' },
  { name: 'parchment-light', accent: '#b45f2a', background: '#efe7dc', text: '#241a12' },
  { name: 'paper-light', accent: '#2f6f9f', background: '#f4f2ee', text: '#1c2530' },
];

console.log('#217 muted-on-glass contrast (settings sheet over wallpaper)');
for (const theme of THEMES) {
  const m = mutedOnGlass(theme);
  check(`${theme.name} muted clears ${AA_NORMAL}:1 behind the 94% sheet, over any wallpaper`,
    m.worst >= AA_NORMAL,
    `surf ${m.surface} muted ${m.muted} · opaque ${m.opaque} · whiteWall ${m.onWhite} · blackWall ${m.onBlack} · worst ${m.worst}`);
}

// Non-vacuous: the opaque contrast is high enough that this suite would trivially pass if
// it measured the wrong thing. Assert at least one theme's worst-case is genuinely CLOSE
// to the floor — otherwise a regression that reintroduced the opaque-only repair could
// slip through on headroom alone. (Pre-fix, these worst-cases sit BELOW 4.5.)
const worstOfAll = Math.min(...THEMES.map((t) => mutedOnGlass(t).worst));
check('the battery actually exercises the floor (some theme lands within 0.3 of it)',
  worstOfAll < AA_NORMAL + 0.3, `tightest worst-case ${round2(worstOfAll)}`);

console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
process.exit(failures ? 1 : 0);
