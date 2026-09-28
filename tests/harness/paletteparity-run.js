#!/usr/bin/env node
// The theme palette is derived twice: PaletteEngine.cs for the panel, palette.js for the
// settings window's live preview and per-widget overrides. They must agree token for
// token, or the preview shows a theme the panel does not. tools/PaletteParity writes the
// C# derivation of a fixed battery of themes; this derives the same themes in JS and
// compares every token.
//
//   T1 · every theme in the battery derives the same tokens in both engines
//   T2 · the tile is the Background colour itself
//   T3 · state colours follow the theme: two accents that differ in saturation give
//        different state colours, each state keeps its own hue family, and a grey accent
//        still gives coloured states
//
// Run: dotnet run --project tools/PaletteParity -- palette-cs.json
//      node tests/harness/paletteparity-run.js palette-cs.json
'use strict';
const fs = require('fs');
const path = require('path');
const file = process.argv[2];
if (!file) { console.error('usage: paletteparity-run.js <palette-cs.json>'); process.exit(2); }
const win = {};
new Function('window', fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'Plinth', 'Shell', 'palette.js'), 'utf8'))(win);
const derive = win.WWPalette.derive;
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  if (!ok) failures++;
};

const battery = JSON.parse(fs.readFileSync(file, 'utf8'));
const mismatches = [];
for (const { spec, tokens } of battery) {
  const js = derive(spec);
  const keys = new Set([...Object.keys(tokens), ...Object.keys(js)]);
  for (const k of keys) if (tokens[k] !== js[k]) mismatches.push(`${JSON.stringify(spec)} ${k}: cs=${tokens[k]} js=${js[k]}`);
}
check(`T1 all ${battery.length} themes derive the same tokens in C# and JS`, battery.length > 400 && mismatches.length === 0,
  mismatches.length ? `${mismatches.length} differ, e.g. ${mismatches.slice(0, 3).join(' | ')}` : undefined);

const t = derive({ accent: '#4dd4e8', background: '#1a2b3c', text: '#e0e0e0' });
check('T2 the tile is the Background colour itself', t['--surface'] === '#1a2b3c' && t['--bg'] === '#1a2b3c', t['--surface']);

const hue = (hex) => {
  const v = parseInt(hex.slice(1), 16), r = (v >> 16) / 255, g = (v >> 8 & 255) / 255, b = (v & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return null;
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
};
const vivid = derive({ accent: '#00e5ff', background: '#101418', text: '#e8e8e8' });
const muted = derive({ accent: '#7f9aa0', background: '#101418', text: '#e8e8e8' });
check('T3 state colours follow the theme: a vivid and a muted accent give different states',
  ['--ok', '--warn', '--err', '--info'].every((k) => vivid[k] !== muted[k]),
  ['--ok', '--warn', '--err'].map((k) => `${k} ${vivid[k]}/${muted[k]}`).join(' '));
const family = (h, lo, hi) => h !== null && (lo <= hi ? h >= lo && h <= hi : h >= lo || h <= hi);
check('T3b ...and each keeps its hue family: OK green, warning amber, error red',
  [vivid, muted].every((p) => family(hue(p['--ok']), 100, 170) && family(hue(p['--warn']), 20, 50) && family(hue(p['--err']), 340, 15)),
  [vivid, muted].map((p) => ['--ok', '--warn', '--err'].map((k) => Math.round(hue(p[k]))).join('/')).join(' '));

// A grey accent has no saturation to lend: the floor keeps the states coloured.
const sat = (hex) => {
  const v = parseInt(hex.slice(1), 16), r = (v >> 16) / 255, g = (v >> 8 & 255) / 255, b = (v & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  return d === 0 ? 0 : l > 0.5 ? d / (2 - max - min) : d / (max + min);
};
const grey = derive({ accent: '#808080', background: '#101418', text: '#e8e8e8' });
check('T3c a grey accent still gives coloured states', ['--ok', '--warn', '--err', '--info'].every((k) => sat(grey[k]) >= 0.4),
  ['--ok', '--warn', '--err', '--info'].map((k) => `${k} ${grey[k]} s=${sat(grey[k]).toFixed(2)}`).join(' '));

console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
process.exit(failures ? 1 : 0);
