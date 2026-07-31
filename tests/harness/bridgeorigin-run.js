#!/usr/bin/env node
// Bridge sender authorization — a nested frame must not reach the native host.
//
// postMessage reaches window.top from ANY descendant, not just a direct child. The
// shell's widget bridge dispatched ww-action, ww-fetch, ww-open-url, ww-ping and
// ww-audio-set without checking who sent them, so a page framed INSIDE a widget could
// drive the host: Process.Start, injected hotkeys, and the proxy fetch used as an SSRF
// hop with the response routed back to the sender.
//
// This is reachable through stock widgets. `twitch` and `youtube` frame third-party
// origins, and `iframe` frames whatever URL the user types — so "the remote page turns
// hostile" is the whole prerequisite; nothing has to be compromised in the usual sense.
//
//   B1 · a widget frame still works — the fix must not cut the real bridge
//   B2 · a nested frame's privileged messages never reach the host
//   B3 · ...including the proxy fetch, which would otherwise be an SSRF hop
//   B4 · a nested frame cannot impersonate ww-ready and harvest another slot's settings
//   B5 · the reply channel is not opened for a sender that was refused
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const http = require('http');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const SHELL = path.join(REPO, 'src', 'WaveshareWidgets', 'Shell');
const PORT = 8956;

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

// A widget that frames a remote page, exactly as twitch/youtube/iframe do. The nested
// document is the attacker: it never talks to its own parent, only to window.top.
const WIDGET_HTML = `<!DOCTYPE html><meta charset="utf-8">
<body style="margin:0;background:#111">
<iframe id="evil" src="https://evil.example/nested.html"
        style="width:100%;height:100%;border:0"></iframe>
<script src="https://app.wsw/widget-api.js"></script>
<script>
  // The widget itself behaves: it uses the bridge the legitimate way, which is what
  // B1 confirms still works after the fix.
  WW.onInit(() => { document.body.dataset.inited = '1'; });
  window.__wwProbeAction = () => WW.action('launch', 'legit.exe');
</script>`;

const NESTED_HTML = `<!DOCTYPE html><meta charset="utf-8">
<body>nested
<script>
  // Everything a hostile framed page would try, aimed at the TOP window rather than
  // its own parent — the reach postMessage grants any descendant.
  const top_ = window.top;
  window.__fire = () => {
    top_.postMessage({ type: 'ww-action', kind: 'launch', target: 'calc.exe' }, '*');
    top_.postMessage({ type: 'ww-open-url', url: 'https://attacker.example/x' }, '*');
    top_.postMessage({ type: 'ww-fetch', id: 'leak1', url: 'http://127.0.0.1:8080/secret' }, '*');
    top_.postMessage({ type: 'ww-audio-set', target: 'master', muted: true }, '*');
    top_.postMessage({ type: 'ww-sd-capture' }, '*');
    top_.postMessage({ type: 'ww-ping', id: 'p1', hosts: ['10.0.0.1'] }, '*');
    top_.postMessage({ type: 'ww-ready' }, '*');   // impersonation attempt
  };
  window.__replies = [];
  window.addEventListener('message', (e) => {
    const t = (e.data || {}).type;
    if (typeof t === 'string' && t.startsWith('ww-')) window.__replies.push(t);
  });
</script>`;

