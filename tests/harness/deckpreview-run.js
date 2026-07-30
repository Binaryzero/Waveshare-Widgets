#!/usr/bin/env node
// Issue #78 — "the Control Deck renders nothing in the settings live preview", the
// THIRD time the deck has come back empty (#43, #49).
//
// The reason it keeps coming back is that this surface had no coverage at all. Every
// other suite drives the shell directly with a stubbed `chrome.webview`, and the
// preview replica is not that: it is a second shell instance running inside an iframe
// of the settings page, talking to its host by relaying
// window.parent.postMessage({type:'ww-shell'|'ww-host'}). Nothing exercised the relay,
// so nothing could catch a widget that fails only there.
//
// This suite boots the REAL settings.html, lets it drive the REAL replica, and serves
// each widget from its own virtual host the way the WebView2 mapping does.
//
//   D1 · the replica runs and builds an iframe per slot
//   D2 · the deck — which paints ONLY from ww-init — shows its default keys
//   D3 · the control, and the reason the field screenshot is ambiguous: the clock
//        paints on a timer whether or not ww-init ever arrives, so a tile full of
//        clock proves nothing about delivery
//   D4 · every supported size, with and without a persisted instanceId
//   D5 · a widget with no host at all still says so, so a delivery failure can
//        never present as a blank tile
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const http = require('http');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const SHELL = path.join(REPO, 'src', 'WaveshareWidgets', 'Shell');
const PORT = 8954;

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

/** The catalog exactly as SettingsWindow.WidgetCatalog() projects it: the manifest's
 *  own property list (defaults included) plus a URL per widget. Read from the real
 *  manifests so the fixture cannot drift away from what ships — a hand-written copy
 *  of the deck's defaults would make this suite agree with itself rather than with
 *  the widget. */
function catalogEntry(slug) {
  const m = JSON.parse(fs.readFileSync(path.join(REPO, 'widgets', slug, 'manifest.json'), 'utf8'));
  return {
    id: m.id, name: m.name, author: m.author, version: m.version,
    // Each widget on its OWN virtual host, cross-origin to the shell — the property
    // the sandbox attribute relies on ("widgets cannot reach the shell's or each
    // other's origin"). Serving them same-origin would quietly test a weaker posture
    // than the one that ships.
    url: `https://${slug}.widgets.wsw/index.html`,
    supportedSlots: m.supported_slots,
    properties: m.properties || [],
  };
}

/** The WebView2 virtual host mapping, in Playwright terms. */
function mapHosts(page) {
  const serve = (route, dir, name) => {
    const file = path.join(dir, name);
    if (!file.startsWith(dir) || !fs.existsSync(file) || !fs.statSync(file).isFile())
      return route.fulfill({ status: 404, body: '' });
    const type = name.endsWith('.css') ? 'text/css'
      : name.endsWith('.js') ? 'application/javascript' : 'text/html';
    route.fulfill({ status: 200, contentType: type, body: fs.readFileSync(file) });
  };
  const rel = (u) => new URL(u).pathname.replace(/^\/+/, '');
  return Promise.all([
    page.route('https://app.wsw/**', (r) => serve(r, SHELL, rel(r.request().url()))),
    page.route('https://*.widgets.wsw/**', (r) => {
      const u = new URL(r.request().url());
      serve(r, path.join(REPO, 'widgets', u.hostname.replace(/\.widgets\.wsw$/, '')), rel(r.request().url()));
    }),
  ]);
}

/** What the user actually sees in a deck tile. Blank is the reported symptom; the two
 *  message states are different bugs entirely (init arrived, settings did not). */
const readDeck = (frame) => frame.evaluate(() => {
  const grid = document.getElementById('grid');
  const msg = document.getElementById('message');
  return {
    keys: grid ? grid.children.length : -1,
    message: msg && !msg.hidden ? (document.getElementById('messageTitle') || {}).textContent : null,
    waiting: document.documentElement.hasAttribute('data-ww-waiting'),
    w: window.innerWidth, h: window.innerHeight,
  };
});

