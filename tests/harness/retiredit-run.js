#!/usr/bin/env node
// Removed widgets in the settings window (#226): Restore and Delete are EDITS of the
// editor's copy, applied by Save & apply like any other change. They used to act on the
// layout on disk, so any unsaved edit greyed them out and the user had to save and reopen
// to take a widget back. The host half (the save naming its Deletes, the credential coming
// back by identity) is tools/SecretRoundTrip D1-D4.
//
//   R1 · with unsaved edits, Restore and Delete are usable and no "save first" hint shows
//   R2 · Restore asks the host only to MASK the def (mask-retained), and writes nothing
//   R3 · the masked def lands on the page in the editor: credential blank and marked saved,
//        the rest kept, the row gone, the editor dirty, no ciphertext on a page
//   R4 · Delete (two clicks) takes the row out and marks the editor dirty; the save names
//        it in retainedDeleted, and carries the restored tile on its page, not in the list
//   R5 · once that save is acknowledged, the next one names nothing
//   R6 · on a page with no room, Restore is disabled and the reason is a visible sentence,
//        not cut off; Delete stays usable
//   R7 · while a refused save holds Save (stale: layout.json changed under the editor),
//        both are disabled and the hint says to reload
//   R10 · a Restore from a clean editor lights Save and shows in the preview
//   R8 · an answer for an identity already live on a page seats nothing
//   R9 · ...nor one for a page that filled while the answer was on its way
//   R12 · a tile this editor removed itself comes back as it is, with a credential typed
//        before the removal, and never through the host's mask
//   R13 · a save whose write did not land leaves the editor unsaved with its Delete named
//   R14 · once the editor takes the layout from disk again, the same identity is disk's
//        sealed entry and goes through the mask
//
// Run: CHROMIUM=/path/to/chrome node tests/harness/retiredit-run.js
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');

function loadPlaywright() {
  const candidates = ['playwright', '/opt/node22/lib/node_modules/playwright',
    path.join(process.env.HOME || '', 'node_modules/playwright')];
  for (const c of candidates) { try { return require(c); } catch (e) { /* next */ } }
  console.error('playwright not found — npm i -g playwright (and provide a chromium via CHROMIUM)');
  process.exit(1);
}
const { chromium } = loadPlaywright();

const REPO = path.resolve(__dirname, '..', '..');
const SHELL = path.join(REPO, 'src', 'Plinth', 'Shell');
const PORT = 8968;

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

const SEALED = 'dpapi:v1:U0VBTEVELVRPS0VO';
const widgets = [{
  id: 'test.gh', name: 'GitHub Queue', author: 'WW',
  url: `http://127.0.0.1:${PORT}/widgets/clock/index.html`,
  supportedSlots: ['quarter', 'half', 'full'],
  properties: [
    { name: 'token', label: 'Token', type: 'secret', help: 'A token.' },
    { name: 'repo', label: 'Repository', type: 'text' },
  ],
}, {
  id: 'test.clock', name: 'Clock', author: 'WW',
  url: `http://127.0.0.1:${PORT}/widgets/clock/index.html`,
  supportedSlots: ['quarter', 'half', 'full'],
  properties: [{ name: 'label', label: 'Label', type: 'text' }],
}];
const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const layout = { pages: [
  { name: 'System', slots: [{ widgetId: 'test.clock', size: 'half', instanceId: 'c1', settings: {} }] },
  { name: 'Full', slots: [
    { widgetId: 'test.clock', size: 'half', instanceId: 'c2', settings: {} },
    { widgetId: 'test.clock', size: 'half', instanceId: 'c3', settings: {} },
  ] },
], retained: [
  { def: { widgetId: 'test.gh', size: 'half', instanceId: 'r1', settings: { token: SEALED, repo: 'owner/name' } }, originPage: 'System', retiredAt: ago(1) },
  { def: { widgetId: 'test.clock', size: 'half', instanceId: 'r2', settings: {} }, originPage: 'System', retiredAt: ago(2) },
  { def: { widgetId: 'test.gh', size: 'full', instanceId: 'r3', settings: { token: SEALED } }, originPage: 'Full', retiredAt: ago(3) },
  // Corrupt on purpose: the same identity as a live tile (R8).
  { def: { widgetId: 'test.clock', size: 'quarter', instanceId: 'c1', settings: {} }, originPage: 'System', retiredAt: ago(4) },
  { def: { widgetId: 'test.clock', size: 'quarter', instanceId: 'r4', settings: {} }, originPage: 'System', retiredAt: ago(5) },
  { def: { widgetId: 'test.clock', size: 'quarter', instanceId: 'r5', settings: {} }, originPage: 'System', retiredAt: ago(6) },
] };

