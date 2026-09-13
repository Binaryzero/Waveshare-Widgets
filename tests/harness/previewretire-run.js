#!/usr/bin/env node
// The RELAY half of "a preview removal retires on the one retire path" (#226).
//
// tests/harness/atticretire-run.js is the CI half: it extracts onReplicaRemove and
// removeSlotAt from the real settings.js and drives them directly, so the DECISION —
// what lands in the attic, what is refused — is pinned on every push. It cannot see the
// part that has to work for any of that to matter: whether tapping the ✕ in the live
// preview actually reaches the settings window at all. That needs two real documents
// and a real postMessage, so it needs a browser, so it runs here rather than in CI —
// the same split as bodycap-run.js (CI) beside proxy-headers-run.js (local).
//
// This boots the REAL settings.html, lets it drive the REAL replica, and answers as the
// native host would. The assertion that matters is E10: a credential typed into the
// settings form — which the replica is never given, and never sees — must be the value
// sitting in the attic entry the host receives on save. That is the whole feature. It is
// also the exact thing the withdrawn union of PR #269 could not do, and the reason the
// preview's ✕ discarded instead of retiring for as long as it did.
//
//   E1-E4 · the scene: replica up, a credential typed, edit mode on, the ✕ tapped twice
//   E5    · the tile leaves the preview
//   E7-E8 · a save reaches the host carrying exactly one attic entry
//   E9    · under the LIVE slot's identity — never one the replica minted (#68)
//   E10   · carrying the credential the replica was never given
//   E11   · the neighbouring tile is untouched (no off-by-one splice through the new door)
//
// Run: CHROMIUM=/path/to/chrome node tests/harness/previewretire-run.js
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const http = require('http');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const PORT = 8971;

