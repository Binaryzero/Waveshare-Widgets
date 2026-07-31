#!/usr/bin/env node
// Demand-scoped delivery — a widget receives what it ASKED for, not what the panel got.
//
// Three host channels answered every initialized widget rather than the one that
// subscribed. Each carries something a bystander widget has no claim to:
//
//   notifications  app name, title and body of the user's Windows toasts. One benign
//                  notification widget enabling the feature exposed them panel-wide,
//                  and a re-init handed the latest payload to widgets that had never
//                  mentioned notifications at all.
//   sd-profile     the Stream Deck's configured keys.
//   sd-capture     a live SCREENSHOT of those keys, pushed repeatedly in live mode.
//
// Every probe here needs BOTH halves — a subscriber that still receives and a bystander
// that does not — because "nobody received it" is what a broken delivery path looks like
// too, and that is the failure this suite would otherwise bless.
//
//   R1  · a subscriber receives notifications
//   R2  · a bystander on the same page does not
//   R3  · a re-init does not hand the payload to a bystander either
//   R4  · dismissal is refused for an id the slot was never shown
//   R5  · ...and still works for one it was
//   R6  · sd-profile reaches the asker only
//   R7  · sd-capture reaches the asker only
//   R8  · dropping the subscription stops delivery
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const http = require('http');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const SHELL = path.join(REPO, 'src', 'WaveshareWidgets', 'Shell');
const PORT = 8957;

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

