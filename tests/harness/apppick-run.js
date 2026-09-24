#!/usr/bin/env node
// Store apps in the app picker (#219), the parts that are not the host's COM enumeration.
//
//   P1 · the "no match" line tells the truth about Store apps, on both pickers
//   P2 · a pick names an EMPTY Name field, and never replaces one the user typed
//   P3 · both pickers carry the same block, with the same behaviour
//   P4 · the pickers are wired to it (text, and says so: the wiring runs in a browser)
//   P5 · a Store app target gets a readable fallback label in Deck and Launcher
//   P6 · falsification — P2 and P5 must FAIL against the pre-#219 behaviour
//
// Every function under test is loaded OUT OF the shipped file between markers and
// executed, never transcribed, so a regression in the real commit cannot leave this green.
// The browser half — the picked name landing in the row's Name input and the saved
// layout — is E36f/E36g in secretfield-run.js and N14k in panelsecret-run.js.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const SHELL = path.join(ROOT, 'src', 'Plinth', 'Shell');

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  if (!ok) failures++;
};

function load(file, marker, names) {
  const src = fs.readFileSync(file, 'utf8');
  const a = src.indexOf('// >>> ' + marker);
  const b = src.indexOf('// <<< ' + marker);
  if (a < 0 || b < 0) return null;
  const ctx = { module: {} };
  vm.createContext(ctx);
  vm.runInContext(src.slice(a, b) + `\nmodule.exports = { ${names.join(', ')} };`, ctx);
  return ctx.module.exports;
}

const pickers = {
  'settings.js': path.join(SHELL, 'settings.js'),
  'shell.js': path.join(SHELL, 'shell.js'),
};
const widgets = {
  deck: path.join(ROOT, 'widgets', 'deck', 'index.html'),
  launcher: path.join(ROOT, 'widgets', 'launcher', 'index.html'),
};

const FIELDS = [{ key: 'icon' }, { key: 'label' }, { key: 'target' }];

function runPickChecks(label, api) {
  // ---- P1
  const listed = api.noMatchText(true);
  const unlisted = api.noMatchText(false);
  check(`P1 ${label}: with Store apps read, it does not blame a missing Store app`,
    /Store apps/.test(listed) && !/may (not|be)/i.test(listed), listed);
  check(`P1 ${label}: with Store apps unread, it says the app may be one of those`,
    /could not be listed/.test(unlisted) && /may be/.test(unlisted), unlisted);

  // ---- P2
  let item = { label: '', target: 'x' };
  check(`P2 ${label}: an empty Name takes the picked app's name`,
    api.nameFromPick(item, FIELDS, 'Calculator') === true && item.label === 'Calculator', JSON.stringify(item));
  item = { target: 'x' };
  check(`P2 ${label}: ...and so does an absent one`,
    api.nameFromPick(item, FIELDS, 'Calculator') === true && item.label === 'Calculator', JSON.stringify(item));
  item = { label: '   ', target: 'x' };
  check(`P2 ${label}: ...and a blank one`,
    api.nameFromPick(item, FIELDS, '  Calculator ') === true && item.label === 'Calculator', JSON.stringify(item));
  item = { label: 'Calc', target: 'x' };
  check(`P2 ${label}: a Name the user typed is kept`,
    api.nameFromPick(item, FIELDS, 'Calculator') === false && item.label === 'Calc', JSON.stringify(item));
  item = { label: 0, target: 'x' };
  check(`P2 ${label}: ...even one that is not text`,
    api.nameFromPick(item, FIELDS, 'Calculator') === false && item.label === 0, JSON.stringify(item));
  item = { target: 'x' };
  check(`P2 ${label}: a row with no Name field is left alone`,
    api.nameFromPick(item, [{ key: 'target' }], 'Calculator') === false && !('label' in item), JSON.stringify(item));
  for (const [what, name] of [['no name', undefined], ['an empty name', ''], ['a blank name', '  '], ['a non-text name', 7]]) {
    item = { label: '', target: 'x' };
    check(`P2 ${label}: ${what} changes nothing`,
      api.nameFromPick(item, FIELDS, name) === false && item.label === '', JSON.stringify(item));
  }
  check(`P2 ${label}: a missing row or field list is not an error`,
    api.nameFromPick(null, FIELDS, 'A') === false && api.nameFromPick({}, null, 'A') === false);
}

const loaded = {};
for (const [label, file] of Object.entries(pickers)) {
  const api = load(file, 'ww-app-pick', ['noMatchText', 'nameFromPick']);
  check(`P0 ${label} carries the ww-app-pick block`, !!api && typeof api.nameFromPick === 'function');
  if (!api) continue;
  loaded[label] = api;
  runPickChecks(label, api);
}

