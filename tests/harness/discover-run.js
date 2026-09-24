#!/usr/bin/env node
// Find — a widget looks up its own setting values (#210 slice 2), the parts that are not
// the browser round trip.
//
//   D1 · the shell keeps only plain, bounded choices from a widget's answer
//   D2 · the widget API answers every question exactly once, in plain data
//   D3 · the editors say what happened, and every dead end leaves the field typeable
//   D4 · the plumbing is wired end to end (text, and says so — it runs across a browser
//        and two WebViews; tests/harness/discoverroute-run.js drives it for real)
//   D5 · falsification — D1 must FAIL against a shell that passes the answer through
//
// Every function under test is loaded OUT OF the shipped file between markers and run,
// never transcribed, so a regression in the real commit cannot leave this green.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const SHELL = path.join(ROOT, 'src', 'Plinth', 'Shell');
const APP = path.join(ROOT, 'src', 'Plinth', 'App');
const read = (p) => fs.readFileSync(p, 'utf8');

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  if (!ok) failures++;
};

function block(file, marker) {
  const src = read(file);
  const a = src.indexOf('// >>> ' + marker);
  const b = src.indexOf('// <<< ' + marker);
  return a < 0 || b < 0 ? null : src.slice(a, b);
}
function load(file, marker, names, globals) {
  const code = block(file, marker);
  if (!code) return null;
  const ctx = Object.assign({ module: {} }, globals || {});
  vm.createContext(ctx);
  vm.runInContext(code + `\nmodule.exports = { ${names.join(', ')} };`, ctx);
  return ctx.module.exports;
}

// ---- D1 · cleanDiscovery ----------------------------------------------------------------
function runCleanChecks(clean, quiet) {
  const say = quiet ? () => {} : check;
  let bad = 0;
  const c = (name, ok, detail) => { if (!ok) bad++; say(name, ok, detail); };
  // Each case runs guarded: the falsification pass feeds these a cleaner that returns
  // raw widget data, and a detail string that throws on it must count as a failure, not
  // end the run.
  const t = (name, fn) => {
    let r;
    try { r = fn(); } catch (e) { r = [false, 'threw: ' + e.message]; }
    c(name, r[0], r[1]);
  };
  t('D1 strings and {value, label} both become {value, label}', () => {
    const r = clean({ options: ['octo/one', { value: 'octo/two', label: 'Two' }, { value: 'octo/three' }] });
    return [r.ok === true && JSON.stringify(r.options) === JSON.stringify([
      { value: 'octo/one', label: 'octo/one' }, { value: 'octo/two', label: 'Two' }, { value: 'octo/three', label: 'octo/three' }]),
    JSON.stringify(r)];
  });
  t('D1 nothing but value and label is passed on', () => {
    const r = clean({ options: [{ value: 'a', label: 'A', html: '<img src=x onerror=alert(1)>', onclick: 'x' }] });
    return [r.ok && Object.keys(r.options[0]).sort().join() === 'label,value', JSON.stringify(r.options)];
  });
  t('D1 blank, over-long, repeated and non-text values are dropped', () => {
    const r = clean({ options: ['', '   ', 'x'.repeat(301), 'ok', 'ok', { value: 5 }, null, 7, { label: 'no value' }] });
    return [r.ok && r.options.length === 1 && r.options[0].value === 'ok', JSON.stringify(r.options.map((o) => String(o && o.value).slice(0, 12)))];
  });
  t('D1 a blank label falls back to the value; a long one is cut to 300', () => {
    const r = clean({ options: [{ value: 'a', label: '  ' }, { value: 'b', label: 'L'.repeat(400) }] });
    return [r.ok && r.options[0].label === 'a' && r.options[1].label.length === 300, JSON.stringify(r.options.map((o) => o.label.length))];
  });
  const many = Array.from({ length: 700 }, (_, i) => 'v' + i);
  t('D1 at most 500 choices, and the cut is reported', () => {
    const r = clean({ options: many });
    return [r.ok && r.options.length === 500 && r.truncated === true, `${r.options && r.options.length} ${r.truncated}`];
  });
  t('D1 exactly 500 is not a cut', () => {
    const r = clean({ options: many.slice(0, 500) });
    return [r.ok && r.options.length === 500 && r.truncated === false];
  });
  t('D1 an empty list is an answer, not a failure', () => [JSON.stringify(clean({ options: [] })) === JSON.stringify({ ok: true, options: [], truncated: false })]);
  t('D1 unsupported is its own reason', () => [JSON.stringify(clean({ unsupported: true })) === JSON.stringify({ ok: false, error: 'unsupported' })]);
  t('D1 a widget error wins over any options and carries its message, trimmed', () => {
    const r = clean({ error: '  Token rejected (401)  ', options: ['x'] });
    return [r.ok === false && r.error === 'widget' && r.message === 'Token rejected (401)', JSON.stringify(r)];
  });
  t('D1 ...cut to 300', () => [clean({ error: 'e'.repeat(1000) }).message.length === 300]);
  t('D1 a blank error is not an error', () => [clean({ error: '  ', options: ['x'] }).ok === true]);
  for (const [what, v] of [['no options', {}], ['options not a list', { options: 'a,b' }], ['null', null], ['a string', 'x']])
    t(`D1 ${what} is an unreadable answer`, () => [JSON.stringify(clean(v)) === JSON.stringify({ ok: false, error: 'bad-reply' }), JSON.stringify(clean(v))]);
  return bad;
}
const cleaner = load(path.join(SHELL, 'shell.js'), 'ww-discover-clean', ['cleanDiscovery']);
check('D0 shell.js carries the ww-discover-clean block', !!cleaner);
if (cleaner) runCleanChecks(cleaner.cleanDiscovery);

