#!/usr/bin/env node
// Scratch probe for the KEV round-2 findings the data-path runner cannot reach: a stalled
// connection, a visibility change, and a poisoned cache. Same frame topology as the real
// runner (shell page owns the widget in an iframe) plus a request counter and a shell that
// re-sends ww-init on every ww-ready, so a frame reload keeps working.
//
//   node kev-round2.js <widget-folder> stall|visibility|badcache
'use strict';
const fs = require('fs');
const path = require('path');
const SHELL = '/home/user/Waveshare-Widgets/src/WaveshareWidgets/Shell';
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };

const folder = process.argv[2];
const mode = process.argv[3];

function loadPlaywright() {
  for (const c of ['playwright', '/opt/node22/lib/node_modules/playwright',
    path.join(process.env.HOME || '', 'node_modules/playwright')]) {
    try { return require(c); } catch (e) { /* next */ }
  }
  throw new Error('playwright not found');
}

(async () => {
  const { chromium } = loadPlaywright();
  const shim = fs.readFileSync(path.join(SHELL, 'widget-api.js'), 'utf8') + '\n'
             + fs.readFileSync(path.join(SHELL, 'icue-compat.js'), 'utf8');
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });

  await page.route('https://app.wsw/**', (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\/+/, '');
    const file = path.resolve(SHELL, rel);
    if (file.startsWith(path.resolve(SHELL) + path.sep) && fs.existsSync(file))
      return route.fulfill({ contentType: MIME[path.extname(file)] || 'text/plain', body: fs.readFileSync(file) });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.route('https://widget.test/**', (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(folder, rel);
    if (fs.existsSync(file) && fs.statSync(file).isFile())
      return route.fulfill({ contentType: MIME[path.extname(file)] || 'text/plain', body: fs.readFileSync(file) });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.route('https://shell.test/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}'
      + 'iframe{display:block;border:0;width:100vw;height:100vh}</style>',
  }));

  let feedHits = 0;
  await page.route(/https?:\/\/(?!(?:app\.wsw|widget\.test|shell\.test)(?:[:/?#]|$)).*/, (route) => {
    if (!route.request().url().includes('cisa.gov')) return route.abort();
    feedHits++;
    // stall: never fulfil, never abort — the connection opens and then goes silent,
    // which is the case with no deadline anywhere in the ladder.
    // overduecache hangs too: a 503 lands inside the probe's wait and marks the tile
    // stale by ITS OWN path, which is the wrong reason and hid the defect entirely.
    // The claim under test is about the window BEFORE any refresh resolves.
    if (mode === 'stall' || mode === 'overduecache') return;
    if (mode === 'metastale') return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ vulnerabilities: [] }), headers: { 'access-control-allow-origin': '*' } });
    return route.fulfill({ status: 503, body: '', headers: { 'access-control-allow-origin': '*' } });
  });

  await page.addInitScript(() => {
    window.__fakeHidden = false;
    try {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__fakeHidden });
      Object.defineProperty(document, 'visibilityState',
        { configurable: true, get: () => (window.__fakeHidden ? 'hidden' : 'visible') });
    } catch (e) { /* already overridden */ }
  });
  await page.addInitScript((compress) => {
    window.__armed = [];
    const real = window.setTimeout;
    window.setTimeout = function (fn, d) {
      const want = Number(d) || 0;
      window.__armed.push(want);
      // The widget's decision is unchanged; only the wall-clock wait is shortened, and
      // only for the multi-minute poll timers. What is recorded is what it ASKED for.
      return real.call(window, fn, compress && want >= 120000 ? 250 : d);
    };
  }, mode === 'hiddenanchor');
  await page.addInitScript(shim);
  await page.addInitScript(() => {
    if (window.top !== window) return;
    let frame = null;
    let settings = {};
    window.__mount = (s) => {
      settings = s;
      frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      frame.src = 'https://widget.test/index.html#ww-slot=p0s0';
      document.body.appendChild(frame);
    };
    // The shell's own game push, exactly as shell.js sends it (widget-api.js:344).
    window.__gameOff = () => window.__slot
      && window.__slot.postMessage({ type: 'ww-game', game: { active: false, process: '' } }, window.__slotOrigin);
    window.addEventListener('message', (ev) => {
      if (!frame || ev.source !== frame.contentWindow || ev.origin !== 'https://widget.test') return;
      const m = ev.data || {};
      const reply = (o) => ev.source.postMessage(o, ev.origin);
      // Every ww-ready is answered, as shell.js does — so a frame that reloads mid-probe
      // is initialised again instead of running on its built-in defaults.
      if (m.type === 'ww-ready') {
        window.__slot = ev.source; window.__slotOrigin = ev.origin;
        return reply({ type: 'ww-init', settings, sensors: [], media: null,
          game: window.__game || { active: false, process: '' },
          theme: { '--accent': '#e0a33e' }, status: { elevated: false, apiVersion: 1 } });
      }
      if (m.type === 'ww-fetch') reply({ type: 'ww-fetch-result', id: m.id, error: 'no proxy in this probe' });
      else if (m.type === 'ww-ping') reply({ type: 'ww-ping-result', id: m.id, results: [] });
    });
  });

  if (mode === 'hiddenstart') await page.addInitScript(() => { window.__fakeHidden = true; });
  if (mode === 'gameon') await page.addInitScript(() => { window.__game = { active: true, process: 'game.exe' }; });
  await page.goto('https://shell.test/host.html');
  await page.evaluate((s) => window.__mount(s),
    mode === 'metastale' ? { refreshMinutes: 1440, watch: [{ term: 'fortinet' }] }
    : mode === 'overduecache' ? { refreshMinutes: 60 }
    : mode === 'gameon' ? { refreshMinutes: 15 }
    : { refreshMinutes: 1440 });
  const frameEl = await page.waitForSelector('iframe');
  let frame = await frameEl.contentFrame();
  await frame.waitForLoadState('domcontentloaded');

  const stateText = async () => frame.evaluate(() => {
    const st = document.getElementById('state');
    if (!st || st.hidden) return '(state hidden — data showing)';
    return (st.innerText || '').replace(/\s+/g, ' ').trim() || '(spinner only)';
  });
  const armed = () => frame.evaluate(() => window.__armed.slice());

  let ok = false;
  if (mode === 'stall') {
    await page.waitForTimeout(3000);
    console.log('after 3s   :', await stateText());
    // FETCH_DEADLINE is 60s; give it a margin.
    await page.waitForTimeout(64000);
    const text = await stateText();
    const polls = (await armed()).filter((d) => d >= 60000 && d !== 6 * 3600000);
    console.log('after 67s  :', text);
    console.log('poll timers armed (min):', polls.map((d) => d / 60000));
    ok = /Feed unavailable/.test(text) && polls.length > 0;
    console.log(ok ? 'PASS the stalled request was cut off, painted an error and rescheduled'
                   : 'FAIL the tile is still frozen on the stalled request');
  } else if (mode === 'visibility') {
    await page.waitForTimeout(1500);
    const before = feedHits;
    console.log('feed requests after the first failed poll:', before);
    // The handler reads document.hidden, which is false here, so a synthetic event
    // exercises exactly the branch a real page-flip would take.
    await frame.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(1200);
    console.log('feed requests after a visibility change:', feedHits);
    ok = feedHits === before;
    console.log(ok ? 'PASS returning to the widget respected the backoff'
                   : 'FAIL the visibility handler fired a poll straight past the backoff');
  } else if (mode === 'hiddenstart') {
    // The widget initialises while its document is hidden, so tick() arms the timer
    // without asking for anything. Then the page becomes visible well inside the
    // interval: a cold tile must fetch, not sit on its spinner for up to a day.
    await page.waitForTimeout(1800);
    console.log('feed requests while hidden:', feedHits, '|', await stateText());
    await frame.evaluate(() => { window.__fakeHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(1500);
    console.log('feed requests after becoming visible:', feedHits, '|', await stateText());
    ok = feedHits > 0;
    console.log(ok ? 'PASS a widget that had never polled fetched as soon as it was shown'
                   : 'FAIL a cold hidden widget stays on its spinner for the whole interval');
  } else if (mode === 'gameon') {
    // A game is ALREADY running when the widget loads — the case the spec calls out,
    // because onGame reports flips and this widget would otherwise never see one. The
    // panel stays visible on the second screen, so document.hidden is false throughout.
    await page.waitForTimeout(2000);
    const during = feedHits;
    console.log('feed requests while a game is running:', during);
    await page.evaluate(() => window.__gameOff());
    await page.waitForTimeout(1500);
    console.log('feed requests after the game ended   :', feedHits);
    ok = during === 0 && feedHits > 0;
    console.log(ok ? 'PASS polling was suspended for the game and caught up when it ended'
                   : 'FAIL the widget polled straight through a running game');
  } else if (mode === 'overduecache') {
    // A cache three hours old against a one-hour interval — the app was closed
    // overnight — with a feed that only 503s, so this is about what is on screen before
    // any refresh can land.
    await frame.evaluate(() => localStorage.setItem('kev.cache.v1', JSON.stringify({
      at: Date.now() - 3 * 3600000,
      entries: [{ vendor: 'Fortinet', product: 'FortiOS', cve: 'CVE-2026-2101', added: '2026-08-01' }],
    })));
    await frame.evaluate(() => location.reload());
    await page.waitForTimeout(2500);
    frame = await frameEl.contentFrame();
    const look = await frame.evaluate(() => ({
      stale: document.body.classList.contains('stale'),
      pill: (document.getElementById('pill') || {}).textContent,
    }));
    console.log('cache 3h old, interval 1h:', JSON.stringify(look));
    ok = look.stale === true && look.pill === 'Stale';
    console.log(ok ? 'PASS a known-overdue cache is presented as stale, not as current'
                   : 'FAIL overdue cached data was presented as current');
  } else if (mode === 'hiddenanchor') {
    // One real poll while visible (it fails, so the deadline becomes 2x the interval),
    // then hide the document and watch what each hidden wake asks for. A wake that
    // RESETS the anchor asks for the full delay every time; one that merely re-arms the
    // existing deadline asks for a little less each time, because the deadline is fixed
    // and real time keeps passing.
    await page.waitForTimeout(1500);
    await frame.evaluate(() => { window.__fakeHidden = true; document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(3000);
    const polls = (await armed()).filter((d) => d >= 120000 && d !== 6 * 3600000);
    const seq = polls.slice(-6);
    console.log('delays requested by successive hidden wakes (ms):', seq);
    const spread = Math.max(...seq) - Math.min(...seq);
    console.log('spread across those wakes:', spread, 'ms  (0 = the deadline was reset each time)');
    ok = seq.length >= 3 && spread > 500;
    console.log(ok ? 'PASS hidden wakes re-armed the SAME deadline; it kept approaching'
                   : 'FAIL every hidden wake pushed the deadline out by a full interval');
  } else if (mode === 'metastale') {
    // A cache holding a real catalog with a WATCH list configured, then a feed that
    // answers empty: the footer must describe the empty answer, not the old one.
    await frame.evaluate(() => localStorage.setItem('kev.cache.v1', JSON.stringify({
      at: Date.UTC(2020, 0, 1, 9, 5),
      entries: [{ vendor: 'Fortinet', product: 'FortiOS', cve: 'CVE-2026-2101', added: '2026-08-01' },
                { vendor: 'Ivanti', product: 'Connect Secure', cve: 'CVE-2026-2088', added: '2026-07-31' }],
    })));
    await frame.evaluate(() => location.reload());
    await page.waitForTimeout(2500);
    frame = await frameEl.contentFrame();
    const meta = await frame.evaluate(() => (document.getElementById('meta').textContent || '').trim());
    console.log('state card:', await stateText());
    console.log('footer    :', JSON.stringify(meta));
    ok = !/watched/.test(meta) && !/09:05|9:05/.test(meta);
    console.log(ok ? 'PASS the footer describes the empty answer'
                   : 'FAIL the footer still describes the catalog the empty answer replaced');
  } else if (mode === 'emptycache') {
    // A legitimately empty catalog, written by a SUCCESSFUL poll, then a failing feed.
    await frame.evaluate(() => localStorage.setItem('kev.cache.v1',
      JSON.stringify({ at: Date.now() - 1000, entries: [] })));
    await frame.evaluate(() => location.reload());
    await page.waitForTimeout(2500);
    frame = await frameEl.contentFrame();
    const text = await stateText();
    const look = await frame.evaluate(() => ({
      stale: document.body.classList.contains('stale'),
      pill: (document.getElementById('pill') || {}).textContent,
      stateOpacity: getComputedStyle(document.getElementById('state')).opacity,
    }));
    console.log('cached empty catalog + failing feed:', text);
    console.log('  body.stale:', look.stale, '| pill:', look.pill, '| #state opacity:', look.stateOpacity);
    ok = /No entries/.test(text) && look.stale && look.pill === 'Stale' && Number(look.stateOpacity) < 1;
    console.log(ok ? 'PASS the cached empty answer survived, and it LOOKS stale'
                   : 'FAIL the cached empty answer was lost, or does not read as stale');
  } else {
    // A cache that parses, has an entries ARRAY, and holds elements render() will throw on.
    await frame.evaluate(() => localStorage.setItem('kev.cache.v1', JSON.stringify({
      at: Date.now(), entries: [null, { cve: 'CVE-1', added: null }, 'not-an-object'],
    })));
    await frame.evaluate(() => location.reload());
    await page.waitForTimeout(2500);
    frame = await frameEl.contentFrame();
    const text = await stateText();
    const look = await frame.evaluate(() => ({
      stale: document.body.classList.contains('stale'),
      stateOpacity: getComputedStyle(document.getElementById('state')).opacity,
    }));
    console.log('with a poisoned cache and a 503 feed:', text);
    console.log('  body.stale:', look.stale, '| #state opacity:', look.stateOpacity,
      '(an ERROR card must stay at full opacity)');
    ok = /Feed unavailable/.test(text) && !look.stale && Number(look.stateOpacity) === 1;
    console.log(ok ? 'PASS the bad cache was discarded and the feed error is on screen'
                   : 'FAIL the tile is stuck behind a cache it could not render');
  }
  await browser.close();
  process.exitCode = ok ? 0 : 1;
})();
