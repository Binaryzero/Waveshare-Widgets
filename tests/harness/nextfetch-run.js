#!/usr/bin/env node
// Next Event — three scheduling/rendering follow-ups from #180. All three are timing bugs
// that a real-time probe kept missing (the fix window is minutes wide at the 5-minute floor),
// so this drives the widget under Playwright's FAKE CLOCK: `page.clock` makes the refresh
// timer, the 1 Hz repaint, and Date.now() all advance on command, so the window a scheduled
// fetch has to fall inside is placed exactly rather than guessed.
//
//   N1 · a source change while PAUSED must leave the next fetch due NOW, so the resume path
//        fetches the new calendar at once instead of re-arming the OLD calendar's deadline
//   N2 · an error card over an empty-but-valid calendar must survive the 1 Hz repaint, not be
//        overwritten by "Nothing scheduled" (which hides the outage and removes Retry)
//   N3 · a cadence change during a backoff must NOT fire an immediate fetch — the backoff is
//        anchored on the last ATTEMPT, not the last success
//
// Each case is falsified against the pre-fix widget (stash the change, or checkout the file)
// before it is trusted: N1/N2/N3 all pass green there without the fix would be a hollow suite.
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const SHELL = path.join(REPO, 'src', 'Plinth', 'Shell');
const WIDGET = path.join(REPO, 'widgets', 'nextevent');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };

const EMPTY_ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//probe//EN\r\nEND:VCALENDAR\r\n';

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
const settle = (p) => p.waitForTimeout(250);   // real time — lets a routed fetch resolve

