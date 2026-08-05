#!/usr/bin/env node
// Hue: a LATE bridge discovery must not redirect the credential.
//
// `connect()` runs concurrently with itself. A settings change starts a second one while
// the first is still in the cloud round trip at discovery.meethue.com, and `v1api`/
// `v2fetch` interpolate `cfg.ip` at REQUEST time rather than at connect time — so a
// discovery that wrote the widget-global `cfg.ip` before the generation check silently
// redirected the connection that had already validated the configured bridge and loaded
// its application key. The fix keeps the resolved address LOCAL until `gen === connectGen`
// commits it.
//
//   J1 · setup: the bridge hunt is in flight
//   J2 · setup: the address the user then configures is validated and being polled
//   J3 · the abandoned hunt's answer is never spoken to
//   J4 · ...and in particular the application key never rides to it
//   J5 · ...while polling carries on against the bridge the user configured, so J3 is not
//        satisfied by a widget that simply stopped talking to anything
//
// The witness is the ww-fetch LOG, not page requests: hue speaks to its bridge exclusively
// through the host proxy (`init.proxy: 'always'`), so none of its traffic is a page request
// at all. Every bridge request is recorded before it is answered, including the ones this
// stub refuses — an address the widget should never have spoken to still has to show up.
//
// Extracted from `gameresume-run.js` when game mode was removed. This scenario never
// involved a game; it shared that file because the generation check is where the (now
// deleted) pause gates sat.
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const SHELL = path.join(REPO, 'src', 'WaveshareWidgets', 'Shell');
const HUE = path.join(REPO, 'widgets', 'hue');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

const HUE_IP = '10.0.0.9';                 // what the user configures, and what holds the key
const HUE_BOGUS = '10.9.9.9';              // what cloud discovery hands back — stale or hostile
const HUE_KEY = 'probe-application-key-9f3a';

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  if (!ok) failures++;
};

const SHELL_PAGE = '<!doctype html><meta charset="utf-8"><title>ww shell</title>'
  + '<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#000}'
  + 'iframe{display:block;border:0;width:100vw;height:100vh}</style>';

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
  // shared origin, and a previous run's cached answer would decide this one.
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
    window.__discoHold = null;      // a promise the test resolves, so the answer can land late
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
      sensors: [], media: null, theme: {},
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

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});

  const j = await mountHue(browser, { bridgeIp: '', disco: 'ip', discoIp: HUE_BOGUS });
  check('J1 setup: the bridge hunt is in flight',
    (await j.page.evaluate(() => window.__discoCount)) === 1);

  // The user sets the bridge IP while that hunt is still out. This is the second connect().
  await j.page.evaluate((ip) => window.__wwPush({
    type: 'ww-init',
    settings: { bridgeIp: ip, showScenes: 'on', bgStyle: 'solid' },
    sensors: [], media: null, theme: {},
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
