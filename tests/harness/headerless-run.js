#!/usr/bin/env node
// What the header used to carry, where it went (beta.21: "Remove all, move what matters").
// Two widgets whose header held a state or a control the body now has to handle itself:
//
//   G1 · GPU: a card with sensors shows its readouts and the device name, not the empty state
//   G2 · ...a card whose only GPU reading is its memory load still shows it: the empty state
//        ("no GPU sensors") is for no GPU reading at all, and it hides the readouts
//   G3 · ...and a machine with no GPU sensor gets the empty state
//   N1 · Notifications: the privacy eye, which moved from the header into the tile's
//        corner, covers no app header, notification or dismiss button on a quarter tile, on
//        a half tile (one column) or on a three-quarter tile (two columns, where the right
//        column's first header starts at the top, beside the eye), with no mute bar
//   N2 · ...nor with the mute bar showing
//
// Run: CHROMIUM=/path/to/chrome node tests/harness/headerless-run.js
'use strict';
const fs = require('fs');
const path = require('path');

function loadPlaywright() {
  const candidates = ['playwright', '/opt/node22/lib/node_modules/playwright',
    path.join(process.env.HOME || '', 'node_modules/playwright')];
  for (const c of candidates) { try { return require(c); } catch (e) { /* next */ } }
  console.error('playwright not found');
  process.exit(1);
}

const REPO = path.resolve(__dirname, '..', '..');
const SHELL = path.join(REPO, 'src', 'Plinth', 'Shell');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  if (!ok) failures++;
};