(async () => {
  const srv = await staticServer(REPO, PORT);
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('pageerror', (e) => { failures++; console.log('[pageerror]', String(e).slice(0, 300)); });
  const posted = [];
  const saves = [];
  let hold = false;           // keep the host's mask answers back until release()
  const held = [];
  const release = async () => {
    for (const a of held.splice(0)) await page.evaluate((d) => window.__hostPush(d), JSON.stringify(a));
    hold = false;
    await wait(400);
  };
  await page.exposeFunction('__hostRecv', async (json) => {
    const msg = JSON.parse(json);
    posted.push(msg);
    const push = (obj) => page.evaluate((d) => window.__hostPush(d), JSON.stringify(obj)).catch(() => {});
    if (msg.type === 'settings-ready' || msg.type === 'ready') {
      push({ type: 'settings-init', data: { layout, widgets, sensors: [], media: null, generation: 1,
        backgroundHost: 'backgrounds.plinth', status: { elevated: false, apiVersion: 1, version: 'probe' } } });
    } else if (msg.type === 'mask-retained') {
      // The host's mask, as SecretPolicy.Mask does it for this manifest (D4 pins the real one).
      const def = JSON.parse(JSON.stringify(msg.def));
      if (def.widgetId === 'test.gh' && def.settings && def.settings.token) {
        def.settings.token = '';
        def.secretsSet = ['token'];
      }
      const answer = { type: 'retained-masked', token: msg.token, def };
      if (hold) held.push(answer); else push(answer);
    } else if (msg.type === 'save-layout') {
      saves.push(JSON.parse(JSON.stringify(msg.layout)));
      push({ type: 'saved', seq: msg.seq, generation: 2, landed: true });
    }
  });
  await page.addInitScript(() => {
    if (window.top !== window) return;
    const listeners = new Set();
    window.chrome = { webview: {
      addEventListener(t, cb) { if (t === 'message') listeners.add(cb); },
      postMessage(m) { window.__hostRecv(JSON.stringify(m)); },
    } };
    window.__hostPush = (json) => { const data = JSON.parse(json); listeners.forEach((cb) => { try { cb({ data }); } catch (e) {} }); };
  });
  await page.addInitScript(fs.readFileSync(path.join(SHELL, 'widget-api.js'), 'utf8'));
  await page.goto(`http://127.0.0.1:${PORT}/src/Plinth/Shell/settings.html`);
  await wait(1500);

  const rows = () => page.evaluate(() => [...document.querySelectorAll('#retiredGallery .r-row')].map((r) => {
    const [restore, del] = r.querySelectorAll('button');
    const why = r.querySelector('.r-why');
    return { name: r.querySelector('.r-name').textContent, meta: r.querySelector('.r-meta').textContent,
      restore: !restore.disabled, del: !del.disabled,
      why: why ? why.textContent : null, whyClipped: why ? why.scrollWidth > why.clientWidth : null,
      whyVisible: why ? why.getBoundingClientRect().height > 0 : null };
  }));
  const hint = () => page.evaluate(() => { const h = document.querySelector('#retiredGallery .r-hint'); return h ? h.textContent : null; });
  const isDirty = () => page.evaluate(() => document.getElementById('save').classList.contains('dirty'));
  const clickRow = (rowName, which, times = 1) => page.evaluate(({ rowName, which, times }) => {
    const row = [...document.querySelectorAll('#retiredGallery .r-row')].find((r) => r.querySelector('.r-meta').textContent.includes(rowName)
      || r.querySelector('.r-name').textContent === rowName);
    if (!row) return false;
    for (let i = 0; i < times; i++) {
      const b = [...row.querySelectorAll('button')].find((x) => x.textContent === which || (which === 'Delete' && x.classList.contains('danger')));
      b.click();
    }
    return true;
  }, { rowName, which, times });

  // R1 · an unsaved edit, then back on System.
  await page.click('#addPage');
  await wait(300);
  await page.locator('#pageList li').first().click();
  await wait(400);
  let rs = await rows();
  check('R1 with unsaved edits, Restore and Delete are usable and no "save first" hint shows',
    (await isDirty()) && rs.length === 6 && rs[0].restore && rs[0].del && !/save/i.test((await hint()) || ''),
    JSON.stringify({ dirty: await isDirty(), hint: await hint(), first: rs[0] }));

  // R2/R3 · Restore the GitHub Queue tile (r1) onto System, its answer held at first.
  posted.length = 0;
  hold = true;
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('#retiredGallery .r-row')][0];
    row.querySelector('button').click();
  });
  await wait(400);
  rs = await rows();
  check('R2b while the host has not answered, that row waits: neither button can be pressed again',
    rs[0] && !rs[0].restore && !rs[0].del && rs[1].restore, JSON.stringify(rs.slice(0, 2)));
  await release();
  const asked = posted.find((m) => m.type === 'mask-retained');
  check('R2 Restore asks the host only to mask the def, and writes nothing',
    !!asked && asked.def && asked.def.instanceId === 'r1' && !posted.some((m) => /restore-retained|save-layout/.test(m.type)),
    JSON.stringify(posted.map((m) => m.type)));
  // The editor's own copy, read through the projection seam with secrets left in.
  const state = await page.evaluate(() => JSON.parse(JSON.stringify(window.__wwReplicaLayout(true))));
  rs = await rows();
  const onPage = (state.pages[0].slots || []).find((s) => s.instanceId === 'r1');
  check('R3 the masked def lands on the page: credential blank and marked saved, the rest kept',
    !!onPage && onPage.settings.token === '' && onPage.settings.repo === 'owner/name'
      && JSON.stringify(onPage.secretsSet) === '["token"]',
    JSON.stringify(onPage));
  check('R3b ...its row leaves the list, the editor is dirty, and no page holds the ciphertext',
    !rs.some((r) => r.name === 'GitHub Queue' && /System/.test(r.meta) && /1h/.test(r.meta)) && rs.length === 5
      && (await isDirty()) && !JSON.stringify(state.pages).includes(SEALED),
    JSON.stringify(rs.map((r) => r.name + ' ' + r.meta)));

  // R4 · Delete the Clock tile (r2): two clicks.
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('#retiredGallery .r-row')].find((r) => /2h/.test(r.querySelector('.r-meta').textContent));
    const del = row.querySelector('button.danger');
    del.click(); del.click();
  });
  await wait(300);
  rs = await rows();
  check('R4 Delete (two clicks) takes the row out and leaves the editor dirty',
    rs.length === 4 && !rs.some((r) => /2h/.test(r.meta)) && (await isDirty()),
    JSON.stringify(rs.map((r) => r.meta)));
  await page.click('#save');
  await wait(500);
  const first = saves[saves.length - 1] || {};
  const firstRetained = (first.retained || []).map((r) => r.def.instanceId).sort();
  check('R4b the save names the Delete, and carries the restored tile on its page, not in the list',
    JSON.stringify(first.retainedDeleted) === JSON.stringify([{ widgetId: 'test.clock', instanceId: 'r2' }])
      && JSON.stringify(firstRetained) === JSON.stringify(['c1', 'r3', 'r4', 'r5'])
      && (first.pages[0].slots || []).some((s) => s.instanceId === 'r1'),
    JSON.stringify({ deleted: first.retainedDeleted, retained: firstRetained }));
  check('R5 ...and once that save is acknowledged the editor is clean',
    !(await isDirty()));
  await page.click('#addPage');
  await wait(300);
  await page.click('#save');
  await wait(500);
  const second = saves[saves.length - 1] || {};
  check('R5b the next save names nothing', saves.length === 2 && second.retainedDeleted === undefined,
    JSON.stringify(second.retainedDeleted));

  // R4c · a Delete from a CLEAN editor is an edit too: the attic is not in the edit
  // detector's projection, so it has to mark the editor itself.
  check('R4c setup: the editor is clean', !(await isDirty()));
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('#retiredGallery .r-row')].find((r) => /5h/.test(r.querySelector('.r-meta').textContent));
    const del = row.querySelector('button.danger');
    del.click(); del.click();
  });
  await wait(300);
  check('R4d ...and a Delete there lights Save', await isDirty());
  await page.click('#save');
  await wait(500);

  // R10 · a Restore from a CLEAN editor lights Save and shows in the preview.
  await page.locator('#pageList li').nth(2).click();   // empty
  await wait(600);
  const slotsIn = () => page.evaluate(() => {
    const doc = document.getElementById('previewFrame').contentDocument;
    return doc ? doc.querySelectorAll('.slot').length : -1;
  });
  const shownBefore = await slotsIn();
  check('R10 setup: the editor is clean', !(await isDirty()));
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('#retiredGallery .r-row')].find((r) => /6h/.test(r.querySelector('.r-meta').textContent));
    row.querySelector('button').click();
  });
  await wait(1500);
  check('R10b ...a Restore lights Save and the preview shows the tile back',
    (await isDirty()) && (await slotsIn()) === shownBefore + 1, `slots ${shownBefore} -> ${await slotsIn()}`);

  // R6 · the Full page: nothing fits there.
  await page.locator('#pageList li').nth(1).click();
  await wait(400);
  rs = await rows();
  const full = rs.find((r) => /Full/.test(r.meta));
  check('R6 on a page with no room, Restore is disabled and the reason is a whole visible sentence',
    !!full && !full.restore && full.whyVisible && !full.whyClipped
      && /No room on Full/.test(full.why) && /make room/.test(full.why),
    JSON.stringify(full));
  check('R6b ...while Delete stays usable', !!full && full.del);

  // R9 · the page fills while the host's answer is on its way: re-checked, not seated.
  await page.locator('#pageList li').nth(3).click();   // empty: the Full tile fits
  await wait(400);
  hold = true;
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('#retiredGallery .r-row')].find((r) => /3h/.test(r.querySelector('.r-meta').textContent));
    row.querySelector('button').click();
  });
  await wait(300);
  await page.evaluate(() => document.querySelector('#widgetGallery button:not([disabled])').click());   // fill it meanwhile
  await wait(400);
  await release();
  const p4 = (await page.evaluate(() => window.__wwReplicaLayout(true))).pages[3];
  rs = await rows();
  check('R9 a page that filled while the answer was on its way does not take the tile',
    !(p4.slots || []).some((s) => s.instanceId === 'r3') && rs.some((r) => /3h/.test(r.meta)),
    JSON.stringify((p4.slots || []).map((s) => s.instanceId + ':' + s.size)));

  // R8 · the corrupt entry whose identity is live on System.
  await page.locator('#pageList li').nth(2).click();   // an empty page, so it fits
  await wait(400);
  posted.length = 0;
  const before = JSON.stringify((await page.evaluate(() => window.__wwReplicaLayout(true))).pages);
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('#retiredGallery .r-row')].find((r) => /4h/.test(r.querySelector('.r-meta').textContent));
    row.querySelector('button').click();
  });
  await wait(500);
  const after = JSON.stringify((await page.evaluate(() => window.__wwReplicaLayout(true))).pages);
  rs = await rows();
  check('R8 an answer for an identity already live on a page seats nothing, and the row stays',
    posted.some((m) => m.type === 'mask-retained') && before === after && rs.some((r) => /4h/.test(r.meta)),
    `pages changed: ${before !== after}`);

  // R7 · stale: an unsaved edit, then the host refuses a save built before a write it made.
  await page.click('#addPage');
  await wait(300);
  await page.evaluate(() => window.__hostPush(JSON.stringify({ type: 'save-refused', reason: 'stale', generation: 9 })));
  await wait(400);
  rs = await rows();
  check('R7 while stale, both are disabled and the hint says to reload',
    rs.length > 0 && rs.every((r) => !r.restore && !r.del) && /reload/.test((await hint()) || ''),
    JSON.stringify({ hint: await hint(), rows: rs.map((r) => [r.restore, r.del]) }));

  // R12-R14 · a second editor, with a host whose next write can fail.
  const layoutB = { pages: [
    { name: 'Home', slots: [
      { widgetId: 'test.gh', size: 'half', instanceId: 'g1', settings: { token: '', repo: 'o/n' }, secretsSet: ['token'] },
      { widgetId: 'test.clock', size: 'half', instanceId: 'k1', settings: {} },
    ] },
  ], retained: [] };
  const ed = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  ed.on('pageerror', (e) => { failures++; console.log('[pageerror]', String(e).slice(0, 300)); });
  const postedB = [];
  const savesB = [];
  let landedNext = true;
  const pushB = (obj) => ed.evaluate((d) => window.__hostPush(d), JSON.stringify(obj)).catch(() => {});
  await ed.exposeFunction('__hostRecv', async (json) => {
    const msg = JSON.parse(json);
    postedB.push(msg);
    if (msg.type === 'settings-ready' || msg.type === 'ready') {
      pushB({ type: 'settings-init', data: { layout: layoutB, widgets, sensors: [], media: null, generation: 1,
        backgroundHost: 'backgrounds.plinth', status: { elevated: false, apiVersion: 1, version: 'probe' } } });
    } else if (msg.type === 'mask-retained') {
      const def = JSON.parse(JSON.stringify(msg.def));
      if (def.settings && def.settings.token) { def.settings.token = ''; def.secretsSet = ['token']; }
      pushB({ type: 'retained-masked', token: msg.token, def });
    } else if (msg.type === 'save-layout') {
      savesB.push(JSON.parse(JSON.stringify(msg.layout)));
      pushB({ type: 'saved', seq: msg.seq, generation: 1 + savesB.length, landed: landedNext });
    }
  });
  await ed.addInitScript(() => {
    if (window.top !== window) return;
    const listeners = new Set();
    window.chrome = { webview: {
      addEventListener(t, cb) { if (t === 'message') listeners.add(cb); },
      postMessage(m) { window.__hostRecv(JSON.stringify(m)); },
    } };
    window.__hostPush = (json) => { const data = JSON.parse(json); listeners.forEach((cb) => { try { cb({ data }); } catch (e) {} }); };
  });
  await ed.addInitScript(fs.readFileSync(path.join(SHELL, 'widget-api.js'), 'utf8'));
  await ed.goto(`http://127.0.0.1:${PORT}/src/Plinth/Shell/settings.html`);
  await wait(1500);
  const dirtyB = () => ed.evaluate(() => document.getElementById('save').classList.contains('dirty'));
  const layoutOf = () => ed.evaluate(() => JSON.parse(JSON.stringify(window.__wwReplicaLayout(true))));
  const removeChip = (name) => ed.evaluate((name) => {
    const chip = [...document.querySelectorAll('#slotList .slot-chip')].find((c) => c.textContent.includes(name));
    chip.querySelector('button[title="Remove"]').click();
  }, name);
  const restoreFirst = () => ed.evaluate(() => document.querySelector('#retiredGallery .r-row button').click());

  // R12 · a credential typed, the tile removed, then restored — all before any save.
  await ed.locator('#slotList .slot-chip .chip-main').first().click();
  await wait(200);
  await ed.locator('#slotDetail .secret-wrap input').first().fill('ghp_TYPED_THEN_REMOVED');
  await wait(200);
  await removeChip('GitHub');
  await wait(400);
  postedB.length = 0;
  await restoreFirst();
  await wait(600);
  const back = ((await layoutOf()).pages[0].slots || []).find((s) => s.instanceId === 'g1');
  check('R12 a tile this editor removed comes back as it was, the typed credential included',
    !!back && back.settings.token === 'ghp_TYPED_THEN_REMOVED' && !postedB.some((m) => m.type === 'mask-retained'),
    JSON.stringify({ back, asked: postedB.map((m) => m.type) }));
  await ed.click('#save');
  await wait(500);
  const savedBack = ((savesB[savesB.length - 1] || { pages: [{}] }).pages[0].slots || []).find((s) => s.instanceId === 'g1');
  check('R12b ...and the save carries it', !!savedBack && savedBack.settings.token === 'ghp_TYPED_THEN_REMOVED',
    JSON.stringify(savedBack));

  // R13 · a Delete whose save did not land stays unsaved, and named.
  await removeChip('Clock');
  await wait(400);
  await ed.evaluate(() => {
    const del = document.querySelector('#retiredGallery .r-row button.danger');
    del.click(); del.click();
  });
  await wait(300);
  landedNext = false;
  await ed.click('#save');
  await wait(500);
  const toastText = await ed.evaluate(() => document.getElementById('toast').textContent);
  check('R13 a save whose write did not land leaves the editor unsaved, and says so',
    (await dirtyB()) && /Not saved/.test(toastText) && JSON.stringify(savesB[savesB.length - 1].retainedDeleted)
      === JSON.stringify([{ widgetId: 'test.clock', instanceId: 'k1' }]),
    JSON.stringify({ dirty: await dirtyB(), toast: toastText }));
  landedNext = true;
  await ed.click('#save');
  await wait(500);
  check('R13b ...so the retry names the Delete again, and clears once it lands',
    JSON.stringify(savesB[savesB.length - 1].retainedDeleted) === JSON.stringify([{ widgetId: 'test.clock', instanceId: 'k1' }])
      && !(await dirtyB()),
    JSON.stringify({ named: savesB[savesB.length - 1].retainedDeleted, dirty: await dirtyB() }));

  // R14 · once the editor takes the layout from disk, the attic is disk's again: sealed,
  // so the same identity goes through the host's mask.
  await removeChip('GitHub');   // g1 again: retired by this copy
  await wait(400);
  const fromDisk = { pages: [{ name: 'Home', slots: [] }], retained: [
    { def: { widgetId: 'test.gh', size: 'half', instanceId: 'g1', settings: { token: SEALED, repo: 'o/n' } }, originPage: 'Home', retiredAt: ago(1) },
  ] };
  await pushB({ type: 'settings-init', data: { layout: fromDisk, widgets, sensors: [], media: null, generation: 7,
    backgroundHost: 'backgrounds.plinth', status: { elevated: false, apiVersion: 1, version: 'probe' } } });
  await wait(800);
  postedB.length = 0;
  await restoreFirst();
  await wait(600);
  const reseated = ((await layoutOf()).pages[0].slots || []).find((s) => s.instanceId === 'g1');
  check('R14 after a reload from disk, the same identity is masked by the host, never seated sealed',
    postedB.some((m) => m.type === 'mask-retained') && !!reseated && reseated.settings.token === ''
      && !JSON.stringify((await layoutOf()).pages).includes(SEALED),
    JSON.stringify({ asked: postedB.map((m) => m.type), reseated }));
  await browser.close();
  srv.close();
  console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