(async () => {
  const srv = await staticServer(REPO, PORT);
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 400 } });
  const hostMessages = [];

  const serve = (route, dir, name) => {
    const file = path.join(dir, name);
    if (!file.startsWith(dir) || !fs.existsSync(file) || !fs.statSync(file).isFile())
      return route.fulfill({ status: 404, body: '' });
    const type = name.endsWith('.css') ? 'text/css'
      : name.endsWith('.js') ? 'application/javascript' : 'text/html';
    route.fulfill({ status: 200, contentType: type, body: fs.readFileSync(file) });
  };
  await page.route('https://app.wsw/**', (r) =>
    serve(r, SHELL, new URL(r.request().url()).pathname.replace(/^\/+/, '')));
  await page.route('https://framer.widgets.wsw/**', (r) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: WIDGET_HTML }));
  await page.route('https://evil.example/**', (r) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: NESTED_HTML }));

  const widget = { id: 'test.framer', name: 'Framer', url: 'https://framer.widgets.wsw/index.html',
    supportedSlots: ['full'], properties: [] };
  const layout = { pages: [{ name: 'P', slots: [
    { widgetId: widget.id, size: 'full', instanceId: 'f1', settings: { secretish: 'sentinel-value' } },
  ] }] };

  await page.addInitScript(() => {
    const L = new Set();
    window.chrome = { webview: {
      addEventListener: (t, c) => { if (t === 'message') L.add(c); },
      postMessage: (m) => window.__rec(JSON.stringify(m)),
    } };
    window.__push = (j) => { const d = JSON.parse(j); L.forEach((c) => { try { c({ data: d }); } catch (e) {} }); };
  });
  await page.exposeFunction('__rec', async (j) => {
    const m = JSON.parse(j);
    hostMessages.push(m);
    if (m.type === 'ready') {
      page.evaluate((d) => window.__push(d), JSON.stringify({ type: 'init', data: {
        layout, widgets: [widget], sensors: [], status: { elevated: false, version: 'probe' },
      } })).catch(() => {});
    }
  });

  await page.goto(`http://127.0.0.1:${PORT}/src/WaveshareWidgets/Shell/index.html`);
  await page.waitForTimeout(2000);

  const widgetFrame = page.frames().find((f) => /framer\.widgets\.wsw/.test(f.url()));
  const nested = page.frames().find((f) => /evil\.example/.test(f.url()));
  check('B0 setup: the widget loaded and its nested remote frame is live',
    !!widgetFrame && !!nested, `widget ${!!widgetFrame} nested ${!!nested}`);
  if (!widgetFrame || !nested) { await browser.close(); srv.close(); process.exit(1); }

  // B1 · the legitimate path must survive. A fix that silences the bridge for everyone
  // would pass every other check here while breaking every widget that ships.
  const initedOk = await widgetFrame.evaluate(() => document.body.dataset.inited === '1');
  hostMessages.length = 0;
  await widgetFrame.evaluate(() => window.__wwProbeAction());
  await page.waitForTimeout(300);
  const fromWidget = hostMessages.filter((m) => m.type === 'action');
  check('B1 a registered widget frame still reaches the host',
    initedOk && fromWidget.length === 1 && fromWidget[0].target === 'legit.exe',
    `inited=${initedOk} ${JSON.stringify(fromWidget)}`);

  // B2/B3/B4 · the nested frame tries everything.
  hostMessages.length = 0;
  await nested.evaluate(() => window.__fire());
  await page.waitForTimeout(600);
  const leaked = hostMessages.filter((m) =>
    ['action', 'open-url', 'fetch', 'audio-set', 'sd-capture', 'ping'].includes(m.type));
  check('B2 nothing a nested frame sent reaches the host',
    leaked.length === 0, JSON.stringify(leaked));
  check('B3 specifically, no proxy fetch — that reply channel is an SSRF hop',
    !hostMessages.some((m) => m.type === 'fetch'),
    JSON.stringify(hostMessages.map((m) => m.type)));

  // B4 · ww-ready from a nested frame must not be answered. The reply carries the
  // slot's settings, so answering it hands a framed page the widget's configuration —
  // credentials included, for any widget that has them.
  const replies = await nested.evaluate(() => window.__replies.slice());
  check('B4 the nested frame is not answered as if it were the widget',
    !replies.includes('ww-init'), JSON.stringify(replies));

  // B5 · the routing tables must not have been armed for a refused sender: a later
  // host reply keyed to that id would deliver straight back to it.
  await page.evaluate(() => window.__push(JSON.stringify({
    type: 'fetch-result', data: { id: 'leak1', ok: true, status: 200, body: 'SENTINEL-BODY' } })));
  await page.waitForTimeout(300);
  const after = await nested.evaluate(() => window.__replies.slice());
  check('B5 a host reply for the refused id is not routed to the nested frame',
    !after.includes('ww-fetch-result'), JSON.stringify(after));

  await browser.close();
  srv.close();
  console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
