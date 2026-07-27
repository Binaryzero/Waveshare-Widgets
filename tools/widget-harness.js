#!/usr/bin/env node
// Headless widget harness — loads a widget in real Chromium with the real
// widget-base.css + widget-api.js, delivers a ww-init, and checks the standard's
// runtime contract. Self-contained: everything is served route-fulfilled from disk.
//
//   node tools/widget-harness.js widgets/clock
//   node tools/widget-harness.js widgets/cpu --slot quarter --theme light --shot cpu.png
//   node tools/widget-harness.js widgets/hue --settings '{"bgStyle":"transparent"}' --json
//
// Checks: loads with zero page errors; renders visible content after init; the
// bgStyle class contract (body background = rgba(surface-rgb, alpha)); pushed theme
// tokens actually land; no horizontal overflow at the slot size. Machine-readable
// with --json; exit 0 only when every check passes. Needs playwright + a chromium
// (PLAYWRIGHT_BROWSERS_PATH or executablePath via CHROMIUM env).
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
  console.error('usage: widget-harness.js <widget-folder> [--slot half] [--theme dark|light|{json}] [--settings {json}] [--shot out.png] [--json]');
  process.exit(1);
}

const slot = opt('slot', 'half');
const [W, H] = SLOTS[slot] || slot.split('x').map(Number);
const themeArg = opt('theme', 'dark');
const theme = themeArg === 'dark' ? derive({})
  : themeArg === 'light' ? derive({ background: '#e8e6e1', text: '#12161a', accent: '#b04a2f' })
  : derive(JSON.parse(themeArg));
// Merge manifest defaults under the provided settings, exactly like the host does —
// a widget must see the same payload here as on the panel.
const settings = (() => {
  const given = JSON.parse(opt('settings', '{}'));
  const merged = {};
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
    for (const prop of manifest.properties || []) if (prop.name) merged[prop.name] = prop.default;
  } catch (e) { /* validator owns manifest errors */ }
  return Object.assign(merged, given);
})();
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

(async () => {
  const { chromium } = loadPlaywright();
  const shim = fs.readFileSync(path.join(SHELL, 'widget-api.js'), 'utf8') + '\n' +
               fs.readFileSync(path.join(SHELL, 'icue-compat.js'), 'utf8');
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: W, height: H } });

  const checks = [];
  const consoleErrors = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail === undefined ? null : String(detail) });
  page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 300)));

  // The widget's own files + the shell foundation, all from disk.
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
  // Anything else (widget data fetches) fails fast and deterministically — the
  // standard requires a graceful state for exactly this.
  await page.route(/https?:\/\/(?!app\.wsw|widget\.test).*/, (route) => route.abort());

  await page.addInitScript(shim);
  // Answer host-bound requests so widgets waiting on data settle quickly.
  await page.addInitScript(() => {
    window.addEventListener('message', (ev) => {
      const m = ev.data || {};
      const reply = (obj) => window.postMessage(obj, '*');
      if (m.type === 'ww-fetch') reply({ type: 'ww-fetch-result', id: m.id, error: 'offline harness' });
      else if (m.type === 'ww-ping') reply({ type: 'ww-ping-result', id: m.id, results: [] });
      else if (m.type === 'ww-media-list') reply({ type: 'ww-media-list-result', id: m.id, files: [] });
      else if (m.type === 'ww-audio-get') reply({ type: 'ww-audio-result', id: m.id, available: false });
    });
  });

  await page.goto('https://widget.test/index.html');
  await page.evaluate(({ settings, theme }) => {
    window.postMessage({ type: 'ww-init', settings, sensors: [], media: null, theme, status: { elevated: false, apiVersion: 1 } }, '*');
  }, { settings, theme });
  await page.waitForTimeout(1200);

  check('no page errors', consoleErrors.length === 0, consoleErrors.join(' | '));
  check('visible content rendered', await page.evaluate(() =>
    [...document.body.querySelectorAll('*')].some((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 4 && r.height > 4 && getComputedStyle(el).visibility !== 'hidden';
    })));

  const themed = await page.evaluate(() => document.documentElement.style.getPropertyValue('--accent').trim());
  check('theme tokens landed on :root', themed === theme['--accent'], `${themed} vs ${theme['--accent']}`);

  const bg = await page.evaluate(() => ({
    color: getComputedStyle(document.body).backgroundColor,
    cls: document.body.className,
  }));
  const alpha = settings.bgStyle === 'transparent' ? 0 : settings.bgStyle === 'glass' ? Number(theme['--panel-alpha']) : 1;
  const rgb = theme['--surface-rgb'];
  // Chromium ≥ 141 serializes a transparent computed background with its color
  // components preserved (rgba(r, g, b, 0)), older builds normalized to
  // rgba(0, 0, 0, 0) — the contract is "alpha 0", so accept both.
  const expected = alpha === 0 ? ['rgba(0, 0, 0, 0)', `rgba(${rgb}, 0)`]
    : alpha === 1 ? [`rgb(${rgb})`, `rgba(${rgb}, 1)`]
    : [`rgba(${rgb}, ${alpha})`];
  check('bgStyle contract (body background)', expected.some((e) => bg.color === e),
    `got ${bg.color} (class "${bg.cls}"), expected ${expected.join(' or ')}`);

  check('no horizontal overflow', await page.evaluate(() =>
    document.documentElement.scrollWidth <= window.innerWidth &&
    document.body.scrollWidth <= window.innerWidth),
    await page.evaluate(() => document.body.scrollWidth + 'w vs viewport ' + window.innerWidth));

  if (shot) await page.screenshot({ path: shot });
  await browser.close();

  const ok = checks.every((c) => c.ok);
  if (asJson) console.log(JSON.stringify({ folder, slot, theme: themeArg, ok, checks, consoleErrors }, null, 1));
  else {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${folder} @ ${slot} (${themeArg})`);
    for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ' - ' + c.detail : ''}`);
  }
  process.exit(ok ? 0 : 1);
})();
