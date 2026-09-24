#!/usr/bin/env node
// Find — the real round trip (#210 slice 2), on the maintainer's machine. The pure parts
// run in CI as tests/harness/discover-run.js; this drives the shipped shell and settings
// pages in a browser.
//
// Dashboard shell, with a fake host:
//   R1  · the host's question reaches the placed widget it names, with property and field
//   R2  · ...and nobody else
//   R3  · the answer goes back to the host, cleaned, under the host's id
//   R4  · an answer from ANOTHER widget, quoting the right id, is ignored
//   R5  · a question is answered once — a second answer from the same frame is dropped
//   R6  · no handler → unsupported; unknown instance → not-placed; a throw → its message
//   R7  · a widget that never answers is reported as a timeout (≈20 s)
// On-panel property sheet:
//   P1  · a text setting and a list field each offer Find
//   P2  · Find lists what the widget found, label over value
//   P3  · picking one writes the VALUE into that field and it is saved
//   P4  · Find straight after an edit waits for the tile's reload instead of failing
// Settings window, with a fake host:
//   S1  · Find asks the host with the slot's instanceId, property and field
//   S2  · the answer is listed; picking writes the value; Save carries it
//   S3  · no dashboard → the chooser says so, and the field stays typeable
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const http = require('http');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const SHELL = path.join(REPO, 'src', 'Plinth', 'Shell');
const PORT = 8972;

