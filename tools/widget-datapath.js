#!/usr/bin/env node
// Data-path harness — the populated twin of widget-harness.js.
//
// widget-harness aborts every non-shell request on purpose, so it can only ever prove
// a widget's OFFLINE state. That leaves the state a user actually looks at all day
// untested: the one with data in it. This runner serves the widget's API from a stub
// file instead, so the happy path, the shapes it has to survive, and the error paths a
// server can hand back are all exercised in real Chromium.
//
//   node tools/widget-datapath.js widgets/kev --stubs tests/fixtures/widgets/kev.json
//   node tools/widget-datapath.js widgets/kev --slot half --shot kev.png --expect "CVE-"
//
// The stub file is a JSON array; the first entry whose `match` is a substring of the
// request URL wins:
//
//   [{ "match": "cisa.gov", "json": { ... } },
//    { "match": "example.com/slow", "status": 503, "body": "" }]
//
// Every request that matches nothing is aborted exactly as widget-harness does, so a
// widget calling an endpoint you did not stub still lands in its designed failure
// state rather than hanging.
'use strict';
const fs = require('fs');
const path = require('path');

global.window = {};
require(path.join(__dirname, '../src/WaveshareWidgets/Shell/palette.js'));
const derive = global.window.WWPalette.derive;

const SHELL = path.join(__dirname, '../src/WaveshareWidgets/Shell');
const SLOTS = {
  quarter: [320, 400], half: [640, 400], 'three-quarter': [960, 400], full: [1280, 400],
  'quarter-upper': [320, 200], 'half-upper': [640, 200], 'three-quarter-upper': [960, 200], 'full-upper': [1280, 200],
  'quarter-lower': [320, 200], 'half-lower': [640, 200], 'three-quarter-lower': [960, 200], 'full-lower': [1280, 200],
};
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.woff2': 'font/woff2', '.gif': 'image/gif', '.webp': 'image/webp' };

const args = process.argv.slice(2);
const folder = args.find((a) => !a.startsWith('--'));
const opt = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
};
if (!folder) {
  console.error('usage: widget-datapath.js <widget-folder> --stubs <file.json> [--slot half] '
    + '[--theme dark|light] [--settings {json}] [--expect "text"] [--reject "text"] [--wait 1500] [--shot out.png] [--json]');
  process.exit(1);
}

const slot = opt('slot', 'half');
const [W, H] = SLOTS[slot] || slot.split('x').map(Number);
const themeArg = opt('theme', 'dark');
const theme = themeArg === 'dark' ? derive({})
  : themeArg === 'light' ? derive({ background: '#e8e6e1', text: '#12161a', accent: '#b04a2f' })
  : derive(JSON.parse(themeArg));
const settings = (() => {
  const given = JSON.parse(opt('settings', '{}'));
  const merged = {};
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
    for (const prop of manifest.properties || []) if (prop.name) merged[prop.name] = prop.default;
  } catch (e) { /* validator owns manifest errors */ }
  return Object.assign(merged, given);
})();
const stubs = (() => {
  const file = opt('stubs', null);
  if (!file) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8'));
})();
const expects = [];
const rejects = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--expect') expects.push(args[i + 1]);
  if (args[i] === '--reject') rejects.push(args[i + 1]);
}
const waitMs = Number(opt('wait', 1500));
const shot = opt('shot', null);
const asJson = args.includes('--json');

function loadPlaywright() {
  const candidates = ['playwright', '/opt/node22/lib/node_modules/playwright',
    path.join(process.env.HOME || '', 'node_modules/playwright')];
  for (const c of candidates) {
    try { return require(c); } catch (e) { /* next */ }
  }
  console.error('playwright not found — npm i -g playwright (and provide a chromium via PLAYWRIGHT_BROWSERS_PATH or CHROMIUM)');
  process.exit(1);
}

const bodyOf = (stub) => (stub.json !== undefined ? JSON.stringify(stub.json) : String(stub.body == null ? '' : stub.body));

