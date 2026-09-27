#!/usr/bin/env node
// Duplicate copies the credential (#226). The host half — Seal filling a fresh copy's
// untouched blank from the tile it names in `copiedFrom` — is tools/SecretRoundTrip E5.
// These are the two client halves, asked what they actually send.
//
// On the PANEL, which is handed the credentials revealed:
//   P1 · the copy is a new tile with its own instanceId, naming its source in copiedFrom
//   P2 · it carries the revealed credential itself, for the host to seal for the copy
//   P3 · a credential the host blanked for the panel (secretsRestorable) travels as a
//        marker, so the host can fill it from the source
//   P4 · a pending Clear on the source travels too, so the copy does not keep it alive
//   P5 · the button says what it does
// In the SETTINGS window, which never holds a stored credential:
//   S1 · the copy names its source, and its stored credential reads "saved", not "not set"
//   S2 · the saved copy sends a blank (the host fills it) and copiedFrom
//   S3 · a credential typed into the source this session rides as the value it is
//   S4 · a pending Clear on the source rides as a Clear
//   S5 · a capture from the preview, which never saw copiedFrom, keeps it
//   S6 · swapping the copy to another widget drops it: that widget has nothing to copy
//
// Run: CHROMIUM=/path/to/chrome node tests/harness/duplicate-run.js
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
const PORT = 8965;

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

const REVEALED = 'ghp_REVEALED_ON_PANEL';
const widgets = [{
  id: 'test.gh', name: 'GitHub Queue', author: 'WW',
  url: `http://127.0.0.1:${PORT}/widgets/clock/index.html`,
  supportedSlots: ['quarter', 'half'],
  properties: [
    { name: 'token', label: 'Token', type: 'secret', help: 'A token.' },
    { name: 'repo', label: 'Repository', type: 'text' },
    // Demoted (#66): the host blanked it and named it in secretsRestorable.
    { name: 'legacyToken', label: 'Legacy token', type: 'text' },
  ],
}, {
  id: 'test.other', name: 'Other', author: 'WW',
  url: `http://127.0.0.1:${PORT}/widgets/clock/index.html`,
  supportedSlots: ['quarter', 'half'],
  properties: [{ name: 'token', label: 'Token', type: 'secret', help: 'A token.' }],
}];

