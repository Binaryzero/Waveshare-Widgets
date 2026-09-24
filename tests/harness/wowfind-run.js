#!/usr/bin/env node
// WoW Panel: Find lists the realms (#210). Asked the way the shell asks, with a ww-discover
// message to the widget frame. The OAuth exchange travels the host-proxy tier, as on the
// panel, so the stub shell answers it as ww-fetch; the realm index is on the direct tier.
//
//   F1 · the Realm setting lists every realm of the region as its slug, labelled with its
//        name and sorted by name, read from the dynamic namespace with the bought token
//   F2 · it answers before a realm or character is set (the widget's setup card)
//   F3 · the character, and any other setting, get no answer from this widget
//   F4 · a region change asks that region's host, namespace and locale
//   F5 · rejected client credentials come back as the widget's own message
//   F6 · with no client credentials yet, Find says what is missing
//   F7 · a slow sign-in and a slow realm read, each inside its own request deadline but
//        20 s together, are reported by the widget inside the shell's 20 s wait, not left
//        for the shell to time out
//
// Run: CHROMIUM=/path/to/chrome node tests/harness/wowfind-run.js
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
const WIDGET = path.join(REPO, 'widgets', 'wow');
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
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};
// Served out of order, so a handler that echoes arrival order fails F1.
const REALMS = {
  us: [
    { id: 3, name: "Kel'Thuzad", slug: 'kelthuzad' },
    { id: 1, name: 'Argent Dawn', slug: 'argent-dawn' },
    { id: 2, name: 'Bleeding Hollow', slug: 'bleeding-hollow' },
  ],
  eu: [{ id: 9, name: 'Silvermoon', slug: 'silvermoon' }],
};

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
  const asked = [];
  let realmsDelayMs = 0;
  await page.route(/https:\/\/(us|eu)\.api\.blizzard\.com\/.*/, (r) => {
    const req = r.request();
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS, body: '' });
    const u = new URL(req.url());
    const region = u.host.split('.')[0];
    asked.push({ region, path: u.pathname, namespace: u.searchParams.get('namespace'),
      locale: u.searchParams.get('locale'), auth: req.headers()['authorization'] || '' });
    if (u.pathname === '/data/wow/realm/index' && realmsDelayMs)
      return new Promise((res) => setTimeout(res, realmsDelayMs)).then(() => r.fulfill({ status: 200, headers: CORS,
        contentType: 'application/json', body: JSON.stringify({ _links: {}, realms: REALMS[region] || [] }) }));
    if (u.pathname === '/data/wow/realm/index')
      return r.fulfill({ status: 200, headers: CORS, contentType: 'application/json',
        body: JSON.stringify({ _links: {}, realms: REALMS[region] || [] }) });
    return r.fulfill({ status: 404, headers: CORS, body: '{}' });
  });
  // The token exchange is proxy-only; a direct request is a contract break.
  await page.route('https://oauth.battle.net/**', (r) => { failures++;
    console.log('  FAIL token exchange hit the direct tier (must be proxy-only)'); return r.abort(); });
  await page.route(/https?:\/\/(?!(?:app\.plinth|widget\.test|shell\.test|(?:us|eu)\.api\.blizzard\.com|oauth\.battle\.net)(?:[/?#]|$)).*/,
    (r) => r.abort());

  const shim = fs.readFileSync(path.join(SHELL, 'widget-api.js'), 'utf8') + '\n'
             + fs.readFileSync(path.join(SHELL, 'icue-compat.js'), 'utf8');
  await page.addInitScript(shim);
  // No realm or character yet: the widget is on its setup card, which is when Find is needed.
  const settings = { region: 'us', realm: '', character: '', clientId: 'stub-id', clientSecret: 'stub-secret', refreshMinutes: 30 };
  await page.addInitScript(({ widgetUrl, widgetOrigin, settings, tokenBody }) => {
    if (window.top !== window) return;
    let frame = null;
    window.__tokenStatus = 200;
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
      if (m.type === 'ww-fetch') {
        const url = String(m.url || '');
        if (url.startsWith('https://oauth.battle.net/token'))
          return setTimeout(() => window.__wwPush(window.__tokenStatus === 200
            ? { type: 'ww-fetch-result', id: m.id, status: 200, contentType: 'application/json', bodyBase64: btoa(tokenBody) }
            : { type: 'ww-fetch-result', id: m.id, status: window.__tokenStatus, contentType: 'application/json',
              bodyBase64: btoa('{"error":"invalid_client"}') }), window.__tokenDelay || 0);
        return window.__wwPush({ type: 'ww-fetch-result', id: m.id, error: 'offline probe' });
      }
    });
  }, {
    widgetUrl: 'https://widget.test/index.html', widgetOrigin: 'https://widget.test', settings,
    tokenBody: JSON.stringify({ access_token: 'stub-bearer', token_type: 'bearer', expires_in: 86400 }),
  });

  await page.goto('https://shell.test/host.html');
  await page.evaluate(() => window.__wwMount());
  const frame = await (await page.waitForSelector('iframe', { timeout: 10000 })).contentFrame();
  await page.waitForTimeout(800);

  const ask = async (id, property, field) => {
    await page.evaluate((q) => window.__wwPush(Object.assign({ type: 'ww-discover' }, q)), { id, property, field });
    for (let i = 0; i < 60; i++) {
      const got = await page.evaluate((k) => (window.__discovered || {})[k] || null, id);
      if (got) return got;
      await page.waitForTimeout(100);
    }
    return null;
  };
  const optsOf = (res) => (res && Array.isArray(res.options) ? res.options : []);

  const us = await ask('f1', 'realm', null);
  const usOpts = optsOf(us);
  const first = asked.find((a) => a.path === '/data/wow/realm/index') || {};
  check('F1 every realm is listed as its slug, labelled with its name, sorted by name',
    JSON.stringify(usOpts) === JSON.stringify([
      { value: 'argent-dawn', label: 'Argent Dawn' },
      { value: 'bleeding-hollow', label: 'Bleeding Hollow' },
      { value: 'kelthuzad', label: "Kel'Thuzad" },
    ]), JSON.stringify(us));
  check('F1b ...from the dynamic namespace, in the region\'s locale, with the token the sign-in bought',
    first.namespace === 'dynamic-us' && first.locale === 'en_US' && first.auth === 'Bearer stub-bearer',
    JSON.stringify(first));
  const setupCard = await frame.evaluate(() => document.body.textContent.includes('Not configured yet'));
  check('F2 it answers while no realm or character is set (the widget is on its setup card)',
    setupCard && usOpts.length === 3, `setup card shown: ${setupCard}`);

  const character = await ask('f3a', 'character', null);
  const other = await ask('f3b', 'refreshMinutes', null);
  check('F3 the character, and any other setting, get no answer from this widget',
    !!(character && character.unsupported && other && other.unsupported), JSON.stringify([character, other]));

  await page.evaluate((s) => window.__wwReinit(s), Object.assign({}, settings, { region: 'eu' }));
  await page.waitForTimeout(300);
  const eu = await ask('f4', 'realm', null);
  const euAsk = asked.filter((a) => a.region === 'eu').pop() || {};
  check('F4 a region change asks that region\'s host, namespace and locale',
    JSON.stringify(optsOf(eu)) === JSON.stringify([{ value: 'silvermoon', label: 'Silvermoon' }])
      && euAsk.namespace === 'dynamic-eu' && euAsk.locale === 'en_GB', JSON.stringify(euAsk));

  // New credentials, so the cached token is not reused, and an exchange that refuses them.
  await page.evaluate(() => { window.__tokenStatus = 401; });
  await page.evaluate((s) => window.__wwReinit(s), Object.assign({}, settings, { clientId: 'wrong-id' }));
  await page.waitForTimeout(300);
  const refused = await ask('f5', 'realm', null);
  check('F5 rejected client credentials come back as the widget\'s own message',
    !!(refused && typeof refused.error === 'string' && /rejected the client credentials/i.test(refused.error) && !refused.options),
    JSON.stringify(refused));
  await page.evaluate(() => { window.__tokenStatus = 200; });

  await page.evaluate((s) => window.__wwReinit(s), Object.assign({}, settings, { clientId: '', clientSecret: '' }));
  await page.waitForTimeout(300);
  const empty = await ask('f6', 'realm', null);
  check('F6 with no client credentials, Find says what is missing',
    !!(empty && typeof empty.error === 'string' && /client id and secret/i.test(empty.error)), JSON.stringify(empty));

  // F7 · new credentials (so a sign-in is needed), a 10 s sign-in and a 10 s realm read.
  await page.evaluate(() => { window.__tokenDelay = 10000; });
  await page.evaluate((s) => window.__wwReinit(s), Object.assign({}, settings, { clientId: 'slow-id' }));
  await page.waitForTimeout(300);
  realmsDelayMs = 10000;
  const t0 = Date.now();
  await page.evaluate((q) => window.__wwPush(Object.assign({ type: 'ww-discover' }, q)), { id: 'f7', property: 'realm', field: null });
  let silent = null;
  for (let i = 0; i < 250 && !silent; i++) {
    silent = await page.evaluate((k) => (window.__discovered || {})[k] || null, 'f7');
    if (!silent) await page.waitForTimeout(100);
  }
  const took = Date.now() - t0;
  check('F7 a slow sign-in plus a slow read is reported by the widget inside the shell\'s 20 s wait',
    !!(silent && typeof silent.error === 'string' && /did not answer in time/i.test(silent.error)) && took < 19000,
    `${took} ms: ${JSON.stringify(silent)}`);
  realmsDelayMs = 0;
  await page.evaluate(() => { window.__tokenDelay = 0; });

  await browser.close();
  console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
