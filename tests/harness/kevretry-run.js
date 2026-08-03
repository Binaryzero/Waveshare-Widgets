#!/usr/bin/env node
// CISA KEV: pressing Retry while a game is running (issue #164).
//
// The game-mode gate suspends polling while a fullscreen game is foreground, because the
// tile downloads and parses a multi-megabyte catalog on a machine whose frame budget is
// spoken for. Retry did not account for it: it painted a spinner, cleared the failure
// count and called tick(), which returned through the gameOn guard without recording
// that a retry had been asked for. Nothing marked the poll as due, so when the game ended
// onGame re-armed the EXISTING deadline — pollAnchor + one interval, measured from the
// last attempt. At refreshMinutes 1440 the tile could sit on a spinner for a day, having
// told the reader it was retrying.
//
// Both halves are asserted, because either alone is still a lie:
//
//   K1 · setup: a game is running and the feed has failed, so the error card is up
//   K2 · pressing Retry while the game runs does NOT fetch — the gate still holds
//   K3 · ...and the tile does not claim to be loading something it is not doing
//   K4 · when the game ends, the retry actually happens, and promptly
//   K5 · the request is a real feed request, not a cache read or a re-render
//   K6 · a game ending with NO retry pending does not fetch early — the gate is not
//        simply disabled, which is what K4 would also look like
//   K1b· with no game running, Retry is unchanged: it fetches at once and says so,
//        because gating the wording added an early return in front of that path
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const SHELL = path.join(REPO, 'src', 'WaveshareWidgets', 'Shell');
const WIDGET = path.join(REPO, 'widgets', 'kev');
const FEED = 'known_exploited_vulnerabilities.json';
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  if (!ok) failures++;
};

const CATALOG = {
  title: 'KEV', catalogVersion: '1', dateReleased: '2026-08-03', count: 1,
  vulnerabilities: [{ cveID: 'CVE-2026-0001', vendorProject: 'Acme', product: 'Thing',
    dateAdded: '2026-08-03' }],
};

