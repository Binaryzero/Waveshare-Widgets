#!/usr/bin/env node
// The protected store, as reached from the SETTINGS PREVIEW (#175).
//
// The preview is a real shell (shell.js?preview) hosting real widget iframes inside the
// settings window, and it must never read or write a live credential: its widgets run
// outside a real slot, and the whole surface is a layout editor. That part was never in
// doubt — HandlePreviewRequest has no secure case.
//
// What was: the shell still FORWARDED. In preview, postToHost posts up to settings.js,
// which relays only fetch / ping / media-list / audio-get and drops everything else with
// no reply. So a secure-* request vanished and settled only when secureCall's 10-second
// timeout fired — an OAuth widget that awaits secureGet before its first paint sat blank
// for ten seconds on every preview reload, on the one surface the user edits in.
//
// Answering is therefore not a nicety, it is the fix; and "the preview posted nothing to
// the host" is exactly what a DEAD branch looks like too, so every check here has the
// other half:
//
//   P0 · setup: the shell really is in preview, and the widget frame really loaded
//   P1 · setup: the parent's relay really works and really is the settings.js allow-list
//        (a fetch crosses; that is what makes P6's silence mean something)
//   P2 · secureGet settles promptly instead of on the 10s timeout
//   P3 · ...and reads as a miss, which the spec tells widgets to treat as normal
//   P4 · secureSet says it did not write, in the documented `unavailable` wording
//   P5 · secureDelete succeeds — nothing is stored, so the caller's intent holds
//   P6 · NOTHING secure-* is posted up: the preview never names a scope to anyone
//   P7 · the SAME widget code in a non-preview shell DOES reach the host — without this,
//        P6 would pass just as well if the branch never worked at all — carrying both
//        scopes the shell stamps from the slot: the widget id and the #226 instance id
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const http = require('http');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const SHELL = path.join(REPO, 'src', 'Plinth', 'Shell');
const PORT = 8964;

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

// One widget file, used in BOTH topologies. The preview and the panel must differ only in
// the shell around it — same code, same calls — or P7 would be comparing two things.
// Each call is timed, because the defect was not a wrong ANSWER, it was a ten-second one.
const WIDGET_HTML = `<!DOCTYPE html><meta charset="utf-8">
<body style="margin:0;background:#111">
<script src="https://app.plinth/widget-api.js"></script>
<script>
  WW.onInit(() => { document.body.dataset.inited = '1'; });
  window.__timed = async (fn) => {
    const t0 = Date.now();
    const value = await fn();
    return { ms: Date.now() - t0, value };
  };
  window.__get = () => window.__timed(() => WW.secureGet('token'));
  window.__set = () => window.__timed(() => WW.secureSet('token', 'bearer-abc'));
  window.__del = () => window.__timed(() => WW.secureDelete('token'));
  window.__fetch = () => WW.fetch('https://example.invalid/x').then(() => 'resolved', () => 'rejected');
</script>`;

// What the settings window relays up to the host, verbatim from settings.js: everything
// else is dropped, which is the condition that made a forwarded secure-* disappear. The
// probe models the DROP rather than a friendly parent, because a parent that answered
// would hide the very failure this exists to pin.
// Served from the shell's OWN origin: settings.html and the preview shell share the
// app's virtual host in the real window, and a cross-origin stand-in is additionally
// refused by Chromium's local-network-access check.
const PARENT_HTML = `<!DOCTYPE html><meta charset="utf-8">
<body style="margin:0">
<iframe id="preview" style="width:1280px;height:400px;border:0"
        src="./index.html?preview"></iframe>
<script>
  window.__relayed = [];   // what a real settings.js would forward to the host
  window.__sawUp = [];     // EVERYTHING the preview shell posted up, relayed or dropped
  const frame = document.getElementById('preview');
  window.addEventListener('message', (ev) => {
    if (ev.source !== frame.contentWindow) return;
    const msg = ev.data || {};
    if (msg.type !== 'ww-shell') return;
    const m = msg.message || {};
    window.__sawUp.push(m.type);
    if (m.type === 'ready') {
      frame.contentWindow.postMessage({ type: 'ww-host', message: {
        type: 'init', data: window.__initData,
      } }, '*');
    } else if (m.type === 'fetch' || m.type === 'ping' || m.type === 'media-list' || m.type === 'audio-get') {
      window.__relayed.push(m.type);
    }
    // Everything else is dropped, exactly as settings.js drops it.
  });
</script>`;

