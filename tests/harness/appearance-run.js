#!/usr/bin/env node
// Shell-owned appearance properties.
//
// `bgStyle` used to be declared in all 31 stock manifests and applied by hand in all 31
// widget scripts. The panel owns it now: Shell/appearance.js splices the declaration into
// every widget's property list as the catalog arrives, and widget-api.js applies the class
// inside the frame. Nothing a widget author writes is involved.
//
// The risk this guards is a SILENT one. Both settings editors render whatever is in
// `widget.properties`, so if normalisation ever stops running or stops appending, no error
// is thrown anywhere — the Background control simply vanishes from every widget's settings
// and the tiles all quietly render solid. That is invisible until someone goes looking for
// a control that used to be there.
//
//   A1 · a widget that declares nothing still gets the property
//   A2 · ...appended LAST, so the position is the same on every widget rather than
//        wherever each author happened to put it
//   A3 · a widget that DECLARES its own bgStyle has the declaration dropped, not merged —
//        the shell's definition is the only one, which is what makes it a single source
//   A4 · the widget's real properties survive, in order, with their shapes intact
//   A5 · each call yields FRESH objects: the editors mutate what they are handed, and a
//        shared options array would let an edit to one tile rewrite every other tile's
//        declaration
//   A6 · against the REAL stock manifests: exactly one bgStyle each, none declared on disk
//
// A6 is the one that would have caught this change going in half-done, and it reads the
// shipped manifests rather than a fixture for that reason.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..', '..');
const SHELL = path.join(REPO, 'src', 'Plinth', 'Shell');

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  if (!ok) failures++;
};

// The real file, executed — not a transcription. A copy here would keep passing after the
// shipped module changed underneath it.
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(SHELL, 'appearance.js'), 'utf8'), ctx);
const A = ctx.window.WWAppearance;

if (!A || typeof A.normalizeCatalog !== 'function') {
  console.log('  FAIL A0 appearance.js did not publish window.WWAppearance.normalizeCatalog');
  process.exit(1);
}

// ---- A1/A2/A4 · a plain widget -------------------------------------------------------
const plain = {
  id: 'test.plain',
  properties: [
    { name: 'url', label: 'URL', type: 'text', default: '' },
    { name: 'refreshSeconds', label: 'Refresh', type: 'number', min: 5, max: 900, default: 30 },
  ],
};
const [outPlain] = A.normalizeCatalog([plain]);
const bg = (outPlain.properties || []).filter((p) => p.name === 'bgStyle');
check('A1 a widget that declares nothing still gets bgStyle', bg.length === 1,
  `${bg.length} bgStyle propert(ies)`);
check('A2 ...appended last', outPlain.properties[outPlain.properties.length - 1].name === 'bgStyle',
  outPlain.properties.map((p) => p.name).join(', '));
check('A4 the widget\'s own properties survive in order and shape',
  outPlain.properties[0].name === 'url' && outPlain.properties[1].name === 'refreshSeconds'
    && outPlain.properties[1].max === 900,
  outPlain.properties.slice(0, 2).map((p) => p.name).join(', '));
// The source object must not be edited underneath the caller — the catalog is reused.
check('A4b the input widget object is not mutated',
  plain.properties.length === 2 && !plain.properties.some((p) => p.name === 'bgStyle'),
  `${plain.properties.length} properties on the original`);

// ---- A3 · a widget that declares its own ---------------------------------------------
// The hostile shape: a third-party package or an iCUE port carrying a bgStyle with
// different options and a different default. Honouring it would mean two definitions of
// one setting and no way to tell which a given tile obeys.
const declares = {
  id: 'test.declares',
  properties: [
    { name: 'bgStyle', label: 'MY background', type: 'select', options: ['neon', 'chrome'], default: 'neon' },
    { name: 'zoom', label: 'Zoom', type: 'slider', min: 0.5, max: 2, default: 1 },
  ],
};
const [outDecl] = A.normalizeCatalog([declares]);
const declBg = outDecl.properties.filter((p) => p.name === 'bgStyle');
check('A3 a declared bgStyle is replaced, not kept alongside', declBg.length === 1,
  `${declBg.length} bgStyle propert(ies)`);
check('A3b ...and it is the SHELL\'s definition that survives',
  declBg[0].default === 'solid' && declBg[0].options.join(',') === 'solid,glass,transparent'
    && declBg[0].label === 'Background',
  `default=${declBg[0].default} options=${declBg[0].options.join('|')} label=${declBg[0].label}`);
