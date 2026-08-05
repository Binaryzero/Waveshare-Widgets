#!/usr/bin/env node
// Issue #112 — a transport failure could push the Hue tile from CLIP v2 onto plaintext v1.
//
// The two are not interchangeable. v1 is http and carries `username` IN THE PATH, and on
// this bridge `username` IS the CLIP v2 application key — so every route from v2 to v1
// hands the key, and every later light command, to anyone watching the LAN. Both routes
// were openable by a TypeError, which is exactly what someone interfering with TLS
// produces: the widget took instruction on its own security properties from the party it
// was meant to be protected from.
//
//   H1 · a bridge that answers CLIP v2 is polled over v2, and the key never appears on http
//   H2 · v2 failing mid-session does NOT move it to v1 — it reports the bridge unreachable
//   H3 · ...and that holds however long the failure lasts (the old rule demoted at two)
//   H4 · a bridge already known to speak v2 stays on v2 even when the PROBE fails, which is
//        the same attack four seconds earlier
//   H5 · a genuinely v1-only bridge still works — the fix must not cost them the widget
//   H6 · pairing clears the memory, so a bridge reset down to v1 is not stuck asking for v2
//   H8 · an UNMARKED bridge — which every existing install is — is not downgraded either
//   H9 · and the question is not a dead end: https recovering resolves it by itself
//   H10 · a probe still on the wire when the user answers does not overrule them
//   H7 · the polling route ALONE: the probe succeeds, then v2 starts failing. H2-H4 cannot
//        tell the two fixes apart, because a probe that demotes never lets polling see v2
//
// The witness throughout is the REQUEST LOG: what the tile renders matters less than which
// URLs it was willing to send the key to.
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const SHELL = path.join(REPO, 'src', 'Plinth', 'Shell');
const WIDGET = path.join(REPO, 'widgets', 'hue');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
const KEY = 'probe-application-key-9f3a';
const IP = '10.0.0.9';

