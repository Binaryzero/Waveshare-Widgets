#!/usr/bin/env node
// Issue #151 — the settings window's refusal banner.
//   R1 · a refused widget with no working copy gets the "not loaded" block
//   R2 · an older refused copy beside one that LOADED gets its own block: the widget
//        works, the old copy is keeping settings from it, and the fix is to remove it
//   R3 · a rescan that removes the old copy removes its block; an empty list hides all
// The host decides WHICH refusals to send (RefusalBanner, tools/SecretRoundTrip B1);
// this is what the window does with them.
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const http = require('http');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');

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

const widgets = [{
  id: 'test.gh', name: 'GitHub Queue', supportedSlots: ['half'],
  properties: [{ name: 'apiToken', label: 'Token', type: 'secret', help: 'From GitHub.' }],
}];
const layout = { pages: [{ name: 'Main', slots: [] }] };
const refused = { id: 'test.bad', name: 'Bad Widget', folder: 'C:\\widgets\\bad', reason: "property 'apiToken' looks like a credential" };
const shadowed = { id: 'test.gh', name: 'GitHub Queue', folder: 'C:\\widgets\\github-1.2',
  reason: "property 'apiToken' looks like a credential", shadowed: true, withheld: ['apiToken'] };

(async () => {
  const srv = await staticServer(REPO, 8954);
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
  page.on('pageerror', (e) => { failures++; console.log('[pageerror]', String(e).slice(0, 300)); });
  const push = (obj) => page.evaluate((d) => window.__hostPush(d), JSON.stringify(obj)).catch(() => {});
  await page.exposeFunction('__hostRecv', async (json) => {
    const msg = JSON.parse(json);
    if (msg.type === 'settings-ready') {
      push({ type: 'settings-init', data: {
        layout, widgets, sensors: [], backgroundHost: 'backgrounds.plinth',
        status: { elevated: false, version: 'v0.2.0 (probe)' },
        rejectedWidgets: [refused, shadowed],
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
  await page.goto('http://127.0.0.1:8954/src/Plinth/Shell/settings.html');
  await page.waitForTimeout(900);

  const box = page.locator('#rejectedWidgets');
  const titles = async () => box.locator('h2').allTextContents();
  const text = async () => (await box.textContent()) || '';

  let t = await titles();
  check('R1 a refused widget with no working copy is reported as not loaded',
    t.includes('1 widget was not loaded'), JSON.stringify(t));
  check('R2 an old refused copy beside a loaded one gets its own block',
    t.includes('An old copy of 1 widget is holding back its settings'), JSON.stringify(t));
  const all = await text();
  check('R2b ...naming the setting it withholds and the folder to remove',
    /GitHub Queue — withholding apiToken/.test(all) && all.includes('C:\\widgets\\github-1.2'), all.slice(0, 400));
  check('R2c ...and the shadowed copy is NOT listed as unavailable',
    (await box.locator('ul').first().textContent()).includes('Bad Widget')
      && !(await box.locator('ul').first().textContent()).includes('GitHub Queue'));

  await push({ type: 'widgets-changed', widgets, rejectedWidgets: [refused] });
  await page.waitForTimeout(300);
  t = await titles();
  check('R3 removing the old copy removes its block',
    t.length === 1 && t[0] === '1 widget was not loaded', JSON.stringify(t));
  await push({ type: 'widgets-changed', widgets, rejectedWidgets: [] });
  await page.waitForTimeout(300);
  check('R3b and an empty list hides the banner', await box.evaluate((n) => n.hidden) === true);

  await browser.close();
  srv.close();
  console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