check('A3c ...and the widget\'s unrelated property is untouched',
  outDecl.properties.some((p) => p.name === 'zoom' && p.max === 2));

// ---- A5 · fresh objects per call -----------------------------------------------------
const [w1] = A.normalizeCatalog([{ id: 'a', properties: [] }]);
const [w2] = A.normalizeCatalog([{ id: 'b', properties: [] }]);
const bg1 = w1.properties.find((p) => p.name === 'bgStyle');
const bg2 = w2.properties.find((p) => p.name === 'bgStyle');
bg1.options.push('MUTATED');
bg1.default = 'MUTATED';
check('A5 one widget\'s declaration is not shared with another',
  bg2.default === 'solid' && !bg2.options.includes('MUTATED'),
  `second widget: default=${bg2.default} options=${bg2.options.join('|')}`);
// ...and a fresh call is still clean, so the module-level constant was not written through.
const bg3 = A.normalizeCatalog([{ id: 'c', properties: [] }])[0].properties.find((p) => p.name === 'bgStyle');
check('A5b ...nor with any widget normalised afterwards',
  bg3.default === 'solid' && !bg3.options.includes('MUTATED'),
  `third widget: default=${bg3.default} options=${bg3.options.join('|')}`);

// ---- A6 · the real shipped manifests --------------------------------------------------
const dirs = fs.readdirSync(path.join(REPO, 'widgets'))
  .filter((d) => fs.existsSync(path.join(REPO, 'widgets', d, 'manifest.json')));
const onDisk = [];
const normalised = [];
for (const d of dirs) {
  const m = JSON.parse(fs.readFileSync(path.join(REPO, 'widgets', d, 'manifest.json'), 'utf8'));
  if ((m.properties || []).some((p) => p && p.name === 'bgStyle')) onDisk.push(d);
  const [out] = A.normalizeCatalog([m]);
  const n = (out.properties || []).filter((p) => p.name === 'bgStyle').length;
  if (n !== 1) normalised.push(`${d}:${n}`);
}
check(`A6 no stock manifest declares bgStyle on disk (${dirs.length} widgets)`,
  onDisk.length === 0, onDisk.join(', ') || 'none');
check('A6b every stock widget has exactly one after normalisation',
  normalised.length === 0, normalised.join(', ') || `all ${dirs.length} have exactly one`);

// ---- A7 · the universal row carries its own group ------------------------------------
// Not cosmetic. The settings window opens a heading whenever a property declares a group
// and never closes one, so an UNGROUPED property appended after a grouped one renders
// under whatever heading was last emitted. Eighteen of the thirty-one stock widgets end on
// a `group: "Text"` property, so a groupless Background is filed as a Text setting on most
// of the catalog — a wrong label with nothing anywhere throwing to say so.
const grouped = A.universalProperties();
check('A7 every shell-owned property declares a group',
  grouped.every((p) => typeof p.group === 'string' && p.group.length > 0),
  grouped.map((p) => `${p.name}:${p.group}`).join(', '));
// The specific shape that broke: a widget whose own last property is grouped.
const trailing = A.normalizeCatalog([{
  id: 'test.trailing',
  properties: [
    { name: 'url', label: 'URL', type: 'text', default: '' },
    { name: 'titleSize', label: 'Title size', type: 'slider', default: 100, group: 'Text' },
  ],
}])[0];
const appended = trailing.properties[trailing.properties.length - 1];
check('A7b ...so it does not inherit the heading of the property before it',
  appended.name === 'bgStyle' && appended.group && appended.group !== 'Text',
  `${appended.name} group=${appended.group} (previous row group=Text)`);

// ---- A8 · how many stock widgets this actually protects --------------------------------
// Reported rather than asserted on a fixed number, which would fail every time a widget
// gained or lost a grouped property and say nothing about correctness.
const endsGrouped = dirs.filter((d) => {
  const props = JSON.parse(fs.readFileSync(path.join(REPO, 'widgets', d, 'manifest.json'), 'utf8')).properties || [];
  return props.length && props[props.length - 1].group;
});
check('A8 the misgrouping this guards is reachable from the shipped catalog',
  endsGrouped.length > 0,
  `${endsGrouped.length}/${dirs.length} widgets end on a grouped property`);

console.log(failures > 0 ? `\n${failures} FAILURES` : '\nALL PASS');
process.exit(failures > 0 ? 1 : 0);