// ---- P3 · the two copies cannot drift apart. Behaviour, not text: the comment on each
// names the other file.
if (loaded['settings.js'] && loaded['shell.js']) {
  const [a, b] = [loaded['settings.js'], loaded['shell.js']];
  const same = [true, false].every((v) => a.noMatchText(v) === b.noMatchText(v))
    && [['', 'A'], ['B', 'A'], [undefined, ' A '], ['  ', '']].every(([l, n]) => {
      const x = { label: l }, y = { label: l };
      return a.nameFromPick(x, FIELDS, n) === b.nameFromPick(y, FIELDS, n) && x.label === y.label;
    });
  check('P3 the desktop picker and the panel sheet behave the same', same);
}

// ---- P4 · wiring
for (const [label, file] of Object.entries(pickers)) {
  const src = fs.readFileSync(file, 'utf8');
  check(`P4 ${label}: a pick sends the app's name with the event`,
    src.includes("new CustomEvent('ww-app-picked', { detail: { name: app.name } })"));
  check(`P4 ${label}: the row handler hands it to nameFromPick`,
    src.includes('nameFromPick(item, fields, ev.detail && ev.detail.name)'));
  check(`P4 ${label}: the Name input shown is updated with it`,
    src.includes(`querySelector('input[data-key="label"]')`) && /input\.dataset\.key = f(ield)?\.key;/.test(src));
  check(`P4 ${label}: the no-match line is noMatchText's`,
    src.includes(': noMatchText(storeListed))') && !src.includes('a packaged Store app may not have one'));
  check(`P4 ${label}: the host's storeListed reaches the picker`,
    /storeListed = wasStoreListed;/.test(src) && /storeListed/.test(src.slice(src.indexOf("'apps-result'"), src.indexOf("'apps-result'") + 700)));
}

// ---- P5 · Deck and Launcher labels
const CASES = [
  ['shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', 'WindowsCalculator'],
  ['SHELL:appsfolder\\SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify', 'SpotifyMusic'],
  ['shell:AppsFolder\\Chrome', 'Chrome'],
  ['shell:AppsFolder\\Microsoft.Office.WINWORD.EXE.15', 'WINWORD'],
  ['shell:AppsFolder\\Microsoft.AutoGenerated.{923DD477-5846-686B-A659-0FCCD73851A8}', 'AutoGenerated'],
  ['shell:AppsFolder\\com.squirrel.slack.slack', 'slack'],
];
const NOT_STORE = ['C:\\Windows\\notepad.exe', 'https://example.com', 'shell:Startup\\x', 'calc.exe', ''];
for (const [label, file] of Object.entries(widgets)) {
  const api = load(file, 'ww-store-label', ['storeAppName']);
  check(`P0 ${label} carries the ww-store-label block`, !!api && typeof api.storeAppName === 'function');
  if (!api) continue;
  for (const [target, want] of CASES)
    check(`P5 ${label}: ${target.split('\\').pop()} is labelled ${want}`, api.storeAppName(target) === want, api.storeAppName(target));
  check(`P5 ${label}: anything else is not a Store target`, NOT_STORE.every((t) => api.storeAppName(t) === ''),
    JSON.stringify(NOT_STORE.map((t) => api.storeAppName(t))));
  const src = fs.readFileSync(file, 'utf8');
  const derive = src.slice(src.indexOf('function deriveLabel('), src.indexOf('function deriveLabel(') + 600);
  check(`P5 ${label}: deriveLabel asks it first`, /const app = storeAppName\((exec\.arg|target)\);\s*if \(app\) return app;/.test(derive));
}

// ---- P6 · falsification: the checks above can fail. The pre-#219 behaviour had no name
// fill and labelled a Store target by its last path segment.
{
  const old = { nameFromPick: () => false, noMatchText: () => 'No match. This lists Start Menu shortcuts — a packaged Store app may not have one.' };
  const before = failures;
  const quiet = console.log;
  console.log = () => {};
  runPickChecks('pre-#219', old);
  console.log = quiet;
  const caught = failures - before;
  failures = before;
  check('P6 the pick checks fail against the pre-#219 picker', caught >= 4, `${caught} failed`);
  const seg = (t) => (t.split(/[\\/]/).filter(Boolean).pop() || t).replace(/\.[^.]+$/, '');
  check('P6 the old label rule gets the Calculator wrong', seg(CASES[0][0]) !== CASES[0][1], seg(CASES[0][0]));
}

console.log(failures === 0 ? 'All app picker checks passed.' : `${failures} app picker check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
