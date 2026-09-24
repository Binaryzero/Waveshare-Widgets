#!/usr/bin/env node
// Issue #227 — the settings window's side of update indicators. Which widgets are new and
// which tiles changed is the host's call (tools/WidgetCatalog); this is what the window
// does with it.
//   U1 · a widget marked new carries "New" on the shelf; one that is not, does not
//   U2 · a tile flagged by the host reads "Updated" in the strip; an unflagged one does not
//   U3 · opening the flagged tile tells the host and clears the mark
//   U4 · adding the new widget hides its badge at once, before any save
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const http = require('http');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const PORT = 8963;

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

const widgets = [
  { id: 'test.hue', name: 'Hue', supportedSlots: ['half', 'quarter'], properties: [], isNew: true },
  { id: 'test.clock', name: 'Clock', supportedSlots: ['half', 'quarter'], properties: [] },
];
const layout = { pages: [{ name: 'Main', slots: [
  { widgetId: 'test.clock', size: 'quarter', instanceId: 'c1', settings: {} },
  { widgetId: 'test.clock', size: 'quarter', instanceId: 'c2', settings: {} },
] }] };

(async () => {
  const srv = await staticServer(REPO, PORT);
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
  page.on('pageerror', (e) => { failures++; console.log('[pageerror]', String(e).slice(0, 300)); });
  const received = [];
  const push = (obj) => page.evaluate((d) => window.__hostPush(d), JSON.stringify(obj)).catch(() => {});
  await page.exposeFunction('__hostRecv', async (json) => {
    const msg = JSON.parse(json);
    received.push(msg);
    if (msg.type === 'settings-ready') {
      push({ type: 'settings-init', data: {
        layout, widgets, sensors: [], backgroundHost: 'backgrounds.plinth', reviewTiles: ['c1'],
        status: { elevated: false, version: 'v0.2.0 (probe)' },
      } });
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
  await page.waitForTimeout(900);

  const item = (name) => page.locator('#widgetGallery .gallery-item', { hasText: name });
  check('U1 the new widget carries "New" on the shelf', await item('Hue').locator('.g-new').count() === 1);
  check('U1b ...and the other does not', await item('Clock').locator('.g-new').count() === 0);

  const chips = page.locator('#slotList .slot-chip');
  check('U2 the flagged tile reads "Updated"', await chips.nth(0).locator('.chip-updated').count() === 1);
  check('U2b ...and the unflagged one does not', await chips.nth(1).locator('.chip-updated').count() === 0);

  await chips.nth(0).locator('.chip-main').click();
  await page.waitForTimeout(250);
  const told = received.filter((m) => m.type === 'tile-reviewed');
  check('U3 opening it tells the host which tile was reviewed',
    told.length === 1 && told[0].instanceId === 'c1', JSON.stringify(told));
  check('U3b ...and the mark is gone', await page.locator('#slotList .slot-chip .chip-updated').count() === 0);

  if (await item('Hue').count()) await item('Hue').click();
  await page.waitForTimeout(300);
  check('U4 adding the new widget hides its badge at once',
    await page.locator('#slotList .slot-chip', { hasText: 'Hue' }).count() === 1
      && await item('Hue').locator('.g-new').count() === 0);

  await browser.close();
  srv.close();
  console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