const serve = (route, dir, rel) => {
  const file = path.join(dir, rel || 'index.html');
  if (!file.startsWith(dir) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
  return route.fulfill({ contentType: MIME[path.extname(file)] || 'text/plain', body: fs.readFileSync(file) });
};

// The widget in an iframe under a shell page that answers ww-ready the way the panel does:
// ww-init at once. The `after` messages (a sensor frame, the notifications) follow a beat
// later, as the host's own pushes do: an init answered at once lands while the widget is
// still parsing, before its onSensors/onNotifications listeners exist. `storage` seeds the
// widget origin's localStorage (per-instance state such as muted apps).
async function mount(browser, widget, size, init, after, storage) {
  const [width, height] = size.split('x').map(Number);
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', (e) => { failures++; console.log('[pageerror]', String(e).slice(0, 300)); });
  const shellPage = '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}'
    + 'iframe{border:0;width:100vw;height:100vh;display:block}</style><script>'
    + 'var INIT=' + JSON.stringify(init) + ',AFTER=' + JSON.stringify(after || []) + ';'
    + 'addEventListener("message",function(ev){var f=document.getElementById("w");'
    + 'if(!f||ev.source!==f.contentWindow||!ev.data||ev.data.type!=="ww-ready")return;'
    + 'f.contentWindow.postMessage(INIT,"https://widget.test");'
    + 'setTimeout(function(){AFTER.forEach(function(m){f.contentWindow.postMessage(m,"https://widget.test");});},300);});'
    + '<\/script><iframe id="w" src="https://widget.test/index.html#ww-slot=p0s0"></iframe>';
  const dir = path.join(REPO, 'widgets', widget);
  await page.route('https://app.plinth/**', (r) => serve(r, SHELL, new URL(r.request().url()).pathname.slice(1)));
  await page.route('https://widget.test/**', (r) => serve(r, dir, new URL(r.request().url()).pathname.slice(1)));
  await page.route('https://shell.test/**', (r) => r.fulfill({ contentType: 'text/html', body: shellPage }));
  await page.route(/https?:\/\/(?!(?:app\.plinth|shell\.test|widget\.test)(?:[/?#]|$)).*/, (r) => r.abort());
  await page.addInitScript(fs.readFileSync(path.join(SHELL, 'widget-api.js'), 'utf8'));
  if (storage) await page.addInitScript((kv) => {
    if (location.origin !== 'https://widget.test') return;
    for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v);
  }, storage);
  await page.goto('https://shell.test/host.html');
  const frame = await (await page.waitForSelector('#w')).contentFrame();
  await page.waitForTimeout(900);
  return { page, frame };
}

const init = (settings, sensors) => ({ type: 'ww-init', settings: settings || {}, sensors: sensors || [],
  media: null, theme: {}, status: { elevated: false, apiVersion: 1 } });
const gpuSensor = (id, name, type, value) =>
  ({ id: 'lhm:/gpu-nvidia/0/' + id, name, device: 'NVIDIA GeForce RTX 4070', deviceType: 'GpuNvidia', type, units: '', value });

(async () => {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});

  // ---- GPU -----------------------------------------------------------------------------
  const gpuState = (frame) => frame.evaluate(() => ({
    empty: !document.getElementById('state').hidden,
    main: !document.getElementById('main').hidden,
    vram: document.getElementById('vram').firstChild ? document.getElementById('vram').firstChild.textContent : '',
    device: document.getElementById('device').textContent,
  }));
  const frameOf = (sensors) => [init({}, sensors), [{ type: 'ww-sensors', sensors }]];
  let m = await mount(browser, 'gpu', '640x400', ...frameOf([
    gpuSensor('load/0', 'GPU Core', 'Load', 37), gpuSensor('temperature/0', 'GPU Core', 'Temperature', 61),
    gpuSensor('clock/0', 'GPU Core', 'Clock', 2310), gpuSensor('load/3', 'GPU Memory', 'Load', 22)]));
  let g = await gpuState(m.frame);
  check('G1 a GPU with sensors shows its readouts and device name, not the empty state',
    !g.empty && g.main && /RTX 4070/.test(g.device), JSON.stringify(g));
  await m.page.close();

  m = await mount(browser, 'gpu', '640x400', ...frameOf([gpuSensor('load/3', 'GPU Memory', 'Load', 48)]));
  g = await gpuState(m.frame);
  check('G2 a GPU whose only reading is memory load still shows it', !g.empty && g.main && g.vram === '48',
    JSON.stringify(g));
  await m.page.close();

  m = await mount(browser, 'gpu', '640x400', ...frameOf([
    { id: 'lhm:/cpu/0/load/0', name: 'CPU Total', device: 'CPU', deviceType: 'Cpu', type: 'Load', units: '', value: 12 }]));
  g = await gpuState(m.frame);
  check('G3 no GPU sensor at all gets the empty state', g.empty && !g.main, JSON.stringify(g));
  await m.page.close();

  // ---- Notifications ---------------------------------------------------------------------
  const now = Date.now();
  const items = [];
  // Long names on purpose: a header's name runs toward the eye, and a short one never
  // reaches it whatever the layout does.
  for (const [app, n] of [['Discord Canary Development Build', 2], ['Microsoft Outlook Desktop Client', 2],
    ['Microsoft Teams for Work or School', 2], ['Slack Technologies Workspace App', 1],
    ['Steam Client Bootstrapper Service', 1]])
    for (let i = 0; i < n; i++)
      items.push({ id: app + i, app, title: app + ' message ' + i, body: 'Body text ' + i, time: now - (i + 1) * 60000 });
  const notif = { type: 'ww-notifications', data: { state: 'allowed', supported: true, items } };
  // What the eye could cover, against its box: the app header's name and count (the header
  // keeps a padded strip under the eye on purpose — a tap there is the eye's), each
  // notification's text, its dismiss button, and the mute bar's chips.
  const overlaps = (frame) => frame.evaluate(() => {
    const eye = document.getElementById('eyeBtn');
    if (!eye || eye.hidden) return { eye: false, hits: [] };
    const e = eye.getBoundingClientRect();
    const hits = [];
    for (const n of document.querySelectorAll('#list .app-name, #list .app-count, #list .item .txt, #list .dismiss, #muteBar .chip')) {
      const r = n.getBoundingClientRect();
      if (r.width === 0 || r.bottom <= 0 || r.top >= innerHeight) continue;
      if (r.left < e.right && e.left < r.right && r.top < e.bottom && e.top < r.bottom)
        hits.push(n.className + ' "' + n.textContent.trim().slice(0, 24) + '"');
    }
    return { eye: true, hits, columns: getComputedStyle(document.getElementById('list')).columnCount };
  });
  for (const size of ['320x400', '640x400', '960x400', '1280x400']) {
    m = await mount(browser, 'notifications', size, init({ maxItems: 24 }), [notif]);
    const o = await overlaps(m.frame);
    check(`N1 ${size} the corner eye covers no header, notification or button`,
      o.eye && o.hits.length === 0, JSON.stringify(o));
    await m.page.close();
  }
  // With the mute bar: the bar reserves the eye's room itself, and the list starts below it.
  for (const size of ['640x400', '960x400']) {
    m = await mount(browser, 'notifications', size, init({ maxItems: 24 }), [notif],
      { 'ww.notifications.mute:p0s0': JSON.stringify([{ k: 'microsoft outlook desktop client', n: 'Outlook' }]) });
    const o = await overlaps(m.frame);
    const bar = await m.frame.evaluate(() => !document.getElementById('muteBar').hidden);
    check(`N2 ${size} with the mute bar showing, the eye still covers nothing`,
      bar && o.eye && o.hits.length === 0, JSON.stringify({ bar, ...o }));
    await m.page.close();
  }

  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})();