function staticServer(rootDir, port) {
  const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
  const srv = http.createServer((req, res) => {
    try {
      const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = path.join(rootDir, path.normalize(p).replace(/^([/\\.])+/, ''));
      if (!file.startsWith(rootDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      res.end(fs.readFileSync(file));
    } catch (e) { res.writeHead(500); res.end(); }
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  if (!ok) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The asked widget: answers by property, and records every question it got.
const FINDER_HTML = `<!DOCTYPE html><meta charset="utf-8">
<body style="margin:0;background:#111">
<script src="https://app.plinth/widget-api.js"></script>
<script>
  window.__asked = [];
  WW.onInit(() => { document.body.dataset.inited = '1'; });
  WW.onDiscover((q) => {
    window.__asked.push(Object.assign({ realmSetting: WW.settings.realm }, q));
    if (q.property === 'repos') return [{ value: 'octo/one', label: 'One' }, 'octo/two', { value: 'octo/one' }];
    if (q.property === 'realm') return ['Silvermoon', 'Argent Dawn'];
    if (q.property === 'fail') throw new Error('Token rejected (401)');
    if (q.property === 'slow') return new Promise((r) => setTimeout(() => r(['real']), 1500));
    if (q.property === 'never') return new Promise(() => {});
    return null;
  });
  // The question's id, as the widget saw it — so the probe can hand it to the forger.
  window.__lastId = () => window.__lastQ;
  addEventListener('message', (ev) => { if (ev.data && ev.data.type === 'ww-discover') window.__lastQ = ev.data.id; });
  window.__answerAgain = (id) => parent.postMessage({ type: 'ww-discover-result', id, options: ['again'] }, '*');
</script>`;
// A bystander with no handler, which can also forge an answer.
const OTHER_HTML = `<!DOCTYPE html><meta charset="utf-8">
<body style="margin:0;background:#222">
<script src="https://app.plinth/widget-api.js"></script>
<script>
  window.__seen = [];
  WW.onInit(() => { document.body.dataset.inited = '1'; });
  addEventListener('message', (ev) => { if (ev.data && ev.data.type === 'ww-discover') window.__seen.push(ev.data); });
  window.__forge = (id) => parent.postMessage({ type: 'ww-discover-result', id, options: ['forged'] }, '*');
</script>`;

const FINDER_PROPS = [
  { name: 'realm', label: 'Realm', type: 'text', optionsSource: 'widget' },
  { name: 'repos', label: 'Repositories', type: 'list', itemLabel: 'repository',
    fields: [{ key: 'repo', label: 'Repository', optionsSource: 'widget' }] },
];

async function dashboard(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 400 } });
  page.on('pageerror', (e) => { failures++; console.log('[pageerror]', String(e).slice(0, 300)); });
  const hostMessages = [];
  const saves = [];
  const serve = (route, dir, name) => {
    const file = path.join(dir, name);
    if (!file.startsWith(dir) || !fs.existsSync(file) || !fs.statSync(file).isFile())
      return route.fulfill({ status: 404, body: '' });
    const type = name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'application/javascript' : 'text/html';
    route.fulfill({ status: 200, contentType: type, body: fs.readFileSync(file) });
  };
  await page.route('https://app.plinth/**', (r) => serve(r, SHELL, new URL(r.request().url()).pathname.replace(/^\/+/, '')));
  await page.route('https://finder.widgets.plinth/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: FINDER_HTML }));
  await page.route('https://other.widgets.plinth/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: OTHER_HTML }));
  const widgets = [
    { id: 'test.finder', name: 'Finder', url: 'https://finder.widgets.plinth/index.html', supportedSlots: ['half'], properties: FINDER_PROPS },
    { id: 'test.other', name: 'Other', url: 'https://other.widgets.plinth/index.html', supportedSlots: ['half'], properties: [] },
  ];
  const layout = { pages: [{ name: 'P', slots: [
    { widgetId: 'test.finder', size: 'half', instanceId: 'f1', settings: { realm: '', repos: [{ repo: '' }] } },
    { widgetId: 'test.other', size: 'half', instanceId: 'o1', settings: {} },
  ] }] };
  await page.addInitScript(() => {
    if (window.top !== window) return;
    const L = new Set();
    window.chrome = { webview: {
      addEventListener: (t, c) => { if (t === 'message') L.add(c); },
      postMessage: (m) => window.__rec(JSON.stringify(m)),
    } };
    window.__push = (j) => { const d = JSON.parse(j); L.forEach((c) => { try { c({ data: d }); } catch (e) {} }); };
  });
  await page.exposeFunction('__rec', async (j) => {
    const m = JSON.parse(j);
    hostMessages.push(m);
    if (m.type === 'save-layout') saves.push(JSON.parse(JSON.stringify(m.layout)));
    if (m.type === 'ready') {
      page.evaluate((d) => window.__push(d), JSON.stringify({ type: 'init', data: {
        layout, widgets, sensors: [], status: { elevated: false, version: 'probe' },
      } })).catch(() => {});
    }
  });
  await page.goto(`http://127.0.0.1:${PORT}/src/Plinth/Shell/index.html`);
  await wait(2000);

  const finder = page.frames().find((f) => /finder\.widgets\.plinth/.test(f.url()));
  const other = page.frames().find((f) => /other\.widgets\.plinth/.test(f.url()));
  check('R0 setup: both widgets loaded and initialized',
    !!finder && !!other && await finder.evaluate(() => document.body.dataset.inited === '1')
      && await other.evaluate(() => document.body.dataset.inited === '1'));
  if (!finder || !other) return page;

  const ask = (data) => page.evaluate((d) => window.__push(d), JSON.stringify({ type: 'discover', data }));
  const answers = (id) => hostMessages.filter((m) => m.type === 'discover-result' && m.id === id);

  await ask({ id: 'h1', instanceId: 'f1', property: 'repos', field: 'repo' });
  await wait(400);
  const asked = await finder.evaluate(() => window.__asked);
  check('R1 the question reaches the widget it names, with property and field',
    asked.length === 1 && asked[0].property === 'repos' && asked[0].field === 'repo', JSON.stringify(asked));
  check('R2 ...and nobody else', (await other.evaluate(() => window.__seen)).length === 0);
  const a1 = answers('h1');
  check('R3 the answer goes back cleaned, under the host\'s id',
    a1.length === 1 && a1[0].ok === true
      && JSON.stringify(a1[0].options) === JSON.stringify([{ value: 'octo/one', label: 'One' }, { value: 'octo/two', label: 'octo/two' }]),
    JSON.stringify(a1));

  // R4 — the forger quotes the live id while the real widget is still working on it.
  await ask({ id: 'h2', instanceId: 'f1', property: 'slow' });
  await wait(300);
  const liveId = await finder.evaluate(() => window.__lastId());
  await other.evaluate((id) => window.__forge(id), liveId);
  await wait(300);
  const forgedEarly = answers('h2').length;
  await wait(1700);
  const a2 = answers('h2');
  check('R4 another widget\'s answer is ignored, even with the right id',
    forgedEarly === 0 && a2.length === 1 && JSON.stringify(a2[0].options) === JSON.stringify([{ value: 'real', label: 'real' }]),
    JSON.stringify({ forgedEarly, a2 }));
  await finder.evaluate((id) => window.__answerAgain(id), liveId);
  await wait(300);
  check('R5 a question is answered once', answers('h2').length === 1, String(answers('h2').length));

  await ask({ id: 'h3', instanceId: 'o1', property: 'x' });
  await ask({ id: 'h4', instanceId: 'nope', property: 'x' });
  await ask({ id: 'h5', instanceId: 'f1', property: 'fail' });
  await wait(500);
  check('R6 no handler → unsupported', answers('h3')[0] && answers('h3')[0].error === 'unsupported', JSON.stringify(answers('h3')));
  check('R6 unknown instance → not-placed', answers('h4')[0] && answers('h4')[0].error === 'not-placed', JSON.stringify(answers('h4')));
  check('R6 a throw → the widget\'s message',
    answers('h5')[0] && answers('h5')[0].error === 'widget' && answers('h5')[0].message === 'Token rejected (401)', JSON.stringify(answers('h5')));

  // ---- on-panel property sheet
  // Two half tiles fill the page, so the edit button sits under a widget frame here; the
  // click is dispatched on it rather than at its coordinates.
  await page.evaluate(() => document.getElementById('editBtn').click());
  await wait(250);
  await page.locator('.slot').first().locator('.edit-overlay .gear').click();
  await wait(300);
  const finds = page.locator('#psRows .ps-find');
  check('P1 the text setting and the list field each offer Find', await finds.count() === 2, String(await finds.count()));
  if (await finds.count() === 2) {
    await finds.nth(1).click();   // the list field (Repositories comes after Realm)
    await wait(500);
    const sheet = page.locator('.ps-discover');
    const rows = sheet.locator('.ps-apps-list button');
    const texts = await rows.allTextContents();
    check('P2 Find lists what the widget found, label over value',
      texts.length === 2 && texts[0] === 'Oneocto/one' && texts[1] === 'octo/two', JSON.stringify(texts));
    if (texts.length) await rows.first().click();
    await wait(1200);
    const rowInput = page.locator('#psRows .ps-item').first().locator('input').first();
    const shown = await rowInput.inputValue();
    const last = saves.length ? saves[saves.length - 1] : null;
    const savedRepos = last ? last.pages[0].slots[0].settings.repos : null;
    check('P3 picking writes the VALUE into that field, and it is saved',
      shown === 'octo/one' && Array.isArray(savedRepos) && savedRepos[0] && savedRepos[0].repo === 'octo/one',
      JSON.stringify({ shown, savedRepos, saves: saves.length }));
    await finds.nth(0).click();
    await wait(500);
    const realms = await page.locator('.ps-discover .ps-apps-list button').allTextContents();
    check('P3 ...and a top-level text setting gets its own answer', JSON.stringify(realms) === '["Silvermoon","Argent Dawn"]', JSON.stringify(realms));
    await page.locator('.ps-discover .ps-apps-head .ps-pick').click().catch(() => {});

    // P4 · Find straight after an edit. The sheet applies the edit first, which reloads
    // the tile; the question has to wait for the new document, not be refused.
    const realmInput = page.locator('#psRows .ps-inline').filter({ has: page.locator('.ps-find') }).first().locator('input');
    await realmInput.fill('Draenor');
    await finds.nth(0).click();          // inside the 400 ms apply debounce
    await wait(2500);
    const afterEdit = await page.locator('.ps-discover .ps-apps-list button').allTextContents();
    const status4 = await page.locator('.ps-discover .ps-apps-status').textContent().catch(() => '');
    const lastAsk = await finder.evaluate(() => window.__asked[window.__asked.length - 1] || null).catch(() => null);
    check('P4 Find right after an edit waits for the reload and asks with the edited settings',
      JSON.stringify(afterEdit) === '["Silvermoon","Argent Dawn"]' && lastAsk && lastAsk.realmSetting === 'Draenor',
      JSON.stringify({ afterEdit, status4, lastAsk }));
    await page.locator('.ps-discover .ps-apps-head .ps-pick').click().catch(() => {});
  }

  // R7 last: it waits out the shell's 20 s.
  await ask({ id: 'h6', instanceId: 'f1', property: 'never' });
  await wait(21000);
  check('R7 a widget that never answers is reported as a timeout',
    answers('h6').length === 1 && answers('h6')[0].error === 'timeout', JSON.stringify(answers('h6')));
  return page;
}

async function settings(browser) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
  page.on('pageerror', (e) => { failures++; console.log('[pageerror]', String(e).slice(0, 300)); });
  const widgets = [{ id: 'test.finder', name: 'Finder', supportedSlots: ['half'], properties: FINDER_PROPS }];
  const layout = { pages: [{ name: 'Main', slots: [
    { widgetId: 'test.finder', size: 'half', instanceId: 'f1', settings: { realm: '', repos: [{ repo: '' }] } },
  ] }] };
  const saved = [];
  const questions = [];
  let dashboardUp = true;
  await page.exposeFunction('__hostRecv', async (json) => {
    const msg = JSON.parse(json);
    const push = (obj) => page.evaluate((d) => window.__hostPush(d), JSON.stringify(obj)).catch(() => {});
    if (msg.type === 'settings-ready') {
      push({ type: 'settings-init', data: { layout, widgets, sensors: [], backgroundHost: 'backgrounds.plinth',
        status: { elevated: false, version: 'probe' } } });
    } else if (msg.type === 'save-layout') {
      saved.push(JSON.parse(JSON.stringify(msg.layout)));
      push({ type: 'saved', seq: msg.seq });
    } else if (msg.type === 'discover') {
      questions.push(msg);
      push(dashboardUp
        ? { type: 'discover-result', id: msg.id, ok: true, truncated: false,
          options: [{ value: 'octo/one', label: 'One' }, { value: 'octo/two', label: 'octo/two' }] }
        : { type: 'discover-result', id: msg.id, ok: false, error: 'no-dashboard' });
    }
  });
  await page.addInitScript(() => {
    const listeners = new Set();
    window.chrome = { webview: {
      addEventListener(t, cb) { if (t === 'message') listeners.add(cb); },
      postMessage(m) { window.__hostRecv(JSON.stringify(m)); },
    } };
    window.__hostPush = (json) => { const data = JSON.parse(json); listeners.forEach((cb) => { try { cb({ data }); } catch (e) {} }); };
  });
  await page.goto(`http://127.0.0.1:${PORT}/src/Plinth/Shell/settings.html`);
  await wait(900);
  await page.locator('#slotList .slot-chip .chip-main').first().click();
  await wait(250);

  const finds = page.locator('#slotDetail .discover-btn');
  check('S0 the text setting and the list field each offer Find', await finds.count() === 2, String(await finds.count()));
  if (await finds.count() !== 2) return page;
  await finds.nth(1).click();
  await wait(300);
  check('S1 Find asks the host with the slot\'s instanceId, property and field',
    questions.length === 1 && questions[0].instanceId === 'f1' && questions[0].property === 'repos' && questions[0].field === 'repo',
    JSON.stringify(questions));
  const rows = page.locator('.discover-pop .app-pop-list button');
  const texts = await rows.allTextContents();
  check('S2 the answer is listed, label over value', JSON.stringify(texts) === '["Oneocto/one","octo/two"]', JSON.stringify(texts));
  if (texts.length) await rows.nth(1).click();
  await wait(200);
  const rowInput = page.locator('#slotDetail .factory-row input').first();
  const shown = await rowInput.inputValue();
  await page.locator('#save').click();
  await wait(600);
  const s = saved.length ? saved[saved.length - 1].pages[0].slots[0].settings : {};
  check('S2 picking writes the value, and Save carries it',
    shown === 'octo/two' && Array.isArray(s.repos) && s.repos[0].repo === 'octo/two', JSON.stringify({ shown, repos: s.repos }));
  check('S2 the chooser closed with the pick', await page.locator('.discover-pop').count() === 0);

  dashboardUp = false;
  await finds.nth(0).click();
  await wait(300);
  const status = await page.locator('.discover-pop .app-pop-status').first().textContent();
  check('S3 no dashboard: the chooser says so and leaves the field typeable',
    /panel is not running/.test(status) && /Type the value/.test(status), status);
  check('S3 ...and lists nothing', await page.locator('.discover-pop .app-pop-list button').count() === 0);
  return page;
}

(async () => {
  const srv = await staticServer(REPO, PORT);
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  try {
    await settings(browser);
    await dashboard(browser);
  } finally {
    await browser.close();
    srv.close();
  }
  console.log(failures === 0 ? 'All Find round-trip checks passed.' : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();
