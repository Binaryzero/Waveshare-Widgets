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
//   T4 · the stock fallbacks in widget-base.css and the token table in WIDGET-STANDARD.md
//        are the stock theme as derived
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

// T4 · the stock theme's tokens are baked into widget-base.css as fallbacks, so a widget
// opened in a plain browser (or painting before the first theme push) looks as it will on
// the panel, and listed in docs/WIDGET-STANDARD.md. Both are hand-written copies of the
// derivation: this is what keeps them from describing the palette before the last change.
const REPO = path.join(__dirname, '..', '..');
const stock = derive({});
const css = fs.readFileSync(path.join(REPO, 'src', 'Plinth', 'Shell', 'widget-base.css'), 'utf8');
const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
const baked = {};
for (const m of rootBlock.matchAll(/^\s*(--[a-z-]+):\s*([^;]+);/gm)) baked[m[1]] = m[2].trim();
const cssOff = Object.keys(stock).filter((k) => k !== '--appearance' && baked[k] !== stock[k]);
check('T4 widget-base.css falls back to the stock theme as derived', cssOff.length === 0,
  cssOff.map((k) => `${k} css=${baked[k]} derived=${stock[k]}`).join(' | ') || undefined);
const doc = fs.readFileSync(path.join(REPO, 'docs', 'WIDGET-STANDARD.md'), 'utf8');
const docOff = [];
let docRows = 0;
for (const line of doc.split('\n')) {
  if (!line.startsWith('| `--')) continue;
  const cells = line.split(' | ');
  const names = [...cells[0].matchAll(/`(--[a-z-]+)`/g)].map((m) => m[1]);
  if (!names.length || !names.every((n) => n in stock) || names[0] === '--appearance') continue;
  docRows++;
  const vals = [...cells[cells.length - 1].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  names.forEach((n, i) => { if (vals[i] !== stock[n]) docOff.push(`${n} doc=${vals[i]} derived=${stock[n]}`); });
}
check('T4b WIDGET-STANDARD.md lists the stock theme as derived', docRows >= 15 && docOff.length === 0,
  docOff.join(' | ') || `${docRows} rows`);

console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
process.exit(failures ? 1 : 0);
