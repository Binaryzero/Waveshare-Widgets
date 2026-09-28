#!/usr/bin/env node
// The settings preview is drawn at the PANEL's page size, not a fixed 1280x400. The
// dashboard's grid is fractions, so on a Corsair XENEON EDGE (2560x720) a quarter tile is
// 640x720; a preview still drawn at 1280x400 showed 320x400 tiles, a different shape, and
// widgets that lay out by their size showed a layout the panel never does. The host sends
// the size with the init (src/Plinth/App/PanelModels.cs, tools/WindowPlacement P1-P5).
//
//   E1 · with no panel connected the preview is the Waveshare's 1280x400, and the size
//        labels quote its tiles
//   E2 · a XENEON EDGE: the preview page is 2560x720, scaled to fit at the panel's shape
//   E3 · ...the shell inside lays its tiles out on that page, so a half tile is 1280 wide
//   E4 · ...and the size labels quote the EDGE's tiles
//   E5 · the same panel at 150% display scaling is a 1707x480 page
//   E6 · a size that is not a sane one keeps the preview as it was
//
// Run: CHROMIUM=/path/to/chrome node tests/harness/panelpage-run.js
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
const PORT = 8969;

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

const widgets = [{
  id: 'test.clock', name: 'Clock', author: 'WW',
  url: `http://127.0.0.1:${PORT}/widgets/clock/index.html`,
  supportedSlots: ['quarter', 'half', 'full'],
  properties: [{ name: 'label', label: 'Label', type: 'text' }],
}];
const layout = { pages: [{ name: 'Main', slots: [
  { widgetId: 'test.clock', size: 'half', instanceId: 'h1', settings: {} },
  { widgetId: 'test.clock', size: 'quarter-upper', instanceId: 'q1', settings: {} },
] }] };

(async () => {
  const srv = await staticServer(REPO, PORT);
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('pageerror', (e) => { failures++; console.log('[pageerror]', String(e).slice(0, 300)); });
  let panel;   // what the next init carries; undefined = no panel connected
  await page.exposeFunction('__hostRecv', async (json) => {
    const msg = JSON.parse(json);
    if (msg.type === 'settings-ready' || msg.type === 'ready') {
      const data = { layout, widgets, sensors: [], media: null, generation: 1,
        backgroundHost: 'backgrounds.plinth', status: { elevated: false, apiVersion: 1, version: 'probe' } };
      if (panel !== undefined) data.panel = panel;
      await page.evaluate((d) => window.__hostPush(d), JSON.stringify({ type: 'settings-init', data })).catch(() => {});
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

  const open = async (p) => {
    panel = p;
    await page.goto(`http://127.0.0.1:${PORT}/src/Plinth/Shell/settings.html`);
    await wait(2000);
  };
  const frame = () => page.evaluate(() => {
    const f = document.getElementById('previewFrame');
    const stage = document.getElementById('previewStage');
    const m = /scale\(([\d.]+)\)/.exec(f.style.transform || '');
    const w = f.contentWindow;
    const slots = f.contentDocument ? [...f.contentDocument.querySelectorAll('.slot')].map((s) => {
      const r = s.getBoundingClientRect();
      return [Math.round(r.width), Math.round(r.height)];
    }) : [];
    return { page: [w.innerWidth, w.innerHeight], scale: m ? Number(m[1]) : null,
      stageW: stage.clientWidth, stageH: stage.getBoundingClientRect().height, slots };
  });
  const labels = async () => {
    await page.locator('#slotList .slot-chip .chip-main').first().click();
    await wait(300);
    return page.evaluate(() => [...document.querySelectorAll('#slotDetail select.size option')].map((o) => o.textContent));
  };

  // E1 · no panel.
  await open(undefined);
  let f = await frame();
  check('E1 with no panel connected the preview page is 1280x400',
    f.page[0] === 1280 && f.page[1] === 400 && Math.abs(f.stageH - Math.round(400 * f.scale)) <= 1, JSON.stringify(f));
  let l = await labels();
  check('E1b ...and the size labels quote its tiles', l.includes('Half (640×400)') && l.includes('Quarter · top (320×200)'),
    JSON.stringify(l));

  // E2-E4 · a XENEON EDGE at 100%.
  await open({ width: 2560, height: 720, model: 'Corsair XENEON EDGE' });
  f = await frame();
  check('E2 a XENEON EDGE: the preview page is 2560x720',
    f.page[0] === 2560 && f.page[1] === 720, JSON.stringify(f.page));
  check('E2b ...scaled to fit the stage at the panel\'s shape',
    f.scale > 0 && f.scale <= 1 && Math.round(2560 * f.scale) <= f.stageW
      && Math.abs(f.stageH - Math.round(720 * f.scale)) <= 1,
    JSON.stringify({ scale: f.scale, stageW: f.stageW, stageH: f.stageH }));
  // Tiles have a small gutter; the widest is the half, and it is half the page less that.
  const widest = f.slots.reduce((a, s) => (s[0] > a[0] ? s : a), [0, 0]);
  check('E3 the shell inside lays its tiles out on that page: a half tile is about 1280x720',
    widest[0] > 1200 && widest[0] <= 1280 && widest[1] > 660 && widest[1] <= 720, JSON.stringify(f.slots));
  l = await labels();
  check('E4 the size labels quote the EDGE\'s tiles',
    l.includes('Half (1280×720)') && l.includes('Quarter · top (640×360)') && l.includes('Full (2560×720)'), JSON.stringify(l));

  // E5 · the same panel at 150%.
  await open({ width: 1707, height: 480 });
  f = await frame();
  check('E5 at 150% display scaling the page is 1707x480', f.page[0] === 1707 && f.page[1] === 480, JSON.stringify(f.page));

  // E6 · sizes that are not sane ones.
  for (const [label, p] of [['a zero', { width: 0, height: 720 }], ['strings', { width: '2560', height: '720' }],
    ['a fraction', { width: 2560.5, height: 720 }], ['a huge one', { width: 100000, height: 720 }], ['null', null]]) {
    await open(p);
    f = await frame();
    check(`E6 ${label} keeps the preview at 1280x400`, f.page[0] === 1280 && f.page[1] === 400, JSON.stringify(f.page));
  }

  await browser.close();
  srv.close();
  console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