function staticServer(rootDir, port) {
  const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
    '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
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

(async () => {
  const srv = await staticServer(REPO, PORT);
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));

  // The catalog exactly as SettingsWindow.WidgetCatalog() projects it — `properties`,
  // each entry keyed by `name`. A synthetic widget rather than a real manifest: this
  // suite needs a `secret` property and must not go red the day the widget that happens
  // to have one changes its mind.
  const widget = {
    id: 'test.gh', name: 'GH', displayName: 'GH', version: '1.0.0',
    url: 'https://test-gh.widgets.plinth/index.html',
    supportedSlots: ['half'],
    properties: [
      { name: 'token', label: 'Token', type: 'secret' },
      { name: 'repo', label: 'Repo', type: 'text' },
    ],
  };

  // TWO tiles. With one, an off-by-one splice and a correct removal look identical:
  // the page ends up empty either way. The survivor's identity is the assertion.
  const layout = { pages: [{ name: 'Main', slots: [
    { widgetId: 'test.gh', size: 'half', instanceId: 'gh1', settings: { token: '', repo: 'one' }, secretsSet: ['token'] },
    { widgetId: 'test.gh', size: 'half', instanceId: 'gh2', settings: { token: '', repo: 'two' }, secretsSet: ['token'] },
  ] }] };

  const hostSeen = [];
  await page.exposeFunction('__hostRecv', async (json) => {
    const msg = JSON.parse(json);
    hostSeen.push(msg);
    const push = (o) => page.evaluate((d) => window.__hostPush(d), JSON.stringify(o)).catch(() => {});
    if (msg.type === 'settings-ready') {
      push({ type: 'settings-init', data: { layout, widgets: [widget], sensors: [],
        backgroundHost: 'backgrounds.plinth', status: { elevated: false, version: 'v0 (probe)' } } });
    } else if (msg.type === 'save-layout') {
      push({ type: 'saved', seq: msg.seq });
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
  await page.waitForTimeout(2500);   // replica boot + ready/init handshake

  const replica = page.frames().find((f) => /Shell\/index\.html/.test(f.url()));
  check('E1 the preview replica is running', !!replica, replica ? 'index.html?preview=1' : 'no replica frame');
  if (!replica) { console.log(errors.join('\n')); await browser.close(); srv.close(); process.exit(1); }

  // ---- E2 · a credential that exists ONLY in the settings working copy ---------------
  // replicaLayout blanks it on the way down, so this value has never been inside the
  // replica's document. If it survives the retire, it survived because the settings side
  // did the retiring.
  await page.evaluate(() => {
    const chips = document.querySelectorAll('.slot-chip');
    (chips[0] && (chips[0].querySelector('.chip-main') || chips[0]) || {}).click?.();
  });
  await page.waitForTimeout(600);
  const typed = await page.evaluate(() => {
    const inp = [...document.querySelectorAll('input')].find((i) => i.type === 'password' && !i.disabled);
    if (!inp) return null;
    // Through the native setter, so the framework-free listeners on `input` see it.
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      .call(inp, 'ghp_TYPED_IN_SETTINGS');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    inp.blur();
    return 'typed into a masked field';
  });
  check('E2 a credential was typed into the settings form', !!typed, typed || 'no secret input rendered');
  await page.waitForTimeout(600);

  const editOn = await page.evaluate(() => (document.getElementById('editToggle') || {}).getAttribute?.('aria-pressed'));
  check('E3 the preview is in edit mode', editOn === 'true', `aria-pressed=${editOn}`);

  // ---- E4/E5 · the gesture -----------------------------------------------------------
  const before = await replica.evaluate(() => document.querySelectorAll('.slot').length);
  const clicked = await replica.evaluate(() => {
    const btn = document.querySelector('.slot .edit-overlay .remove');
    if (!btn) return 'no ✕ in the overlay';
    btn.click(); btn.click();   // confirmThen: the ✕ arms on the first tap, fires on the second
    return 'tapped twice';
  });
  check('E4 the preview ✕ was tapped twice', clicked === 'tapped twice', clicked);
  await page.waitForTimeout(1200);   // past refreshReplica's 350ms debounce and the re-init

  const after = await replica.evaluate(() => document.querySelectorAll('.slot').length);
  check('E5 the tile left the preview', after === before - 1, `${before} -> ${after}`);
  // Deliberately NOT asserted here: that the replica's own layoutData.retained stayed
  // undefined. It is IIFE-scoped and unreachable from this side, and reaching for it
  // would mean exporting shell internals for a test. atticretire-run.js pins the same
  // property statically instead (L0b: removeSlot begins `if (PREVIEW) return;`).

  // ---- E7-E11 · what actually reaches the host ---------------------------------------
  hostSeen.length = 0;
  await page.evaluate(() => (document.getElementById('save') || {}).click?.());
  await page.waitForTimeout(1200);

  const save = hostSeen.find((m) => m.type === 'save-layout');
  check('E7 a save reached the host', !!save,
    save ? 'save-layout' : `saw: ${hostSeen.map((m) => m.type).join(',') || 'nothing'}`);
  const ret = save && save.layout && save.layout.retained;
  check('E8 the saved layout carries exactly one attic entry',
    Array.isArray(ret) && ret.length === 1,
    JSON.stringify(ret && ret.map((r) => r.def && r.def.instanceId)));
  const def = ret && ret[0] && ret[0].def;
  check('E9 ...under the LIVE slot\'s identity, not one the replica minted (#68)',
    !!def && def.instanceId === 'gh1', def && def.instanceId);
  check('E10 ...carrying the credential the replica was never given',
    !!def && def.settings && def.settings.token === 'ghp_TYPED_IN_SETTINGS',
    def && def.settings && JSON.stringify(def.settings.token));
  const pages = save && save.layout && save.layout.pages;
  check('E11 the neighbouring tile is untouched — no off-by-one splice',
    !!pages && pages[0].slots.length === 1 && pages[0].slots[0].instanceId === 'gh2',
    pages && JSON.stringify(pages[0].slots.map((s) => s.instanceId)));

  if (errors.length) console.log('\n  page errors:\n   ' + errors.join('\n   '));
  console.log(failures > 0 ? `\n${failures} FAILURES` : '\nALL PASS');
  await browser.close();
  srv.close();
  process.exit(failures > 0 ? 1 : 0);
})();
