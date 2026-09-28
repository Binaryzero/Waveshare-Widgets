#!/usr/bin/env node
// Text scales with the tile (owner, beta.21: "everything is too TINY").
//
// widget-api.js stamps --ts on a widget document's root from the tile's size, and
// widget-base.css multiplies every type size by it. A widget's own type does the same
// (WIDGET-STANDARD §6).
//
//   S1 · the curve: 1.3 at the smallest tile, 1.97 at a full 1280x400 one, 2.5 at most,
//        1 for a size that is no size; it only grows as the tile does
//   S2 · a widget document gets --ts on :root, and WW.tileScale says the same number
//   S3 · the base type multiplies by it: body text is 13.5px times --ts
//   S4 · a resized tile re-stamps it without a reload
//   S5 · a document that is not a widget (a page a widget embeds) gets no --ts: the shim
//        is injected into every document, and the page may use the name itself
//
// Run: CHROMIUM=/path/to/chrome node tests/harness/tilescale-run.js
//      node tests/harness/tilescale-run.js --curve   (S1 only, no browser: what CI runs)
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const SHELL = path.join(REPO, 'src', 'Plinth', 'Shell');
const API = fs.readFileSync(path.join(SHELL, 'widget-api.js'), 'utf8');

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  if (!ok) failures++;
};

// ---- S1 · the curve, extracted from the shipped file and run ---------------------------
const block = (API.split('// >>> ww-tile-scale')[1] || '').split('// <<< ww-tile-scale')[0]
  .split('\n').slice(1).join('\n');   // the marker line's own text is not code
const tileScale = new Function(block + '\nreturn tileScale;')();
const cases = [
  [320, 200, 1.3], [1280, 400, 1.97], [2560, 720, 2.5], [0, 400, 1], [NaN, 200, 1],
];
const got = cases.map(([w, h]) => tileScale(w, h));
check('S1 1.3 at 320x200, 1.97 at 1280x400, capped at 2.5, 1 for no size',
  cases.every(([, , want], i) => got[i] === want), JSON.stringify(got));
const SIZES = [[320, 200], [640, 200], [320, 400], [960, 200], [640, 400], [1280, 200],
  [640, 360], [960, 400], [1280, 400], [1280, 720], [2560, 360], [2560, 720]];
const byArea = SIZES.slice().sort((a, b) => a[0] * a[1] - b[0] * b[1]).map(([w, h]) => tileScale(w, h));
check('S1b it never shrinks as the tile grows', byArea.every((v, i) => i === 0 || v >= byArea[i - 1]),
  SIZES.map(([w, h]) => `${w}x${h}=${tileScale(w, h)}`).join(' '));

if (process.argv.includes('--curve')) {
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}

// ---- S2-S5 · in a browser -----------------------------------------------------------
function loadPlaywright() {
  const candidates = ['playwright', '/opt/node22/lib/node_modules/playwright',
    path.join(process.env.HOME || '', 'node_modules/playwright')];
  for (const c of candidates) { try { return require(c); } catch (e) { /* next */ } }
  console.error('playwright not found');
  process.exit(1);
}

const WIDGET = '<!doctype html><html><head><meta charset="utf-8">'
  + '<link rel="stylesheet" href="https://app.plinth/widget-base.css"></head>'
  + '<body><p id="t">text</p><script src="https://app.plinth/widget-api.js"></script></body></html>';
const EMBED = '<!doctype html><html><head><meta charset="utf-8"></head><body>embedded</body></html>';

(async () => {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 400 } });
  page.on('pageerror', (e) => { failures++; console.log('[pageerror]', String(e).slice(0, 300)); });
  await page.route('https://app.plinth/**', (r) => {
    const f = path.join(SHELL, new URL(r.request().url()).pathname.slice(1));
    if (!fs.existsSync(f)) return r.fulfill({ status: 404, body: '' });
    return r.fulfill({ contentType: f.endsWith('.css') ? 'text/css' : f.endsWith('.js') ? 'application/javascript' : 'font/woff2',
      body: fs.readFileSync(f) });
  });
  await page.route('https://widget.test/**', (r) => r.fulfill({ contentType: 'text/html', body: WIDGET }));
  await page.route('https://embed.test/**', (r) => r.fulfill({ contentType: 'text/html', body: EMBED }));
  await page.route('https://shell.test/**', (r) => r.fulfill({ contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><style>body{margin:0}iframe{border:0;display:block}</style>'
      + '<iframe id="w" style="width:1280px;height:400px" src="https://widget.test/index.html#ww-slot=p0s0"></iframe>'
      + '<iframe id="e" style="width:1280px;height:400px" src="https://embed.test/index.html"></iframe>' }));
  // Injected into every document, as the WebView injects it.
  await page.addInitScript(API);
  await page.goto('https://shell.test/host.html');
  const frameOf = async (id) => (await page.waitForSelector('#' + id)).contentFrame();
  const w = await frameOf('w');
  await w.waitForFunction(() => window.WW && getComputedStyle(document.body).fontSize !== '');
  const read = () => w.evaluate(() => ({
    ts: document.documentElement.style.getPropertyValue('--ts'),
    api: window.WW.tileScale,
    body: parseFloat(getComputedStyle(document.body).fontSize),
  }));

  const full = await read();
  check('S2 a widget document gets --ts, and WW.tileScale agrees', full.ts === '1.97' && full.api === 1.97,
    JSON.stringify(full));
  check('S3 body text is 13.5px times --ts', Math.abs(full.body - 13.5 * 1.97) < 0.05, `${full.body}px`);

  await page.evaluate(() => { const f = document.getElementById('w'); f.style.width = '320px'; f.style.height = '200px'; });
  await w.waitForFunction(() => window.WW.tileScale === 1.3, null, { timeout: 5000 }).catch(() => {});
  const small = await read();
  check('S4 a resized tile re-stamps it', small.ts === '1.3' && small.api === 1.3
    && Math.abs(small.body - 13.5 * 1.3) < 0.05, JSON.stringify(small));

  const e = await frameOf('e');
  await e.waitForFunction(() => document.readyState === 'complete');
  const embedded = await e.evaluate(() => document.documentElement.style.getPropertyValue('--ts'));
  check('S5 a document that is not a widget gets no --ts', embedded === '', JSON.stringify(embedded));

  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})();
