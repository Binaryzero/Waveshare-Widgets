#!/usr/bin/env node
// The settings window's own frame: what sits between the header and the bottom edge.
//
//   L1 · the stale-layout banner is hidden when nothing is stale — its display:flex used
//        to outrank [hidden], leaving an empty orange bar under the header on every open
//   L2 · on a tall window the dock and its columns reach the bottom edge: no empty band
//   L3 · ...and the canvas keeps the size it fits to, rather than giving height up to it
//   L4 · a shorter window refits: the canvas keeps its size, the dock still ends at the edge
//   L5 · with a widget selected the dock still ends at the edge
//   L6 · with the preview hidden the dock takes the window down to the edge
//   L9 · a very tall window with a long form open: the columns reach the edge too
//   L10 · ...and a shorter window afterwards is not squeezed by the height the form had
//   L7 · at the 780x480 minimum, long form open, the dock ends exactly at the bottom edge
//   L8 · the banner still shows when the panel changes the layout under unsaved work
//   L11 · with nothing selected the dock's empty column says what goes there, and gives
//         way once a widget is open
//
// Run: CHROMIUM=/path/to/chrome node tests/harness/settingslayout-run.js
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
const PORT = 8966;

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
  supportedSlots: ['quarter', 'half'],
  properties: [
    { name: 'label', label: 'Label', type: 'text' },
    { name: 'mode', label: 'Mode', type: 'select', options: ['a', 'b'] },
  ],
}, {
  // Settings enough to be taller than the dock's own cap, which is what decides whether
  // the fill and the cap are kept apart.
  id: 'test.many', name: 'Many', author: 'WW',
  url: `http://127.0.0.1:${PORT}/widgets/clock/index.html`,
  supportedSlots: ['quarter', 'half'],
  properties: Array.from({ length: 30 }, (_, i) => ({ name: 'f' + i, label: 'Field ' + i, type: 'text' })),
}];
const layout = { pages: [{ name: 'System', slots: [
  { widgetId: 'test.clock', size: 'half', instanceId: 'c1', settings: { label: 'One' } },
  { widgetId: 'test.many', size: 'half', instanceId: 'm1', settings: {} },
] }] };