(async () => {
  const srv = await staticServer(REPO, PORT);
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});

  const widgets = [{
    id: 'test.oauth', name: 'OAuth', url: 'https://oauth.widgets.plinth/index.html',
    supportedSlots: ['half'], properties: [],
  }];
  const layout = { pages: [{ name: 'P', slots: [
    { widgetId: 'test.oauth', size: 'half', instanceId: 'o1', settings: {} },
  ] }] };
  const initData = { genBase: 3, layout, widgets, sensors: [], status: { elevated: false, version: 'probe' } };

  const wire = async (page) => {
    const serve = (route, dir, name) => {
      const file = path.join(dir, name);
      if (!file.startsWith(dir) || !fs.existsSync(file) || !fs.statSync(file).isFile())
        return route.fulfill({ status: 404, body: '' });
      const type = name.endsWith('.css') ? 'text/css'
        : name.endsWith('.js') ? 'application/javascript' : 'text/html';
      route.fulfill({ status: 200, contentType: type, body: fs.readFileSync(file) });
    };
    await page.route('https://app.plinth/**', (r) =>
      serve(r, SHELL, new URL(r.request().url()).pathname.replace(/^\/+/, '')));
    await page.route('https://oauth.widgets.plinth/**', (r) =>
      r.fulfill({ status: 200, contentType: 'text/html', body: WIDGET_HTML }));
  };

  // ---- the PREVIEW topology: parent page -> shell.js?preview -> widget iframe ---------
  const page = await browser.newPage({ viewport: { width: 1300, height: 500 } });
  page.on('pageerror', (e) => { failures++; console.log('[pageerror]', String(e).slice(0, 300)); });
  await wire(page);
  await page.route(`http://127.0.0.1:${PORT}/src/Plinth/Shell/__parent.html`, (r) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: PARENT_HTML }));
  await page.addInitScript((d) => { window.__initData = d; }, initData);
  await page.goto(`http://127.0.0.1:${PORT}/src/Plinth/Shell/__parent.html`);
  await page.waitForTimeout(2500);

  const previewShell = page.frames().find((f) => /\?preview/.test(f.url()));
  const previewWidget = page.frames().find((f) => /oauth\.widgets\.plinth/.test(f.url()));
  const isPreview = previewShell
    ? await previewShell.evaluate(() => new URLSearchParams(location.search).has('preview'))
    : false;
  check('P0 setup: the shell is in PREVIEW and the widget frame initialized',
    !!previewShell && !!previewWidget && isPreview
      && await previewWidget.evaluate(() => document.body.dataset.inited === '1'),
    `shell ${!!previewShell} preview ${isPreview} widget ${!!previewWidget}`);
  if (!previewShell || !previewWidget) { await browser.close(); srv.close(); process.exit(1); }

  // The relay is real and it is the settings.js allow-list. Without this, P6's "no
  // secure-* went up" would be satisfied by a parent that hears nothing at all.
  await previewWidget.evaluate(() => window.__fetch());
  await page.waitForTimeout(500);
  const relayed = await page.evaluate(() => window.__relayed.slice());
  check('P1 setup: the parent relays what settings.js relays (a fetch crosses)',
    relayed.includes('fetch'), JSON.stringify(relayed));

  // The defect was a TEN-SECOND wait. 2000ms is far below that and far above a real
  // round trip, so this cannot pass by being merely quicker than the timeout.
  const got = await previewWidget.evaluate(() => window.__get());
  check('P2 secureGet settles promptly, not on the 10s timeout', got.ms < 2000, `${got.ms} ms`);
  check('P3 ...and reads as a miss', got.value === null, JSON.stringify(got.value));

  const set = await previewWidget.evaluate(() => window.__set());
  check('P4 secureSet settles promptly and says it did not write',
    set.ms < 2000 && set.value && set.value.ok === false && set.value.error === 'unavailable',
    `${set.ms} ms ${JSON.stringify(set.value)}`);

  const del = await previewWidget.evaluate(() => window.__del());
  check('P5 secureDelete settles promptly and succeeds',
    del.ms < 2000 && del.value && del.value.ok === true,
    `${del.ms} ms ${JSON.stringify(del.value)}`);

  // The point of the whole branch: the live credential store is never reached, and no
  // widget id is even named to the settings window.
  const wentUp = await page.evaluate(() => window.__sawUp.slice());
  check('P6 nothing secure-* was posted up out of the preview',
    !wentUp.some((t) => String(t).startsWith('secure-')), JSON.stringify(wentUp.filter((t, i, a) => a.indexOf(t) === i)));

  // ---- the PANEL topology: the same widget in a real shell --------------------------
  // P6 is a claim about a branch being TAKEN, and "posted nothing" is also what a branch
  // that never runs looks like. This is the other half: the identical call, in the shell
  // the panel uses, must reach the host.
  const panel = await browser.newPage({ viewport: { width: 1280, height: 400 } });
  panel.on('pageerror', (e) => { failures++; console.log('[pageerror]', String(e).slice(0, 300)); });
  await wire(panel);
  const hostSaw = [];
  await panel.addInitScript(() => {
    const L = new Set();
    window.chrome = { webview: {
      addEventListener: (t, c) => { if (t === 'message') L.add(c); },
      postMessage: (m) => window.__rec(JSON.stringify(m)),
    } };
    window.__push = (j) => { const d = JSON.parse(j); L.forEach((c) => { try { c({ data: d }); } catch (e) {} }); };
  });
  await panel.exposeFunction('__rec', async (j) => {
    const m = JSON.parse(j);
    hostSaw.push(m);
    if (m.type === 'ready')
      panel.evaluate((d) => window.__push(d), JSON.stringify({ type: 'init', data: initData })).catch(() => {});
  });
  await panel.goto(`http://127.0.0.1:${PORT}/src/Plinth/Shell/index.html`);
  await panel.waitForTimeout(2000);
  const panelWidget = panel.frames().find((f) => /oauth\.widgets\.plinth/.test(f.url()));
  check('P7 setup: the panel widget initialized', !!panelWidget
    && await panelWidget.evaluate(() => document.body.dataset.inited === '1'));
  if (panelWidget) {
    // Not awaited: the fake host never answers, and what is being checked is what the
    // shell SENT, not what came back.
    panelWidget.evaluate(() => window.__get()).catch(() => {});
    await panel.waitForTimeout(600);
    const secure = hostSaw.filter((m) => String(m.type).startsWith('secure-'));
    check('P7 the same call in a real panel DOES reach the host',
      secure.length === 1 && secure[0].type === 'secure-get',
      JSON.stringify(secure.map((m) => m.type)));
    // ...carrying the scope the SHELL stamped, which is the property the store rests on:
    // both the widget id and, since #226, the per-tile instance id — each taken from the
    // slot that sent the message, never named by the widget.
    check('P7b ...scoped by the widget id the shell stamped, not by the widget',
      secure.length === 1 && secure[0].widgetId === 'test.oauth',
      secure.length ? String(secure[0].widgetId) : '(none)');
    check('P7c ...and by the instanceId the shell stamped from the slot',
      secure.length === 1 && secure[0].instanceId === 'o1',
      secure.length ? String(secure[0].instanceId) : '(none)');
  }

  await browser.close();
  srv.close();
  console.log(failures > 0 ? `${failures} FAILURES` : 'ALL PASS');
  process.exit(failures > 0 ? 1 : 0);
})();