(async () => {
  const { chromium } = loadPlaywright();
  const shim = fs.readFileSync(path.join(SHELL, 'widget-api.js'), 'utf8') + '\n' +
               fs.readFileSync(path.join(SHELL, 'icue-compat.js'), 'utf8');
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: W, height: H } });

  const checks = [];
  const consoleErrors = [];
  const served = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail === undefined ? null : String(detail) });
  page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 300)));

  await page.route('https://app.wsw/**', (route) => {
    const file = path.join(SHELL, new URL(route.request().url()).pathname);
    if (fs.existsSync(file)) return route.fulfill({ contentType: MIME[path.extname(file)] || 'text/plain', body: fs.readFileSync(file) });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.route('https://widget.test/**', (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\//, '') || 'index.html';
    const file = path.join(path.resolve(folder), rel);
    if (file.startsWith(path.resolve(folder)) && fs.existsSync(file) && fs.statSync(file).isFile())
      return route.fulfill({ contentType: MIME[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
    return route.fulfill({ status: 404, body: '' });
  });
  // The stubs. Anything unmatched aborts, same as widget-harness — an un-stubbed
  // endpoint must still land the widget in a designed state, never a hang.
  await page.route(/https?:\/\/(?!app\.wsw|widget\.test).*/, (route) => {
    const url = route.request().url();
    const stub = stubs.find((s) => url.includes(s.match));
    if (!stub) return route.abort();
    served.push(url);
    return route.fulfill({
      status: stub.status || 200,
      contentType: stub.contentType || (stub.json !== undefined ? 'application/json' : 'text/plain'),
      headers: Object.assign({ 'access-control-allow-origin': '*' }, stub.headers || {}),
      body: bodyOf(stub),
    });
  });

  await page.addInitScript(shim);
  // Host-bound messages. ww-fetch is answered from the SAME stub table, because a
  // widget that escalates to the host proxy must reach the same data it would have
  // reached directly — otherwise the stub only covers whichever tier happened to win.
  await page.addInitScript(({ table }) => {
    window.addEventListener('message', (ev) => {
      const m = ev.data || {};
      const reply = (obj) => window.postMessage(obj, '*');
      if (m.type === 'ww-fetch') {
        const stub = table.find((s) => String(m.url || '').includes(s.match));
        if (!stub) return reply({ type: 'ww-fetch-result', id: m.id, error: 'offline harness' });
        // The proxy tier's contract is bodyBase64 + contentType, NOT a body string and
        // a headers map — the shim rebuilds a Response from exactly those fields. Note
        // it carries no response headers beyond Content-Type, so anything reading an
        // ETag off a proxied call legitimately sees nothing; that is the host's shape,
        // and a widget has to survive it.
        const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(stub.bodyText || '')));
        return reply({
          type: 'ww-fetch-result', id: m.id, status: stub.status || 200,
          contentType: stub.contentType || 'application/json', bodyBase64: b64,
        });
      }
      if (m.type === 'ww-ping') reply({ type: 'ww-ping-result', id: m.id, results: [] });
      else if (m.type === 'ww-media-list') reply({ type: 'ww-media-list-result', id: m.id, files: [] });
      else if (m.type === 'ww-audio-get') reply({ type: 'ww-audio-result', id: m.id, available: false });
    });
  }, { table: stubs.map((s) => ({ match: s.match, status: s.status, headers: s.headers, bodyText: bodyOf(s) })) });

  await page.goto('https://widget.test/index.html');
  await page.evaluate(({ settings, theme }) => {
    window.postMessage({ type: 'ww-init', settings, sensors: [], media: null, theme, status: { elevated: false, apiVersion: 1 } }, '*');
  }, { settings, theme });
  await page.waitForTimeout(waitMs);

  check('no page errors', consoleErrors.length === 0, consoleErrors.join(' | '));

  const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());
  for (const want of expects) check(`renders ${JSON.stringify(want)}`, text.includes(want), text.slice(0, 220));
  for (const nope of rejects) check(`does NOT render ${JSON.stringify(nope)}`, !text.includes(nope), text.slice(0, 220));

  // A populated widget must have left its state layer: the whole point of this runner
  // is that a spinner or an error card is a FAILURE when the data was served.
  //
  // --allow-state opts out, for the runs where the state card IS the expected result:
  // an unconfigured widget with no token, a deliberately un-stubbed endpoint. Those
  // still need their text asserted, which is what --expect is for.
  const stateVisible = await page.evaluate(() => {
    const s = document.querySelector('.state-card, .spinner');
    if (!s) return false;
    const r = s.getBoundingClientRect();
    return r.width > 4 && r.height > 4;
  });
  if (!args.includes('--allow-state')) {
    check('state layer cleared (data is showing, not a spinner or error card)', !stateVisible);
  }

  check('no horizontal overflow', await page.evaluate(() =>
    document.documentElement.scrollWidth <= window.innerWidth &&
    document.body.scrollWidth <= window.innerWidth),
    await page.evaluate(() => document.body.scrollWidth + 'w vs viewport ' + window.innerWidth));

  if (shot) await page.screenshot({ path: shot });
  await browser.close();

  const ok = checks.every((c) => c.ok);
  if (asJson) console.log(JSON.stringify({ folder, slot, theme: themeArg, ok, checks, served, consoleErrors }, null, 1));
  else {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${folder} @ ${slot} (${themeArg}) — data path`);
    for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ' - ' + c.detail : ''}`);
  }
  process.exit(ok ? 0 : 1);
})();