(async () => {
  const srv = await staticServer(REPO, PORT);
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on('pageerror', (e) => { failures++; console.log('[pageerror]', String(e).slice(0, 300)); });
  page.on('console', (m) => { if (/ResizeObserver loop/i.test(m.text())) { failures++; console.log('[console]', m.text()); } });
  await page.exposeFunction('__hostRecv', async (json) => {
    const msg = JSON.parse(json);
    const push = (obj) => page.evaluate((d) => window.__hostPush(d), JSON.stringify(obj)).catch(() => {});
    if (msg.type === 'settings-ready' || msg.type === 'ready') {
      push({ type: 'settings-init', data: { layout, widgets, sensors: [], media: null, generation: 1,
        backgroundHost: 'backgrounds.plinth', status: { elevated: false, apiVersion: 1, version: 'probe' } } });
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

  const frame = () => page.evaluate(() => {
    const r = (id) => { const e = document.getElementById(id); const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, height: b.height }; };
    const banner = document.getElementById('staleLayout');
    return {
      inner: window.innerHeight,
      dock: r('dock'),
      body: r('dockBody'),
      stage: r('previewStage'),
      banner: { hidden: banner.hidden, display: getComputedStyle(banner).display, height: banner.getBoundingClientRect().height, text: banner.textContent.trim().slice(0, 40) },
    };
  });

  const hint = () => page.evaluate(() => {
    const e = document.getElementById('dockEmpty');
    return { shown: !!e && getComputedStyle(e).display !== 'none', text: e ? e.textContent : '' };
  });
  const idle = await hint();
  check('L11 with nothing selected, the dock says what goes in its empty column',
    idle.shown && /change its settings/.test(idle.text), JSON.stringify(idle));

  let f = await frame();
  check('L1 the stale-layout banner is hidden when nothing is stale',
    f.banner.hidden && f.banner.display === 'none' && f.banner.height === 0, JSON.stringify(f.banner));
  check('L2 on a tall window the dock, and its columns, reach the bottom edge',
    Math.abs(f.dock.bottom - f.inner) <= 1 && Math.abs(f.body.bottom - f.inner) <= 1,
    `dock bottom ${f.dock.bottom}, columns ${f.body.bottom} of ${f.inner}`);
  // 1280 wide: the stage is 1280 less the wrap's padding and its own border, and the
  // canvas fits that width at under native scale.
  const fitted = Math.round(400 * Math.min((1280 - 32 - 2) / 1280, 1));
  check('L3 ...and the canvas keeps the size it fits to', Math.abs(f.stage.height - fitted) <= 2,
    `stage ${f.stage.height}, fits ${fitted}`);

  await page.setViewportSize({ width: 1280, height: 860 });
  await wait(500);
  f = await frame();
  check('L4 a shorter window refits: the canvas keeps its size, the dock still ends at the edge',
    Math.abs(f.stage.height - fitted) <= 2 && Math.abs(f.dock.bottom - f.inner) <= 1,
    `stage ${f.stage.height}, dock bottom ${f.dock.bottom} of ${f.inner}`);

  await page.evaluate(() => { const chip = document.querySelector('#slotList .slot-chip .chip-main'); if (chip) chip.click(); });
  await wait(500);
  f = await frame();
  const open = await page.evaluate(() => document.getElementById('contextPanel').classList.contains('open'));
  const busy = await hint();
  check('L11b ...and the hint gives way once a widget is open', !busy.shown, JSON.stringify(busy));
  check('L5 with a widget selected the dock still ends at the edge',
    open && Math.abs(f.dock.bottom - f.inner) <= 1 && Math.abs(f.body.bottom - f.inner) <= 1,
    `inspector open ${open}, dock bottom ${f.dock.bottom}, columns ${f.body.bottom} of ${f.inner}`);

  await page.click('#previewToggle');
  await wait(400);
  f = await frame();
  check('L6 with the preview hidden the dock takes the window down to the edge',
    f.stage.height === 0 && Math.abs(f.dock.bottom - f.inner) <= 1, `stage ${f.stage.height}, dock bottom ${f.dock.bottom} of ${f.inner}`);
  await page.click('#previewToggle');
  await wait(400);

  // A widget whose settings are taller than the dock's cap.
  await page.evaluate(() => { const chips = document.querySelectorAll('#slotList .slot-chip .chip-main'); if (chips[1]) chips[1].click(); });
  await page.setViewportSize({ width: 1280, height: 1700 });
  await wait(600);
  f = await frame();
  check('L9 a very tall window with a long form open: the columns reach the bottom edge',
    Math.abs(f.dock.bottom - f.inner) <= 1 && Math.abs(f.body.bottom - f.inner) <= 1,
    `dock bottom ${f.dock.bottom}, columns ${f.body.bottom} of ${f.inner}`);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await wait(600);
  f = await frame();
  check('L10 ...and back at 1000 tall the canvas is not squeezed by the height the form had',
    f.stage.height > 250 && Math.abs(f.dock.bottom - f.inner) <= 1,
    `stage ${f.stage.height}, dock bottom ${f.dock.bottom} of ${f.inner}`);

  await page.setViewportSize({ width: 780, height: 480 });
  await wait(600);
  f = await frame();
  check('L7 at the 780x480 minimum, long form open, the dock ends exactly at the bottom edge',
    Math.abs(f.dock.bottom - f.inner) <= 1 && Math.abs(f.body.bottom - f.inner) <= 1 && f.stage.height >= 60,
    `stage ${f.stage.height}, dock bottom ${f.dock.bottom}, columns ${f.body.bottom} of ${f.inner}`);

  await page.setViewportSize({ width: 1280, height: 1000 });
  await wait(400);
  await page.click('#addPage');
  await wait(300);
  await page.evaluate((l) => window.__hostPush(JSON.stringify({ type: 'layout-written', layout: l, generation: 2 })), layout);
  await wait(400);
  f = await frame();
  check('L8 the banner still shows when the panel changes the layout under unsaved work',
    !f.banner.hidden && f.banner.display === 'flex' && f.banner.height > 20 && /changed the layout/.test(f.banner.text),
    JSON.stringify(f.banner));

  await browser.close();
  srv.close();
  console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