(async () => {
  const srv = await staticServer(REPO, PORT);
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  await mapHosts(page);

  const deck = catalogEntry('deck');
  const clock = catalogEntry('clock');

  // Page 0 is the reported scene: a deck beside a clock, neither with saved settings.
  // The rest is the matrix — every supported size, with and without the instanceId a
  // slot only gains once it has been edited on the panel.
  const MATRIX = [];
  for (const size of ['quarter', 'half', 'full'])
    for (const withId of [true, false]) MATRIX.push({ size, withId });
  const layout = { pages: [
    { name: 'Reported', slots: [
      { widgetId: deck.id, size: 'half', instanceId: 'deck-main', settings: {} },
      { widgetId: clock.id, size: 'half', instanceId: 'clock-main', settings: {} },
    ] },
    ...MATRIX.map((c, i) => ({
      name: 'M' + i,
      slots: [Object.assign({ widgetId: deck.id, size: c.size, settings: {} },
        c.withId ? { instanceId: 'm' + i } : {})],
    })),
  ] };

  await page.exposeFunction('__hostRecv', async (json) => {
    const msg = JSON.parse(json);
    const push = (obj) => page.evaluate((d) => window.__hostPush(d), JSON.stringify(obj)).catch(() => {});
    if (msg.type === 'settings-ready') {
      push({ type: 'settings-init', data: {
        layout, widgets: [deck, clock], sensors: [], backgroundHost: 'backgrounds.wsw',
        status: { elevated: false, version: 'v0.2.0 (probe)' },
      } });
    } else if (msg.type === 'save-layout') {
      push({ type: 'saved', seq: msg.seq });
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

  await page.goto(`http://127.0.0.1:${PORT}/src/WaveshareWidgets/Shell/settings.html`);
  await page.waitForTimeout(3000);   // replica boot, widget iframes, ww-ready round trip

  const replica = page.frames().find((f) => /Shell\/index\.html/.test(f.url()));
  check('D1 the preview replica is running', !!replica, replica ? 'index.html?preview=1' : 'no replica frame');
  if (!replica) { await browser.close(); srv.close(); process.exit(1); }

  const built = await replica.evaluate(() => document.querySelectorAll('.slot iframe').length);
  const expected = 2 + MATRIX.length;
  check('D1b it built an iframe for every slot on every page', built === expected,
    `${built} of ${expected}`);

  // Every slot is built up front, so all the deck documents exist at once. Read them
  // by their slot tag rather than by "the first deck frame" — switching pages and
  // re-finding would keep returning page 0 and the matrix would measure one constant.
  const deckFrames = page.frames().filter((f) => /deck\.widgets\.wsw/.test(f.url()));
  const byTag = new Map();
  for (const f of deckFrames) {
    const tag = (f.url().match(/ww-slot=([^&]*)/) || [])[1];
    byTag.set(tag, await readDeck(f).catch((e) => ({ err: String(e).slice(0, 80) })));
  }

  const main = byTag.get('deck-main');
  check('D1c the deck document in the reported scene loaded', !!main && !main.err,
    JSON.stringify(main));
  check('D2 the deck renders — its default keys, or its own empty-state message',
    !!main && (main.keys > 0 || !!main.message), JSON.stringify(main));
  check('D2b and specifically its four manifest defaults, since nothing was saved',
    !!main && main.keys === 4, main ? `${main.keys} keys` : 'no frame');
  check('D2c ww-init reached it, so the waiting stamp is cleared',
    !!main && main.waiting === false, main ? `waiting=${main.waiting}` : 'no frame');

  const clockFrame = page.frames().find((f) => /clock\.widgets\.wsw/.test(f.url()));
  const clockText = clockFrame ? (await clockFrame.evaluate(() =>
    (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 30))) : '';
  check('D3 control: the clock paints on a timer with or without ww-init, so a tile '
      + 'full of clock is not evidence that delivery works',
    /\d/.test(clockText), JSON.stringify(clockText));

  // ---- D4 · the matrix -------------------------------------------------------------
  let bad = [];
  MATRIX.forEach((c, i) => {
    const tag = c.withId ? 'm' + i : 'p' + (i + 1) + 's0';   // id-less slots tag by position
    const st = byTag.get(tag);
    if (!st || st.keys !== 4) bad.push(`${c.size}/${c.withId ? 'id' : 'no-id'}=${st ? st.keys : 'missing'}`);
  });
  check('D4 the deck renders at every supported size, with and without an instanceId',
    bad.length === 0 && byTag.size === expected - 1, bad.length ? bad.join(' ') : `${byTag.size - 0} decks`);

  // ---- D5 · a delivery failure must never look like a blank tile --------------------
  // The deck paints ONLY from ww-init, so if init never lands there is nothing of its
  // own to show. widget-base stamps html[data-ww-waiting] until the first init and
  // renders "waiting for panel data…" — that stamp is the only thing standing between
  // a delivery bug and a tile the user can only describe as empty.
  const solo = await browser.newPage({ viewport: { width: 640, height: 400 } });
  await mapHosts(solo);
  await solo.goto('https://deck.widgets.wsw/index.html');   // no shell parent: init never comes
  await solo.waitForTimeout(1000);
  const stamp = await solo.evaluate(() => ({
    waiting: document.documentElement.hasAttribute('data-ww-waiting'),
    content: getComputedStyle(document.body, '::after').content,
    shown: getComputedStyle(document.body, '::after').display !== 'none',
  }));
  check('D5 a deck that never receives ww-init says so rather than going blank',
    stamp.waiting && stamp.shown && /waiting for panel data/.test(stamp.content),
    JSON.stringify(stamp));

  if (errors.length) console.log('  [pageerror]', JSON.stringify(errors.slice(0, 4)));

  await browser.close();
  srv.close();
  console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
