#!/usr/bin/env node
// Home Assistant: a poll that begins mid-command must not release the action guard (#172).
//
// Each entity carries a guard while a command to it is outstanding, so a second press
// cannot send a second service against the same stale state. The guard is released by
// the first poll that can speak for the command's outcome. It used to be stamped with the
// poll sequence current when the command was SENT, and released by any poll with a higher
// sequence — so a SCHEDULED poll that began between the send and the settle released it,
// though Home Assistant may still have been answering with the pre-command state. A second
// press was then accepted in flight; on a lock, that is a second service call against a
// state the first one was in the middle of changing.
//
// Timing is the whole test, so it is synchronised on the requests themselves, never on
// elapsed time alone (issue #172 records two earlier probes that guessed from the interval
// and tested nothing):
//
//   H1 · a scheduled poll that lands WHILE a command is in flight does not release the
//        guard: a second press during the command sends nothing. The probe first proves
//        the poll really fell inside the window, or it fails rather than passing vacuously.
//   H2 · the guard is not stuck: after the command settles and a poll that began after it
//        lands, the next press is accepted.
//   H3 · a settings change (a new server) while a command is in flight does not strand the
//        guard: once the new server's first poll lands, the tile acts again.
//   H4 · one command's backstop timer does not open the NEXT command's guard: a press during
//        a second command, after the first command's timer has fired, sends nothing.
//
// A light (tap) stands in for a lock (hold): the guard is the same code for every domain,
// and a tap keeps the timing to the requests alone.
//
// Run: CHROMIUM=/path/to/chrome node tests/harness/haguard-run.js
'use strict';
const fs = require('fs');
const path = require('path');

function loadPlaywright() {
  const candidates = ['playwright', '/opt/node22/lib/node_modules/playwright',
    path.join(process.env.HOME || '', 'node_modules/playwright')];
  for (const c of candidates) { try { return require(c); } catch (e) { /* next */ } }
  console.error('playwright not found — npm i -g playwright (and provide a chromium via CHROMIUM)');
  process.exit(1);
}
const { chromium } = loadPlaywright();

const REPO = path.resolve(__dirname, '..', '..');
const SHELL = path.join(REPO, 'src', 'Plinth', 'Shell');
const WIDGET = path.join(REPO, 'widgets', 'homeassistant');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(20); }
  throw new Error('timed out waiting for ' + what);
}

const SHELL_PAGE = '<!doctype html><meta charset="utf-8"><title>ww shell</title>'
  + '<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#000}'
  + 'iframe{display:block;border:0;width:100vw;height:100vh}</style>';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};
const ENTITY = 'light.kitchen';

// One stub Home Assistant, answering on two hosts so H3 can retarget the tile.
function stub() {
  const s = { on: false, polls: [], services: [], held: null };
  s.statesBody = () => JSON.stringify([{ entity_id: ENTITY, state: s.on ? 'on' : 'off',
    attributes: { friendly_name: 'Kitchen' } }]);
  // The next service call is held until release() — the command window the test controls.
  // Returns the release; the caller keeps it, because the route takes the hold when the
  // call arrives.
  s.hold = () => { let release; const p = new Promise((r) => { release = r; }); s.held = { p }; return release; };
  return s;
}