// ---- D2 · widget-api answerDiscover ---------------------------------------------------------
async function ask(handler, msg) {
  const posted = [];
  const api = load(path.join(SHELL, 'widget-api.js'), 'ww-discover-answer', ['answerDiscover'], {
    parent: { postMessage: (m, target) => posted.push({ m: JSON.parse(JSON.stringify(m)), target }) },
    shellTarget: () => 'https://app.plinth',
    discoverHandler: handler,
    DISCOVER_SEND_MAX: 2000,
    Promise,
  });
  if (!api) return null;
  api.answerDiscover(msg);
  await new Promise((r) => setTimeout(r, 20));
  return posted;
}
(async () => {
  const hasBlock = !!block(path.join(SHELL, 'widget-api.js'), 'ww-discover-answer');
  check('D0 widget-api.js carries the ww-discover-answer block', hasBlock);
  if (hasBlock) {
    let seen = null;
    let p = await ask((q) => { seen = q; return ['a', { value: 'b', label: 'B', extra: () => 1 }, { value: 3 }, () => 0, null]; },
      { id: 'q1', property: 'repos', field: 'repo' });
    check('D2 the handler is told which setting — property and list field',
      seen && seen.property === 'repos' && seen.field === 'repo', JSON.stringify(seen));
    check('D2 the answer is one ww-discover-result, to the shell only, with the question\'s id',
      p.length === 1 && p[0].m.type === 'ww-discover-result' && p[0].m.id === 'q1' && p[0].target === 'https://app.plinth',
      JSON.stringify(p));
    check('D2 ...holding plain strings and {value, label} only',
      p.length === 1 && JSON.stringify(p[0].m.options) === JSON.stringify(['a', { value: 'b', label: 'B' }, { value: '3', label: '' }]),
      JSON.stringify(p[0] && p[0].m.options));
    p = await ask((q) => { seen = q; return []; }, { id: 'q2', property: 'realm' });
    check('D2 a top-level setting has no field', seen.field === null && seen.property === 'realm', JSON.stringify(seen));
    p = await ask(() => Promise.resolve(['x']), { id: 'q3', property: 'realm' });
    check('D2 a promise is awaited', p.length === 1 && JSON.stringify(p[0].m.options) === '["x"]', JSON.stringify(p));
    p = await ask(null, { id: 'q4', property: 'realm' });
    check('D2 no handler says unsupported rather than staying silent',
      p.length === 1 && p[0].m.unsupported === true && p[0].m.id === 'q4', JSON.stringify(p));
    p = await ask(() => null, { id: 'q5', property: 'other' });
    check('D2 a handler that returns nothing for this setting says unsupported',
      p.length === 1 && p[0].m.unsupported === true, JSON.stringify(p));
    p = await ask(() => { throw new Error('Token rejected'); }, { id: 'q6', property: 'realm' });
    check('D2 a throw becomes the widget\'s error message', p.length === 1 && p[0].m.error === 'Token rejected', JSON.stringify(p));
    p = await ask(() => Promise.reject(new Error('Offline')), { id: 'q7', property: 'realm' });
    check('D2 ...and so does a rejection', p.length === 1 && p[0].m.error === 'Offline', JSON.stringify(p));
    p = await ask(() => Array.from({ length: 3000 }, (_, i) => 'v' + i), { id: 'q8', property: 'realm' });
    check('D2 a runaway list is cut before it crosses the frame boundary',
      p.length === 1 && p[0].m.options.length === 2000, String(p[0] && p[0].m.options.length));
    for (const bad of [{}, { id: '' }, { id: 7 }]) {
      p = await ask(() => ['x'], bad);
      check(`D2 a question with no usable id is not answered (${JSON.stringify(bad)})`, p.length === 0, JSON.stringify(p));
    }
  }

  // ---- D3 · status text, both copies -----------------------------------------------------
  const copies = {};
  for (const name of ['settings.js', 'shell.js']) {
    const api = load(path.join(SHELL, name), 'ww-discover-text', ['discoverStatusText']);
    check(`D0 ${name} carries the ww-discover-text block`, !!api);
    if (api) copies[name] = api.discoverStatusText;
  }
  const CASES = [
    { ok: true, options: [{ value: 'a', label: 'a' }], truncated: false },
    { ok: true, options: [{ value: 'a', label: 'a' }], truncated: true },
    { ok: true, options: [], truncated: false },
    { ok: false, error: 'no-dashboard' }, { ok: false, error: 'not-placed' }, { ok: false, error: 'not-ready' },
    { ok: false, error: 'timeout' }, { ok: false, error: 'unsupported' }, { ok: false, error: 'widget', message: 'Token rejected (401)' },
    { ok: false, error: 'bad-reply' }, { ok: false, error: 'something-new' }, null,
  ];
  for (const [name, text] of Object.entries(copies)) {
    check(`D3 ${name}: a plain list needs no words`, text(CASES[0]) === '', JSON.stringify(text(CASES[0])));
    check(`D3 ${name}: a cut list says how many are shown`, /first 1\b/.test(text(CASES[1])), text(CASES[1]));
    for (const r of CASES.slice(2)) {
      const t = text(r);
      const key = r ? (r.error || 'empty') : 'null';
      check(`D3 ${name}: ${key} says something`, typeof t === 'string' && t.length > 10, JSON.stringify(t));
      if (key !== 'not-ready' && key !== 'widget')
        check(`D3 ${name}: ${key} leaves the field typeable`, /type the value/i.test(t), t);
    }
    check(`D3 ${name}: the widget's own reason is shown`, /Token rejected \(401\)/.test(text(CASES[8])), text(CASES[8]));
    check(`D3 ${name}: no panel is not mistaken for an unplaced widget`,
      /panel is not running/.test(text(CASES[3])) && /not on the panel yet/.test(text(CASES[4])));
  }
  if (copies['settings.js'] && copies['shell.js'])
    check('D3 the desktop chooser and the panel sheet say the same things',
      CASES.every((r) => copies['settings.js'](r) === copies['shell.js'](r)));

  // ---- D4 · wiring ---------------------------------------------------------------------------
  const shell = read(path.join(SHELL, 'shell.js'));
  const settings = read(path.join(SHELL, 'settings.js'));
  const api = read(path.join(SHELL, 'widget-api.js'));
  const dash = read(path.join(APP, 'DashboardWindow.cs'));
  const setw = read(path.join(APP, 'SettingsWindow.cs'));
  check('D4 the widget API exposes onDiscover and answers ww-discover',
    /onDiscover\(cb\) \{ discoverHandler = /.test(api) && /msg\.type === 'ww-discover'\) \{\s*answerDiscover\(msg\)/.test(api));
  check('D4 the shell accepts an answer only from the slot it asked',
    /const route = discoverRoutes\.get\(msg\.id\);\s*if \(!route \|\| route\.slot !== sender\) return;/.test(shell));
  check('D4 ...once, and cleaned',
    /discoverRoutes\.delete\(msg\.id\);\s*clearTimeout\(route\.timer\);\s*route\.done\(cleanDiscovery\(msg\)\);/.test(shell));
  check('D4 the shell answers the host\'s question with discover-result',
    /msg\.type === 'discover'\)/.test(shell) && /postToHost\(Object\.assign\(\{ type: 'discover-result', id: hostId \}, result\)\)/.test(shell));
  check('D4 a tile mid-reload is asked once its new document is ready, not refused',
    /if \(slot\.initialized\) sendToSlot\(slot, question\);/.test(shell)
      && /sendToSlot\(sender, initMessage\(sender\)\);[\s\S]{0,500}for \(const route of discoverRoutes\.values\(\)\)\s*if \(route\.slot === sender\) sendToSlot\(sender, route\.question\);/.test(shell));
  check('D4 the panel sheet asks the slot being edited, after applying pending edits',
    /discoverSlot\(record, property, field,/.test(shell) && /function psDiscoverBtn[\s\S]{0,1200}applyPropNow\(record\);[\s\S]{0,2600}discoverSlot\(record/.test(shell));
  check('D4 settings asks the host with the slot\'s instanceId',
    /post\(\{ type: 'discover', id, instanceId, property, field: field \|\| null \}\)/.test(settings));
  check('D4 the settings window relays to the dashboard, or refuses at once without one',
    /case "discover":\s*HandleDiscover\(message\);/.test(setw) && /dashboard\.RequestDiscovery\(instanceId, property, field, Answer\)/.test(setw)
      && /DiscoveryRefused\("no-dashboard"\)/.test(setw));
  check('D4 the dashboard hands the shell\'s answer back by id',
    /case "discover-result":/.test(dash) && /CompleteDiscovery\(discoveryId,/.test(dash) && /PostToShell\("discover",/.test(dash));
  for (const [name, src, btn, fieldVar] of [['settings.js', settings, 'makeDiscoverBtn(input, slot, ', 'field'], ['shell.js', shell, 'psDiscoverBtn(input, ', 'f']]) {
    const top = src.split(btn + 'prop.name, null)').length - 1;
    check(`D4 ${name} offers Find on select and text settings`, top === 2, `${top} site(s)`);
    check(`D4 ${name} offers Find on a list row's field, naming the field`,
      src.includes(btn + `prop.name, ${fieldVar}.key)`) && src.includes(`if (${fieldVar}.optionsSource === 'widget')`));
  }

  // ---- D5 · falsification --------------------------------------------------------------------
  const passThrough = (msg) => ({ ok: true, options: (msg && msg.options) || [], truncated: false });
  const caught = runCleanChecks(passThrough, true);
  check('D5 the D1 checks fail against a shell that passes the answer through', caught >= 5, `${caught} failed`);

  console.log(failures === 0 ? 'All discovery checks passed.' : `${failures} discovery check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