function loadPlaywright() {
  const candidates = ['playwright', '/opt/node22/lib/node_modules/playwright',
    path.join(process.env.HOME || '', 'node_modules/playwright')];
  for (const c of candidates) { try { return require(c); } catch (e) { /* next */ } }
  console.error('playwright not found');
  process.exit(1);
}

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  if (!ok) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { chromium } = loadPlaywright();
  const shim = fs.readFileSync(path.join(SHELL, 'widget-api.js'), 'utf8');
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  page.on('pageerror', (e) => { failures++; console.log('[pageerror]', String(e).slice(0, 300)); });

  // The bridge, scripted per probe. `v2` decides whether CLIP v2 answers, fails at the
  // transport layer, or 404s the way a real v1-only bridge does.
  const v2Rooms = { data: [{ id: 'r1', metadata: { name: 'Kitchen' }, services: [] }] };
  // `type` matters: pollV1 keeps only Room/Zone groups, so a fixture without it renders
  // "No rooms on this bridge" and H5b would be measuring the fixture rather than the fix.
  const v1Groups = { 1: { name: 'Kitchen', type: 'Room', action: { bri: 200 }, state: { any_on: true } } };

  // The widget is proxy-only for bridge traffic (init.proxy 'always'), so every bridge
  // request arrives as a ww-fetch message rather than a network request. Answering it here
  // is what makes the URL log complete — a page route would never see them.
  await page.addInitScript(shim);
  await page.addInitScript(([ip, key, rooms, groups]) => {
    window.__asked = [];
    window.__v2 = 'ok';
    window.addEventListener('message', (ev) => {
      const m = ev.data || {};
      if (m.type !== 'ww-fetch') return;
      window.__asked.push({ url: m.url, headers: m.headers || {} });
      const reply = (body, status) => window.postMessage({
        type: 'ww-fetch-result', id: m.id, status: status || 200,
        contentType: 'application/json', bodyBase64: btoa(body),
      }, '*');
      const fail = (msg) => window.postMessage({ type: 'ww-fetch-result', id: m.id, error: msg }, '*');
      const u = String(m.url);
      if (u === 'http://' + ip + '/api/config') return reply(JSON.stringify({ bridgeid: 'ABCD' }));
      if (u.indexOf('/clip/v2') !== -1) {
        // A transport failure is what the shim turns a dead socket into: a TypeError.
        if (window.__v2 === 'transport') return fail('connection refused');
        // Still on the wire when the user answers: the race H10 drives.
        if (window.__v2 === 'slowfail') return setTimeout(() => fail('connection refused'), window.__v2Delay || 6000);
        if (window.__v2 === '404') return reply('{}', 404);
        if (u.indexOf('/resource/room') !== -1) return reply(JSON.stringify(rooms));
        return reply(JSON.stringify({ data: [] }));
      }
      if (u.indexOf('/api/' + key + '/groups') !== -1) return reply(JSON.stringify(groups));
      if (u.indexOf('/api/' + key + '/scenes') !== -1) return reply(JSON.stringify({}));
      if (u.indexOf('/api/' + key) !== -1) return reply(JSON.stringify([{ success: {} }]));
      return fail('unrouted in probe: ' + u);
    });
  }, [IP, KEY, v2Rooms, v1Groups]);

  await page.route('https://app.plinth/**', (route) => {
    const file = path.join(SHELL, new URL(route.request().url()).pathname);
    if (fs.existsSync(file)) return route.fulfill({ contentType: MIME[path.extname(file)] || 'text/plain', body: fs.readFileSync(file) });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.route('https://widget.test/**', (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\//, '') || 'index.html';
    const file = path.join(WIDGET, rel);
    if (file.startsWith(WIDGET) && fs.existsSync(file) && fs.statSync(file).isFile())
      return route.fulfill({ contentType: MIME[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.route(/https?:\/\/(?!app\.plinth|widget\.test).*/, (route) => route.abort());

  // A fresh document per scenario: `mode` is probed once per session, so re-initialising
  // the same page would answer questions about a session that already decided.
  const boot = async (opts) => {
    await page.goto('about:blank');
    await page.goto('https://widget.test/index.html');
    await page.evaluate(([ip, key, mode, seen, clearConsent]) => {
      localStorage.setItem('hue-user-' + ip, key);
      if (seen) localStorage.setItem('hue-v2-' + ip, '1');
      else localStorage.removeItem('hue-v2-' + ip);
      // NOT cleared unless asked: H8d checks the consent survives a reload, which only
      // means anything if the reload does not quietly wipe it.
      if (clearConsent) localStorage.removeItem('hue-v1ok-' + ip);
      window.__v2 = mode;
      window.__asked = [];
    }, [IP, KEY, opts.v2, !!opts.seen, opts.clearConsent !== false]);
    await page.evaluate((ip) => {
      window.postMessage({ type: 'ww-init', sensors: [], media: null, theme: null,
        status: { elevated: false, apiVersion: 1 },
        settings: { bridgeIp: ip, showScenes: 'on', bgStyle: 'solid' } }, '*');
    }, IP);
    await wait(opts.settleMs || 1500);
    return page.evaluate(() => window.__asked.slice());
  };

  const httpKeyUrls = (log) => log.filter((r) => r.url.startsWith('http://') && r.url.includes(KEY)).map((r) => r.url);
  const v2Urls = (log) => log.filter((r) => r.url.indexOf('/clip/v2') !== -1).map((r) => r.url);
  const msg = () => page.evaluate(() => {
    const m = document.getElementById('message');
    return { shown: m.style.display === 'flex', title: (m.querySelector('.state-title') || {}).textContent || '' };
  });

  // ---- H1 · a v2 bridge is used over v2, and the key never rides http -----------------
  let log = await boot({ v2: 'ok' });
  check('H1 a CLIP v2 bridge is polled over v2', v2Urls(log).length > 0, String(v2Urls(log).length));
  check('H1b ...and the application key never appears in an http URL',
    httpKeyUrls(log).length === 0, httpKeyUrls(log).join(' '));

  // ---- H2/H3 · v2 failing does not open the v1 route ----------------------------------
  // Long enough for several polls: the rule this replaces demoted on the SECOND failure,
  // so a window that only covers one would pass against the bug.
  log = await boot({ v2: 'transport', seen: true, settleMs: 10000 });
  const v2Tries = v2Urls(log).length;
  check('H2 a v2 transport failure does not put the key on plaintext http',
    httpKeyUrls(log).length === 0, httpKeyUrls(log).join(' '));
  check('H2b ...the tile reports the bridge unreachable instead',
    (await msg()).shown && /unreachable/i.test((await msg()).title), (await msg()).title);
  check('H3 ...and it keeps trying v2 across many polls rather than giving up on it',
    v2Tries >= 3, `${v2Tries} v2 attempts`);

  // ---- H4 · the same attack at PROBE time ---------------------------------------------
  // Fixing only the polling demotion would have moved this attack four seconds earlier,
  // not closed it: the probe's own catch used to set v1 just as readily.
  log = await boot({ v2: 'transport', seen: true, settleMs: 3000 });
  check('H4 a bridge known to speak v2 is not demoted by a failing PROBE',
    httpKeyUrls(log).length === 0, httpKeyUrls(log).join(' '));

  // ---- H7 · the POLLING route on its own ------------------------------------------------
  // H2-H4 fail for either demotion route, because a probe that demotes never lets polling
  // reach v2 at all — so they cannot tell the two fixes apart. Here the probe SUCCEEDS and
  // v2 only starts failing afterwards, which is reachable only through the polling
  // path: the bridge answered v2 a moment ago and the tile watched it stop.
  await page.goto('about:blank');
  await page.goto('https://widget.test/index.html');
  await page.evaluate(([ip, key]) => {
    localStorage.setItem('hue-user-' + ip, key);
    localStorage.removeItem('hue-v2-' + ip);
    window.__v2 = 'ok';
    window.__asked = [];
  }, [IP, KEY]);
  await page.evaluate((ip) => {
    window.postMessage({ type: 'ww-init', sensors: [], media: null, theme: null,
      status: { elevated: false, apiVersion: 1 },
      settings: { bridgeIp: ip, showScenes: 'on', bgStyle: 'solid' } }, '*');
  }, IP);
  await wait(1500);
  const beforeBreak = await page.evaluate(() => window.__asked.length);
  await page.evaluate(() => { window.__v2 = 'transport'; });   // TLS starts being interfered with
  await wait(10000);
  const afterBreak = await page.evaluate((n) => window.__asked.slice(n), beforeBreak);
  check('H7 setup: the bridge really was on v2 before it broke', beforeBreak > 0, String(beforeBreak));
  check('H7 a session already polling v2 is not moved to http when v2 starts failing',
    httpKeyUrls(afterBreak).length === 0, httpKeyUrls(afterBreak).join(' '));

  // ---- H8 · the UPGRADE case, which is every existing install ---------------------------
  // The v2 marker is only ever written by a SUCCESSFUL v2 run, so an installation upgrading
  // from an earlier version has the stored key and no marker — and an attacker who keeps
  // blocking TLS keeps it that way forever. Choosing v1 here would hand over the key, so
  // an unconfirmed bridge waits for the user instead of guessing.
  log = await boot({ v2: 'transport', seen: false, settleMs: 3000 });
  check('H8 an unmarked bridge whose probe is blocked does NOT put the key on http',
    httpKeyUrls(log).length === 0, httpKeyUrls(log).join(' '));
  const choice = await page.evaluate(() => ({
    shown: document.getElementById('legacy').style.display === 'flex',
    hint: (document.getElementById('legacyHint') || {}).textContent || '',
  }));
  check('H8b ...it asks, naming what the legacy API costs',
    choice.shown && /unencrypted/i.test(choice.hint), `${choice.shown} — ${choice.hint.slice(0, 60)}`);
  // ...and the decision is the user's, so taking it must actually work — otherwise the fix
  // strands every bridge that really has no HTTPS.
  await page.evaluate(() => { window.__asked = []; document.getElementById('legacyBtn').click(); });
  await wait(1500);
  const afterConsent = await page.evaluate(() => window.__asked.slice());
  check('H8c ...and taking that choice runs v1, so a bridge without HTTPS is not stranded',
    httpKeyUrls(afterConsent).some((u) => u.includes('/groups')), httpKeyUrls(afterConsent).join(' '));
  // The consent is per address and persists, or the tile would ask on every reload.
  log = await boot({ v2: 'transport', seen: false, settleMs: 2500, clearConsent: false });
  check('H8d ...and once given it is remembered, rather than asked again every reload',
    httpKeyUrls(log).some((u) => u.includes('/groups')), httpKeyUrls(log).join(' '));

  // ---- H5 · a bridge that ANSWERS non-200 is not thereby trusted --------------------
  // This changed in round 2, and the earlier version of this probe was asserting something
  // the code could not actually observe. The v2 probe rides `insecure: true` and the host
  // accepts any certificate, so an on-LAN attacker can impersonate the bridge and answer
  // 404 as easily as it can drop the connection — "the bridge said it is v1" is not a
  // statement this widget is in a position to make. Only a 200 authorizes v2; every other
  // outcome asks.
  log = await boot({ v2: '404' });
  check('H5 a non-200 answer does not by itself put the key on http',
    httpKeyUrls(log).length === 0, httpKeyUrls(log).join(' '));
  const asked404 = await page.evaluate(() => document.getElementById('legacy').style.display === 'flex');
  check('H5b ...it asks, exactly as a dropped connection does', asked404, String(asked404));
  // ...and a real v1-only bridge is one tap from working, which is the cost of not being
  // able to tell it apart from an impersonated one.
  await page.evaluate(() => { window.__asked = []; document.getElementById('legacyBtn').click(); });
  await wait(1500);
  const after404 = await page.evaluate(() => window.__asked.slice());
  check('H5c ...and accepting runs v1, so a genuine v1-only bridge still works',
    httpKeyUrls(after404).some((u) => u.includes('/groups')), httpKeyUrls(after404).join(' '));

  // ---- H9 · the question is not a dead end -------------------------------------------
  // While the offer is on screen the widget keeps retrying https. Without that, one
  // transient TLS failure leaves a single way out — authorizing plaintext permanently, for
  // a bridge that is about to come back. The retry is what makes refusing the offer safe.
  await page.goto('about:blank');
  await page.goto('https://widget.test/index.html');
  await page.evaluate(([ip, key]) => {
    localStorage.setItem('hue-user-' + ip, key);
    localStorage.removeItem('hue-v2-' + ip);
    localStorage.removeItem('hue-v1ok-' + ip);
    window.__v2 = 'transport';
    window.__asked = [];
  }, [IP, KEY]);
  await page.evaluate((ip) => {
    window.postMessage({ type: 'ww-init', sensors: [], media: null, theme: null,
      status: { elevated: false, apiVersion: 1 },
      settings: { bridgeIp: ip, showScenes: 'on', bgStyle: 'solid' } }, '*');
  }, IP);
  await wait(2000);
  check('H9 setup: the offer is showing while https is down',
    await page.evaluate(() => document.getElementById('legacy').style.display === 'flex'));
  await page.evaluate(() => { window.__v2 = 'ok'; });   // https comes back on its own
  await wait(20000);                                     // one retry interval, plus slack
  const recovered = await page.evaluate(() => ({
    hidden: document.getElementById('legacy').style.display === 'none',
    v2: window.__asked.filter((r) => r.url.indexOf('/clip/v2') !== -1).length,
    consented: localStorage.getItem('hue-v1ok-' + ''.concat('10.0.0.9')),
  }));
  check('H9 https recovering resolves it without the user authorizing anything',
    recovered.hidden && recovered.v2 > 1 && recovered.consented === null,
    JSON.stringify(recovered));
  check('H9b ...and the key never went to http while the question was open',
    httpKeyUrls(await page.evaluate(() => window.__asked.slice())).length === 0);

  // ---- H10 · a late probe answer does not overrule the user ---------------------------
  // The consent button can cancel a pending retry timer, but not a v2fetch already on the
  // wire. Without a latch, that in-flight probe settles seconds later and either re-asks the
  // question just answered or flips the session to v2 while v1 polling is running.
  const retryMs = Number((fs.readFileSync(path.join(WIDGET, 'index.html'), 'utf8')
    .match(/PROBE_RETRY_MS\s*=\s*(\d+)/) || [])[1] || 15000);
  await page.goto('about:blank');
  await page.goto('https://widget.test/index.html');
  await page.evaluate(([ip, key]) => {
    localStorage.setItem('hue-user-' + ip, key);
    localStorage.removeItem('hue-v2-' + ip);
    localStorage.removeItem('hue-v1ok-' + ip);
    window.__v2 = 'transport';
    window.__asked = [];
  }, [IP, KEY]);
  await page.evaluate((ip) => {
    window.postMessage({ type: 'ww-init', sensors: [], media: null, theme: null,
      status: { elevated: false, apiVersion: 1 },
      settings: { bridgeIp: ip, showScenes: 'on', bgStyle: 'solid' } }, '*');
  }, IP);
  await wait(2000);
  check('H10 setup: the offer is up after the first probe failed',
    await page.evaluate(() => document.getElementById('legacy').style.display === 'flex'));
  // Make the NEXT probe slow, then let the retry timer fire so it is in flight.
  await page.evaluate(() => { window.__v2 = 'slowfail'; window.__v2Delay = 6000; });
  await wait(retryMs + 1500);
  check('H10 setup: a probe really is in flight when the button is clicked',
    await page.evaluate(() => window.__asked.filter((r) => r.url.indexOf('/clip/v2') !== -1).length >= 2),
    String(await page.evaluate(() => window.__asked.filter((r) => r.url.indexOf('/clip/v2') !== -1).length)));
  await page.evaluate(() => { window.__asked = []; document.getElementById('legacyBtn').click(); });
  await wait(8000);   // long enough for the in-flight probe to settle after the click
  const late = await page.evaluate(() => ({
    offerBack: document.getElementById('legacy').style.display === 'flex',
    urls: window.__asked.map((r) => r.url),
  }));
  check('H10 a late probe failure does not re-ask a question the user already answered',
    !late.offerBack, String(late.offerBack));
  check('H10b ...and v1 polling, which the user authorized, keeps running',
    late.urls.some((u) => u.startsWith('http://') && u.includes(KEY) && u.includes('/groups')),
    late.urls.join(' ').slice(0, 120));

  // ---- H6 · pairing clears the memory ---------------------------------------------------
  log = await boot({ v2: '404', seen: true, settleMs: 1500 });
  check('H6 setup: a remembered bridge stays on v2 even when it answers 404',
    httpKeyUrls(log).length === 0, httpKeyUrls(log).join(' '));
  const cleared = await page.evaluate((ip) => {
    // What the pairing handler does on success. If this did not clear, a bridge reset
    // down to v1 would be stuck asking for an API generation it no longer serves.
    localStorage.removeItem('hue-v2-' + ip);
    return localStorage.getItem('hue-v2-' + ip);
  }, IP);
  check('H6b ...and pairing clears it, so a reset bridge can re-probe', cleared === null, String(cleared));
  check('H6c setup: the pairing handler really is what clears it',
    fs.readFileSync(path.join(WIDGET, 'index.html'), 'utf8')
      .includes("localStorage.removeItem('hue-v2-' + cfg.ip)"));

  await browser.close();
  console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