// One widget file for both slots. What it subscribes to is driven from the probe, so the
// subscriber and the bystander are the same code — the only difference is what they ask.
const WIDGET_HTML = `<!DOCTYPE html><meta charset="utf-8">
<body style="margin:0;background:#111">
<script src="https://app.wsw/widget-api.js"></script>
<script>
  window.__notifs = [];
  window.__decks = [];
  window.__caps = [];
  window.__initNotifs = [];
  WW.onInit((s) => { document.body.dataset.inited = '1'; window.__initNotifs.push(s.notifications); });
  WW.onNotifications((n) => window.__notifs.push(n));
  WW.onStreamDeck((p) => window.__decks.push(p));
  WW.onStreamDeckCapture((c) => window.__caps.push(c));
  window.__watch = (on) => WW.watchNotifications(on);
  window.__dismiss = (id) => WW.dismissNotification(id);
  window.__askDeck = () => WW.requestStreamDeck({ profileName: 'p' });
  window.__askCapture = () => WW.requestStreamDeckCapture();
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
  await page.route('https://sub.widgets.wsw/**', (r) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: WIDGET_HTML }));
  await page.route('https://bys.widgets.wsw/**', (r) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: WIDGET_HTML }));

  // Two widget IDs so the two slots get distinct virtual hosts, as the real host map does.
  const widgets = [
    { id: 'test.sub', name: 'Subscriber', url: 'https://sub.widgets.wsw/index.html', supportedSlots: ['half'], properties: [] },
    { id: 'test.bys', name: 'Bystander', url: 'https://bys.widgets.wsw/index.html', supportedSlots: ['half'], properties: [] },
  ];
  const layout = { pages: [{ name: 'P', slots: [
    { widgetId: 'test.sub', size: 'half', instanceId: 's1', settings: {} },
    { widgetId: 'test.bys', size: 'half', instanceId: 'b1', settings: {} },
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
        layout, widgets, sensors: [], status: { elevated: false, version: 'probe' },
      } })).catch(() => {});
    }
  });

  await page.goto(`http://127.0.0.1:${PORT}/src/WaveshareWidgets/Shell/index.html`);
  await page.waitForTimeout(2000);

  const sub = page.frames().find((f) => /sub\.widgets\.wsw/.test(f.url()));
  const bys = page.frames().find((f) => /bys\.widgets\.wsw/.test(f.url()));
  check('R0 setup: both widgets loaded and initialized',
    !!sub && !!bys && await sub.evaluate(() => document.body.dataset.inited === '1')
      && await bys.evaluate(() => document.body.dataset.inited === '1'),
    `sub ${!!sub} bys ${!!bys}`);
  if (!sub || !bys) { await browser.close(); srv.close(); process.exit(1); }

  const NOTIFS = { state: 'allowed', items: [
    { id: 'n1', app: 'Mail', title: 'Invoice', body: 'account details inside' },
    { id: 'n2', app: 'Chat', title: 'Standup', body: 'in five' },
  ] };
  const pushNotifs = () => page.evaluate((d) => window.__push(d),
    JSON.stringify({ type: 'notifications', data: NOTIFS }));

  // Only the first widget subscribes. The second is an ordinary widget that never
  // mentions notifications — the malicious-widget case needs no more than that.
  await sub.evaluate(() => window.__watch(true));
  await page.waitForTimeout(200);
  await pushNotifs();
  await page.waitForTimeout(400);

  const subGot = await sub.evaluate(() => window.__notifs.length);
  check('R1 the subscriber receives notifications', subGot === 1, `${subGot} delivery(ies)`);
  const bysGot = await bys.evaluate(() => window.__notifs.map((n) => JSON.stringify(n)));
  check('R2 a widget that never subscribed receives none',
    bysGot.length === 0, JSON.stringify(bysGot));

  // R3 · the other delivery path. ww-init carries the latest payload, so a bystander
  // that merely reloads would otherwise be handed the toasts it was denied above.
  // The re-init has to be driven FROM the frame — a ww-ready posted at it from the top
  // document is not a request by that widget, and the shell rightly ignores it. Getting
  // that backwards made this probe measure nothing at all, which only the falsification
  // pass revealed: the payload also arrives as null when no re-init ever happens.
  await bys.evaluate(() => parent.postMessage({ type: 'ww-ready' }, '*'));
  await page.waitForTimeout(400);
  const bysInit = await bys.evaluate(() => window.__initNotifs.map((n) => JSON.stringify(n)));
  check('R3 setup: the bystander really was re-initialized',
    bysInit.length >= 2, `${bysInit.length} init(s)`);
  check('R3 a re-init does not carry the payload to a bystander either',
    bysInit.every((n) => n === 'null'), JSON.stringify(bysInit));

  // R4/R5 · dismissal. Ids come from the host, so a widget that saw a payload knows
  // real ids; one that did not should not be able to act on them regardless.
  hostMessages.length = 0;
  await bys.evaluate(() => window.__dismiss('n1'));
  await page.waitForTimeout(300);
  check('R4 a slot cannot dismiss a notification it was never shown',
    !hostMessages.some((m) => m.type === 'notification-dismiss'),
    JSON.stringify(hostMessages.map((m) => m.type)));

  hostMessages.length = 0;
  await sub.evaluate(() => window.__dismiss('n1'));
  await page.waitForTimeout(300);
  check('R5 ...while the subscriber that was shown it still can',
    hostMessages.some((m) => m.type === 'notification-dismiss' && m.id === 'n1'),
    JSON.stringify(hostMessages.filter((m) => m.type === 'notification-dismiss')));

  // R6 · Stream Deck profile: the keys the user configured.
  await sub.evaluate(() => window.__askDeck());
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__push(JSON.stringify({
    type: 'sd-profile-result', data: { available: true, rows: 3, cols: 5, buttons: [{ row: 0, col: 0, title: 'OBS' }] } })));
  await page.waitForTimeout(400);
  const subDecks = await sub.evaluate(() => window.__decks.length);
  const bysDecks = await bys.evaluate(() => window.__decks.length);
  check('R6 the Stream Deck profile reaches the widget that asked, and only it',
    subDecks === 1 && bysDecks === 0, `asker ${subDecks}, bystander ${bysDecks}`);

  // R7 · the capture is a screenshot of those keys.
  await sub.evaluate(() => window.__askCapture());
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__push(JSON.stringify({
    type: 'sd-capture-result', data: { available: true, pngBase64: 'SENTINEL-PIXELS' } })));
  await page.waitForTimeout(400);
  const subCaps = await sub.evaluate(() => window.__caps.length);
  const bysCaps = await bys.evaluate(() => JSON.stringify(window.__caps));
  check('R7 the live capture reaches the widget that asked, and only it',
    subCaps === 1 && bysCaps === '[]', `asker ${subCaps}, bystander ${bysCaps}`);

  // R8 · unsubscribing is a real state change, not just a message to the host.
  await sub.evaluate(() => { window.__watch(false); window.__notifs.length = 0; });
  await page.waitForTimeout(200);
  await pushNotifs();
  await page.waitForTimeout(400);
  const afterOff = await sub.evaluate(() => window.__notifs.length);
  check('R8 dropping the subscription stops delivery to that slot',
    afterOff === 0, `${afterOff} delivery(ies) after watch(false)`);

  await browser.close();
  srv.close();
  console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