async function hostPage(browser, url, initType, layout, saves, viewport) {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (e) => { failures++; console.log('[pageerror]', String(e).slice(0, 300)); });
  await page.exposeFunction('__hostRecv', async (json) => {
    const msg = JSON.parse(json);
    const push = (obj) => page.evaluate((d) => window.__hostPush(d), JSON.stringify(obj)).catch(() => {});
    if (msg.type === 'ready' || msg.type === 'settings-ready') {
      push({ type: initType, data: { layout, widgets, sensors: [], media: null,
        backgroundHost: 'backgrounds.plinth', status: { elevated: false, apiVersion: 1, version: 'probe' } } });
    } else if (msg.type === 'save-layout') {
      saves.push(JSON.parse(JSON.stringify(msg.layout)));
      if (msg.seq !== undefined) push({ type: 'saved', seq: msg.seq });
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
  await page.goto(url);
  await wait(1200);
  return page;
}

(async () => {
  const srv = await staticServer(REPO, PORT);
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});

  // ---- the panel -----------------------------------------------------------------------
  const panelSaves = [];
  const panelLayout = { pages: [{ name: 'P', slots: [{
    widgetId: 'test.gh', size: 'quarter', instanceId: 'src1',
    settings: { token: REVEALED, repo: 'owner/name', legacyToken: '' },
    secretsRestorable: ['legacyToken'],
  }] }] };
  const panel = await hostPage(browser, `http://127.0.0.1:${PORT}/src/Plinth/Shell/index.html`,
    'init', panelLayout, panelSaves, { width: 1280, height: 400 });
  await panel.locator('#editBtn').click();
  await wait(250);
  const dupe = panel.locator('.slot').first().locator('.edit-overlay .dupe');
  const dupeTitle = await dupe.getAttribute('title');
  await dupe.click();
  await wait(600);
  const lastPanel = () => panelSaves[panelSaves.length - 1] || { pages: [{ slots: [] }] };
  let slotsNow = lastPanel().pages[0].slots;
  const source = slotsNow.find((s) => s.instanceId === 'src1') || {};
  const copy = slotsNow.find((s) => s.widgetId === 'test.gh' && s.instanceId !== 'src1') || {};
  check('P1 the copy is a new tile with its own identity, naming its source',
    slotsNow.length === 2 && !!copy.instanceId && copy.copiedFrom === 'src1',
    JSON.stringify(slotsNow.map((s) => [s.instanceId, s.copiedFrom])));
  check('P2 ...and carries the revealed credential for the host to seal for it',
    copy.settings && copy.settings.token === REVEALED && copy.settings.repo === 'owner/name'
      && source.settings && source.settings.token === REVEALED,
    JSON.stringify(copy.settings));
  check('P3 a credential the host blanked for the panel travels as a marker',
    JSON.stringify(copy.secretsRestorable) === JSON.stringify(['legacyToken']),
    JSON.stringify(copy.secretsRestorable));

  // P4 · Clear the source's token on the sheet, then duplicate again.
  await panel.locator('.slot').first().locator('.edit-overlay .gear').click();
  await wait(250);
  const tokenRow = panel.locator('#psRows .ps-secret').first();
  await tokenRow.locator('.ps-clear').click();
  await wait(900);   // edits persist on a debounce
  await panel.evaluate(() => document.getElementById('psClose').click());
  await wait(300);
  await panel.locator('.slot').first().locator('.edit-overlay .dupe').click();
  await wait(600);
  slotsNow = lastPanel().pages[0].slots;
  const sourceNow = slotsNow.find((s) => s.instanceId === 'src1') || {};
  const second = slotsNow.find((s) => s.widgetId === 'test.gh' && s.instanceId !== 'src1'
    && s.instanceId !== copy.instanceId) || {};
  check('P4 a pending Clear on the source travels with the copy',
    (sourceNow.secretsCleared || []).includes('token') && (second.secretsCleared || []).includes('token')
      && second.copiedFrom === 'src1' && !second.settings.token,
    JSON.stringify({ source: sourceNow.secretsCleared, copy: second.secretsCleared, token: second.settings && second.settings.token }));
  check('P5 the button says the credentials come along',
    /credentials included/i.test(dupeTitle || ''), dupeTitle);
  await panel.close();

  // ---- the settings window ---------------------------------------------------------------
  const setSaves = [];
  const setLayout = { pages: [{ name: 'Main', slots: [{
    widgetId: 'test.gh', size: 'quarter', instanceId: 'gh1',
    settings: { token: '', repo: 'owner/name', legacyToken: '' },
    secretsSet: ['token'],
    secretsRestorable: ['legacyToken'],
  }] }] };
  const set = await hostPage(browser, `http://127.0.0.1:${PORT}/src/Plinth/Shell/settings.html`,
    'settings-init', setLayout, setSaves, { width: 1100, height: 820 });
  const chips = set.locator('#slotList .slot-chip');
  const dupeOf = (i) => chips.nth(i).locator('button[title*="Add another one"]');
  await dupeOf(0).click();
  await wait(300);
  // The editor opens the copy, which is what the user configures next.
  const copyState = await set.locator('#slotDetail .secret-wrap .secret-state').first().textContent().catch(() => '');
  const inMemory = await set.evaluate(() => JSON.parse(JSON.stringify(window.__wwReplicaLayout(true))));
  const memCopy = (inMemory.pages[0].slots || [])[1] || {};
  check('S1 the copy names its source, and its stored credential reads as saved',
    memCopy.copiedFrom === 'gh1' && /saved/i.test(copyState || '') && memCopy.instanceId !== 'gh1',
    JSON.stringify({ copiedFrom: memCopy.copiedFrom, state: copyState }));
  await set.locator('#save').click();
  await wait(400);
  const lastSet = () => setSaves[setSaves.length - 1] || { pages: [{ slots: [] }] };
  const savedCopy = lastSet().pages[0].slots[1] || {};
  check('S2 the saved copy sends a blank for the host to fill, and copiedFrom',
    savedCopy.copiedFrom === 'gh1' && savedCopy.settings && savedCopy.settings.token === ''
      && JSON.stringify(savedCopy.secretsRestorable) === JSON.stringify(['legacyToken']),
    JSON.stringify({ copiedFrom: savedCopy.copiedFrom, token: savedCopy.settings && savedCopy.settings.token,
      restorable: savedCopy.secretsRestorable }));

  // S3 · type a credential into the source, then duplicate it.
  await chips.nth(0).locator('.chip-main').click();
  await wait(200);
  await set.locator('#slotDetail .secret-wrap input').first().fill('ghp_TYPED_HERE');
  await wait(150);
  await dupeOf(0).click();
  await wait(300);
  const afterTyped = await set.evaluate(() => JSON.parse(JSON.stringify(window.__wwReplicaLayout(true))));
  const typedCopy = afterTyped.pages[0].slots[afterTyped.pages[0].slots.length - 1] || {};
  check('S3 a credential typed into the source this session rides as the value it is',
    typedCopy.settings && typedCopy.settings.token === 'ghp_TYPED_HERE' && typedCopy.copiedFrom === 'gh1',
    JSON.stringify(typedCopy.settings));

  // S4 · Clear the source's credential, then duplicate it.
  await chips.nth(0).locator('.chip-main').click();
  await wait(200);
  await set.locator('#slotDetail .secret-wrap').first().locator('button[title*="Remove the stored credential"]').click();
  await wait(150);
  await dupeOf(0).click();
  await wait(300);
  const afterClear = await set.evaluate(() => JSON.parse(JSON.stringify(window.__wwReplicaLayout(true))));
  const clearedCopy = afterClear.pages[0].slots[afterClear.pages[0].slots.length - 1] || {};
  const clearedState = await set.locator('#slotDetail .secret-wrap .secret-state').first().textContent().catch(() => '');
  check('S4 a pending Clear on the source rides as a Clear, and the copy reads "not set"',
    (clearedCopy.secretsCleared || []).includes('token') && !(clearedCopy.secretsSet || []).includes('token')
      && /not set/i.test(clearedState || ''),
    JSON.stringify({ cleared: clearedCopy.secretsCleared, set: clearedCopy.secretsSet, state: clearedState }));

  // S5 · a capture from the preview, shaped like the replica's own scrubbed view.
  const merged = await set.evaluate(() => {
    const captured = JSON.parse(JSON.stringify(window.__wwReplicaLayout()));
    for (const page of captured.pages) for (const slot of page.slots) delete slot.copiedFrom;
    return window.__wwMergeReplicaCapture(captured);
  });
  const mergedCopy = (merged.pages[0].slots || [])[1] || {};
  check('S5 a capture from the preview keeps the copy\'s copiedFrom',
    mergedCopy.copiedFrom === 'gh1', JSON.stringify({ id: mergedCopy.instanceId, copiedFrom: mergedCopy.copiedFrom }));

  // S6 · swap the first copy to another widget.
  await chips.nth(1).locator('.chip-main').click();
  await wait(200);
  await set.locator('#slotDetail select').first().selectOption('test.other');
  await wait(200);
  const afterSwap = await set.evaluate(() => JSON.parse(JSON.stringify(window.__wwReplicaLayout(true))));
  const swapped = afterSwap.pages[0].slots[1] || {};
  check('S6 swapping the copy to another widget drops copiedFrom',
    swapped.widgetId === 'test.other' && swapped.copiedFrom === undefined,
    JSON.stringify({ widgetId: swapped.widgetId, copiedFrom: swapped.copiedFrom }));

  await browser.close();
  srv.close();
  console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
