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
// Frame IDENTITY is only half of it. A slot frame that navigates away — to anywhere the
// widget's own code sends it — keeps the same WindowProxy, so it still looks like the
// registered widget while no longer being it; and the shim is injected into every
// document in the WebView, so a nested page runs it too and would report its errors to
// whatever frames it.
//
//   B1 · a widget frame still works — the fix must not cut the real bridge
//   B2 · a nested frame's privileged messages never reach the host
//   B3 · ...including the proxy fetch, which would otherwise be an SSRF hop
//   B4 · a nested frame cannot impersonate ww-ready and harvest another slot's settings
//   B5 · the reply channel is not opened for a sender that was refused
//   B6 · a nested frame cannot forge ww-init and feed its parent widget fake state
//   B6b· ...including through the iCUE shim's separate listener in the same document
//   B7 · a nested frame's uncaught errors are not reported to the widget framing it
//   B7b· ...while a real widget's own errors still reach the host log
//   B7c· ...and one raised before init is not lost to the guard
//   B8 · a slot frame that navigated to another origin cannot drive the host
//   B8b· ...and is not answered with the widget's settings
//   B9 · ...and host broadcasts are not delivered to it, while a live widget still gets them
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const http = require('http');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const SHELL = path.join(REPO, 'src', 'Plinth', 'Shell');
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
<script src="https://app.plinth/widget-api.js"></script>
<!-- iCUE-compatible widgets carry a SECOND injected shim with its own message
     listener, so a gate on one file leaves the other as the way in. -->
<script src="https://app.plinth/icue-compat.js"></script>
<script>
  // Raised while the shim is still waiting for its init — B7c checks it arrives anyway.
  // A widget that dies during startup is the case these diagnostics exist for, so a
  // guard that silently costs them would trade one bug for another.
  throw new Error('early-boom');
</script>
<script>
  // The widget itself behaves: it uses the bridge the legitimate way, which is what
  // B1 confirms still works after the fix.
  window.__inits = [];
  WW.onInit((s) => { document.body.dataset.inited = '1'; window.__inits.push(s.settings || {}); });
  WW.onSensors((s) => { window.__sensors = s; });
  window.__wwProbeAction = () => WW.action('launch', 'legit.exe');
  window.__wwThrow = () => setTimeout(() => { throw new Error('widget-boom'); }, 0);
  window.__wwNavigate = (url) => { location.href = url; };
  // A widget owns the frames it creates, so for its child it IS window.parent. This is
  // the attack B7d covers: unlock the child's shim by pretending to be the shell.
  window.__forgeDown = () => document.getElementById('evil').contentWindow.postMessage(
    { type: 'ww-init', settings: {}, sensors: [] }, '*');
  // Everything this document can SEE, whoever sent it. The shim's own filtering is not
  // the measurement — what a widget can observe of the page it frames is.
  window.__heard = [];
  window.addEventListener('message', (e) => {
    const d = e.data || {};
    if (typeof d.type === 'string') window.__heard.push(d.type + '|' + String(d.message || ''));
  });
</script>`;

const NESTED_HTML = `<!DOCTYPE html><meta charset="utf-8">
<body>nested
<!-- WebView2 injects the shim into EVERY document, nested frames included. -->
<script src="https://app.plinth/widget-api.js"></script>
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
  // Aimed at the PARENT this time: the widget that framed us. Nothing here needs the
  // shell — it is one frame lying to another.
  window.__forgeInit = () => parent.postMessage({
    type: 'ww-init',
    // pwned is read by WW.onInit; pwnedGlobal is what the iCUE shim would publish as a
    // window global for widget code to read. One forged message, two shims to fool.
    settings: { pwned: 'yes', pwnedGlobal: 'yes' },
    sensors: [{ name: 'fake', value: 1 }],
  }, '*');
  window.__throw = () => setTimeout(() => { throw new Error('nested-boom'); }, 0);
  window.__throw2 = () => setTimeout(() => { throw new Error('nested-boom-2'); }, 0);
  window.__replies = [];
  window.addEventListener('message', (e) => {
    const t = (e.data || {}).type;
    if (typeof t === 'string' && t.startsWith('ww-')) window.__replies.push(t);
  });