// The shell page. Same shape widget-datapath uses: markup only, the frame is created from
// script so the responder exists before the widget can speak, and the widget keeps its own
// origin exactly as it has on the panel.
const SHELL_PAGE = '<!doctype html><meta charset="utf-8"><title>ww shell</title>'
  + '<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#000}'
  + 'iframe{display:block;border:0;width:100vw;height:100vh}</style>';

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  page.on('pageerror', (e) => { failures++; console.log('[pageerror]', String(e).slice(0, 300)); });

  // Every feed request is counted, and the count is the witness for all of this: what is
  // being asserted is whether a REQUEST happened, not what the tile drew afterwards.
  let feedHits = 0;
  let feedAnswers = false;   // flipped once the retry should be able to succeed
  // A refused request resolves in microseconds, so the in-flight state is over before a
  // probe can look at it. Held open deliberately when the loading state is what is being
  // asserted — the spinner is real, it was just already gone.
  let feedDelayMs = 0;

  const serve = (route, dir, rel) => {
    const root = path.resolve(dir);
    const file = path.resolve(root, rel);
    if ((file === root || file.startsWith(root + path.sep)) && fs.existsSync(file) && fs.statSync(file).isFile())
      return route.fulfill({ contentType: MIME[path.extname(file)] || 'text/plain', body: fs.readFileSync(file) });
    return route.fulfill({ status: 404, body: '' });
  };
  await page.route('https://app.wsw/**', (r) =>
    serve(r, SHELL, decodeURIComponent(new URL(r.request().url()).pathname).replace(/^\/+/, '')));
  await page.route('https://widget.test/**', (r) =>
    serve(r, WIDGET, decodeURIComponent(new URL(r.request().url()).pathname).replace(/^\/+/, '') || 'index.html'));
  await page.route('https://shell.test/**', (r) =>
    r.fulfill({ contentType: 'text/html', body: SHELL_PAGE }));
  await page.route('https://www.cisa.gov/**', (r) => {
    if (!r.request().url().includes(FEED)) return r.abort();
    feedHits++;
    const finish = () => {
      if (!feedAnswers) return r.abort();   // the outage that puts the error card up
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CATALOG) });
    };
    if (feedDelayMs) return setTimeout(finish, feedDelayMs);
    return finish();
  });
  await page.route(/https?:\/\/(?!(?:app\.wsw|widget\.test|shell\.test|www\.cisa\.gov)(?:[/?#]|$)).*/,
    (r) => r.abort());

  const shim = fs.readFileSync(path.join(SHELL, 'widget-api.js'), 'utf8') + '\n'
             + fs.readFileSync(path.join(SHELL, 'icue-compat.js'), 'utf8');
  await page.addInitScript(shim);
  await page.addInitScript(({ widgetUrl, widgetOrigin, initMessage }) => {
    if (window.top !== window) return;
    let frame = null;
    window.__wwMount = () => {
      frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      frame.src = widgetUrl + '#ww-slot=p0s0';
      (document.body || document.documentElement).appendChild(frame);
    };
    window.__wwPush = (msg) => { if (frame && frame.contentWindow) frame.contentWindow.postMessage(msg, widgetOrigin); };
    window.addEventListener('message', (ev) => {
      if (!frame || ev.source !== frame.contentWindow || ev.origin !== widgetOrigin) return;
      const m = ev.data || {};
      if (m.type === 'ww-ready') return window.__wwPush(initMessage);
      // The tile reaches the feed directly here; a proxy escalation would answer the
      // same way the host does, and is refused so the run cannot pass on that tier.
      if (m.type === 'ww-fetch') window.__wwPush({ type: 'ww-fetch-result', id: m.id, error: 'offline probe' });
    });
  }, {
    widgetUrl: 'https://widget.test/index.html',
    widgetOrigin: 'https://widget.test',
    // refreshMinutes 1440: the interval the issue names, so a poll that is NOT marked due
    // cannot fire during this run by coincidence.
    // No game at init: the tile has to poll and FAIL first, or there is no error card and
    // no Retry button to press. The game is started afterwards, which is also the real
    // sequence — a reader sees a failed tile, launches a game, then presses Retry.
    initMessage: { type: 'ww-init', settings: { maxItems: 6, windowDays: 7, refreshMinutes: 1440 },
      sensors: [], media: null, theme: {}, game: { active: false, process: '' },
      status: { elevated: false, apiVersion: 1 } },
  });

  await page.goto('https://shell.test/host.html');
  await page.evaluate(() => window.__wwMount());
  const frameEl = await page.waitForSelector('iframe', { timeout: 10000 });
  const frame = await frameEl.contentFrame();
  if (!frame) { console.log('  FAIL K0 widget frame never attached'); await browser.close(); process.exit(1); }
  await frame.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(2500);

  // ---- K1 · setup -------------------------------------------------------------------
  // The feed has been tried and failed, so the error card is up with a Retry button. Both
  // halves matter: no request means the gate was already closed and nothing under test
  // ever ran; no button means there is nothing to press.
  let retryBtn = await frame.$('#state .btn');
  check('K1 setup: the feed failed and the error card offers Retry',
    !!retryBtn && feedHits > 0, `feedHits=${feedHits} retry=${!!retryBtn}`);
  if (!retryBtn) { await browser.close(); process.exit(1); }

  // ---- K1b · the ordinary path, before any game is involved -------------------------
  // Gating the wording put an early return in front of the normal branch, so the plain
  // Retry is the thing this change could have broken. Asserted HERE, while the error
  // card is up and nothing is gated — after the game sequence the tile is showing data
  // and the button is no longer reachable.
  const beforePlain = feedHits;
  feedDelayMs = 1500;              // hold the request open so the in-flight state is visible
  await retryBtn.click();
  await page.waitForTimeout(500);  // well inside the held request
  const plain = await frame.evaluate(() => {
    const vis = (el) => el && el.getBoundingClientRect().width > 4 && getComputedStyle(el).visibility !== 'hidden';
    return { spinner: vis(document.querySelector('#state .spinner')),
             pill: (document.getElementById('pill') || {}).textContent || '' };
  });
  check('K1b Retry with no game running still fetches at once', feedHits > beforePlain,
    `${feedHits - beforePlain} request(s)`);
  check('K1b2 ...and reports it as loading while it runs',
    plain.spinner || plain.pill === 'Loading', `spinner=${plain.spinner} pill="${plain.pill}"`);

  // Let the held request finish and fail, so the card is back for the game sequence.
  feedDelayMs = 0;
  await page.waitForTimeout(1800);

  // NOW the game starts — the reader launched something after the tile had already failed.
  await page.evaluate(() => window.__wwPush({ type: 'ww-game', game: { active: true, process: 'game.exe' } }));
  await page.waitForTimeout(300);

  // ---- K2/K3 · pressing Retry under the gate ----------------------------------------
  const before = feedHits;
  retryBtn = await frame.$('#state .btn');
  if (!retryBtn) { console.log('  FAIL K2 setup: the Retry button vanished before it could be pressed'); await browser.close(); process.exit(1); }
  await retryBtn.click();
  await page.waitForTimeout(1200);
  check('K2 Retry under a running game does not fetch', feedHits === before,
    `${feedHits - before} request(s)`);
  // The tile must not present this as work in progress. A spinner here is a promise the
  // widget cannot keep while the gate holds, and it is the state this widget has spent
  // several rounds learning not to show.
  const shown = await frame.evaluate(() => {
    const vis = (el) => el && el.getBoundingClientRect().width > 4 && getComputedStyle(el).visibility !== 'hidden';
    return {
      spinner: vis(document.querySelector('#state .spinner')),
      text: (document.querySelector('#state') || {}).innerText || '',
      pill: (document.getElementById('pill') || {}).textContent || '',
    };
  });
  // KEV_SHOT=<path> captures the queued card, because "the wording is honest" is a claim
  // about what a reader sees and is checked by looking at it.
  if (process.env.KEV_SHOT) await page.screenshot({ path: process.env.KEV_SHOT });
  check('K3 ...and does not show a spinner that cannot resolve',
    !shown.spinner, `spinner=${shown.spinner} pill="${shown.pill}" text="${shown.text.replace(/\s+/g, ' ').trim().slice(0, 90)}"`);

  // ---- K4/K5 · the game ends --------------------------------------------------------
  feedAnswers = true;
  const beforeEnd = feedHits;
  await page.evaluate(() => window.__wwPush({ type: 'ww-game', game: { active: false, process: '' } }));
  await page.waitForTimeout(1500);
  check('K4 when the game ends, the queued retry actually runs', feedHits > beforeEnd,
    `${feedHits - beforeEnd} request(s) after the game ended`);
  const settled = await frame.evaluate(() => {
    const vis = (el) => el && el.getBoundingClientRect().width > 4 && getComputedStyle(el).visibility !== 'hidden';
    return { state: vis(document.querySelector('#state')), body: document.body.innerText.replace(/\s+/g, ' ').trim() };
  });
  check('K5 ...and the tile leaves its state layer for real data',
    !settled.state && settled.body.includes('Acme'), settled.body.slice(0, 110));

  // ---- K6 · the gate is not simply switched off -------------------------------------
  // K4 passes just as well if a game ending always polls, which would defeat the whole
  // point of the gate. A SECOND game, with no retry pending and a deadline a day out,
  // must end without fetching.
  const beforeIdle = feedHits;
  await page.evaluate(() => window.__wwPush({ type: 'ww-game', game: { active: true, process: 'game.exe' } }));
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__wwPush({ type: 'ww-game', game: { active: false, process: '' } }));
  await page.waitForTimeout(1500);
  check('K6 a game ending with nothing pending does NOT poll early',
    feedHits === beforeIdle, `${feedHits - beforeIdle} request(s)`);

  await browser.close();
  console.log(failures > 0 ? `${failures} FAILURES` : 'ALL PASS');
  process.exit(failures > 0 ? 1 : 0);
})();
