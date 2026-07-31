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
//   R11 · two Stream Deck askers each get ONLY their own answer (profile and capture)
//   R11d· a reloaded slot ignores the previous document's answer, not its own
//   R11e· ...and asks for captures as a different consumer, so it is not told
//         "unchanged" about pixels it never received
//   R9  · a slot subscribing while the host already polls is handed the cached payload
//   R10 · ...but one subscribing after polling STOPPED is not handed a stale one
//   R10c· ...nor does a re-init carry it (the cleared cache)
//   R10d· ...nor does a poll that landed while nobody watched (the demand gate)
//   R10e· ...nor the SECOND subscriber after that one flips demand back on
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
  window.__deckNames = () => window.__decks.map((p) => (p && p.name) || '?');
  window.__capTags = () => window.__caps.map((c) => (c && c.tag) || '?');
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

  // R6 · Stream Deck profile: the keys the user configured. The reply is addressed to
  // the request, so the probe answers the id the shell actually sent (#127).
  hostMessages.length = 0;
  await sub.evaluate(() => window.__askDeck());
  await page.waitForTimeout(200);
  const r6Id = (hostMessages.find((m) => m.type === 'sd-profile') || {}).id;
  check('R6 setup: the ask reached the host with an id', !!r6Id, String(r6Id));
  await page.evaluate((id) => window.__push(JSON.stringify({
    type: 'sd-profile-result', data: { id, available: true, rows: 3, cols: 5, buttons: [{ row: 0, col: 0, title: 'OBS' }] } })), r6Id);
  await page.waitForTimeout(400);
  const subDecks = await sub.evaluate(() => window.__decks.length);
  const bysDecks = await bys.evaluate(() => window.__decks.length);
  check('R6 the Stream Deck profile reaches the widget that asked, and only it',
    subDecks === 1 && bysDecks === 0, `asker ${subDecks}, bystander ${bysDecks}`);

  // R7 · the capture is a screenshot of those keys.
  hostMessages.length = 0;
  await sub.evaluate(() => window.__askCapture());
  await page.waitForTimeout(200);
  const r7Id = (hostMessages.find((m) => m.type === 'sd-capture') || {}).id;
  check('R7 setup: the capture ask reached the host with an id', !!r7Id, String(r7Id));
  await page.evaluate((id) => window.__push(JSON.stringify({
    type: 'sd-capture-result', data: { id, available: true, pngBase64: 'SENTINEL-PIXELS' } })), r7Id);
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

  // R9 · a slot that subscribes while another ALREADY has the host polling. There is no
  // demand transition for it to ride in on, and the host dedupes an unchanged poll, so
  // without an explicit hand-off the newcomer sits on null until a toast happens to
  // change. The bystander from R2 becomes that late subscriber — it starts from nothing,
  // which is exactly the state a reloaded notification widget would be in.
  await sub.evaluate(() => window.__watch(true));   // first subscriber active again
  await page.waitForTimeout(200);
  await pushNotifs();
  await page.waitForTimeout(300);
  await bys.evaluate(() => { window.__notifs.length = 0; });
  check('R9 setup: the late subscriber has nothing yet',
    (await bys.evaluate(() => window.__notifs.length)) === 0);
  await bys.evaluate(() => window.__watch(true));
  await page.waitForTimeout(400);
  const lateGot = await bys.evaluate(() => window.__notifs.length);
  check('R9 a slot subscribing after the host is already polling gets the cached payload',
    lateGot === 1, `${lateGot} delivery(ies)`);

  // ...and it can act on what it was just handed, which is the point of delivering it.
  hostMessages.length = 0;
  await bys.evaluate(() => window.__dismiss('n2'));
  await page.waitForTimeout(300);
  check('R9b ...and may dismiss what that payload showed it',
    hostMessages.some((m) => m.type === 'notification-dismiss' && m.id === 'n2'),
    JSON.stringify(hostMessages.map((m) => m.type)));

  // R10 · the mirror of R9, and the case that fix opened. When the LAST watcher stops,
  // the host stops polling, so anything cached is frozen at that moment. A slot
  // subscribing later must not be handed it: those toasts may be long gone, and the
  // delivery would also authorize dismissing their ids.
  await sub.evaluate(() => window.__watch(false));
  await bys.evaluate(() => window.__watch(false));
  await page.waitForTimeout(300);
  await sub.evaluate(() => { window.__notifs.length = 0; });
  await sub.evaluate(() => window.__watch(true));
  await page.waitForTimeout(400);
  const afterQuiet = await sub.evaluate(() => window.__notifs.length);
  check('R10 a slot subscribing after all watchers stopped is not handed the stale cache',
    afterQuiet === 0, `${afterQuiet} delivery(ies)`);

  // R11 · TWO askers. R6/R7 only prove an asker gets its answer and a bystander does
  // not, which a sticky per-slot flag satisfies just as well. The case that flag could
  // never get right is two widgets each waiting on their OWN request: the flags stayed
  // set for both, so every later reply went to both and two Stream Deck widgets with
  // different profiles overwrote each other (#127).
  hostMessages.length = 0;
  await sub.evaluate(() => { window.__decks.length = 0; window.__askDeck(); });
  await bys.evaluate(() => { window.__decks.length = 0; window.__askDeck(); });
  await page.waitForTimeout(300);
  const asks = hostMessages.filter((m) => m.type === 'sd-profile');
  check('R11 setup: both asks reached the host, with distinct ids',
    asks.length === 2 && asks[0].id && asks[1].id && asks[0].id !== asks[1].id,
    JSON.stringify(asks.map((a) => a.id)));

  // Answered in REVERSE order here, and in FORWARD order in R11b. That pairing is the
  // point: a mechanism that just remembers "the most recent asker" happens to be right
  // for one of those orderings and wrong for the other, so neither probe alone catches
  // it. Verified — mutating the route lookup to last-asker-wins passes R11 and fails
  // R11b.
  await page.evaluate((ids) => {
    window.__push(JSON.stringify({ type: 'sd-profile-result', data: { id: ids[1], available: true, name: 'PROFILE-B', rows: 3, cols: 5, buttons: [] } }));
    window.__push(JSON.stringify({ type: 'sd-profile-result', data: { id: ids[0], available: true, name: 'PROFILE-A', rows: 3, cols: 5, buttons: [] } }));
  }, asks.map((a) => a.id));
  await page.waitForTimeout(400);
  const subNames = await sub.evaluate(() => window.__deckNames());
  const bysNames = await bys.evaluate(() => window.__deckNames());
  check('R11 each asker receives ONLY the profile it asked for',
    JSON.stringify(subNames) === '["PROFILE-A"]' && JSON.stringify(bysNames) === '["PROFILE-B"]',
    `first=${JSON.stringify(subNames)} second=${JSON.stringify(bysNames)}`);

  // R11b · the same for captures, which carry a screenshot rather than a key list.
  hostMessages.length = 0;
  await sub.evaluate(() => { window.__caps.length = 0; window.__askCapture(); });
  await bys.evaluate(() => { window.__caps.length = 0; window.__askCapture(); });
  await page.waitForTimeout(300);
  const capAsks = hostMessages.filter((m) => m.type === 'sd-capture');
  check('R11b setup: both capture asks reached the host with distinct ids',
    capAsks.length === 2 && capAsks[0].id !== capAsks[1].id,
    JSON.stringify(capAsks.map((a) => a.id)));
  await page.evaluate((ids) => {
    window.__push(JSON.stringify({ type: 'sd-capture-result', data: { id: ids[0], tag: 'PIXELS-A' } }));
    window.__push(JSON.stringify({ type: 'sd-capture-result', data: { id: ids[1], tag: 'PIXELS-B' } }));
  }, capAsks.map((a) => a.id));
  await page.waitForTimeout(400);
  const r11SubCaps = await sub.evaluate(() => window.__capTags());
  const r11BysCaps = await bys.evaluate(() => window.__capTags());
  check('R11b each asker receives ONLY its own capture',
    JSON.stringify(r11SubCaps) === '["PIXELS-A"]' && JSON.stringify(r11BysCaps) === '["PIXELS-B"]',
    `first=${JSON.stringify(r11SubCaps)} second=${JSON.stringify(r11BysCaps)}`);

  // R11c · an answer for a request nobody made goes nowhere. Under the old flags an
  // unsolicited result reached every widget that had ever asked.
  await sub.evaluate(() => { window.__decks.length = 0; });
  await bys.evaluate(() => { window.__decks.length = 0; });
  await page.evaluate(() => window.__push(JSON.stringify({
    type: 'sd-profile-result', data: { id: 'never-requested', available: true, name: 'GHOST', rows: 3, cols: 5, buttons: [] } })));
  await page.waitForTimeout(300);
  const ghost = (await sub.evaluate(() => window.__deckNames())).concat(await bys.evaluate(() => window.__deckNames()));
  check('R11c an unrequested Stream Deck reply reaches nobody', ghost.length === 0, JSON.stringify(ghost));

  // R11d · a slot RELOAD (settings change) keeps the same WindowProxy at the same
  // origin, so a route armed by the previous document stays deliverable for its whole
  // timeout. Stream Deck replies go straight to listeners rather than resolving a
  // promise, so nothing else would stop the old document's answer landing in the new one
  // and overwriting the profile it just selected.
  hostMessages.length = 0;
  await sub.evaluate(() => { window.__decks.length = 0; window.__askDeck(); });
  await page.waitForTimeout(200);
  const staleId = (hostMessages.find((m) => m.type === 'sd-profile') || {}).id;
  check('R11d setup: a request is in flight', !!staleId, String(staleId));

  // Stamp the CURRENT document so "did it reload" is answered by the document being
  // gone, not by a flag any document would set. A first attempt appended ?r= after the
  // fragment, which changes only the hash and reloads nothing — and `inited` was true
  // either way, so the setup check passed while the probe measured the old document.
  await sub.evaluate(() => { window.__generation = 'OLD'; });
  // Reload the slot the way a settings change does: query BEFORE the fragment, which is
  // what makes it a navigation rather than a hash change (mirrors reloadSlot in shell.js).
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('iframe')) {
      if (!/sub\./.test(el.src)) continue;
      const [base, hash] = el.src.split('#');
      el.src = base.split('?')[0] + '?r=' + Date.now() + (hash ? '#' + hash : '');
    }
  });
  await page.waitForTimeout(1800);
  const reloaded = page.frames().find((f) => /sub\.widgets\.wsw/.test(f.url()));
  const isNewDocument = !!reloaded && await reloaded.evaluate(() => window.__generation === undefined);
  check('R11d setup: the slot is a NEW document, not the same one',
    isNewDocument && await reloaded.evaluate(() => document.body.dataset.inited === '1'),
    `newDocument=${isNewDocument}`);
  await page.evaluate((id) => window.__push(JSON.stringify({
    type: 'sd-profile-result', data: { id, available: true, name: 'STALE-PROFILE', rows: 3, cols: 5, buttons: [] } })), staleId);
  await page.waitForTimeout(400);
  const afterReload = await reloaded.evaluate(() => window.__deckNames());
  check('R11d the replacement document ignores the previous document\'s answer',
    afterReload.length === 0, JSON.stringify(afterReload));

  // ...and it is not simply deaf: its own request is still answered.
  hostMessages.length = 0;
  await reloaded.evaluate(() => window.__askDeck());
  await page.waitForTimeout(200);
  const freshId = (hostMessages.find((m) => m.type === 'sd-profile') || {}).id;
  await page.evaluate((id) => window.__push(JSON.stringify({
    type: 'sd-profile-result', data: { id, available: true, name: 'FRESH-PROFILE', rows: 3, cols: 5, buttons: [] } })), freshId);
  await page.waitForTimeout(400);
  const freshNames = await reloaded.evaluate(() => window.__deckNames());
  check('R11d2 ...while its own request still is',
    JSON.stringify(freshNames) === '["FRESH-PROFILE"]', JSON.stringify(freshNames));

  // R11e · the capture dedup is keyed on a consumer identity the SHELL mints, and that
  // identity has to change when the document does. The C# probe covers the dedup's own
  // contract but cannot see what the shell puts in `client`, so without this the shell
  // half was inspection only — and the failure it guards against is a mirror that stays
  // blank after a settings change.
  hostMessages.length = 0;
  await reloaded.evaluate(() => window.__askCapture());
  await page.waitForTimeout(250);
  const clientBefore = (hostMessages.find((m) => m.type === 'sd-capture') || {}).client;
  check('R11e setup: the capture request carries a consumer id', !!clientBefore, String(clientBefore));

  await reloaded.evaluate(() => { window.__generation = 'BEFORE-2'; });
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('iframe')) {
      if (!/sub\./.test(el.src)) continue;
      const [base, hash] = el.src.split('#');
      el.src = base.split('?')[0] + '?r2=' + Date.now() + (hash ? '#' + hash : '');
    }
  });
  await page.waitForTimeout(1800);
  const again = page.frames().find((f) => /sub\.widgets\.wsw/.test(f.url()));
  check('R11e setup: it really is another new document',
    !!again && await again.evaluate(() => window.__generation === undefined));
  hostMessages.length = 0;
  await again.evaluate(() => window.__askCapture());
  await page.waitForTimeout(250);
  const clientAfter = (hostMessages.find((m) => m.type === 'sd-capture') || {}).client;
  check('R11e a reloaded document asks as a DIFFERENT consumer',
    !!clientAfter && clientAfter !== clientBefore, `${clientBefore} -> ${clientAfter}`);
  check('R11e2 ...while still naming the same slot',
    String(clientAfter).split('#')[0] === String(clientBefore).split('#')[0],
    `${clientBefore} -> ${clientAfter}`);

  // R10c · what the CLEARED CACHE covers and the gate does not. `sub` is subscribed with
  // an empty cache; a re-init would carry whatever is cached to a watching slot, so if
  // the stale payload were still held it would arrive by that path instead.
  await sub.evaluate(() => { window.__initNotifs.length = 0; parent.postMessage({ type: 'ww-ready' }, '*'); });
  await page.waitForTimeout(400);
  const reinit = await sub.evaluate(() => window.__initNotifs.map((n) => JSON.stringify(n)));
  check('R10c setup: the slot really re-initialized', reinit.length >= 1, `${reinit.length} init(s)`);
  check('R10c a re-init after the quiet period carries no stale payload',
    reinit.every((n) => n === 'null'), JSON.stringify(reinit));

  // R10d · what the GATE covers and the cleared cache does not. A poll already in flight
  // when the last watcher leaves lands after the clear and repopulates the cache; the
  // host is no longer polling, so that payload is the last thing anyone saw and ages the
  // same way. Only the "was the host already polling" condition refuses it.
  await sub.evaluate(() => window.__watch(false));
  await page.waitForTimeout(300);
  await pushNotifs();                                  // the late in-flight poll
  await page.waitForTimeout(200);
  await sub.evaluate(() => { window.__notifs.length = 0; });
  await sub.evaluate(() => window.__watch(true));
  await page.waitForTimeout(400);
  const afterLate = await sub.evaluate(() => window.__notifs.length);
  check('R10d a payload that landed while nobody was watching is not handed out either',
    afterLate === 0, `${afterLate} delivery(ies)`);

  // R10e · the one-time clear is not enough on its own. A poll that lands while demand
  // is off REPOPULATES the cache, and the first subscriber — protected by the gate —
  // flips demand back on, which makes that stale payload live again for whoever comes
  // next. So the SECOND subscriber, and a re-init of the first, must not see it either.
  await sub.evaluate(() => window.__watch(false));
  await bys.evaluate(() => window.__watch(false));
  await page.waitForTimeout(300);
  await pushNotifs();                                   // lands with nobody watching
  await page.waitForTimeout(200);
  await sub.evaluate(() => { window.__notifs.length = 0; window.__initNotifs.length = 0; });
  await bys.evaluate(() => { window.__notifs.length = 0; });
  await sub.evaluate(() => window.__watch(true));       // first: gate protects it
  await page.waitForTimeout(300);
  await bys.evaluate(() => window.__watch(true));       // second: demand is on again
  await page.waitForTimeout(400);
  const secondGot = await bys.evaluate(() => window.__notifs.length);
  check('R10e the SECOND subscriber does not inherit a payload received while demand was off',
    secondGot === 0, `${secondGot} delivery(ies)`);

  await sub.evaluate(() => parent.postMessage({ type: 'ww-ready' }, '*'));
  await page.waitForTimeout(400);
  const lateInit = await sub.evaluate(() => window.__initNotifs.map((n) => JSON.stringify(n)));
  check('R10e setup: the first subscriber really re-initialized', lateInit.length >= 1, `${lateInit.length} init(s)`);
  check('R10e2 ...nor does a re-init carry it',
    lateInit.every((n) => n === 'null'), JSON.stringify(lateInit));

  // ...and it is a live subscription, not a silenced one. Without this, R10 and R10d
  // would pass just as well if subscribing had stopped working altogether.
  await pushNotifs();
  await page.waitForTimeout(400);
  const afterFresh = await sub.evaluate(() => window.__notifs.length);
  check('R10b ...and still receives the next real poll',
    afterFresh === 1, `${afterFresh} delivery(ies) after a fresh push`);

  await browser.close();
  srv.close();
  console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
