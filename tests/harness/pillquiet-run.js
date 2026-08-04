#!/usr/bin/env node
// The header pill reports EXCEPTIONS, not health (issue #205).
//
// Every stock tile carried a permanent badge in its top-right corner reading LIVE, ALL UP,
// CLEAR, QUIET, LOADED or SCHEDULED — a word that was true from the moment the widget
// worked until the moment it stopped, on every tile at once. The field report is the whole
// argument: "I don't need something telling me it's a live 7-day forecast when it's really
// just a 7-day forecast." A badge that is always present is not a status, it is furniture,
// and it teaches the reader to skip the one corner a widget has to speak from.
//
// The rule now: hidden while healthy, shown only for something the reader would act on.
// So the check has to run BOTH ways, or it is satisfied by simply deleting the pill:
//
//   P1/P3 · a healthy render does NOT put the nominal word on screen
//   P2/P4 · a degraded one still does
//
// --reject matches document.innerText, which omits hidden elements, and widget-base
// uppercases pill text — so the nominal word appearing at all means the pill is showing.
//
// endpoints and ollama carry it because their stock fixtures reach a genuinely healthy
// render and a genuinely degraded one without needing credentials. The other six widgets
// changed by this rule (forecast7, ghqueue, homeassistant, kev, nextevent, wow) are covered
// for RENDERING by the 162-run stock sweep, but their nominal state is not asserted here —
// each needs configured settings plus a fixture shaped to produce it, and an unfalsifiable
// check would be worse than an absent one. Stated rather than glossed.
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const RUNNER = path.join(REPO, 'tools', 'widget-datapath.js');
const FIX = path.join(REPO, 'tests', 'fixtures', 'widgets');

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  if (!ok) failures++;
};

// One target up and one refusing: enough for "1 down" without depending on timing.
const DOWN_TARGETS = JSON.stringify({
  targets: [{ label: 'Router', url: 'http://192.168.1.1/' },
    { label: 'Old box', url: 'http://old.lan/' }],
});

const CASES = [
  { id: 'P1', widget: 'endpoints', stubs: 'endpoints.json',
    args: ['--expect', 'Router', '--reject', 'ALL UP'],
    what: 'every endpoint up leaves the corner empty' },
  { id: 'P2', widget: 'endpoints', stubs: 'endpoints.json',
    args: ['--settings', DOWN_TARGETS, '--expect', 'DOWN'],
    what: '...and an endpoint that is down still says so' },
  { id: 'P3', widget: 'ollama', stubs: 'ollama.json',
    args: ['--expect', 'llama3.1:8b', '--reject', 'LOADED'],
    what: 'models loaded and listed leaves the corner empty' },
  { id: 'P4', widget: 'ollama', stubs: 'ollama-idle.json',
    args: ['--expect', 'IDLE'],
    what: '...and a host with no models loaded still says so' },
];

