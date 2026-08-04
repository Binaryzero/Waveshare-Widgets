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
//
// Scenarios C and D then cover the FAILURE paths, which the gates above never sat on: a
// rejection jumps to a catch, skipping every await-gate on the success path. C is the
// geocode (terminal — the setup returns before arming anything), D is the frame list one
// request later (recoverable, but only at the next five-minute tick, and on a first load
// the tile has no frames at all until then).
//
// G and J move to hue, the other widget whose setup is the paused thing. G is the same
// failure-path question against its cloud bridge hunt. J is what putting a gate beside the
// generation check exposed: two connect() calls overlapping, the older one's answer landing
// after the newer one has validated a bridge and loaded its key.
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
// Flipped by scenario C: the geocoder REFUSES, which sends radar down its catch path
// rather than its await-gate path. That is the branch the gate was never on.
let geocodeFails = false;
// Held open so a game can START while the request is in flight. Without that the failure
// happens outside the game and the catch path is never the one under test — the first
// version of scenario C made exactly that mistake and passed against the unfixed widget.
let geocodeHold = null;
// The same pair for the FRAME LIST, one request later. Scenario D needs them because
// refreshRadar has a catch of its own, and fixing start()'s did nothing for it.
let mapFails = false;
let mapHold = null;

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

  await page.route('https://geocoding-api.open-meteo.com/**', async (r) => {
    const name = new URL(r.request().url()).searchParams.get('name') || '';
    geocoded.push(name);
    if (geocodeHold) { await geocodeHold; }
    if (geocodeFails) return r.abort();
    const hit = PLACES[name];
    return r.fulfill({
      status: 200, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ results: hit ? [hit] : [] }),
    });
  });
  await page.route('https://api.rainviewer.com/**', async (r) => {
    mapHits++;
    if (mapHold) { await mapHold; }
    if (mapFails) return r.abort();
    return r.fulfill({
      status: 200, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      // One real past frame, not an empty list: refreshRadar returns early on an empty
      // one, so with `past: []` nothing downstream of the fetch ever runs and D4 could
      // not tell a rebuilt radar from a refetched-and-discarded one.
      body: JSON.stringify({ host: 'https://tilecache.rainviewer.com',
        radar: { past: [{ time: 1735689600, path: '/v2/radar/1735689600' }], nowcast: [] } }),
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

// ---- hue -----------------------------------------------------------------------------
// The other widget whose SETUP is the paused thing, and the reason it needs its own mount
// rather than a parameter on the one above: hue speaks to its bridge exclusively through
// the host proxy (`init.proxy: 'always'`), so none of its traffic is a page request at
// all. The witness has to be the ww-fetch log, and the radar mount refuses that channel
// on purpose. Kept separate so the radar scenarios above are untouched by any of this.
const HUE = path.join(REPO, 'widgets', 'hue');
const HUE_IP = '10.0.0.9';                 // what the user configures, and what holds the key
const HUE_BOGUS = '10.9.9.9';              // what cloud discovery hands back — stale or hostile
const HUE_KEY = 'probe-application-key-9f3a';

async function mountHue(browser, opts) {
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
    serve(r, HUE, decodeURIComponent(new URL(r.request().url()).pathname).replace(/^\/+/, '') || 'index.html'));
  await page.route('https://shell.test/**', (r) => r.fulfill({ contentType: 'text/html', body: SHELL_PAGE }));
  await page.route(/https?:\/\/(?!(?:app\.wsw|widget\.test|shell\.test)(?:[/?#]|$)).*/, (r) => r.abort());

  const shim = fs.readFileSync(path.join(SHELL, 'widget-api.js'), 'utf8') + '\n'
             + fs.readFileSync(path.join(SHELL, 'icue-compat.js'), 'utf8');
  await page.addInitScript(shim);
  // Seeded in the WIDGET frame: the credential for the address the user configures, and a
  // clean discovery cache. Clearing that cache matters — it lives in localStorage on a
  // shared origin, and a previous scenario's cached answer would decide the next one.
  await page.addInitScript((seed) => {
    if (window.top === window) return;
    try {
      localStorage.removeItem('hue-discovery');
      localStorage.setItem('hue-user-' + seed.ip, seed.key);
      localStorage.setItem('hue-v2-' + seed.ip, '1');   // known to speak CLIP v2: poll it directly
      localStorage.removeItem('hue-v1ok-' + seed.ip);
    } catch (e) { /* private mode */ }
  }, { ip: HUE_IP, key: HUE_KEY });

  await page.addInitScript(({ widgetUrl, widgetOrigin, initMessage, ip, rooms }) => {
    if (window.top !== window) return;
    let frame = null;
    window.__asked = [];
    window.__discoCount = 0;
    window.__disco = 'fail';        // 'fail' | 'ip'
    window.__discoIp = '';
    window.__discoHold = null;      // a promise the test resolves, so a game can start mid-flight
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
      if (m.type !== 'ww-fetch') return;
      // EVERY bridge request is recorded before it is answered, including ones this stub
      // refuses: an address the widget should never have spoken to still has to show up.
      window.__asked.push({ url: String(m.url), headers: m.headers || {} });
      const reply = (body, status) => window.__wwPush({ type: 'ww-fetch-result', id: m.id,
        status: status || 200, contentType: 'application/json', bodyBase64: btoa(body) });
      const fail = (msg) => window.__wwPush({ type: 'ww-fetch-result', id: m.id, error: msg });
      const u = String(m.url);
      if (u.indexOf('discovery.meethue.com') !== -1) {
        window.__discoCount++;
        const answer = () => {
          if (window.__disco === 'ip') return reply(JSON.stringify([{ internalipaddress: window.__discoIp }]));
          return fail('discovery unreachable');
        };
        if (window.__discoHold) { window.__discoHold.then(answer); return; }
        return answer();
      }
      // Only the CONFIGURED bridge answers. Anything else is a wrong address the widget
      // was talked into, and refusing it here keeps the log honest about what was tried.
      if (u === 'http://' + ip + '/api/config') return reply(JSON.stringify({ bridgeid: 'ABCD' }));
      if (u.indexOf('https://' + ip + '/clip/v2') === 0) {
        if (u.indexOf('/resource/room') !== -1) return reply(JSON.stringify(rooms));
        return reply(JSON.stringify({ data: [] }));
      }
      return fail('unrouted in probe: ' + u);
    });
  }, {
    widgetUrl: 'https://widget.test/index.html',
    widgetOrigin: 'https://widget.test',
    ip: HUE_IP,
    rooms: { data: [{ id: 'r1', metadata: { name: 'Kitchen' }, services: [] }] },
    initMessage: { type: 'ww-init',
      settings: { bridgeIp: opts.bridgeIp, showScenes: 'on', bgStyle: 'solid' },
      sensors: [], media: null, theme: {}, game: { active: false, process: '' },
      status: { elevated: false, apiVersion: 1 } },
  });

  await page.goto('https://shell.test/host.html');
  await page.evaluate(([disco, discoIp]) => {
    window.__disco = disco;
    window.__discoIp = discoIp;
    // Held from the start: the discovery request has to still be in flight when the test
    // takes its next step, or the race under test never happens.
    window.__discoHold = new Promise((res) => { window.__releaseDisco = res; });
  }, [opts.disco, opts.discoIp || '']);
  await page.evaluate(() => window.__wwMount());
  const frameEl = await page.waitForSelector('iframe', { timeout: 10000 });
  const frame = await frameEl.contentFrame();
  if (!frame) { console.log('  FAIL mount: hue frame never attached'); await browser.close(); process.exit(1); }
  await frame.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(1200);
  return { page, frame };
}

const hueAsked = (page) => page.evaluate(() => window.__asked.map((r) => ({ url: r.url, headers: r.headers })));
const hueText = (frame) => frame.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());

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

  // ===== Scenario C · the request FAILS while a game is running =========================
  // The gates added for #201 sit after each await on the SUCCESS path. A rejection jumps
  // straight to catch, skipping them — so the failure is painted during the game and
  // nothing records that anything is owed. For radar's initial geocode that is terminal:
  // the setup returns before arming refreshTimer, so the resume finds no work and the
  // error card stays up forever. A transient blip during a game becomes permanent.
  //
  // The ORDER is what makes this the catch path: the request is held open, the game starts
  // while it is in flight, and only then does it fail.
  await b.page.close();
  geocoded = [];
  mapHits = 0;
  geocodeFails = true;
  let releaseGeocode;
  geocodeHold = new Promise((res) => { releaseGeocode = res; });

  const c = await mount(browser, false);   // no game: the setup runs and the geocode hangs
  check('C1 setup: the geocode is in flight',
    geocoded.length === 1 && mapHits === 0, `${JSON.stringify(geocoded)}, ${mapHits} map fetch(es)`);

  // A game starts WHILE it is in flight, and only then does the request fail.
  await c.page.evaluate(() => window.__wwPush({ type: 'ww-game', game: { active: true, process: 'game' } }));
  await c.page.waitForTimeout(200);
  geocodeHold = null;
  releaseGeocode();
  await c.page.waitForTimeout(1200);
  check('C2 setup: it failed during the game, and nothing else was requested',
    geocoded.length === 1 && mapHits === 0, `${JSON.stringify(geocoded)}, ${mapHits} map fetch(es)`);

  // The game ends. A widget that recorded the failure as owed work retries; one whose
  // catch path skipped the gate sits on the error card until it is reinitialised.
  geocodeFails = false;
  await c.page.evaluate(() => window.__wwPush({ type: 'ww-game', game: { active: false, process: '' } }));
  await c.page.waitForTimeout(2500);
  check('C3 a failure observed during a game is retried when the game ends',
    geocoded.length === 2, JSON.stringify(geocoded));
  check('C4 ...and the retry completes the setup rather than leaving the error card up',
    mapHits > 0, `${mapHits} map fetch(es)`);
  const recovered = await c.frame.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());
  check('C5 ...and the tile shows neither the error nor the pause any more',
    !/paused/i.test(recovered) && !/set a location/i.test(recovered),
    JSON.stringify(recovered.slice(0, 110)));

  // ===== Scenario D · the FRAME LIST fails while a game is running =====================
  // Scenario C fixed start()'s catch. refreshRadar has one of its own, one request later,
  // and it was still logging and returning — so a frame list that failed during a game
  // recorded nothing and the resume did no catch-up. Unlike C this is not permanent (the
  // five-minute interval survives), which is exactly why it needs its own check: a game
  // shorter than that window leaves the radar stale for the rest of it, and on a FIRST
  // load — the case below — leaves it with no frames at all.
  //
  // Same ordering rule as C: the request is held open, the game starts while it is in
  // flight, and only then does it fail.
  await c.page.close();
  geocoded = [];
  mapHits = 0;
  geocodeFails = false;
  mapFails = true;
  let releaseMap;
  mapHold = new Promise((res) => { releaseMap = res; });

  const d = await mount(browser, false);   // the geocode succeeds; the frame list hangs
  check('D1 setup: the geocode completed and the frame list is in flight',
    geocoded.length === 1 && mapHits === 1, `${JSON.stringify(geocoded)}, ${mapHits} map fetch(es)`);

  await d.page.evaluate(() => window.__wwPush({ type: 'ww-game', game: { active: true, process: 'game' } }));
  await d.page.waitForTimeout(200);
  mapHold = null;
  releaseMap();
  await d.page.waitForTimeout(1200);
  check('D2 setup: the frame list failed during the game, and nothing was re-requested',
    mapHits === 1, `${mapHits} map fetch(es)`);

  mapFails = false;
  await d.page.evaluate(() => window.__wwPush({ type: 'ww-game', game: { active: false, process: '' } }));
  await d.page.waitForTimeout(2500);
  check('D3 a frame-list failure during a game is retried when the game ends',
    mapHits === 2, `${mapHits} map fetch(es)`);
  // D3 alone would be satisfied by a refetch whose result went nowhere, which is the S3/S4
  // lesson: the tile is what the reader sees, so assert the layers actually came back.
  const layers = await d.frame.evaluate(() => document.querySelectorAll('.frame').length);
  check('D4 ...and the retry rebuilt the radar layers rather than only refetching',
    layers >= 1, `${layers} frame layer(s)`);

  // ===== Scenario G · hue: DISCOVERY failing during a game ============================
  // Radar's setup is a geocode; hue's is a cloud bridge hunt, and it has a terminal card of
  // its own. The gates went in above that card rather than below it, so discovery failing
  // during a game reached 'No Hue Bridge found' — a verdict, recorded in neither flag —
  // and the resume, finding nothing owed, left it up until something re-initialised the
  // widget. Same ordering rule as C and D: held open, game starts, then it fails.
  await d.page.close();
  const g = await mountHue(browser, { bridgeIp: '', disco: 'fail' });
  const gAsked0 = await hueAsked(g.page);
  check('G1 setup: the bridge hunt is in flight and nothing else has been asked',
    (await g.page.evaluate(() => window.__discoCount)) === 1 && gAsked0.length === 1,
    `${gAsked0.length} request(s): ${gAsked0.map((r) => r.url).join(' ')}`);

  await g.page.evaluate(() => window.__wwPush({ type: 'ww-game', game: { active: true, process: 'game' } }));
  await g.page.waitForTimeout(200);
  await g.page.evaluate(() => { window.__discoHold = null; window.__releaseDisco(); });
  await g.page.waitForTimeout(1500);
  const gPaused = await hueText(g.frame);
  check('G2 discovery failing during a game reads as paused, not as "no bridge found"',
    /paused/i.test(gPaused) && !/no hue bridge/i.test(gPaused), JSON.stringify(gPaused.slice(0, 120)));

  // The game ends and the bridge is there after all. Clearing the cached MISS stands in for
  // its 60-second lifetime expiring — without that the retry legitimately answers from
  // cache, and G3 would be asking whether the cache works rather than whether the resume
  // re-enters the setup at all.
  await g.frame.evaluate(() => { try { localStorage.removeItem('hue-discovery'); } catch (e) { /* ignore */ } });
  await g.page.evaluate((ip) => { window.__disco = 'ip'; window.__discoIp = ip; }, HUE_IP);
  await g.page.evaluate(() => window.__wwPush({ type: 'ww-game', game: { active: false, process: '' } }));
  await g.page.waitForTimeout(3000);
  check('G3 a discovery failure observed during a game is retried when the game ends',
    (await g.page.evaluate(() => window.__discoCount)) === 2,
    `${await g.page.evaluate(() => window.__discoCount)} discovery attempt(s)`);
  const gAsked1 = await hueAsked(g.page);
  check('G4 ...and the retry reaches the bridge rather than leaving the card up',
    gAsked1.some((r) => r.url.indexOf('https://' + HUE_IP + '/clip/v2') === 0),
    gAsked1.map((r) => r.url).join(' ').slice(0, 160));
  const gRecovered = await hueText(g.frame);
  check('G5 ...and the tile shows neither the pause nor the terminal card any more',
    !/paused/i.test(gRecovered) && !/no hue bridge/i.test(gRecovered),
    JSON.stringify(gRecovered.slice(0, 110)));

  // ===== Scenario J · hue: a LATE discovery must not redirect the credential ============
  // No game in this one. It belongs here because it is the same block: the gates above sit
  // beside the generation check, and reordering them exposed that discovery was writing the
  // widget-global cfg.ip BEFORE that check. connect() runs concurrently with itself — a
  // settings change starts a new one while the old is still in the cloud round trip — and
  // v1api/v2fetch interpolate cfg.ip at REQUEST time. So the stale connection's answer
  // silently redirected the live one, which had already validated the configured bridge and
  // loaded its application key. The witness is the request log: an address the widget was
  // talked into is still an address it spoke to.
  await g.page.close();
  const j = await mountHue(browser, { bridgeIp: '', disco: 'ip', discoIp: HUE_BOGUS });
  check('J1 setup: the bridge hunt is in flight',
    (await j.page.evaluate(() => window.__discoCount)) === 1);

  // The user sets the bridge IP while that hunt is still out. This is the second connect().
  await j.page.evaluate((ip) => window.__wwPush({
    type: 'ww-init',
    settings: { bridgeIp: ip, showScenes: 'on', bgStyle: 'solid' },
    sensors: [], media: null, theme: {}, game: { active: false, process: '' },
    status: { elevated: false, apiVersion: 1 },
  }), HUE_IP);
  await j.page.waitForTimeout(2000);
  const jAsked0 = await hueAsked(j.page);
  const v2ForIp = (log) => log.filter((r) => r.url.indexOf('https://' + HUE_IP + '/clip/v2') === 0).length;
  check('J2 setup: the configured bridge was validated and is being polled',
    jAsked0.some((r) => r.url === 'http://' + HUE_IP + '/api/config') && v2ForIp(jAsked0) > 0,
    `${v2ForIp(jAsked0)} v2 request(s) to the configured bridge`);

  // Only NOW does the abandoned hunt come back, with a different address.
  const v2Before = v2ForIp(jAsked0);
  await j.page.evaluate(() => { window.__discoHold = null; window.__releaseDisco(); });
  await j.page.waitForTimeout(6000);   // the poll ticks every 4s: at least one lands here
  const jAsked1 = await hueAsked(j.page);
  const toBogus = jAsked1.filter((r) => r.url.indexOf(HUE_BOGUS) !== -1);
  check('J3 a discovery that resolves after a newer connection has taken over is not spoken to',
    toBogus.length === 0, toBogus.map((r) => r.url).join(' ') || 'none');
  check('J4 ...and in particular the application key never rides to it',
    toBogus.every((r) => r.url.indexOf(HUE_KEY) === -1 && !r.headers['hue-application-key']),
    toBogus.map((r) => r.url + ' ' + JSON.stringify(r.headers)).join(' ') || 'none');
  // J3 would also be satisfied by a widget that simply stopped talking to anything.
  check('J5 ...and polling carries on against the bridge the user configured',
    v2ForIp(jAsked1) > v2Before, `${v2Before} v2 request(s) before, ${v2ForIp(jAsked1)} after`);

  await browser.close();
  console.log(failures > 0 ? `\n${failures} FAILURES` : '\nALL PASS');
  process.exit(failures > 0 ? 1 : 0);
})();
