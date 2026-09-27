#!/usr/bin/env node
// Jellyfin: Find lists the users and the libraries (#210). Asked the way the shell asks,
// with a ww-discover message to the widget frame, against a stub Jellyfin:
//
//   J1 · the username lists every user, sorted by name, administrators and disabled
//        accounts labelled, asked with the saved API key
//   J2 · a Hidden libraries row lists the server's libraries, sorted, labelled by kind
//        (no kind reads "Mixed"), one per spelling since the list matches by name
//   J3 · it answers before the username or any hidden library is set
//   J4 · any other setting gets no answer from this widget ("unsupported")
//   J5 · a rejected key comes back as the widget's own message, not a list
//   J6 · a reply that is not a list is reported as not Jellyfin's data
//   J7 · with no address or key yet, Find says what is missing
//   J8 · a server that never answers is reported by the widget itself, inside the
//        shell's 20 s wait, not left for the shell to time out
//
// Run: CHROMIUM=/path/to/chrome node tests/harness/jellyfinfind-run.js
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
const WIDGET = path.join(REPO, 'widgets', 'jellyfin');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  if (!ok) failures++;
};

const SHELL_PAGE = '<!doctype html><meta charset="utf-8"><title>ww shell</title>'
  + '<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#000}'
  + 'iframe{display:block;border:0;width:100vw;height:100vh}</style>';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'x-emby-token, content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