(async () => {
  const { chromium } = loadPlaywright();
  const shim = fs.readFileSync(path.join(SHELL, 'widget-api.js'), 'utf8');
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  page.on('pageerror', (e) => { failures++; console.log('[pageerror]', String(e).slice(0, 300)); });

  // A fixed epoch so the fake clock and any Date math are reproducible.
  await page.clock.install({ time: new Date('2026-06-01T12:00:00Z') });

  // What each ICS url answers, rescriptable per step, plus a request ledger.
  const responders = new Map();   // pathname -> () => ({ status, body })
  const hits = [];                // { url, at } for every calendar request the widget made
  const setCal = (name, fn) => responders.set('/' + name, fn);
  const hitsTo = (name) => hits.filter((h) => h.url.includes('/' + name));

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
  await page.route('https://cal.test/**', (route) => {
    const u = new URL(route.request().url());
    hits.push({ url: u.pathname, at: Date.now() });
    const r = (responders.get(u.pathname) || (() => ({ status: 200, body: EMPTY_ICS })))();
    return route.fulfill({ status: r.status, contentType: r.contentType || 'text/calendar', body: r.body });
  });
  await page.route(/https?:\/\/(?!app\.plinth|widget\.test|cal\.test).*/, (route) => route.abort());

  await page.addInitScript(shim);
  // document.hidden, backed by a flag the probe flips — Playwright cannot hide a page on demand.
  await page.addInitScript(() => {
    if (window.__hidden === undefined) window.__hidden = false;
    Object.defineProperty(document, 'hidden', { get: () => window.__hidden === true, configurable: true });
    Object.defineProperty(document, 'visibilityState',
      { get: () => (window.__hidden === true ? 'hidden' : 'visible'), configurable: true });
  });
  // WW.fetch escalates to the host proxy on a network failure; without a host answering, that
  // promise never settles. These tests fail via HTTP status (res.ok=false), which does not
  // escalate — but answer the proxy channel too, so a stray escalation cannot hang the run.
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
  const setHidden = (h) => page.evaluate((v) => {
    window.__hidden = v;
    document.dispatchEvent(new Event('visibilitychange'));
  }, h);
  const stateText = () => page.evaluate(() => ({
    title: (document.querySelector('.state-title') || {}).textContent || '',
    hasRetry: !![...document.querySelectorAll('button')].find((b) => b.textContent === 'Retry'),
    stateHidden: document.getElementById('state').hidden,
  }));
  // Advance the widget's own timers/clock by `ms`, then give any fetch it kicked off real time
  // to resolve. `page.clock.runFor` fires setTimeout/setInterval and moves Date.now().
  const advance = async (ms) => { await page.clock.runFor(ms); await settle(page); };

  const MIN = 60000;

  // ---- N1 · a paused source change leaves the next fetch due now ------------------------
  setCal('a.ics', () => ({ status: 200, body: EMPTY_ICS }));
  setCal('b.ics', () => ({ status: 200, body: EMPTY_ICS }));
  await init({ icsUrl: 'https://cal.test/a.ics', refreshMinutes: 30, bgStyle: 'solid' });
  await settle(page);
  check('N1 setup: calendar A is fetched on init', hitsTo('a.ics').length === 1, `${hitsTo('a.ics').length} A hits`);

  await setHidden(true);                       // panel hidden (a game, a blanked screen)
  const bBefore = hitsTo('b.ics').length;
  await init({ icsUrl: 'https://cal.test/b.ics', refreshMinutes: 30, bgStyle: 'solid' });   // NEW calendar, while paused
  await settle(page);
  check('N1a a source change while paused fetches nothing yet (the pause gate holds)',
    hitsTo('b.ics').length === bBefore, `${hitsTo('b.ics').length - bBefore} B hits while paused`);
  await setHidden(false);                      // resume
  await settle(page);
  check('N1b on resume the NEW calendar is fetched at once, not the old deadline re-armed',
    hitsTo('b.ics').length === bBefore + 1, `${hitsTo('b.ics').length - bBefore} B hits after resume`);

  // N1c · a CADENCE-ONLY edit that arrives while STILL paused, after a source change, must not
  // overwrite the "due now" the source change set. The cadence recompute anchors on `lastTry`;
  // if that still points at the OLD calendar's attempt, it re-derives a future deadline and the
  // new calendar stays on its spinner past resume (Codex review). Reset `lastTry` with the rest
  // of the source-specific state, and keep an un-attempted source due now.
  setCal('e1.ics', () => ({ status: 200, body: EMPTY_ICS }));
  setCal('e2.ics', () => ({ status: 200, body: EMPTY_ICS }));
  await init({ icsUrl: 'https://cal.test/e1.ics', refreshMinutes: 30, bgStyle: 'solid' });   // settle on e1
  await settle(page);
  await setHidden(true);
  await init({ icsUrl: 'https://cal.test/e2.ics', refreshMinutes: 30, bgStyle: 'solid' });   // source change, paused
  await settle(page);
  const e2Before = hitsTo('e2.ics').length;
  await init({ icsUrl: 'https://cal.test/e2.ics', refreshMinutes: 45, bgStyle: 'solid' });    // cadence-only, STILL paused
  await settle(page);
  await setHidden(false);                      // resume
  await settle(page);
  check('N1c a cadence edit while paused does not strand a just-changed source past resume',
    hitsTo('e2.ics').length === e2Before + 1, `${hitsTo('e2.ics').length - e2Before} e2 hits after resume`);

  // ---- N2 · an error card over an empty calendar survives the 1 Hz repaint --------------
  setCal('c.ics', () => ({ status: 200, body: EMPTY_ICS }));
  await init({ icsUrl: 'https://cal.test/c.ics', refreshMinutes: 5, bgStyle: 'solid' });
  await settle(page);
  const emptyState = await stateText();
  check('N2 setup: an empty-but-valid calendar shows "Nothing scheduled"',
    /Nothing scheduled/.test(emptyState.title), emptyState.title);
  // Next refresh fails. Advance past the 5-minute cadence to fire the scheduled load.
  setCal('c.ics', () => ({ status: 503, body: 'down' }));
  await advance(5 * MIN + 1000);
  const errState = await stateText();
  check('N2a a failed refresh on the empty calendar raises an error card with Retry',
    /unavailable/i.test(errState.title) && errState.hasRetry, `${errState.title} retry=${errState.hasRetry}`);
  // Let the 1 Hz repaint run several times — this is where it was overwritten.
  await page.clock.runFor(4000);
  const afterTicks = await stateText();
  check('N2b the error card and its Retry survive the 1 Hz repaint (not replaced by "Nothing scheduled")',
    /unavailable/i.test(afterTicks.title) && afterTicks.hasRetry, `${afterTicks.title} retry=${afterTicks.hasRetry}`);
  // ...and a successful refresh clears it back to the empty state, so the guard is not sticky.
  setCal('c.ics', () => ({ status: 200, body: EMPTY_ICS }));
  await advance(10 * MIN + 1000);              // past the backoff for the single failure
  await page.clock.runFor(1500);
  const recovered = await stateText();
  check('N2c a good refresh clears the error card back to "Nothing scheduled"',
    /Nothing scheduled/.test(recovered.title), recovered.title);

  // ---- N3 · a cadence change during a backoff does not fire an immediate fetch ----------
  // Reproduces the review's example: success, then a failure well after it, then a cadence
  // edit — the pre-fix anchor (last SUCCESS) lands in the past and fetches now; the fix
  // anchors on the last ATTEMPT and keeps the backoff.
  setCal('d.ics', () => ({ status: 200, body: EMPTY_ICS }));
  await init({ icsUrl: 'https://cal.test/d.ics', refreshMinutes: 30, bgStyle: 'solid' });
  await settle(page);
  check('N3 setup: calendar D fetched, cadence 30m', hitsTo('d.ics').length === 1, `${hitsTo('d.ics').length} D hits`);
  // 30 minutes on: the scheduled refresh fires and FAILS, arming a backoff.
  setCal('d.ics', () => ({ status: 503, body: 'down' }));
  await advance(30 * MIN + 1000);
  const dAfterFail = hitsTo('d.ics').length;
  check('N3a the 30m refresh fired and failed (backoff now armed)', dAfterFail === 2, `${dAfterFail} D hits`);
  // One minute into the backoff, change the cadence. The pre-fix anchor (last success, ~31m
  // ago) + the 10m backoff is far in the past -> immediate fetch. The fix anchors on the
  // failed attempt (~1m ago) -> still ~9m out -> no fetch now.
  await advance(1 * MIN);
  const dBeforeEdit = hitsTo('d.ics').length;
  await init({ icsUrl: 'https://cal.test/d.ics', refreshMinutes: 5, bgStyle: 'solid' });   // same URL, new cadence
  await settle(page);
  check('N3b a cadence change during the backoff does NOT fire an immediate fetch',
    hitsTo('d.ics').length === dBeforeEdit, `${hitsTo('d.ics').length - dBeforeEdit} D hits right after the cadence edit`);

  await browser.close();
  console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})();
