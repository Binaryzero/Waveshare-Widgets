#!/usr/bin/env node
// Issue #16 — the Generic REST tile's data path. The widget harness proves the
// rendering contract offline; these probes drive the parts that only exist once a real
// response arrives, against a scriptable fixture endpoint:
//   R1 · the value is pulled out by JSON Pointer AND by the friendlier dotted path
//   R2 · thresholds colour the number, in both directions (warn<crit and crit<warn)
//   R3 · a non-2xx answer never leaves a blank tile
//   R4 · a configured auth header reaches the request — and appears nowhere on screen
//   R5 · no URL is a setup state, not a spinner that never resolves
//   R6 · a failure AFTER a good read keeps the value, dimmed, with a Stale pill
//   R7 · a real null reading, a pointer miss and a non-scalar each say what to fix
//   R8 · a repeated ww-init (settings edit) does not stack pollers
//   R10 · a failing endpoint backs off; an explicit Retry overrides the backoff
//   R11 · the age label is recomputed from the clock, not frozen until the next poll
//   R12 · a hidden panel stops the cadence underneath the tile, and resumes it
//   R22 · a response past the WW.fetch ceiling is named as such, not as unreachable —
//         and an ordinary body still reads through the new cap
//   R23 · the same refusal arriving from the HOST proxy tier reads the same way, by either
//         way into the ladder, and carries the same error TYPE — while an ordinary host
//         failure keeps the type, and the state, that means "unreachable"
//   R24/R25 · the wrapper WW.fetch returns IS a Response — its body takes a BYOB reader and
//         it survives the brand check cache.put performs. Neither is expressible in Node.
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const SHELL = path.join(REPO, 'src', 'Plinth', 'Shell');
const WIDGET = path.join(REPO, 'widgets', 'rest');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };

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

const TOKEN = 'Bearer super-secret-probe-token';