// Served in no particular order, so a handler that echoes arrival order fails J1/J2.
const USERS = [
  { Name: 'zoe', Id: 'u3', Policy: { IsAdministrator: false, IsDisabled: false } },
  { Name: 'Admin', Id: 'u1', Policy: { IsAdministrator: true, IsDisabled: false } },
  { Name: 'guest', Id: 'u4', Policy: { IsAdministrator: false, IsDisabled: true } },
  { Name: 'Bob ', Id: 'u2', Policy: { IsAdministrator: false, IsDisabled: false } },
  { Name: '   ', Id: 'u5' },
];
const FOLDERS = { Items: [
  { Name: 'TV Shows', Id: 'f2', CollectionType: 'tvshows' },
  { Name: 'Movies', Id: 'f1', CollectionType: 'movies' },
  { Name: 'Home Videos', Id: 'f3', CollectionType: 'homevideos' },
  { Name: 'movies', Id: 'f5', CollectionType: 'movies' },
  { Name: 'Everything', Id: 'f4' },
] };

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
  await page.route('https://app.plinth/**', (r) =>
    serve(r, SHELL, decodeURIComponent(new URL(r.request().url()).pathname).replace(/^\/+/, '')));
  await page.route('https://widget.test/**', (r) =>
    serve(r, WIDGET, decodeURIComponent(new URL(r.request().url()).pathname).replace(/^\/+/, '') || 'index.html'));
  await page.route('https://shell.test/**', (r) => r.fulfill({ contentType: 'text/html', body: SHELL_PAGE }));
  let status = 200;
  let hang = false;
  let malformed = false;
  const keys = [];
  await page.route('https://jf1.test/**', (r) => {
    const req = r.request();
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS, body: '' });
    const at = new URL(req.url()).pathname;
    if (at === '/Users' || at === '/Library/MediaFolders') {
      keys.push(req.headers()['x-emby-token'] || '');
      if (hang) return new Promise(() => {});   // accepts, then never answers
      if (status !== 200) return r.fulfill({ status, headers: CORS, body: '' });
      const reply = malformed ? { error: 'not a list' } : at === '/Users' ? USERS : FOLDERS;
      return r.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(reply) });
    }
    return r.fulfill({ status: 404, headers: CORS, body: '{}' });
  });
  await page.route(/https?:\/\/(?!(?:app\.plinth|widget\.test|shell\.test|jf1\.test)(?:[/?#:]|$)).*/, (r) => r.abort());

  const shim = fs.readFileSync(path.join(SHELL, 'widget-api.js'), 'utf8') + '\n'
             + fs.readFileSync(path.join(SHELL, 'icue-compat.js'), 'utf8');
  await page.addInitScript(shim);
  // No username and nothing hidden: exactly when Find is needed.
  const settings = { baseUrl: 'https://jf1.test', apiKey: 'stub-key', userName: '', hideLibraries: [],
    view: 'Server overview', refreshSeconds: 300 };
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
      if (m.type === 'ww-discover-result') (window.__discovered = window.__discovered || {})[m.id] = m;
      if (m.type === 'ww-fetch') window.__wwPush({ type: 'ww-fetch-result', id: m.id, error: 'no host in probe' });
    });
  }, { widgetUrl: 'https://widget.test/index.html', widgetOrigin: 'https://widget.test', settings });

  await page.goto('https://shell.test/host.html');
  await page.evaluate(() => window.__wwMount());
  const frame = await (await page.waitForSelector('iframe', { timeout: 10000 })).contentFrame();
  await frame.waitForSelector('#state', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(600);

  const ask = async (id, property, field, waitMs = 5000) => {
    await page.evaluate((q) => window.__wwPush(Object.assign({ type: 'ww-discover' }, q)), { id, property, field });
    for (let i = 0; i < waitMs / 100; i++) {
      const got = await page.evaluate((k) => (window.__discovered || {})[k] || null, id);
      if (got) return got;
      await page.waitForTimeout(100);
    }
    return null;
  };
  const pairs = (r) => (r && Array.isArray(r.options) ? r.options.map((o) => o.value + '|' + (o.label || '')) : []);

  const users = await ask('j1', 'userName', null);
  check('J1 the username lists every user, sorted by name, admins and disabled accounts labelled',
    JSON.stringify(pairs(users)) === JSON.stringify(['Admin|Administrator', 'Bob|', 'guest|Disabled', 'zoe|']),
    JSON.stringify(pairs(users)));
  check('J1b ...asked with the saved API key', keys.length >= 1 && keys.every((k) => k === 'stub-key'), JSON.stringify(keys));

  const libs = await ask('j2', 'hideLibraries', 'name');
  check('J2 a Hidden libraries row lists the libraries, sorted, labelled by kind, one per spelling',
    JSON.stringify(pairs(libs)) === JSON.stringify(['Everything|Mixed', 'Home Videos|Home videos', 'Movies|Movies', 'TV Shows|Shows']),
    JSON.stringify(pairs(libs)));
  check('J3 both answer while no username or hidden library is set',
    pairs(users).length === 4 && pairs(libs).length === 4);

  const other = await ask('j4', 'refreshSeconds', null);
  const otherField = await ask('j4b', 'hideLibraries', 'label');
  check('J4 any other setting gets no answer from this widget',
    !!(other && other.unsupported) && !!(otherField && otherField.unsupported),
    JSON.stringify({ other, otherField }));

  status = 401;
  const rejected = await ask('j5', 'userName', null);
  check('J5 a rejected key comes back as the widget\'s own message',
    !!(rejected && typeof rejected.error === 'string' && /API key was rejected/i.test(rejected.error) && !rejected.options),
    JSON.stringify(rejected));
  status = 200;

  malformed = true;
  const odd = await ask('j6', 'hideLibraries', 'name');
  const oddUsers = await ask('j6b', 'userName', null);
  check('J6 a reply that is not a list is reported as not Jellyfin\'s data',
    [odd, oddUsers].every((r) => r && typeof r.error === 'string' && /not with Jellyfin's data/i.test(r.error) && !r.options),
    JSON.stringify({ odd, oddUsers }));
  malformed = false;

  await page.evaluate(() => window.__wwReinit({ baseUrl: '', apiKey: '', userName: '', hideLibraries: [], refreshSeconds: 300 }));
  await page.waitForTimeout(300);
  const empty = await ask('j7', 'hideLibraries', 'name');
  check('J7 with no address or key, Find says what is missing',
    !!(empty && typeof empty.error === 'string' && /address and an API key first/i.test(empty.error)
      && /libraries/.test(empty.error)),
    JSON.stringify(empty));

  await page.evaluate((s) => window.__wwReinit(s), settings);
  await page.waitForTimeout(300);
  hang = true;
  const t0 = Date.now();
  const silent = await ask('j8', 'userName', null, 25000);
  const took = Date.now() - t0;
  check('J8 a server that never answers is reported by the widget inside the shell\'s 20 s wait',
    !!(silent && typeof silent.error === 'string' && /did not answer in time/i.test(silent.error)) && took < 19000,
    `${took} ms: ${JSON.stringify(silent)}`);
  hang = false;

  await browser.close();
  console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