for (const c of CASES) {
  let out = '';
  let ok = true;
  try {
    out = execFileSync('node', [RUNNER, path.join('widgets', c.widget),
      '--stubs', path.join(FIX, c.stubs), '--slot', 'half', ...c.args],
    { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    ok = false;
    out = (e.stdout || '') + (e.stderr || '');
  }
  // The runner's own FAIL lines are the detail worth surfacing; its PASS lines are noise.
  // But a runner that dies BEFORE printing any — Chromium missing, a throw during launch —
  // has no FAIL line to find, and reporting "runner all green" beside a failed verdict is
  // both self-contradictory and a discarded stack trace. Fall back to what it did say.
  const failLines = out.split('\n').filter((l) => l.includes('FAIL')).join(' | ');
  const detail = failLines ? failLines.slice(0, 200)
    : ok ? 'runner all green'
      : 'runner produced no FAIL line: ' + out.trim().split('\n').slice(-4).join(' | ').slice(0, 300);
  check(`${c.id} ${c.widget}: ${c.what}`, ok, detail);
}

// ===== Part B · recovery INSIDE one mounted instance ==================================
// The four cases above each launch their own process, so the degraded ones start from a
// pill that is still visible from boot ('Loading'/'Checking') and never follow a healthy
// render. That means they pass whether or not anything re-shows a pill the healthy render
// hid — which is the whole risk this change introduces, and it went untested until review
// pointed at it.
//
// So: one widget, one mount, driven healthy → hidden → changed. `ollama` carries it because
// an address change is the fastest post-healthy path back to a visible pill (no poll to wait
// for), and because its reset() → showLoading() is one of the eight assignments added here.
//
// Reading the source, I expected this to land in showLoading() and wrote the check to
// assert the word 'Loading'. It lands in showError(): an address change resets `answered`
// to false, so the first refusal from the new address is "nothing has answered" rather
// than "stale". The assertion is therefore on what the change actually guarantees — the
// pill is VISIBLE again — not on which word it recovers with, which is a race between the
// reset and how fast the new address refuses.
//
// WHAT THIS CHECK CAN AND CANNOT DISTINGUISH, measured rather than assumed. reset() calls
// showLoading() and then tick(), which fails into showError() — so the two added
// assignments are redundant WITH EACH OTHER on this path, and deleting either one alone
// leaves R2 green. Deleting BOTH fails it, with the tile in exactly the state the change
// exists to prevent:
//
//     FAIL R2 ... - {"hidden":true,"text":"Error"}
//
// an error card whose header corner is empty. So R2 falsifies the pair, not either member.
// Worth stating because the obvious single-line revert does NOT turn it red, and a future
// reader deleting one of them would otherwise take a green run as permission.
const { chromium } = require('playwright');
const fs = require('fs');

const SHELL = path.join(REPO, 'src', 'WaveshareWidgets', 'Shell');
const OLLAMA = path.join(REPO, 'widgets', 'ollama');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const SHELL_PAGE = '<!doctype html><meta charset="utf-8"><title>ww shell</title>'
  + '<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#000}'
  + 'iframe{display:block;border:0;width:100vw;height:100vh}</style>';
const BASE_A = 'http://ollama-a.test:11434';
const BASE_B = 'http://ollama-b.test:11434';
const MODELS = { models: [{ name: 'llama3.1:8b', size: 6111111111 }] };

const initFor = (baseUrl) => ({ type: 'ww-init',
  settings: { baseUrl, refreshSeconds: 5, bgStyle: 'solid' },
  sensors: [], media: null, theme: {}, game: { active: false, process: '' },
  status: { elevated: false, apiVersion: 1 } });

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
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
    serve(r, OLLAMA, decodeURIComponent(new URL(r.request().url()).pathname).replace(/^\/+/, '') || 'index.html'));
  await page.route('https://shell.test/**', (r) => r.fulfill({ contentType: 'text/html', body: SHELL_PAGE }));
  await page.route(/https?:\/\/(?!(?:app\.wsw|widget\.test|shell\.test)(?:[/?#]|$)).*/, (r) => r.abort());

  const shim = fs.readFileSync(path.join(SHELL, 'widget-api.js'), 'utf8') + '\n'
             + fs.readFileSync(path.join(SHELL, 'icue-compat.js'), 'utf8');
  await page.addInitScript(shim);
  // The widget is https and its server is plain http, so every call arrives as a ww-fetch
  // for the host-proxy tier rather than as a page request — the shell answers them here.
  await page.addInitScript(({ widgetUrl, widgetOrigin, init, baseA, models }) => {
    if (window.top !== window) return;
    let frame = null;
    window.__serving = baseA;    // which address the fake Ollama answers for
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
      if (m.type === 'ww-ready') return window.__wwPush(init);
      if (m.type !== 'ww-fetch') return;
      const u = String(m.url);
      if (u.indexOf(window.__serving) === 0) {
        return window.__wwPush({ type: 'ww-fetch-result', id: m.id, status: 200,
          contentType: 'application/json', bodyBase64: btoa(JSON.stringify(models)) });
      }
      return window.__wwPush({ type: 'ww-fetch-result', id: m.id, error: 'connection refused' });
    });
  }, { widgetUrl: 'https://widget.test/index.html', widgetOrigin: 'https://widget.test',
    init: initFor(BASE_A), baseA: BASE_A, models: MODELS });

  await page.goto('https://shell.test/host.html');
  await page.evaluate(() => window.__wwMount());
  const frameEl = await page.waitForSelector('iframe', { timeout: 10000 });
  const frame = await frameEl.contentFrame();
  if (!frame) { console.log('  FAIL mount: ollama frame never attached'); await browser.close(); process.exit(1); }
  await frame.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(2000);

  const pill = () => frame.evaluate(() => {
    const p = document.getElementById('pill');
    return { hidden: !!(p && (p.hidden || getComputedStyle(p).display === 'none')),
      text: (p && p.textContent) || '' };
  });

  // R1 is the PRECONDITION, asserted rather than assumed: if the healthy render never hid
  // the pill, R2 below is testing nothing at all — it would pass against a widget that
  // simply left the pill up from boot.
  const healthy = await pill();
  check('R1 setup: a healthy render hid the pill, so there is something to recover from',
    healthy.hidden, JSON.stringify(healthy));

  // The user retypes the server address, and the new one is not answering yet. Whichever
  // card that produces, the pill has to come back from hidden — that is the assignment
  // under test, and without it the tile shows an error with an empty corner.
  await page.evaluate((init) => window.__wwPush(init), initFor(BASE_B));
  await page.waitForTimeout(1500);
  const afterSwitch = await pill();
  check('R2 a state change after that healthy render brings the pill back',
    !afterSwitch.hidden && afterSwitch.text.trim() !== '', JSON.stringify(afterSwitch));

  // ...and it is a recovery, not a badge that is simply stuck on now: point the fake server
  // at the new address and the pill goes away again on the next healthy render. Without
  // this, R2 is satisfied by a widget that shows the pill from here on forever.
  await page.evaluate((b) => { window.__serving = b; }, BASE_B);
  // One failure has already stretched the interval (refreshMs * 2^failures), so this waits
  // out the backed-off retry rather than the nominal 5s.
  await page.waitForTimeout(16000);
  const recovered = await pill();
  check('R3 ...and it goes quiet again once the new address answers',
    recovered.hidden, JSON.stringify(recovered));

  await browser.close();
  console.log(failures > 0 ? `\n${failures} FAILURES` : '\nALL PASS');
  process.exit(failures > 0 ? 1 : 0);
})();
