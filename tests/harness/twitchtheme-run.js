#!/usr/bin/env node
// Twitch Chat: the chat follows the panel's appearance ("most widgets do not respect the
// theme setting", beta.21). Twitch's embed takes one switch, darkpopout, so the widget
// derives it from the theme's --appearance and re-derives it on a live theme push:
//
//   T1 · 'auto' (the default) on a light panel loads the light chat
//   T2 · ...and a live push to a dark theme swaps it to the dark chat, and back (T3)
//   T4 · 'auto' on a dark panel loads the dark chat
//   T5 · 'dark' pinned on a light panel stays dark; 'light' pinned on a dark panel stays
//        light, through a theme push too (T6)
//   T7 · an unusable channel loads no chat, and a theme push does not load one either
//
// The chat itself is Twitch's page and is never fetched here: the src the widget sets is
// the whole contract.
//
// Run: CHROMIUM=/path/to/chrome node tests/harness/twitchtheme-run.js
'use strict';
const fs = require('fs');
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
const WIDGET = path.join(REPO, 'widgets', 'twitch');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

// The themes the host would push, derived by the shell's own palette code.
global.window = {};
require(path.join(SHELL, 'palette.js'));
const derive = global.window.WWPalette.derive;
const DARK = derive({});
const LIGHT = derive({ background: '#e8e6e1', text: '#12161a', accent: '#b04a2f' });

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  if (!ok) failures++;
};

async function mount(browser, settings, theme) {
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  page.on('pageerror', (e) => { failures++; console.log('[pageerror]', String(e).slice(0, 300)); });
  const serve = (route, dir, rel) => {
    const root = path.resolve(dir);
    const file = path.resolve(root, rel);
    if ((file === root || file.startsWith(root + path.sep)) && fs.existsSync(file) && fs.statSync(file).isFile())
      return route.fulfill({ contentType: MIME[path.extname(file)] || 'text/plain', body: fs.readFileSync(file) });
    return route.fulfill({ status: 404, body: '' });
  };
  await page.route('https://app.plinth/**', (r) =>
    serve(r, SHELL, decodeURIComponent(new URL(r.request().url()).pathname).replace(/^\/+/, '')));
  await page.route('https://widget.test/**', (r) =>
    serve(r, WIDGET, decodeURIComponent(new URL(r.request().url()).pathname).replace(/^\/+/, '') || 'index.html'));
  await page.route('https://shell.test/**', (r) => r.fulfill({ contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><body style="margin:0"></body>' }));
  // Twitch itself is never reached: the embed's src is what is under test.
  await page.route(/https?:\/\/(?!(?:app\.plinth|widget\.test|shell\.test)(?:[/?#:]|$)).*/, (r) => r.abort());
  await page.addInitScript(fs.readFileSync(path.join(SHELL, 'widget-api.js'), 'utf8'));
  await page.addInitScript(({ settings, theme }) => {
    if (window.top !== window) return;
    let frame = null;
    window.__wwMount = () => {
      frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      frame.style.cssText = 'display:block;border:0;width:100vw;height:100vh';
      frame.src = 'https://widget.test/index.html#ww-slot=p0s0';
      document.body.appendChild(frame);
    };
    window.__wwPush = (msg) => { if (frame && frame.contentWindow) frame.contentWindow.postMessage(msg, 'https://widget.test'); };
    window.addEventListener('message', (ev) => {
      if (!frame || ev.source !== frame.contentWindow || ev.origin !== 'https://widget.test') return;
      if ((ev.data || {}).type === 'ww-ready') window.__wwPush({ type: 'ww-init', settings, sensors: [], media: null,
        theme, status: { elevated: false, apiVersion: 1 } });
    });
  }, { settings, theme });
  await page.goto('https://shell.test/host.html');
  await page.evaluate(() => window.__wwMount());
  const frame = await (await page.waitForSelector('iframe', { timeout: 10000 })).contentFrame();
  // Attached, not visible: an unusable channel hides the embed.
  await frame.waitForSelector('#frame', { state: 'attached', timeout: 10000 });
  await page.waitForTimeout(600);
  const src = () => frame.evaluate(() => document.getElementById('frame').getAttribute('src') || '');
  const push = async (t) => {
    await page.evaluate((th) => window.__wwPush({ type: 'ww-theme', theme: th }), t);
    await page.waitForTimeout(300);
  };
  return { page, src, push };
}

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const chat = /^https:\/\/www\.twitch\.tv\/embed\/monstercat\/chat\?parent=widget\.test/;

  // No theme key at all: the manifest default, as a never-edited slot has it.
  let m = await mount(browser, { channel: 'monstercat', msgSize: 100 }, LIGHT);
  let s = await m.src();
  check('T1 auto on a light panel loads the light chat', chat.test(s) && !/darkpopout/.test(s), s);
  await m.push(DARK);
  s = await m.src();
  check('T2 a live push to a dark theme swaps it to the dark chat', chat.test(s) && /darkpopout/.test(s), s);
  await m.push(LIGHT);
  s = await m.src();
  check('T3 ...and back to light', chat.test(s) && !/darkpopout/.test(s), s);
  await m.page.close();

  m = await mount(browser, { channel: 'monstercat', theme: 'auto' }, DARK);
  s = await m.src();
  check('T4 auto on a dark panel loads the dark chat', chat.test(s) && /darkpopout/.test(s), s);
  await m.page.close();

  m = await mount(browser, { channel: 'monstercat', theme: 'dark' }, LIGHT);
  s = await m.src();
  check('T5 dark pinned on a light panel stays dark', /darkpopout/.test(s), s);
  await m.page.close();
  m = await mount(browser, { channel: 'monstercat', theme: 'light' }, DARK);
  s = await m.src();
  const pinnedLight = !/darkpopout/.test(s);
  await m.push(LIGHT);
  await m.push(DARK);
  s = await m.src();
  check('T6 light pinned on a dark panel stays light, through theme pushes', pinnedLight && chat.test(s) && !/darkpopout/.test(s), s);
  await m.page.close();

  m = await mount(browser, { channel: 'https://example.com/x' }, DARK);
  await m.push(LIGHT);
  s = await m.src();
  check('T7 an unusable channel loads no chat, before or after a theme push', s === '' || s === 'about:blank', s);
  await m.page.close();

  await browser.close();
  console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