</script>`;

// A document that is a direct CHILD of the shell but was never a registered slot: it
// passes the topology check and must still be held quiet, which is what keeps B7e from
// merely re-testing B7d.
const STRAY_HTML = `<!DOCTYPE html><meta charset="utf-8">
<body>stray
<script src="https://app.plinth/widget-api.js"></script>
<script>window.__throw = () => setTimeout(() => { throw new Error('stray-boom'); }, 0);</script>`;

// The slot frame after it navigates away. Same WindowProxy, foreign origin — it still
// passes an identity check, which is exactly why identity alone is not enough.
const HIJACK_HTML = `<!DOCTYPE html><meta charset="utf-8">
<body>hijacked
<script>
  window.__got = [];
  window.addEventListener('message', (e) => {
    const t = (e.data || {}).type;
    if (typeof t === 'string' && t.startsWith('ww-')) window.__got.push(t);
  });
  window.__fire = () => {
    window.top.postMessage({ type: 'ww-ready' }, '*');
    window.top.postMessage({ type: 'ww-action', kind: 'launch', target: 'hijack.exe' }, '*');
  };
</script>`;

(async () => {
  const srv = await staticServer(REPO, PORT);
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 400 } });
  const hostMessages = [];
  const allLogs = [];

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
  await page.route('https://framer.widgets.plinth/**', (r) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: WIDGET_HTML }));
  await page.route('https://evil.example/**', (r) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: NESTED_HTML }));
  await page.route('https://stray.example/**', (r) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: STRAY_HTML }));
  await page.route('https://attacker.example/**', (r) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: HIJACK_HTML }));

  const widget = { id: 'test.framer', name: 'Framer', url: 'https://framer.widgets.plinth/index.html',
    supportedSlots: ['half'], properties: [] };
  // Two slots: one navigates away mid-run, the other stays. Without the second, "the
  // hijacked frame received no broadcast" would also hold if broadcasts had simply
  // stopped happening — the control is what makes B9 mean anything.
  const layout = { pages: [{ name: 'P', slots: [
    { widgetId: widget.id, size: 'half', instanceId: 'f1', settings: { secretish: 'sentinel-value' } },
    { widgetId: widget.id, size: 'half', instanceId: 'f2', settings: { secretish: 'control-value' } },
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
    // Never cleared: the pre-init diagnostic B7c looks for is flushed during startup,
    // long before any probe resets the working buffer.
    if (m.type === 'log') allLogs.push(String(m.message));
    if (m.type === 'ready') {
      page.evaluate((d) => window.__push(d), JSON.stringify({ type: 'init', data: {
        layout, widgets: [widget], sensors: [], status: { elevated: false, version: 'probe' },
      } })).catch(() => {});
    }
  });

  await page.goto(`http://127.0.0.1:${PORT}/src/Plinth/Shell/index.html`);
  await page.waitForTimeout(2000);

  const widgetFrame = page.frames().find((f) => /framer\.widgets\.plinth/.test(f.url()));
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

  // B6 · frame-to-frame, with the shell not involved at all. The nested page posts to
  // its PARENT — the widget — pretending to be the shell. The shim must answer only to
  // the window that actually is its parent, or a framed page can hand the widget fake
  // settings, fake sensor readings, or a fetch result of its choosing.
  await nested.evaluate(() => window.__forgeInit());
  await page.waitForTimeout(300);
  const inits = await widgetFrame.evaluate(() => window.__inits.map((s) => JSON.stringify(s)));
  check('B6 a nested frame cannot forge ww-init to the widget framing it',
    inits.length === 1 && !inits[0].includes('pwned'), JSON.stringify(inits));

  // B6b · the iCUE shim is a separate listener in a separate file, injected into the
  // same documents. It publishes settings as window globals that widget code reads
  // directly, so a forged init there rewrites the widget's inputs without touching WW.
  const icueGlobal = await widgetFrame.evaluate(() => window.pwnedGlobal ?? null);
  check('B6b ...and the iCUE shim in the same document does not take it either',
    icueGlobal === null, JSON.stringify(icueGlobal));

  // B7 · the injected shim runs in the nested document too, and its error handler
  // reports to `parent` — which for a nested frame is the widget, not the shell. Left
  // ungated, a widget learns the error text, script URLs and post-redirect hostname of
  // any page it frames: cross-origin detail the SOP exists to withhold.
  hostMessages.length = 0;
  await widgetFrame.evaluate(() => { window.__heard.length = 0; });
  await nested.evaluate(() => window.__throw());
  await page.waitForTimeout(500);
  const heard = await widgetFrame.evaluate(() => window.__heard.slice());
  check('B7 the nested frame\'s uncaught error is not reported to the widget framing it',
    !heard.some((h) => h.includes('nested-boom')), JSON.stringify(heard));

  // B7b · and the widget's OWN diagnostics still reach the host — a shim that simply
  // stopped reporting would pass B7 while blinding the field logs it exists for.
  await widgetFrame.evaluate(() => window.__wwThrow());
  await page.waitForTimeout(500);
  const logs = hostMessages.filter((m) => m.type === 'log').map((m) => String(m.message));
  check('B7b a real widget\'s own uncaught error still reaches the host log',
    logs.some((l) => l.includes('widget-boom')), JSON.stringify(logs));

  // B7c · the pre-init throw from the widget's first script. A widget that dies during
  // startup is the case these diagnostics exist for, so the guard must not cost them.
  check('B7c a diagnostic raised before init still reaches the host',
    allLogs.some((l) => l.includes('early-boom')), JSON.stringify(allLogs));

  // B7d · the hold alone is not enough, and this is why. The widget forges an init to
  // the page it framed; for that page the widget IS window.parent, so the message is
  // authentic by every test the shim can apply to it. Only the frame's POSITION — a slot
  // is a direct child of the shell, a nested page is not — settles it, and no script can
  // move itself up a level.
  hostMessages.length = 0;
  await widgetFrame.evaluate(() => { window.__heard.length = 0; window.__forgeDown(); });
  await page.waitForTimeout(300);
  await nested.evaluate(() => window.__throw2());
  await page.waitForTimeout(500);
  const heard2 = await widgetFrame.evaluate(() => window.__heard.slice());
  check('B7d a forged init does not unlock the nested frame\'s diagnostics',
    !heard2.some((h) => h.includes('nested-boom-2')), JSON.stringify(heard2));

  // B7e · a frame the shell never registered. It is a direct child of the shell, so the
  // topology check alone would let it speak; the shell's own sender gate is what stops
  // it, and this pins that the two layers together leave no path.
  await page.evaluate(() => {
    const f = document.createElement('iframe');
    f.id = 'stray';
    f.src = 'https://stray.example/loose.html';
    document.body.appendChild(f);
  });
  await page.waitForTimeout(1200);
  const stray = page.frames().find((f) => /stray\.example/.test(f.url()));
  check('B7e setup: an unregistered frame is live as a direct child of the shell',
    !!stray, `stray ${!!stray}`);
  if (stray) {
    hostMessages.length = 0;
    await stray.evaluate(() => window.__throw());
    await page.waitForTimeout(500);
    const strayLogs = hostMessages.filter((m) => m.type === 'log').map((m) => String(m.message));
    check('B7e a top-level frame the shell never answered stays quiet',
      !strayLogs.some((l) => l.includes('stray-boom')), JSON.stringify(strayLogs));
  }

  // B8/B8b/B9 · the slot frame navigates away. Its WindowProxy is unchanged, so it is
  // still `slots[0].frame.contentWindow` — the identity check alone cannot tell that
  // the widget is gone. Destructive, so it runs last.
  const control = page.frames().filter((f) => /framer\.widgets\.plinth/.test(f.url()))[1];
  check('B8 setup: a second widget is live to act as the broadcast control',
    !!control, `control ${!!control}`);
  await widgetFrame.evaluate(() => window.__wwNavigate('https://attacker.example/hijack.html'));
  await page.waitForTimeout(1200);
  const hijack = page.frames().find((f) => /attacker\.example/.test(f.url()));
  check('B8 setup: the slot frame really navigated to the foreign origin',
    !!hijack, page.frames().map((f) => f.url()).join(' '));
  if (!hijack || !control) { await browser.close(); srv.close(); process.exit(1); }

  hostMessages.length = 0;
  await hijack.evaluate(() => window.__fire());
  await page.waitForTimeout(600);
  check('B8 a navigated slot frame cannot drive the host',
    !hostMessages.some((m) => m.type === 'action'),
    JSON.stringify(hostMessages.map((m) => m.type)));
  const gotAfterFire = await hijack.evaluate(() => window.__got.slice());
  check('B8b ...and its ww-ready is not answered with the widget\'s settings',
    !gotAfterFire.includes('ww-init'), JSON.stringify(gotAfterFire));

  // B9 · the outbound half, which the inbound gate does not cover: the slot is still
  // marked initialized, so every broadcast is aimed at it. Targeting the origin the
  // widget was mounted on is what stops delivery.
  await control.evaluate(() => { window.__sensors = null; });
  await page.evaluate(() => window.__push(JSON.stringify({
    type: 'sensors', data: [{ name: 'cpu', value: 42 }] })));
  await page.waitForTimeout(400);
  const controlGot = await control.evaluate(() => (window.__sensors || []).length);
  check('B9 setup: the broadcast happened — the untouched widget received it',
    controlGot === 1, `control sensors ${controlGot}`);
  const hijackGot = await hijack.evaluate(() => window.__got.slice());
  check('B9 a host broadcast is not delivered to the navigated frame',
    !hijackGot.includes('ww-sensors'), JSON.stringify(hijackGot));

  await browser.close();
  srv.close();
  console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
