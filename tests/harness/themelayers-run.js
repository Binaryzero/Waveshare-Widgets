#!/usr/bin/env node
// Issue #225 — the appearance layers are real but were invisible in the settings window.
//   L1 · a tile that overrides the theme is marked in the tile strip; one that follows is not
//   L2 · its Appearance panel says, per value, whether it comes from the theme or this widget
//   L3 · "Follow the theme again" drops the override, and the save carries no style
//   L4 · the Theme editor names the widgets its colours will not reach, and can revert one
//   L5 · a tile with no override offers no revert
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const http = require('http');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const PORT = 8962;

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
  { id: 'test.clock', name: 'Clock', supportedSlots: ['half'], properties: [] },
  { id: 'test.cpu', name: 'CPU', supportedSlots: ['half'], properties: [] },
];
const layout = {
  theme: { accent: '#00ff88' },
  pages: [{
    name: 'Main',
    slots: [
      { widgetId: 'test.clock', size: 'half', instanceId: 'c1', settings: {}, style: { accent: '#ff0000', panelAlpha: 0.5 } },
      { widgetId: 'test.cpu', size: 'half', instanceId: 'u1', settings: {} },
    ],
  }],
};

(async () => {
  const srv = await staticServer(REPO, PORT);
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
  page.on('pageerror', (e) => { failures++; console.log('[pageerror]', String(e).slice(0, 300)); });
  const saved = [];
  const push = (obj) => page.evaluate((d) => window.__hostPush(d), JSON.stringify(obj)).catch(() => {});
  await page.exposeFunction('__hostRecv', async (json) => {
    const msg = JSON.parse(json);
    if (msg.type === 'settings-ready') {
      push({ type: 'settings-init', data: {
        layout, widgets, sensors: [], backgroundHost: 'backgrounds.plinth',
        status: { elevated: false, version: 'v0.2.0 (probe)' },
      } });
    } else if (msg.type === 'save-layout') {
      saved.push(JSON.parse(JSON.stringify(msg.layout)));
      push({ type: 'saved', seq: msg.seq, generation: saved.length });
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

  const chips = page.locator('#slotList .slot-chip');
  const mark = (i) => chips.nth(i).locator('.chip-style');
  check('L1 the tile that overrides the theme is marked in the strip',
    await mark(0).count() === 1 && /accent, panel opacity/.test(await mark(0).getAttribute('title')),
    await mark(0).count() ? await mark(0).getAttribute('title') : 'no mark');
  check('L1b ...and the tile that follows the theme is not', await mark(1).count() === 0);

  await chips.nth(0).locator('.chip-main').click();
  await page.waitForTimeout(250);
  const sources = await page.locator('#styleBody .style-row .style-source').allTextContents();
  check('L2 each Appearance value says which layer it comes from',
    JSON.stringify(sources) === JSON.stringify(['this widget', 'theme', 'theme', 'this widget']), JSON.stringify(sources));

  const revert = page.locator('#styleBody .style-revert');
  check('L3 setup: an overridden tile offers "Follow the theme again"', await revert.count() === 1);
  if (await revert.count()) await revert.click();
  await page.waitForTimeout(250);
  await page.locator('#save').click();
  await page.waitForTimeout(500);
  const slot0 = saved.length ? saved[saved.length - 1].pages[0].slots[0] : {};
  check('L3 following the theme again drops the override from what is saved',
    saved.length > 0 && !('style' in slot0), JSON.stringify(slot0.style));
  check('L3b ...the strip mark goes with it', await mark(0).count() === 0);
  check('L5 and a tile with no override offers no revert', await page.locator('#styleBody .style-revert').count() === 0);

  // L4 · the Theme editor, from a fresh init that still carries the override.
  await push({ type: 'settings-init', data: {
    layout: JSON.parse(JSON.stringify(layout)), widgets, sensors: [], backgroundHost: 'backgrounds.plinth',
    status: { elevated: false, version: 'v0.2.0 (probe)' },
  } });
  await page.waitForTimeout(500);
  await page.locator('#themeBtn').click();
  await page.waitForTimeout(250);
  const listed = await page.locator('#themeEditor .theme-override span').allTextContents();
  check('L4 the Theme editor names the widgets its colours will not reach, and which colours',
    listed.length === 1 && /Clock · Main — accent, panel opacity/.test(listed[0]), JSON.stringify(listed));
  const back = page.locator('#themeEditor .theme-override button');
  if (await back.count()) await back.click();
  await page.waitForTimeout(250);
  await page.locator('#save').click();
  await page.waitForTimeout(500);
  const after = saved[saved.length - 1].pages[0].slots[0];
  check('L4b ...and reverts one from there',
    !('style' in after) && await page.locator('#themeEditor .theme-override').count() === 0,
    JSON.stringify(after.style));

  await browser.close();
  srv.close();
  console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
