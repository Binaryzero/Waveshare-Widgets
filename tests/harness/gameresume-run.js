#!/usr/bin/env node
// Resuming from game mode when the SETUP is what was paused (issue #201).
//
// Most gated widgets pause a poll: the tile is already built, and resuming means fetching
// again. Two do not. `radar` geocodes the configured location inside onInit before it can
// draw anything, and `hue` hunts for a bridge the same way — so gating only their refresh
// left the setup running through a game, which is how radar kept reaching
// geocoding-api.open-meteo.com while paused.
//
// Holding the setup is the easy half. Resuming it correctly is where this went wrong, and
// R4 is why this file exists:
//
//   R1 · a game running at init means NO request at all — the setup is held, not just
//        the refresh
//   R2 · ...and the tile says so rather than sitting blank on a black rectangle
//   R3 · a settings change arriving DURING the pause is still held — the gate is not
//        re-opened by a re-init
//   R4 · when the game ends, the setup runs against the settings that arrived LAST.
//        The first fix tested "was an interval ever armed" to decide whether the setup or
//        the refresh was owed. That is right while the widget has never run — and wrong
//        exactly when it has: the sequence below runs a SUCCESSFUL session first, so the
//        interval is armed, and only then starts a game and changes the location. With
//        the timer test the resume took the refresh branch, redrew the old coordinates
//        and never resolved the new ones.
//
//        The first version of this file paused at init, which meant no timer was ever
//        armed, which meant R4 passed against the buggy test too. A check that cannot
//        fail proves nothing, so the run below is ordered the way the defect needs.
//   R5 · the setup actually COMPLETED — the map data was fetched too, not just the
//        geocode, which is what "resumed" has to mean
//   R6 · a game ending with nothing held does not re-run the setup, so R4 cannot be
//        satisfied by a gate that simply reopens on every flip
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const SHELL = path.join(REPO, 'src', 'WaveshareWidgets', 'Shell');
const WIDGET = path.join(REPO, 'widgets', 'radar');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  if (!ok) failures++;
};

const SHELL_PAGE = '<!doctype html><meta charset="utf-8"><title>ww shell</title>'
  + '<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#000}'
  + 'iframe{display:block;border:0;width:100vw;height:100vh}</style>';

const PLACES = {
  Dallas: { latitude: 32.78, longitude: -96.8, name: 'Dallas' },
  Reykjavik: { latitude: 64.15, longitude: -21.94, name: 'Reykjavik' },
};

// The witnesses. Which NAME was geocoded is the whole point of R4 — counting requests
// alone would pass a resume that fetched diligently for the wrong city.
let geocoded = [];
let mapHits = 0;

