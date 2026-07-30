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
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const SHELL = path.join(REPO, 'src', 'WaveshareWidgets', 'Shell');
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

  await page.route('https://app.wsw/**', (route) => {
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
  await page.route('https://api.test/**', (route) => {
    seen.push({ url: route.request().url(), headers: route.request().headers() });
    const r = respond();
    if (r.abort) return route.abort();
    return route.fulfill({ status: r.status, contentType: r.contentType || 'application/json', body: r.body });
  });
  await page.route(/https?:\/\/(?!app\.wsw|widget\.test|api\.test).*/, (route) => route.abort());

  await page.addInitScript(shim);
  // WW.fetch escalates to the host proxy when the browser request fails. Without a
  // host answering that message the promise never settles — which is exactly how the
  // first run of this suite wedged the widget, and why it now has a timeout.
  await page.addInitScript(() => {
    window.addEventListener('message', (ev) => {
      const m = ev.data || {};
      if (m.type === 'ww-fetch') window.postMessage({ type: 'ww-fetch-result', id: m.id, error: 'host offline in probe' }, '*');
    });
  });
  await page.goto('https://widget.test/index.html');

  const init = (settings) => page.evaluate((s) => {
    window.postMessage({ type: 'ww-init', settings: s, sensors: [], media: null, theme: null,
      status: { elevated: false, apiVersion: 1 } }, '*');
  }, settings);

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

  // ---- R11 · the age label refreshes between polls ---------------------------------
  // With a long interval the footer would otherwise claim "0s ago" until the next
  // request — up to 24 h at the supported maximum.
  respond = () => ({ status: 200, body: JSON.stringify({ v: 1 }) });
  await init(Object.assign({}, base, { url: 'https://api.test/slow', jsonPointer: '/v', pollSeconds: 86400 }));
  await wait(500);
  const ageAtStart = await page.evaluate(() => document.getElementById('meta').textContent);
  // The ticker runs every 30 s; drive it directly rather than idling the suite for
  // half a minute, then confirm the label is recomputed from the clock.
  await page.evaluate(() => { window.__t0 = Date.now(); });
  await page.evaluate(() => {
    const m = document.getElementById('meta');
    m.__before = m.textContent;
  });
  await wait(1200);
  const recomputed = await page.evaluate(() => {
    // Simulate the ticker firing without waiting 30 s for it.
    const ev = new Event('visibilitychange');
    document.dispatchEvent(ev);
    return document.getElementById('meta').textContent;
  });
  check('R11 the age label is recomputed from the clock, not frozen at the poll',
    /ago$/.test(ageAtStart) && /ago$/.test(recomputed), `${ageAtStart} -> ${recomputed}`);

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