async function mount(browser, ha, settings) {
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  page.on('pageerror', (e) => { failures++; console.log('[pageerror]', String(e).slice(0, 300)); });
  const serve = (route, dir, rel) => {
    const root = path.resolve(dir);
    const file = path.resolve(root, rel);
    if ((file === root || file.startsWith(root + path.sep)) && fs.existsSync(file) && fs.statSync(file).isFile())
      return route.fulfill({ contentType: MIME[path.extname(file)] || 'text/plain', body: fs.readFileSync(file) });
    return route.fulfill({ status: 404, body: '' });
  };
  await page.route('https://app.plinth/**', (r) =>
    serve(r, SHELL, decodeURIComponent(new URL(r.request().url()).pathname).replace(/^\/+/, '')));
  await page.route('https://widget.test/**', (r) =>
    serve(r, WIDGET, decodeURIComponent(new URL(r.request().url()).pathname).replace(/^\/+/, '') || 'index.html'));
  await page.route('https://shell.test/**', (r) => r.fulfill({ contentType: 'text/html', body: SHELL_PAGE }));
  await page.route(/https:\/\/ha[12]\.test\/.*/, async (r) => {
    const req = r.request();
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS, body: '' });
    const url = new URL(req.url());
    if (url.pathname === '/api/states') {
      ha.polls.push({ at: Date.now(), host: url.host });
      return r.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: ha.statesBody() });
    }
    if (url.pathname.startsWith('/api/services/')) {
      const call = { at: Date.now(), path: url.pathname, settledAt: 0 };
      ha.services.push(call);
      const held = ha.held;
      ha.held = null;
      if (held) await held.p;
      ha.on = !ha.on;
      call.settledAt = Date.now();
      return r.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: '[]' });
    }
    return r.fulfill({ status: 404, headers: CORS, body: '{}' });
  });
  await page.route(/https?:\/\/(?!(?:app\.plinth|widget\.test|shell\.test|ha[12]\.test)(?:[/?#:]|$)).*/, (r) => r.abort());

  const shim = fs.readFileSync(path.join(SHELL, 'widget-api.js'), 'utf8') + '\n'
             + fs.readFileSync(path.join(SHELL, 'icue-compat.js'), 'utf8');
  await page.addInitScript(shim);
  await page.addInitScript(({ widgetUrl, widgetOrigin, settings }) => {
    if (window.top !== window) return;
    let frame = null;
    window.__wwMount = () => {
      frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      frame.src = widgetUrl + '#ww-slot=p0s0';
      (document.body || document.documentElement).appendChild(frame);
    };
    const init = (s) => ({ type: 'ww-init', settings: s, sensors: [], media: null, theme: {},
      status: { elevated: false, apiVersion: 1 } });
    window.__wwPush = (msg) => { if (frame && frame.contentWindow) frame.contentWindow.postMessage(msg, widgetOrigin); };
    window.__wwReinit = (s) => window.__wwPush(init(s));
    window.addEventListener('message', (ev) => {
      if (!frame || ev.source !== frame.contentWindow || ev.origin !== widgetOrigin) return;
      const m = ev.data || {};
      if (m.type === 'ww-ready') return window.__wwPush(init(settings));
      // Direct requests carry CORS here, so nothing should need the host tier; refuse it
      // so a request that did fall through fails loudly rather than hanging.
      if (m.type === 'ww-fetch') window.__wwPush({ type: 'ww-fetch-result', id: m.id, error: 'no host in probe' });
    });
  }, { widgetUrl: 'https://widget.test/index.html', widgetOrigin: 'https://widget.test', settings });

  await page.goto('https://shell.test/host.html');
  await page.evaluate(() => window.__wwMount());
  const frame = await (await page.waitForSelector('iframe', { timeout: 10000 })).contentFrame();
  await frame.waitForSelector('.ent.pressable', { timeout: 10000 });
  return { page, frame };
}

const SETTINGS = { baseUrl: 'https://ha1.test', accessToken: 'probe-token',
  entities: [{ entity: ENTITY }], refreshSeconds: 5 };
const tap = (frame) => frame.click('.ent.pressable');

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});

  // ---- H1 / H2 -------------------------------------------------------------------------
  {
    const ha = stub();
    const { page, frame } = await mount(browser, ha, SETTINGS);
    await until(() => ha.polls.length >= 1, 10000, 'the first poll');
    // Tap ~3.5s after a poll landed, so the next SCHEDULED one (5s cadence) falls ~1.5s
    // into a command that is held for as long as the probe likes.
    const anchor = ha.polls[ha.polls.length - 1].at;
    await sleep(Math.max(0, anchor + 3500 - Date.now()));
    const pollsBefore = ha.polls.length;
    const release = ha.hold();
    await tap(frame);
    await until(() => ha.services.length === 1, 3000, 'the first command');
    const cmd = ha.services[0];
    await until(() => ha.polls.length > pollsBefore, 6000, 'the scheduled poll inside the command');
    const inside = ha.polls[pollsBefore];
    await sleep(400);   // let the widget take in that poll's answer
    check('H0 the scheduled poll really began inside the command window (or H1 proves nothing)',
      inside.at > cmd.at && cmd.settledAt === 0,
      `poll began ${inside.at - cmd.at}ms after the send; command still held: ${cmd.settledAt === 0}`);
    await tap(frame);   // the press that must be refused
    await sleep(400);
    const sentDuring = ha.services.length;
    check('H1 a poll that landed mid-command did not release the guard: a second press sent nothing',
      sentDuring === 1, `${sentDuring} service call(s) while the first was in flight`);

    // H2: settle the command; the reconciling poll begins after it and must release.
    const pollsAtSettle = ha.polls.length;
    release();
    await until(() => cmd.settledAt > 0, 3000, 'the command to settle');
    await until(() => ha.polls.some((p, i) => i >= pollsAtSettle && p.at >= cmd.settledAt), 8000,
      'a poll that began after the command settled');
    await sleep(400);
    const before = ha.services.length;
    await tap(frame);
    await until(() => ha.services.length > before, 3000, 'a press after reconciliation').catch(() => {});
    check('H2 the guard is not stuck: once a poll begun after the command lands, the next press is sent',
      ha.services.length === before + 1, `${ha.services.length - before} call(s) for the press after reconciliation`);
    await page.close();
  }

  // ---- H3 · a new server while a command is in flight ---------------------------------------
  {
    const ha = stub();
    const { page, frame } = await mount(browser, ha, SETTINGS);
    await until(() => ha.polls.length >= 1, 10000, 'the first poll');
    await sleep(300);
    const release = ha.hold();
    await tap(frame);
    await until(() => ha.services.length === 1, 3000, 'the command');
    // Retarget mid-command: a different server is a new generation, and the command's
    // own settle path returns early for it.
    await page.evaluate((s) => window.__wwReinit(s), Object.assign({}, SETTINGS, { baseUrl: 'https://ha2.test' }));
    await sleep(200);
    release();
    await until(() => ha.services[0].settledAt > 0, 3000, 'the command to settle');
    const settled = ha.services[0].settledAt;
    await until(() => ha.polls.some((p) => p.host === 'ha2.test' && p.at >= settled), 8000,
      'the new server to be polled after the command settled');
    await frame.waitForSelector('.ent.pressable', { timeout: 5000 });
    await sleep(400);
    const before = ha.services.length;
    await tap(frame);
    await until(() => ha.services.length > before, 3000, 'a press on the new server').catch(() => {});
    check('H3 a settings change mid-command does not strand the guard: the tile acts again',
      ha.services.length === before + 1, `${ha.services.length - before} call(s) for the press after the change`);
    await page.close();
  }

  // ---- H4 · the first command's backstop does not open the second's guard ------------------
  {
    const ha = stub();
    const { page, frame } = await mount(browser, ha, SETTINGS);
    await until(() => ha.polls.length >= 1, 10000, 'the first poll');
    await sleep(300);
    await tap(frame);                                       // command 1, answered at once
    await until(() => ha.services.length === 1 && ha.services[0].settledAt > 0, 3000, 'command 1');
    const firstSettled = ha.services[0].settledAt;
    await until(() => ha.polls.some((p) => p.at >= firstSettled), 8000, 'the reconciling poll');
    await sleep(400);
    const release = ha.hold();
    await tap(frame);                                       // command 2, held
    await until(() => ha.services.length === 2, 3000, 'command 2');
    // Command 1's backstop fires ACT_DEADLINE (8s) after it settled; command 2 is still held.
    await sleep(Math.max(0, firstSettled + 8000 + 400 - Date.now()));
    const still = ha.services[1].settledAt === 0;
    await tap(frame);
    await sleep(400);
    const sent = ha.services.length;
    release();
    check('H4 the first command\'s backstop timer does not open the second command\'s guard',
      still && sent === 2, `command 2 still in flight: ${still}; ${sent} call(s) after the third press`);
    await page.close();
  }

  await browser.close();
  console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