// One mounted widget, with the game either already running or not. Two scenarios need
// this because the two halves of the gate fail independently: seeding covers a game that
// was ALREADY running at init, and onGame covers one that starts later. A single mount
// can only ever test one of them.
async function mount(browser, gameAtInit) {
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  page.on('pageerror', (e) => { failures++; console.log('[pageerror]', String(e).slice(0, 300)); });

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

  await page.route('https://geocoding-api.open-meteo.com/**', (r) => {
    const name = new URL(r.request().url()).searchParams.get('name') || '';
    geocoded.push(name);
    const hit = PLACES[name];
    return r.fulfill({
      status: 200, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ results: hit ? [hit] : [] }),
    });
  });
  await page.route('https://api.rainviewer.com/**', (r) => {
    mapHits++;
    return r.fulfill({
      status: 200, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ host: 'https://tilecache.rainviewer.com', radar: { past: [], nowcast: [] } }),
    });
  });
  // Tiles and anything else: refused, deterministically. The map image is not what this
  // file is about, and a real tile fetch would make the counts depend on the network.
  await page.route(/https?:\/\/(?!(?:app\.wsw|widget\.test|shell\.test|geocoding-api\.open-meteo\.com|api\.rainviewer\.com)(?:[/?#]|$)).*/,
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
      // The proxy tier is refused so a run cannot pass on it: every request this file
      // counts has to be the direct one the routes above serve.
      if (m.type === 'ww-fetch') window.__wwPush({ type: 'ww-fetch-result', id: m.id, error: 'offline probe' });
    });
  }, {
    widgetUrl: 'https://widget.test/index.html',
    widgetOrigin: 'https://widget.test',
    initMessage: { type: 'ww-init',
      settings: { location: 'Dallas', zoom: 7, animate: 'off', mapDim: 0, textSize: 100, bgStyle: 'solid' },
      sensors: [], media: null, theme: {}, game: { active: gameAtInit, process: gameAtInit ? 'game' : '' },
      status: { elevated: false, apiVersion: 1 } },
  }, gameAtInit);

  await page.goto('https://shell.test/host.html');
  await page.evaluate(() => window.__wwMount());
  const frameEl = await page.waitForSelector('iframe', { timeout: 10000 });
  const frame = await frameEl.contentFrame();
  if (!frame) { console.log('  FAIL mount: widget frame never attached'); await browser.close(); process.exit(1); }
  await frame.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(1500);
  return { page, frame };
}

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});

  // ===== Scenario A · a game that starts AFTER a healthy session =====================
  // NO game at init, deliberately: the widget has to complete a normal session and arm
  // its refresh interval, because "an interval is already armed" is precisely the state
  // in which the resume decision can go wrong. A run that starts paused never reaches it.
  const a = await mount(browser, false);
  const page = a.page;
  const frame = a.frame;

  // ---- R0 · the session that arms the interval ---------------------------------------
  // Asserted, not assumed: if this did not happen there is no armed interval, and R4
  // below would be testing the easy case that the buggy version also got right.
  check('R0 setup: a normal session ran first and armed the refresh interval',
    geocoded.length === 1 && geocoded[0] === 'Dallas' && mapHits > 0,
    `${JSON.stringify(geocoded)}, ${mapHits} map fetch(es)`);

  // ---- R1/R2 · a game starts, and the tile goes quiet --------------------------------
  const geoAtPause = geocoded.length;
  const mapAtPause = mapHits;
  await page.evaluate(() => window.__wwPush({ type: 'ww-game', game: { active: true, process: 'game' } }));
  await page.waitForTimeout(1200);
  check('R1 a game starting stops the requests',
    geocoded.length === geoAtPause && mapHits === mapAtPause,
    `+${geocoded.length - geoAtPause} geocode(s), +${mapHits - mapAtPause} map fetch(es)`);

  // ---- R3 · a settings change DURING the pause --------------------------------------
  // The user edits the location while the game is running. This is a second ww-init, and
  // it must be held rather than treated as permission to run.
  await page.evaluate(() => window.__wwPush({
    type: 'ww-init',
    settings: { location: 'Reykjavik', zoom: 7, animate: 'off', mapDim: 0, textSize: 100, bgStyle: 'solid' },
    sensors: [], media: null, theme: {}, game: { active: true, process: 'game' },
    status: { elevated: false, apiVersion: 1 },
  }));
  await page.waitForTimeout(800);
  check('R3 a settings change arriving mid-pause is held too',
    geocoded.length === geoAtPause, `${JSON.stringify(geocoded)}`);
  const pausedText = await frame.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());
  check('R2 ...and the tile says it is paused rather than showing stale data as current',
    /paused/i.test(pausedText), JSON.stringify(pausedText.slice(0, 120)));

  // ---- R4/R5 · the resume ------------------------------------------------------------
  await page.evaluate(() => window.__wwPush({ type: 'ww-game', game: { active: false, process: '' } }));
  await page.waitForTimeout(2000);
  check('R4 the resume geocodes the LAST settings, not the ones the pause began with',
    geocoded.length > 0 && geocoded[geocoded.length - 1] === 'Reykjavik',
    JSON.stringify(geocoded));
  check('R5 ...and the setup completed — the map data was fetched again, not just the geocode',
    mapHits > mapAtPause, `${mapHits} map fetch(es), ${mapAtPause} before the pause`);

  // ---- R6 · a flip with nothing held -------------------------------------------------
  const geoBefore = geocoded.length;
  const mapBefore = mapHits;
  await page.evaluate(() => window.__wwPush({ type: 'ww-game', game: { active: true, process: 'game' } }));
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__wwPush({ type: 'ww-game', game: { active: false, process: '' } }));
  await page.waitForTimeout(1200);
  check('R6 a game ending with nothing held does not re-run the setup',
    geocoded.length === geoBefore && mapHits === mapBefore,
    `+${geocoded.length - geoBefore} geocode(s), +${mapHits - mapBefore} map fetch(es)`);

  // ===== Scenario B · a game ALREADY running at init ================================
  // The half the reorder above took away. Scenario A only ever sets gameOn through a
  // ww-game transition, so deleting the `state.game` seeding from the widget would leave
  // every one of its checks green — the seeding needs a mount that starts paused.
  await page.close();
  geocoded = [];
  mapHits = 0;
  const b = await mount(browser, true);
  check('S1 a game already running at init means no request at all, setup included',
    geocoded.length === 0 && mapHits === 0,
    `${JSON.stringify(geocoded)}, ${mapHits} map fetch(es)`);
  const startedPaused = await b.frame.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());
  check('S2 ...and the tile says it is paused rather than sitting blank',
    /paused/i.test(startedPaused), JSON.stringify(startedPaused.slice(0, 120)));

  // ...and it recovers: a seeded pause has to be re-enterable, or S1 would be satisfied
  // by a widget that simply never works when a game was running at load.
  await b.page.evaluate(() => window.__wwPush({ type: 'ww-game', game: { active: false, process: '' } }));
  await b.page.waitForTimeout(2000);
  check('S3 ...and the setup runs once the game ends',
    geocoded.length === 1 && geocoded[0] === 'Dallas' && mapHits > 0,
    `${JSON.stringify(geocoded)}, ${mapHits} map fetch(es)`);
  // S4 is the USER-VISIBLE half, and S3 does not imply it: the fetches can all succeed
  // behind a Paused card that nothing ever took down, leaving a recovered map the reader
  // cannot see. Deleting hideMessage() satisfies S3 and fails only this.
  const resumedHidden = await b.frame.evaluate(() => {
    const el = document.getElementById('message');
    return !!(el && (el.hidden || getComputedStyle(el).display === 'none'));
  });
  const resumedText = await b.frame.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());
  check('S4 ...and the Paused card is taken down, so the recovered map is visible',
    resumedHidden && !/paused/i.test(resumedText),
    `overlay hidden: ${resumedHidden}, text: ${JSON.stringify(resumedText.slice(0, 90))}`);

  await browser.close();
  console.log(failures > 0 ? `\n${failures} FAILURES` : '\nALL PASS');
  process.exit(failures > 0 ? 1 : 0);
})();