(async () => {
  const { chromium } = loadPlaywright();
  const shim = fs.readFileSync(path.join(SHELL, 'widget-api.js'), 'utf8');
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  page.on('pageerror', (e) => { failures++; console.log('[pageerror]', String(e).slice(0, 300)); });

  // The fixture endpoint, rescripted per probe. `seen` records what the widget
  // actually sent, which is how R4 proves the header made it onto the wire.
  let respond = () => ({ status: 200, body: '{}' });
  const seen = [];

  // Shared by every page the suite opens — R11 needs a second one with a fake clock.
  async function prepare(p) {
    await p.route('https://app.plinth/**', (route) => {
      const file = path.join(SHELL, new URL(route.request().url()).pathname);
      if (fs.existsSync(file)) return route.fulfill({ contentType: MIME[path.extname(file)] || 'text/plain', body: fs.readFileSync(file) });
      return route.fulfill({ status: 404, body: '' });
    });
    await p.route('https://widget.test/**', (route) => {
      const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\//, '') || 'index.html';
      const file = path.join(WIDGET, rel);
      if (file.startsWith(WIDGET) && fs.existsSync(file) && fs.statSync(file).isFile())
        return route.fulfill({ contentType: MIME[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
      return route.fulfill({ status: 404, body: '' });
    });
    await p.route('https://api.test/**', async (route) => {
      const url = route.request().url();
      seen.push({ url: url, headers: route.request().headers() });
      const r = respond(url);
      // A slow endpoint, so a probe can retarget the tile while a request is still out.
      if (r.delayMs) await wait(r.delayMs);
      if (r.abort) return route.abort();
      return route.fulfill({ status: r.status, contentType: r.contentType || 'application/json', body: r.body });
    });
    await p.route(/https?:\/\/(?!app\.plinth|widget\.test|api\.test).*/, (route) => route.abort());

    await p.addInitScript(shim);
    // The one pause this tile has is a hidden panel, and Playwright cannot hide a page on
    // demand — so `hidden` and `visibilityState` are backed by a flag the probes flip.
    // Installed before any widget script runs, and visible unless a page says otherwise:
    // R21 needs a document that was ALREADY hidden when the widget booted.
    await p.addInitScript(() => {
      if (window.__hidden === undefined) window.__hidden = false;
      Object.defineProperty(document, 'hidden', { get: () => window.__hidden === true, configurable: true });
      Object.defineProperty(document, 'visibilityState',
        { get: () => (window.__hidden === true ? 'hidden' : 'visible'), configurable: true });
    });
    // WW.fetch escalates to the host proxy when the browser request fails. Without a
    // host answering that message the promise never settles — which is exactly how the
    // first run of this suite wedged the widget, and why it now has a timeout.
    await p.addInitScript(() => {
      // Scriptable, because the host has more than one way to refuse. It reports every
      // failure as a STRING — 'response too large' and 'connection refused' arrive by the
      // same field — and the tile has to tell those apart (R23).
      window.__probeHostError = 'host offline in probe';
      window.addEventListener('message', (ev) => {
        const m = ev.data || {};
        if (m.type !== 'ww-fetch') return;
        // OAuth2 token exchanges use proxy:'always', so they arrive here rather than on the
        // browser tier. When a token endpoint is armed (RT, #176.1), answer it with a
        // scriptable token body and COUNT the grant — that count is how the halt is proven,
        // since the bug is one successful grant per poll. Everything else keeps the R22/R23
        // host-error behaviour untouched.
        if (window.__tokenEndpoint && String(m.url).indexOf(window.__tokenEndpoint) === 0) {
          window.__grants = (window.__grants || 0) + 1;
          const body = JSON.stringify(window.__tokenResp
            || { access_token: 'probe-token', token_type: 'DPoP', expires_in: 3600 });
          window.postMessage({ type: 'ww-fetch-result', id: m.id, status: 200,
            contentType: 'application/json', bodyBase64: btoa(body) }, '*');
          return;
        }
        window.postMessage({ type: 'ww-fetch-result', id: m.id, error: window.__probeHostError }, '*');
      });
    });
  }

  await prepare(page);
  await page.goto('https://widget.test/index.html');

  // The manifest's declared defaults go UNDER whatever a probe passes, because that is
  // what the widget actually receives: shell.js seeds every property with its default
  // before overlaying stored settings, so absent and explicitly-chosen are the same
  // string by the time a widget sees them. Posting a probe's settings verbatim models a
  // payload the panel never sends.
  //
  // This is not cosmetic. `authMode` declares "header" in the manifest but falls back to
  // "none" in the widget's own cfg, so without the seed the tile suppressed its static
  // auth header — and R4 read that as the widget failing to send a configured
  // credential. It was the probe handing it a payload the host would never produce.
  const manifestDefaults = (() => {
    const out = {};
    try {
      const m = JSON.parse(fs.readFileSync(path.join(WIDGET, 'manifest.json'), 'utf8'));
      for (const prop of m.properties || []) {
        if (prop && prop.name && prop.default !== undefined) out[prop.name] = prop.default;
      }
    } catch (e) { /* a manifest this probe cannot read is the validator's business */ }
    return out;
  })();

  const init = (settings) => page.evaluate((s) => {
    window.postMessage({ type: 'ww-init', settings: s, sensors: [], media: null, theme: null,
      status: { elevated: false, apiVersion: 1 } }, '*');
  }, Object.assign({}, manifestDefaults, settings));

  // Hidden the way a browser does it: the flag first, then the event, because the widget
  // drops its pending timer from the handler rather than at the next tick.
  const setHidden = (hidden) => page.evaluate((h) => {
    window.__hidden = h;
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);

  const read = () => page.evaluate(() => ({
    value: document.getElementById('value').textContent,
    cls: document.getElementById('value').className,
    bodyHidden: document.getElementById('body').hidden,
    stale: document.getElementById('body').classList.contains('stale'),
    pill: document.getElementById('pill').hidden ? null : document.getElementById('pill').textContent,
    stateHidden: document.getElementById('state').hidden,
    title: document.getElementById('stateTitle').textContent,
    body: document.getElementById('stateBody').textContent,
    retry: !document.getElementById('retry').hidden,
    text: document.body.innerText,
  }));

  // #173 — the geometry of the value box: `clipped` is the bug (scrollWidth, the full
  // text, exceeds clientWidth, the visible box), `fit` is the shrink factor script applied,
  // `fontPx` the resulting size. A pageP argument lets a second page reuse it.
  const readFit = (pageP) => (pageP || page).evaluate(() => {
    const v = document.getElementById('value');
    return {
      text: v.textContent,
      fontPx: parseFloat(getComputedStyle(v).fontSize),
      fit: parseFloat(v.style.getPropertyValue('--value-fit')) || 1,
      clipped: v.scrollWidth > v.clientWidth + 1,
    };
  });

  const base = { url: 'https://api.test/v1', pollSeconds: 5, bgStyle: 'solid' };

  // ---- R5 · no endpoint is a setup state -----------------------------------------
  await init({ pollSeconds: 5 });
  await wait(200);
  let s = await read();
  check('R5 with no URL the tile explains what to set, and is not a spinner',
    s.title === 'No endpoint set' && /settings/i.test(s.body) && !s.retry, s.title);

  // ---- R1 · JSON Pointer, then the dotted equivalent ------------------------------
  respond = () => ({ status: 200, body: JSON.stringify({ data: { temperature: 21.462, name: 'ok' } }) });
  await init(Object.assign({}, base, { jsonPointer: '/data/temperature', decimals: 1, unit: '°C' }));
  await wait(400);
  s = await read();
  check('R1 a JSON Pointer resolves the value and honours the decimal setting',
    s.value === '21.5' && !s.bodyHidden, s.value);
  await init(Object.assign({}, base, { jsonPointer: 'data.temperature', decimals: 2 }));
  await wait(400);
  s = await read();
  check('R1b the dotted path form resolves the same value',
    s.value === '21.46', s.value);

  // ---- R2 · thresholds, both directions -------------------------------------------
  respond = () => ({ status: 200, body: JSON.stringify({ v: 85 }) });
  await init(Object.assign({}, base, { jsonPointer: '/v', warn: '80', crit: '90' }));
  await wait(400);
  s = await read();
  check('R2 a value past warn (but under crit) colours warn', /\bwarn\b/.test(s.cls), s.cls);
  respond = () => ({ status: 200, body: JSON.stringify({ v: 95 }) });
  await init(Object.assign({}, base, { jsonPointer: '/v', warn: '80', crit: '90' }));
  await wait(400);
  check('R2b past crit colours crit', /\bcrit\b/.test((await read()).cls));
  respond = () => ({ status: 200, body: JSON.stringify({ v: 12 }) });
  await init(Object.assign({}, base, { jsonPointer: '/v', warn: '80', crit: '90' }));
  await wait(400);
  check('R2c a normal value stays uncoloured — only trouble pulls the eye',
    !/warn|crit/.test((await read()).cls));
  // crit BELOW warn reads as "lower is worse" (free space, battery) with no extra setting.
  await init(Object.assign({}, base, { jsonPointer: '/v', warn: '20', crit: '10' }));
  await wait(400);
  check('R2d crit below warn inverts the scale: 12 is warn, not normal',
    /\bwarn\b/.test((await read()).cls));
  respond = () => ({ status: 200, body: JSON.stringify({ v: 5 }) });
  await init(Object.assign({}, base, { jsonPointer: '/v', warn: '20', crit: '10' }));
  await wait(400);
  check('R2e and 5 is crit on that inverted scale', /\bcrit\b/.test((await read()).cls));

  // ---- R4 · the auth header reaches the wire, and stays off the screen -------------
  seen.length = 0;
  respond = () => ({ status: 200, body: JSON.stringify({ v: 1 }) });
  await init(Object.assign({}, base, {
    jsonPointer: '/v', headerName: 'Authorization', headerValue: TOKEN,
  }));
  await wait(400);
  const sent = seen[seen.length - 1];
  check('R4 the configured auth header is sent with the request',
    !!sent && sent.headers['authorization'] === TOKEN,
    sent ? JSON.stringify(sent.headers['authorization']) : '(no request)');
  s = await read();
  check('R4b the credential appears nowhere in the rendered tile',
    !s.text.includes('super-secret-probe-token'), s.text.replace(/\s+/g, ' ').slice(0, 80));
  const inDom = await page.evaluate(() => document.documentElement.outerHTML);
  check('R4c nor anywhere in the DOM', !inDom.includes('super-secret-probe-token'));
  // An unset secret must not produce an empty header — the request just goes without.
  seen.length = 0;
  await init(Object.assign({}, base, { jsonPointer: '/v', headerName: 'Authorization', headerValue: '' }));
  await wait(400);
  check('R4d an unset secret sends no auth header at all, rather than an empty one',
    seen.length > 0 && !('authorization' in seen[seen.length - 1].headers),
    JSON.stringify(Object.keys(seen[seen.length - 1] ? seen[seen.length - 1].headers : {})));

  // ---- R3 · non-2xx never leaves a blank tile --------------------------------------
  respond = () => ({ status: 503, body: 'nope', contentType: 'text/plain' });
  await init(Object.assign({}, base, { url: 'https://api.test/down', jsonPointer: '/v' }));
  await wait(500);
  s = await read();
  check('R3 a 503 with no prior reading shows an error card naming the status',
    /503/.test(s.title) && s.retry && !s.stateHidden, s.title);
  check('R3b the tile is never blank — something is always on screen',
    s.text.trim().length > 0, JSON.stringify(s.text.replace(/\s+/g, ' ').slice(0, 60)));
  respond = () => ({ abort: true });
  await init(Object.assign({}, base, { url: 'https://api.test/gone', jsonPointer: '/v' }));
  await wait(500);
  s = await read();
  check('R3c an outright fetch failure also renders a card with a Retry',
    /Could not reach/.test(s.title) && s.retry, s.title);

  // ---- R6 · stale keeps the last good value ----------------------------------------
  respond = () => ({ status: 200, body: JSON.stringify({ v: 42 }) });
  await init(Object.assign({}, base, { url: 'https://api.test/flaky', jsonPointer: '/v' }));
  await wait(400);
  check('R6 a good read shows the value', (await read()).value === '42');
  respond = () => ({ status: 500, body: '' });
  await page.click('#retry').catch(() => {});
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await wait(600);
  s = await read();
  check('R6b after the endpoint fails, the last value stays on screen, dimmed',
    s.value === '42' && s.stale && !s.bodyHidden, `${s.value} stale=${s.stale}`);
  check('R6c and the header pill says Stale rather than pretending it is live',
    s.pill === 'Stale', String(s.pill));

  // ---- R7 · null, pointer miss, non-scalar each name the fix -----------------------
  respond = () => ({ status: 200, body: JSON.stringify({ v: null }) });
  await init(Object.assign({}, base, { url: 'https://api.test/null', jsonPointer: '/v' }));
  await wait(400);
  s = await read();
  check('R7 a real null renders a placeholder, never a blank tile',
    (s.value === '--' && !s.bodyHidden) || !s.stateHidden, `${s.value} / ${s.title}`);
  respond = () => ({ status: 200, body: JSON.stringify({ a: 1 }) });
  await init(Object.assign({}, base, { url: 'https://api.test/miss', jsonPointer: '/nope/deep' }));
  await wait(400);
  s = await read();
  check('R7b a pointer miss names the path and offers NO retry (settings, not network)',
    /No value at that path/.test(s.title) && s.body.includes('/nope/deep') && !s.retry,
    s.title + ' | retry=' + s.retry);
  respond = () => ({ status: 200, body: JSON.stringify({ list: [1, 2, 3] }) });
  await init(Object.assign({}, base, { url: 'https://api.test/arr', jsonPointer: '/list' }));
  await wait(400);
  s = await read();
  check('R7c pointing at a list says so instead of stringifying it onto the panel',
    /not a single value/.test(s.title), s.title);
  respond = () => ({ status: 200, body: 'this is not json' });
  await init(Object.assign({}, base, { url: 'https://api.test/text', jsonPointer: '/v' }));
  await wait(400);
  check('R7d a non-JSON body is reported as such', /Not JSON/.test((await read()).title));

  // ---- R8 · a settings edit must not stack pollers ---------------------------------
  // The window has to span a real interval tick, or a regression that stacks timers
  // passes trivially: at pollSeconds 5, an assertion 3 s after the last init observes
  // nothing at all. Five stacked timers would produce five requests here, not one.
  respond = () => ({ status: 200, body: JSON.stringify({ v: 7 }) });
  await init(Object.assign({}, base, { url: 'https://api.test/count', jsonPointer: '/v', pollSeconds: 5 }));
  await wait(300);
  for (let i = 0; i < 4; i++) {
    await init(Object.assign({}, base, { url: 'https://api.test/count', jsonPointer: '/v', pollSeconds: 5, label: 'edit' + i }));
    await wait(120);
  }
  seen.length = 0;
  await wait(6500);   // one full 5 s period plus slack: exactly one timer must fire
  check('R8 repeated inits leave exactly ONE poller running across a full interval',
    seen.length === 1, `${seen.length} requests in 6.5s (expected 1)`);

  // ---- R10 · a failing endpoint backs off instead of hammering ----------------------
  // Same 6.5 s window, but every answer is a 503: the first retry waits 2x, the next
  // 4x, so a correctly backing-off tile makes far fewer requests than the fixed cadence.
  respond = () => ({ status: 503, body: '' });
  await init(Object.assign({}, base, { url: 'https://api.test/down503', jsonPointer: '/v', pollSeconds: 5 }));
  await wait(300);
  seen.length = 0;
  await wait(6500);
  check('R10 consecutive failures back the retry off rather than polling every 5s',
    seen.length === 0, `${seen.length} retries in 6.5s (backoff should push the first past 10s)`);
  // ...and an explicit Retry ignores the backoff, because the user just asked.
  respond = () => ({ status: 200, body: JSON.stringify({ v: 3 }) });
  seen.length = 0;
  await page.click('#retry');
  await wait(500);
  check('R10b tapping Retry polls immediately and clears the backoff',
    seen.length >= 1 && (await read()).value === '3', `${seen.length} request(s)`);

  // ---- R11 · the age label ADVANCES between polls -----------------------------------
  // Needs a controlled clock. The ticker runs every 30 s against a 24 h poll interval,
  // so real time cannot show the difference inside a test — and the previous version of
  // this probe fired `visibilitychange`, which starts a poll, so it re-rendered from a
  // fresh reading rather than exercising the ticker at all. It also only asserted that
  // both strings ended in "ago", which a permanently frozen "0s ago" satisfies.
  // Own page: a fake clock would break every real-time wait elsewhere in the suite.
  const clockPage = await browser.newPage({ viewport: { width: 640, height: 400 } });
  clockPage.on('pageerror', (e) => { failures++; console.log('[pageerror:clock]', String(e).slice(0, 300)); });
  await clockPage.clock.install();
  await prepare(clockPage);
  await clockPage.goto('https://widget.test/index.html');

  respond = () => ({ status: 200, body: JSON.stringify({ v: 1 }) });
  await clockPage.evaluate((s) => {
    window.postMessage({ type: 'ww-init', settings: s, sensors: [], media: null, theme: null,
      status: { elevated: false, apiVersion: 1 } }, '*');
  }, Object.assign({}, base, { url: 'https://api.test/aged', jsonPointer: '/v', pollSeconds: 86400 }));
  // Real time, not clock time: the fixture round-trip is genuine async work and the
  // fake clock does not advance while it happens.
  await wait(600);
  const ageAtStart = await clockPage.evaluate(() => document.getElementById('meta').textContent);
  seen.length = 0;
  // Past the 30 s ticker, but nowhere near the 24 h poll — so any change to the label
  // is the ticker's doing and nothing else's.
  await clockPage.clock.runFor(125000);
  const ageLater = await clockPage.evaluate(() => document.getElementById('meta').textContent);
  check('R11 the age label advances between polls, driven by its own ticker',
    /^0s ago/.test(ageAtStart) && /^2m ago/.test(ageLater), `${ageAtStart} -> ${ageLater}`);
  check('R11b and it advanced without issuing another request', seen.length === 0,
    `${seen.length} requests`);
  await clockPage.close();

  // ---- R12 · a hidden panel must not keep polling underneath the tile ---------------
  // A quiet tile with its next poll already armed: becoming hidden has to drop that
  // timer, not merely decline to arm the one after it. Getting this wrong is invisible by
  // definition — nobody is looking at a hidden panel — and shows up only as a tile that
  // spent the night asking a corporate endpoint for a number every five seconds, for
  // nobody. (The other ordering, where the poll is already OUT when the panel goes away,
  // is R12d.)
  respond = () => ({ status: 200, body: JSON.stringify({ v: 7 }) });
  await init(Object.assign({}, base, { url: 'https://api.test/paused', jsonPointer: '/v' }));
  await wait(700);                         // the opening poll has answered; the next is armed
  await setHidden(true);
  seen.length = 0;
  await wait(6500);                        // one full 5 s period plus slack
  check('R12 a widget paused by a hidden panel schedules no polls', seen.length === 0,
    `${seen.length} requests`);
  // The reading it already has stays up, and that is NOT what this guards: a tile that
  // fell back to a spinner for the whole pause, then a number when the panel returned,
  // would be worse than one request. What must not happen is the 5 s cadence
  // continuing underneath.
  check('R12b it still shows a value rather than spinning for the whole pause',
    (await read()).value === '7');

  await setHidden(false);
  await wait(600);
  check('R12c and polling resumes once the panel is visible again', seen.length > 0, `${seen.length} requests`);

  // ---- R12d · the hide that lands while a request is IN FLIGHT ----------------------
  // R12 hides the panel with nothing outstanding, so the pending timer is there to be
  // cleared and the chain stops. The hole is one step over: the poll is already out when
  // the panel goes away, so `visibilitychange` clears a timer that is ALREADY null — and
  // then the request resolves and its own `.then(schedule)` arms the next one. `poll()`
  // has no visibility guard of its own, so from there the tile polls a hidden panel
  // forever. The re-arm is the only place that can refuse, which is why the check lives
  // in `schedule()` and not only in the event handler.
  //
  // Deleting `document.hidden` from `schedule()` fails R12 as well, so this is not the
  // only witness to that line. It is here for the ordering R12 never builds: R12 hides a
  // quiet tile, and a "fix" that cleared the timer harder in the visibilitychange handler
  // would satisfy it while leaving this sequence — where there is no timer to clear —
  // exactly as broken.
  respond = () => ({ status: 200, body: JSON.stringify({ v: 3 }), delayMs: 1500 });
  await init(Object.assign({}, base, { url: 'https://api.test/inflight', jsonPointer: '/v' }));
  await wait(500);                         // the request is out and will not answer yet
  const inFlight = seen.length;
  check('R12d setup: a request is in flight when the panel goes away', inFlight > 0,
    `${inFlight} request(s)`);
  await setHidden(true);
  // Long enough for the held response to land (1.5 s) AND for the timer its resolution
  // would arm to fire (5 s). A shorter wait passes against the defect.
  await wait(7500);
  check('R12d a poll resolving after the panel hid does not re-arm the chain',
    seen.length === inFlight, `${seen.length - inFlight} request(s) after the panel hid`);
  respond = () => ({ status: 200, body: JSON.stringify({ v: 3 }) });
  await setHidden(false);
  await wait(700);
  check('R12e ...and the tile is not dead either — it polls when the panel returns',
    seen.length > inFlight, `${seen.length - inFlight} request(s)`);

  // ---- R22 · a response past the WW.fetch ceiling is NAMED, not reported as unreachable
  // The tile renders one number. An endpoint that answers with megabytes is answering —
  // the URL is right, the network is fine — so "could not reach the endpoint" would send
  // the user to check two things that are both working. WW.fetch refuses the body without
  // materialising it, and the tile has to say which failure this is.
  respond = () => ({ status: 200, contentType: 'application/json', body: 'x'.repeat(6 * 1024 * 1024) });
  await init(Object.assign({}, base, { url: 'https://api.test/huge', jsonPointer: '/v' }));
  await wait(2500);
  const huge = await read();
  check('R22 an oversized response says so, rather than blaming the URL or the network',
    /too large/i.test(huge.title), `${huge.title} — ${huge.body}`);
  check('R22b ...and it is offered as retryable, since the endpoint is answering',
    huge.retry === true, String(huge.retry));

  // R13c · and the ordinary case still reads. A ceiling that also refused normal bodies
  // would pass R13 while breaking every tile, which is the direction this has to be
  // checked in — the cap is new, and it sits in front of every widget's reads.
  respond = () => ({ status: 200, body: JSON.stringify({ v: 42 }) });
  await init(Object.assign({}, base, { url: 'https://api.test/small', jsonPointer: '/v' }));
  await wait(1500);
  const afterCap = await read();
  check('R22c a normal body still reads through the cap', afterCap.value === '42', afterCap.value);

  // ---- R23 · the SAME refusal from the host proxy tier reads the same way -----------
  // Which tier serves a call is the remote server's choice, not the widget's: a 403 or a
  // CORS failure escalates to the proxy, where the ceiling is enforced in C# and comes
  // back as a plain string. If only the browser tier's refusal were recognisable, this
  // tile would name the failure or blame the network depending on something the user
  // cannot see or influence — and the same target can flip between the two.
  // The ladder has TWO ways in, and each one used to swallow the refusal differently, so
  // both are driven — with the proxy-first memo set EXPLICITLY rather than inherited from
  // whichever earlier probe happened to fail, which is the difference between testing a
  // path and testing the order this file happens to be written in.
  respond = () => ({ abort: true });   // browser tier fails, so the call escalates
  await page.evaluate(() => {
    window.__probeHostError = 'response too large';
    sessionStorage.setItem('ww-proxy-first:https://api.test', '1');   // proxy-FIRST path
  });
  await init(Object.assign({}, base, { url: 'https://api.test/proxyhuge', jsonPointer: '/v' }));
  await wait(2500);
  const proxied = await read();
  check('R23 an oversize refusal from the proxy tier is named, not blamed on the network',
    /too large/i.test(proxied.title), `${proxied.title} — ${proxied.body}`);

  // R23b · the other way in: browser tier answers 403 (a bot wall), so the call escalates,
  // and the proxy gets past the wall only to find the body too large. Handing back the 403
  // — which is what "keep the original answer if the retry can't do better" did — points
  // the field at credentials for a resource whose only problem is its size.
  respond = () => ({ status: 403, body: 'blocked' });
  await page.evaluate(() => sessionStorage.removeItem('ww-proxy-first:https://api.test'));
  await init(Object.assign({}, base, { url: 'https://api.test/wallhuge', jsonPointer: '/v' }));
  await wait(2500);
  const walled = await read();
  check('R23b a size refusal behind a bot wall is named, not reported as the wall\'s 403',
    /too large/i.test(walled.title), `${walled.title} — ${walled.body}`);

  // R23c/d · the TYPE, at the shim, which is the contract the two probes above lean on.
  // Asserted here rather than through the tile because the tile tests the type AND the
  // message, so it goes on rendering the right state even when the type is wrong — a
  // rendering check cannot fail for a broken classifier alone, and one that cannot fail
  // for the thing it is named after is not guarding it. proxy:'always' takes the tier
  // directly, with no fallback in the way.
  const kinds = await page.evaluate(async () => {
    const one = async (hostError) => {
      window.__probeHostError = hostError;
      try { await WW.fetch('https://api.test/typed', { proxy: 'always' }); return 'resolved'; }
      catch (e) { return e.constructor.name; }
    };
    return { big: await one('response too large'), ordinary: await one('connection refused') };
  });
  check('R23c the proxy tier\'s size refusal rejects as a RangeError, like the browser tier\'s',
    kinds.big === 'RangeError', kinds.big);
  // The other direction: turning every host failure into a size refusal would pass R23,
  // R23b and R23c while telling the field to shrink a response that was never sent.
  check('R23d ...while an ordinary host failure stays a TypeError',
    kinds.ordinary === 'TypeError', kinds.ordinary);
  await page.evaluate(() => { window.__probeHostError = 'host offline in probe'; });

  // ---- R24/R25 · the wrapper WW.fetch returns has to BE a Response -------------------
  // Both of these live here rather than in bodycap-run.js because Node cannot express
  // either one: its Response re-wraps a body stream (so BYOB never reaches ours) and its
  // own getters accept a forwarding Proxy quite happily (so the brand check passes for the
  // bug). Chromium is the platform that ships, and it disagrees on both.
  respond = () => ({ status: 200, contentType: 'application/octet-stream', body: 'y'.repeat(4096) });
  const wrapper = await page.evaluate(async () => {
    const out = {};
    const race = (p, label) => Promise.race([
      p.then((v) => String(v), (e) => label + ' threw ' + e.constructor.name),
      new Promise((r) => setTimeout(() => r('HUNG'), 8000)),
    ]);
    // A native Response.body is a readable BYTE stream, so a widget may read into a buffer
    // of its own. An ordinary ReadableStream refuses that reader outright, and a byte stream
    // that answers the request with enqueue() never settles the read at all — the second is
    // worse, and is what the obvious fix does.
    out.byob = await race((async () => {
      const r = await WW.fetch('https://api.test/byob', { proxy: 'never' });
      const reader = r.body.getReader({ mode: 'byob' });
      let n = 0;
      for (;;) {
        const { done, value } = await reader.read(new Uint8Array(1024));
        if (done) break;
        n += value.byteLength;
      }
      return n;
    })(), 'byob');
    // ...and the brand check. Every other platform API unwraps its arguments to the real
    // object, which no amount of faithful property forwarding can supply: cache.put rejects
    // a Proxy outright, for a value WIDGET-SPEC promises is a Response.
    out.cachePut = await race((async () => {
      const cache = await caches.open('ww-probe');
      await cache.put(new Request('https://api.test/cached'),
        await WW.fetch('https://api.test/tocache', { proxy: 'never' }));
      const back = await cache.match('https://api.test/cached');
      return (await back.arrayBuffer()).byteLength;
    })(), 'cachePut');
    return out;
  });
  check('R24 the wrapped body accepts a BYOB reader, as a native one does',
    wrapper.byob === '4096', wrapper.byob);
  check('R25 the wrapper passes the brand check other platform APIs perform on a Response',
    wrapper.cachePut === '4096', wrapper.cachePut);

  // ---- R13 · a Critical threshold works on its own ---------------------------------
  // The manifest offers Warn and Critical independently and marks neither required, so
  // "Critical at 90" with no Warn has to colour — not silently disable colouring.
  respond = () => ({ status: 200, body: JSON.stringify({ v: 96 }) });
  await init({ url: 'https://api.test/critonly', jsonPointer: '/v', crit: '90', pollSeconds: 60 });
  await wait(500);
  check('R13 a Critical threshold with no Warn still colours the value',
    /\bcrit\b/.test((await read()).cls), (await read()).cls);
  respond = () => ({ status: 200, body: JSON.stringify({ v: 12 }) });
  await init({ url: 'https://api.test/critonly2', jsonPointer: '/v', crit: '90', pollSeconds: 60 });
  await wait(500);
  check('R13b and a value under it stays uncoloured', !/\b(crit|warn)\b/.test((await read()).cls));

  // ---- R14 · backoff may only ever SLOW the tile down -------------------------------
  // Capping the total rather than the extra inverts the feature above 600 s: a daily
  // tile would answer one failure by polling every ten minutes.
  const delays = await page.evaluate(() => {
    const out = [];
    for (const [seconds, fails] of [[86400, 1], [86400, 6], [700, 1], [5, 1], [5, 6]]) {
      cfg.pollSeconds = seconds;
      failures = fails;
      out.push({ seconds: seconds, fails: fails, base: seconds * 1000, delay: nextDelayMs() });
    }
    failures = 0;
    return out;
  });
  check('R14 backoff never schedules sooner than the configured interval',
    delays.every((d) => d.delay >= d.base),
    delays.map((d) => `${d.seconds}s/${d.fails}f=${Math.round(d.delay / 1000)}s`).join(' '));
  check('R14b and it still grows on a short interval rather than doing nothing',
    delays[3].delay === 10000 && delays[4].delay === 320000);

  // ---- R15 · retargeting mid-flight must not paint the OLD endpoint's answer --------
  // The in-flight request outlives the settings change; when it lands, cfg already
  // describes a different source, so its payload would be read with the new pointer.
  respond = (url) => /slowsrc/.test(url)
    ? { status: 200, body: JSON.stringify({ old: 111 }), delayMs: 2000 }
    : { status: 200, body: JSON.stringify({ fresh: 222 }) };
  await init({ url: 'https://api.test/slowsrc', jsonPointer: '/old', pollSeconds: 60 });
  await wait(400);                       // request is out, nothing back yet
  await init({ url: 'https://api.test/newsrc', jsonPointer: '/fresh', pollSeconds: 60 });
  await wait(3000);                      // long enough for the OLD request to land too
  const after = await read();
  check('R15 the tile shows the new source, not the answer to the retired request',
    after.value === '222', after.value);
  check('R15b and the retired request did not leave the tile stuck loading',
    after.stateHidden === true && after.bodyHidden === false);

  // ---- R16 · a 2xx clears the backoff even if the BODY is unusable ------------------
  // Removing the failure increment from the non-JSON branch was not enough: that branch
  // returns early, so a reset placed after the parse never ran and the tile kept
  // retrying on the cadence earned by the earlier outage.
  respond = () => ({ status: 503, body: 'down' });
  await init({ url: 'https://api.test/recover', jsonPointer: '/v', pollSeconds: 5 });
  await wait(600);
  const failedCount = await page.evaluate(() => failures);
  respond = () => ({ status: 200, contentType: 'text/html', body: '<html>maintenance</html>' });
  // NOT the Retry button: its handler zeroes `failures` itself, so driving the probe
  // that way passes against the unfixed code and proves nothing. Trigger an ordinary
  // poll through the visibility path, which touches no counters of its own.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await wait(600);
  const afterNonJson = await page.evaluate(() => failures);
  check('R16 a 200 with an unusable body still clears the failure backoff',
    failedCount > 0 && afterNonJson === 0, `${failedCount} -> ${afterNonJson}`);

  // ---- R17 · retargeting clears the footer, not just the timestamp ------------------
  // The setup and error cards both leave the footer visible, so a stale "4m ago ·
  // unreachable" would sit under them describing an endpoint the tile no longer uses.
  respond = () => ({ status: 200, body: JSON.stringify({ v: 5 }) });
  await init({ url: 'https://api.test/hadvalue', jsonPointer: '/v', pollSeconds: 60 });
  await wait(500);
  const footerBefore = await page.evaluate(() => document.getElementById('meta').textContent);
  await init({ url: '', jsonPointer: '/v', pollSeconds: 60 });     // endpoint removed
  await wait(300);
  const footerAfter = await page.evaluate(() => document.getElementById('meta').textContent);
  check('R17 removing the endpoint clears the age footer belonging to the old source',
    /ago/.test(footerBefore) && footerAfter === '', `"${footerBefore}" -> "${footerAfter}"`);

  // ---- R18 · a presentation-only edit must not fake freshness -----------------------
  // Renaming a tile is not a reading. Re-running showValue on the cached number stamps
  // lastAt = now and drops the Stale pill, so an hour-old survivor of a dead endpoint
  // would redraw as a live "0s ago" because the user changed its title.
  respond = () => ({ status: 200, body: JSON.stringify({ v: 77 }) });
  await init({ url: 'https://api.test/fresh', jsonPointer: '/v', pollSeconds: 60, label: 'Before' });
  await wait(500);
  respond = () => ({ status: 500, body: '' });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await wait(600);
  const wentStale = await read();
  // Age the reading so a reset to "now" is unmistakable, then edit the label only.
  await page.evaluate(() => { lastAt -= 300000; renderMeta(); });
  const agedLabel = await page.evaluate(() => document.getElementById('meta').textContent);
  // Stall the poll that the re-init kicks off. Without this it lands before the
  // assertions and repaints the Stale pill itself, so the pill checks below pass
  // against the unfixed code and prove nothing — only the timestamp discriminates.
  // With the endpoint hanging, what we read is exactly what the re-init rendered.
  respond = () => ({ status: 500, body: '', delayMs: 5000 });
  await init({ url: 'https://api.test/fresh', jsonPointer: '/v', pollSeconds: 60, label: 'After' });
  await wait(300);
  const afterEdit = await read();
  const afterLabel = await page.evaluate(() => document.getElementById('meta').textContent);
  check('R18 a label-only edit keeps the Stale pill rather than passing old data off as live',
    wentStale.pill === 'Stale' && afterEdit.pill === 'Stale' && afterEdit.stale === true,
    `${wentStale.pill} -> ${afterEdit.pill} stale=${afterEdit.stale}`);
  check('R18b and it does not reset the age to "0s ago"',
    /5m ago/.test(agedLabel) && /5m ago/.test(afterLabel), `${agedLabel} -> ${afterLabel}`);
  check('R18c the failure reason survives the edit too', /unreachable|HTTP/.test(afterLabel), afterLabel);

  // ---- R19 · the resume path re-reads the reason it was paused for ------------------
  // `visibilitychange` fires for the panel going away as well as coming back, and both
  // enter the same resume path. A resume that polls before re-reading document.hidden
  // fires a request for a panel nobody can see — quiet afterwards, because schedule()
  // then declines to arm anything, but the request has already gone.
  respond = () => ({ status: 200, body: JSON.stringify({ v: 9 }) });
  await init({ url: 'https://api.test/stillhidden', jsonPointer: '/v', pollSeconds: 60 });
  await wait(600);
  seen.length = 0;
  await setHidden(true);                                                    // the real hide
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));  // ...and a second event, still hidden
  await wait(600);
  check('R19 a visibility change that arrives while the panel is still hidden issues no request',
    seen.length === 0, `${seen.length} requests`);
  await setHidden(false);
  await wait(600);
  check('R19b and once the panel is visible again, polling resumes normally',
    seen.length > 0, `${seen.length} requests`);

  // ---- R20 · JSON Pointer tokens keep their whitespace ------------------------------
  // RFC 6901 is literal after the first '/', so `/temperature ` selects "temperature ".
  // Trimming the setting resolved the wrong key — and in a payload holding both spellings
  // it reads the wrong NUMBER, which is worse than a visible miss.
  respond = () => ({ status: 200, body: JSON.stringify({ 'temperature ': 11, temperature: 99 }) });
  await init({ url: 'https://api.test/ws1', jsonPointer: '/temperature ', pollSeconds: 60 });
  await wait(500);
  check('R20 a pointer token keeps its trailing space and selects the right key',
    (await read()).value === '11', (await read()).value);
  await init({ url: 'https://api.test/ws2', jsonPointer: '/temperature', pollSeconds: 60 });
  await wait(500);
  check('R20b and the space-free spelling still selects the other one',
    (await read()).value === '99', (await read()).value);
  // Leading whitespace is never part of either syntax — and stripping it is what picks
  // the RFC branch, so a pasted " /a" must not fall through to the dotted parser.
  respond = () => ({ status: 200, body: JSON.stringify({ a: 5 }) });
  await init({ url: 'https://api.test/ws3', jsonPointer: '  /a', pollSeconds: 60 });
  await wait(500);
  check('R20c a pasted pointer with leading spaces still resolves',
    (await read()).value === '5', (await read()).value);

  // ---- R21 · a cold load while hidden fetches nothing --------------------------------
  // The shell answers ww-ready whether or not the WebView is visible, so an unconditional
  // opening poll costs one request per cold start or reload while minimised.
  const hiddenPage = await browser.newPage({ viewport: { width: 640, height: 400 } });
  hiddenPage.on('pageerror', (e) => { failures++; console.log('[pageerror:hidden]', String(e).slice(0, 300)); });
  await prepare(hiddenPage);
  // Hidden before the widget script runs, so init sees a hidden document. prepare() has
  // already installed the property; this only decides what it reads on this page.
  await hiddenPage.addInitScript(() => { window.__hidden = true; });
  await hiddenPage.goto('https://widget.test/index.html');
  respond = () => ({ status: 200, body: JSON.stringify({ v: 4 }) });
  seen.length = 0;
  await hiddenPage.evaluate((s) => {
    window.postMessage({ type: 'ww-init', settings: s, sensors: [], media: null, theme: null,
      status: { elevated: false, apiVersion: 1 } }, '*');
  }, { url: 'https://api.test/hidden', jsonPointer: '/v', pollSeconds: 60, bgStyle: 'solid' });
  await wait(800);
  check('R21 a widget initialised while the panel is hidden issues no request',
    seen.length === 0, `${seen.length} requests`);
  // ...and the deferral is not a permanent stall: becoming visible fetches immediately.
  await hiddenPage.evaluate(() => { window.__hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
  await wait(800);
  check('R21b and it fetches as soon as the panel becomes visible',
    seen.length === 1, `${seen.length} requests`);
  check('R21c painting the value it just fetched',
    (await hiddenPage.evaluate(() => document.getElementById('value').textContent)) === '4');
  await hiddenPage.close();

  // ---- RF · #173: a long value shrinks to fit instead of clipping to an ellipsis ----
  // The reported bug: a value that is merely LONG (not tall) was clipped — 2841230…, so the
  // digits carrying the magnitude vanished, and 2841230…/2841230000/2841230000000 all read
  // the same. The tile takes strings too, so `degraded_performance` clipped the same way. The
  // fix shrinks the font until the whole value fits, keeping the ellipsis only for the
  // pathological case at the floor.
  //
  // Note on the cases chosen: this harness substitutes a narrower system font for the panel's
  // Outfit (the .woff2 is served but the exact metrics differ), so the shrink THRESHOLD moves
  // between here and the device. The cases below overflow in any sans — the issue's own string
  // example on a half slot, and its ten-digit number on the tighter quarter — so what is
  // asserted is the font-independent BEHAVIOUR (shrink-to-fit, floor, relax), not a pixel size.
  await page.setViewportSize({ width: 640, height: 400 });
  respond = () => ({ status: 200, body: JSON.stringify({ v: 'degraded_performance' }) });
  await init(Object.assign({}, base, { url: 'https://api.test/statusstr', jsonPointer: '/v', pollSeconds: 60 }));
  await wait(400);
  const longStr = await readFit();
  check('RF1 a long value renders in full, not clipped to an ellipsis',
    longStr.text === 'degraded_performance' && !longStr.clipped,
    `"${longStr.text}" clipped=${longStr.clipped}`);
  check('RF1b ...and it got there by shrinking the font (fit below 1, above the floor)',
    longStr.fit < 1 && longStr.fit > 0.45, `--value-fit ${longStr.fit}, ${Math.round(longStr.fontPx)}px`);

  // The issue's number example, on the quarter slot where a ten-digit value is tight: the
  // whole magnitude stays on screen instead of "2841230…".
  await page.setViewportSize({ width: 320, height: 400 });
  respond = () => ({ status: 200, body: JSON.stringify({ v: 2841230000 }) });
  await init(Object.assign({}, base, { url: 'https://api.test/wowtoken', jsonPointer: '/v', pollSeconds: 60 }));
  await wait(400);
  const num = await readFit();
  check('RF1c the ten-digit number keeps every digit rather than clipping the magnitude away',
    num.text === '2841230000' && !num.clipped && num.fit < 1,
    `"${num.text}" clipped=${num.clipped} fit=${num.fit}`);

  // A value that already fits is left at the clamp size — the fit only engages on overflow,
  // so an ordinary reading is not quietly shrunk, and stays LARGER than one that had to.
  await page.setViewportSize({ width: 640, height: 400 });
  respond = () => ({ status: 200, body: JSON.stringify({ v: 21.4 }) });
  await init(Object.assign({}, base, { url: 'https://api.test/short173', jsonPointer: '/v', pollSeconds: 60 }));
  await wait(400);
  const shortV = await readFit();
  check('RF2 a value that already fits keeps the clamp size (fit stays 1, no shrink)',
    shortV.fit === 1 && !shortV.clipped, `--value-fit ${shortV.fit}, "${shortV.text}"`);
  check('RF2b the short value is rendered LARGER than the long one it did not have to shrink',
    shortV.fontPx > longStr.fontPx + 1, `${Math.round(shortV.fontPx)}px vs ${Math.round(longStr.fontPx)}px`);

  // The floor: a value too long even at the smallest the fit allows stops shrinking and
  // lets the ellipsis take over — better a readable prefix than an unreadably tiny whole.
  await page.setViewportSize({ width: 320, height: 400 });
  respond = () => ({ status: 200, body: JSON.stringify({ v: 'degraded_performance_across_every_region_right_now' }) });
  await init(Object.assign({}, base, { url: 'https://api.test/long173', jsonPointer: '/v', pollSeconds: 60 }));
  await wait(400);
  const floorCase = await readFit();
  check('RF3 a value too long even at the floor stops at the floor and lets the ellipsis take over',
    Math.abs(floorCase.fit - 0.45) < 0.02 && floorCase.clipped,
    `--value-fit ${floorCase.fit}, clipped=${floorCase.clipped}`);

  // Resize re-fits: the long value cramped on a narrow slot has room on a wide one, so the
  // fit relaxes when the slot grows under a running tile — the ResizeObserver path, no edit.
  respond = () => ({ status: 200, body: JSON.stringify({ v: 'degraded_performance' }) });
  await page.setViewportSize({ width: 320, height: 400 });
  await init(Object.assign({}, base, { url: 'https://api.test/relax', jsonPointer: '/v', pollSeconds: 60 }));
  await wait(400);
  const atQuarter = await readFit();
  await page.setViewportSize({ width: 1280, height: 400 });
  await wait(500);
  const atFull = await readFit();
  check('RF4 widening the slot relaxes the fit (ResizeObserver re-measures, no settings edit)',
    atFull.fit > atQuarter.fit && !atFull.clipped,
    `quarter fit ${atQuarter.fit} -> full fit ${atFull.fit}`);

  // ---- RT · #176.1: an unsupported token type HALTS polling, not buys tokens forever ----
  // OAuth2 client-credentials exchanges go through the proxy tier (proxy:'always'), which the
  // harness answers above. Arm a token endpoint issuing a DPoP token — a type this tile cannot
  // present — at the 5s floor: the pre-fix widget performs a fresh, SUCCESSFUL grant on every
  // poll and discards it on type, twelve a minute forever behind a card that says it is not
  // retrying. The fix stops the schedule until the auth settings change.
  await page.evaluate(() => { window.__grants = 0; window.__tokenEndpoint = 'https://api.test/tok';
    window.__tokenResp = { access_token: 'dpop-token', token_type: 'DPoP', expires_in: 3600 }; });
  respond = () => ({ status: 200, body: JSON.stringify({ v: 1 }) });
  await init(Object.assign({}, base, { url: 'https://api.test/oauthdata', jsonPointer: '/v', pollSeconds: 5,
    authMode: 'oauth2', tokenEndpoint: 'https://api.test/tok', clientId: 'id', clientSecret: 'sec' }));
  await wait(800);
  const rtCard = await read();
  const grantsFirst = await page.evaluate(() => window.__grants);
  check('RT setup: a non-Bearer token type shows the unsupported-token card',
    /Unsupported token type/.test(rtCard.title), rtCard.title);
  check('RT1 the first poll exchanges exactly once', grantsFirst === 1, `${grantsFirst} grants`);
  // Two more poll intervals at the 5s floor — a halted tile grants nothing further.
  await wait(11500);
  const grantsLater = await page.evaluate(() => window.__grants);
  check('RT2 a halted tile stops granting rather than buying a token every interval',
    grantsLater === grantsFirst, `${grantsLater} grants after ~2 more 5s intervals`);
  // Corrected auth — a new token endpoint issuing Bearer — lifts the halt and the tile reads.
  await page.evaluate(() => { window.__tokenEndpoint = 'https://api.test/tok2';
    window.__tokenResp = { access_token: 'bearer-token', token_type: 'Bearer', expires_in: 3600 }; });
  await init(Object.assign({}, base, { url: 'https://api.test/oauthdata', jsonPointer: '/v', pollSeconds: 5,
    authMode: 'oauth2', tokenEndpoint: 'https://api.test/tok2', clientId: 'id', clientSecret: 'sec' }));
  await wait(800);
  const rtResumed = await read();
  check('RT3 corrected auth settings lift the halt and the tile reads again',
    rtResumed.value === '1' && !rtResumed.bodyHidden, `${rtResumed.value} / ${rtResumed.title}`);
  await page.evaluate(() => { window.__tokenEndpoint = undefined; });   // clear for anything after

  // ---- populated screenshots (the eyes, not just the contract) ---------------------
  respond = () => ({ status: 200, body: JSON.stringify({ data: { temperature: 87.3 } }) });
  for (const [w, h, name] of [[320, 400, 'quarter'], [640, 400, 'half'], [640, 200, 'half-upper']]) {
    await page.setViewportSize({ width: w, height: h });
    await init({ url: 'https://api.test/shot', jsonPointer: '/data/temperature', label: 'Reactor core',
      unit: '°C', decimals: 1, warn: '80', crit: '95', pollSeconds: 60, bgStyle: 'solid' });
    await wait(400);
    await page.screenshot({ path: path.join(__dirname, 'restvalue-' + name + '.png') });
  }
  check('R9 populated screenshots captured for quarter / half / half-upper', true);

  await browser.close();
  console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
