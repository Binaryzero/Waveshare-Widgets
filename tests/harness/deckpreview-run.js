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
//   D4 · every size the settings UI can select — widths AND bands — with and
//        without a persisted instanceId, checked at the SLOT as well as the widget:
//        a hidden slot keeps a live iframe with all its keys
//   D5 · a widget with no host at all still says so, so a delivery failure can
//        never present as a blank tile
//   D6 · the preview's data bridge, reached from a frame nested INSIDE a widget —
//        the reported SSRF/media-enumeration path (#96, #108), measured here rather
//        than inferred from the dashboard sharing shell.js
//   D6d· ...and no reply route was armed for ANY of the four request kinds, which
//        refusing to forward does not by itself prove — they are four separate maps
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const http = require('http');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const SHELL = path.join(REPO, 'src', 'Plinth', 'Shell');
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
    url: `https://${slug}.widgets.plinth/index.html`,
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
    page.route('https://app.plinth/**', (r) => serve(r, SHELL, rel(r.request().url()))),
    page.route('https://*.widgets.plinth/**', (r) => {
      const u = new URL(r.request().url());
      serve(r, path.join(REPO, 'widgets', u.hostname.replace(/\.widgets\.plinth$/, '')), rel(r.request().url()));
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
  // The rest is the matrix — every size the SETTINGS UI can put on this widget, not just the three widths its
  // manifest declares. settings.js synthesizes `three-quarter` for anything declaring
  // half or full, and offers -upper/-lower bands for every width, so a matrix of the
  // manifest widths alone would report ALL PASS while a regression confined to a
  // three-quarter tile or a 200px-high band went unseen. Twelve tokens; the id-less
  // half of each pair covers slots that have never been edited on the panel.
  const MATRIX = [];
  for (const width of ['quarter', 'half', 'three-quarter', 'full'])
    for (const band of ['', '-upper', '-lower'])
      for (const withId of [true, false]) MATRIX.push({ size: width + band, withId });
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

  // Everything the settings page sends to the native host. D6 reads this: reaching the
  // host IS the finding — that is where the proxy fetch and the media enumeration happen.
  const hostSeen = [];
  await page.exposeFunction('__hostRecv', async (json) => {
    const msg = JSON.parse(json);
    hostSeen.push(msg);
    const push = (obj) => page.evaluate((d) => window.__hostPush(d), JSON.stringify(obj)).catch(() => {});
    if (msg.type === 'settings-ready') {
      push({ type: 'settings-init', data: {
        layout, widgets: [deck, clock], sensors: [], backgroundHost: 'backgrounds.plinth',
        status: { elevated: false, version: 'v0.2.0 (probe)' },
      } });
    } else if (msg.type === 'save-layout') {
      push({ type: 'saved', seq: msg.seq });
    } else if (msg.type === 'preview-data') {
      // Answer the way SettingsWindow does — preview-host wrapping the result the
      // dashboard produced. Answering rather than dropping is what makes D6c mean
      // anything: a probe that asserts "the hostile frame got no reply" against a host
      // that replies to nobody is asserting nothing at all.
      const m = msg.message || {};
      const kind = { fetch: 'fetch-result', ping: 'ping-result',
        'media-list': 'media-list-result', 'audio-get': 'audio-result' }[m.type];
      if (kind) {
        push({ type: 'preview-host', message: { type: kind, data: {
          id: m.id, ok: true, status: 200, body: 'PREVIEW-SENTINEL',
          results: [], items: [{ name: 'holiday.png', url: 'https://media.plinth/holiday.png' }],
        } } });
      }
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
  const deckFrames = page.frames().filter((f) => /deck\.widgets\.plinth/.test(f.url()));
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

  const clockFrame = page.frames().find((f) => /clock\.widgets\.plinth/.test(f.url()));
  const clockText = clockFrame ? (await clockFrame.evaluate(() =>
    (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 30))) : '';
  check('D3 control: the clock paints on a timer with or without ww-init, so a tile '
      + 'full of clock is not evidence that delivery works',
    /\d/.test(clockText), JSON.stringify(clockText));

  // ---- D4 · the matrix -------------------------------------------------------------
  // The widget's key count alone is not enough. A slot the shell HIDES — relayoutPage
  // hides anything that no longer fits — keeps its already-built iframe, which stays
  // initialized and keeps all four keys. The widget would report a healthy tile while
  // that size is absent from the preview entirely. So the shell-side slot is measured
  // too: it must be displayed, and at the geometry its size token asks for.
  const SLOT_W = { quarter: 320, half: 640, 'three-quarter': 960, full: 1280 };
  const slotBoxes = await replica.evaluate(() => {
    const out = {};
    for (const el of document.querySelectorAll('.slot')) {
      const f = el.querySelector('iframe');
      const tag = f ? ((f.src.match(/ww-slot=([^&]*)/) || [])[1]) : null;
      if (!tag) continue;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      out[tag] = {
        w: Math.round(r.width), h: Math.round(r.height),
        shown: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0,
      };
    }
    return out;
  });
  let bad = [];
  MATRIX.forEach((c, i) => {
    const tag = c.withId ? 'm' + i : 'p' + (i + 1) + 's0';   // id-less slots tag by position
    const st = byTag.get(tag);
    const box = slotBoxes[tag];
    const label = `${c.size}/${c.withId ? 'id' : 'no-id'}`;
    const width = SLOT_W[c.size.replace(/-(upper|lower)$/, '')];
    const height = /-(upper|lower)$/.test(c.size) ? 200 : 400;
    if (!st || st.keys !== 4) bad.push(`${label} keys=${st ? st.keys : 'missing'}`);
    else if (!box || !box.shown) bad.push(`${label} slot-hidden`);
    else if (Math.abs(box.w - width) > 2 || Math.abs(box.h - height) > 2)
      bad.push(`${label} ${box.w}x${box.h} want ${width}x${height}`);
  });
  check('D4 the deck renders at every size the settings UI offers — widths, bands, '
      + 'and both with and without an instanceId',
    bad.length === 0 && byTag.size === expected - 1, bad.length ? bad.join(' ') : `${byTag.size - 0} decks`);

  // ---- D5 · a delivery failure must never look like a blank tile --------------------
  // The deck paints ONLY from ww-init, so if init never lands there is nothing of its
  // own to show. widget-base stamps html[data-ww-waiting] until the first init and
  // renders "waiting for panel data…" — that stamp is the only thing standing between
  // a delivery bug and a tile the user can only describe as empty.
  const solo = await browser.newPage({ viewport: { width: 640, height: 400 } });
  await mapHosts(solo);
  await solo.goto('https://deck.widgets.plinth/index.html');   // no shell parent: init never comes
  await solo.waitForTimeout(1000);
  const stamp = await solo.evaluate(() => ({
    waiting: document.documentElement.hasAttribute('data-ww-waiting'),
    content: getComputedStyle(document.body, '::after').content,
    shown: getComputedStyle(document.body, '::after').display !== 'none',
  }));
  check('D5 a deck that never receives ww-init says so rather than going blank',
    stamp.waiting && stamp.shown && /waiting for panel data/.test(stamp.content),
    JSON.stringify(stamp));

  // ---- D6 · the data bridge, reached from INSIDE a widget (#96, #108) ---------------
  // The reported attack: a remote page embedded in a widget posts a data request past
  // its host widget to the shell — parent.parent from the nested frame — and the shell
  // stores that remote window as the reply route and forwards the request. In the
  // PREVIEW that lands on HandlePreviewRequest, which performs the real proxy fetch,
  // ping, audio or media enumeration. Loopback and LAN SSRF, and the user's media
  // filenames, from a page inside an iframe widget.
  //
  // The sender gate from #88 is believed to close this, because the replica IS shell.js.
  // But that is inference from shared source, and it is exactly the inference this suite
  // exists to stop making: the preview reaches the host through hops the dashboard does
  // not have — a window.parent relay through settings.js, generation tagging, and the
  // replicaTimer staleness gate — and any of them could have made the dashboard probe
  // agree with a preview that behaves differently. So: the real settings page, the real
  // replica, a real nested cross-origin frame.
  await page.route('https://hostile.example/**', (r) => r.fulfill({
    status: 200, contentType: 'text/html', body: `<!DOCTYPE html><meta charset="utf-8"><script>
      window.__replies = [];
      window.__attacked = null;
      addEventListener('message', (e) => { window.__replies.push(e.data && e.data.type); });
      try {
        // parent = the widget that embedded us; parent.parent = the replica shell.
        // hosts is the key shell.js actually reads for ping. Sending targets made the
        // forwarded request an empty enumeration, so removing the gate would have leaked
        // a ping with nothing in it — proving nothing about the path this claims to cover.
        for (const type of ['ww-fetch', 'ww-ping', 'ww-media-list', 'ww-audio-get'])
          parent.parent.postMessage(
            { type, id: 'HOSTILE-' + type, url: 'http://127.0.0.1:9/', hosts: ['127.0.0.1'] }, '*');
        // The SECOND gate, and a different one: settings.js accepts ww-shell only from the
        // preview frame's own window. Reaching the replica is not the only way to the host.
        top.postMessage({ type: 'ww-shell', message: {
          type: 'fetch', id: 'HOSTILE-direct-to-top', url: 'http://127.0.0.1:9/' } }, '*');
        window.__attacked = 'done';
      } catch (e) { window.__attacked = 'threw: ' + e; }
    </script>` }));

  const deckFrame = page.frames().find((f) => /deck\.widgets\.plinth/.test(f.url()));
  check('D6 setup: a widget frame to embed the hostile page in', !!deckFrame);

  // The positive control first, and it is not optional: "the host received nothing" is
  // also what a broken relay looks like, and this suite would otherwise bless a preview
  // whose data bridge had stopped working altogether.
  hostSeen.length = 0;
  await deckFrame.evaluate(() => {
    window.__legitReplies = [];
    addEventListener('message', (e) => {
      if (e.data && e.data.type === 'ww-media-list-result') window.__legitReplies.push(e.data.id);
    });
    parent.postMessage({ type: 'ww-media-list', id: 'LEGIT' }, '*');
  });
  await page.waitForTimeout(700);
  const legit = hostSeen.filter((m) => m.type === 'preview-data').map((m) => m.message && m.message.id);
  check('D6 control: a registered slot frame DOES reach the host through the preview relay',
    legit.includes('LEGIT'), JSON.stringify(legit));
  // Both halves of the relay. Checking only the outbound one leaves D6c able to pass
  // because NOBODY can receive a reply — the exact condition the answering host stub was
  // added to rule out.
  const legitReplies = await deckFrame.evaluate(() => window.__legitReplies);
  check('D6 control: ...and the answer comes back to it',
    legitReplies.includes('LEGIT'), JSON.stringify(legitReplies));

  hostSeen.length = 0;
  await deckFrame.evaluate(() => {
    const el = document.createElement('iframe');
    el.src = 'https://hostile.example/nested.html';
    document.body.appendChild(el);
  });
  await page.waitForTimeout(1200);
  // Counted by SHAPE, not by the attack's own ids. Matching on "HOSTILE-" made the
  // assertion depend on a value the relay is free to drop or rewrite: a regression that
  // forwarded the request without its id would map to '?', be filtered out, and pass —
  // while HandlePreviewRequest still dispatched on type and performed the fetch, the ping
  // or the media enumeration. What must be zero is data requests reaching the host at all,
  // and this window contains no legitimate ones because only the hostile frame is acting.
  const ATTACK_TYPES = ['fetch', 'ping', 'media-list', 'audio-get'];
  const reachedHost = hostSeen.filter((m) =>
    m.type === 'preview-data' && ATTACK_TYPES.includes(m.message && m.message.type));
  check('D6b a frame nested inside a widget reaches the host with NOTHING',
    reachedHost.length === 0, JSON.stringify(reachedHost.map((m) => m.message.type)));
  // Named separately because it is a different gate: settings.js checks the SOURCE of
  // ww-shell against the preview frame's own window. A nested frame can address window.top
  // directly, and shell.js never sees that message at all. Also shape-based: the forged
  // message is the only `fetch` that could arrive by that route in this window.
  check('D6b2 ...including a ww-shell forged straight at the settings page',
    !hostSeen.some((m) => m.type === 'preview-data' && m.message && m.message.type === 'fetch'),
    hostSeen.filter((m) => m.type === 'preview-data').length + ' preview-data message(s) total');

  const nested = page.frames().find((f) => /hostile\.example/.test(f.url()));
  // "The frame loaded" is not "the attack ran". If that inline script threw part-way, every
  // rejection assertion below would pass while testing nothing — and pageerror is only
  // logged by this harness, never failed. The marker is set after the last postMessage.
  const attacked = nested ? await nested.evaluate(() => window.__attacked) : '(no frame)';
  check('D6b setup: the hostile frame loaded AND finished posting every request',
    attacked === 'done', String(attacked));
  const replies = nested ? await nested.evaluate(() => window.__replies) : ['(no frame)'];
  check('D6c ...and receives no reply either', JSON.stringify(replies) === '[]', JSON.stringify(replies));

  // D6d · refusing to FORWARD is not the same as refusing to REMEMBER. Because the gate
  // works, no hostile request reaches the host, so nothing above ever exercises what the
  // shell did with its routing tables — a regression that stored the nested window in
  // fetchRoutes and only then declined the outbound post would satisfy every assertion so
  // far, and still deliver a later matching answer straight to that frame. So the answer
  // is injected by hand, the way bridgeorigin-run.js B5 does it.
  //
  // EVERY type, not just fetch. The four request kinds are backed by four independent
  // route maps in shell.js — fetchRoutes, pingRoutes, mediaRoutes, audioRoutes — and a
  // regression that armed any one of them would be invisible to an injection that only
  // exercises another. Each refused id gets its matching answer.
  const REFUSED = [
    { id: 'HOSTILE-ww-fetch', result: 'fetch-result' },
    { id: 'HOSTILE-ww-ping', result: 'ping-result' },
    { id: 'HOSTILE-ww-media-list', result: 'media-list-result' },
    { id: 'HOSTILE-ww-audio-get', result: 'audio-result' },
  ];
  await page.evaluate((refused) => {
    for (const r of refused)
      window.__hostPush(JSON.stringify({
        type: 'preview-host',
        message: { type: r.result, data: {
          id: r.id, ok: true, status: 200, body: 'SHOULD-NOT-ARRIVE',
          results: [{ host: '127.0.0.1', ok: true }],
          items: [{ name: 'holiday.png', url: 'https://media.plinth/holiday.png' }],
        } },
      }));
  }, REFUSED);
  await page.waitForTimeout(500);
  const afterInject = nested ? await nested.evaluate(() => window.__replies) : ['(no frame)'];
  check('D6d a reply for EVERY refused request reaches nobody, so no route was armed',
    JSON.stringify(afterInject) === '[]', JSON.stringify(afterInject));

  if (errors.length) console.log('  [pageerror]', JSON.stringify(errors.slice(0, 4)));

  await browser.close();
  srv.close();
  console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
