#!/usr/bin/env node
// Home Assistant: Find lists the entities (#210). Asked the way the shell asks, with a
// ww-discover message to the widget frame, against a stub Home Assistant:
//
//   F1 · the Entity ID field lists every entity, sorted by id, each labelled with its
//        friendly name, with the saved token on the request
//   F2 · it works before any entity is added (the widget's setup state): Find needs only
//        the address and the token
//   F3 · any other setting gets no answer from this widget ("unsupported")
//   F4 · a rejected token comes back as the widget's own message, not a list
//   F5 · with no address or token yet, Find says what is missing
//   F6 · a Home Assistant that never answers is reported by the widget itself, inside the
//        shell's 20 s wait, not left for the shell to time out
//
// Run: CHROMIUM=/path/to/chrome node tests/harness/hafind-run.js
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

const SHELL_PAGE = '<!doctype html><meta charset="utf-8"><title>ww shell</title>'
  + '<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#000}'
  + 'iframe{display:block;border:0;width:100vw;height:100vh}</style>';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

// Served in no particular order, so a handler that echoes arrival order fails F1.
const STATES = [
  { entity_id: 'switch.fan', state: 'off', attributes: { friendly_name: 'Desk fan' } },
  { entity_id: 'light.kitchen', state: 'on', attributes: { friendly_name: 'Kitchen' } },
  { entity_id: 'sensor.outdoor_temp', state: '12.5', attributes: { friendly_name: 'Outside', unit_of_measurement: '°C' } },
  { entity_id: 'lock.front_door', state: 'locked', attributes: {} },
];
const WANT = ['light.kitchen', 'lock.front_door', 'sensor.outdoor_temp', 'switch.fan'];

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
  let statesStatus = 200;
  let statesHang = false;
  const auth = [];
  await page.route('https://ha1.test/**', (r) => {
    const req = r.request();
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS, body: '' });
    if (new URL(req.url()).pathname === '/api/states') {
      auth.push(req.headers()['authorization'] || '');
      if (statesHang) return new Promise(() => {});   // accepts, then never answers
      if (statesStatus !== 200) return r.fulfill({ status: statesStatus, headers: CORS, body: '' });
      return r.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(STATES) });
    }
    return r.fulfill({ status: 404, headers: CORS, body: '{}' });
  });
  await page.route(/https?:\/\/(?!(?:app\.plinth|widget\.test|shell\.test|ha1\.test)(?:[/?#:]|$)).*/, (r) => r.abort());

  const shim = fs.readFileSync(path.join(SHELL, 'widget-api.js'), 'utf8') + '\n'
             + fs.readFileSync(path.join(SHELL, 'icue-compat.js'), 'utf8');
  await page.addInitScript(shim);
  // No entities: the widget sits on its setup card, which is exactly when Find is needed.
  const settings = { baseUrl: 'https://ha1.test', accessToken: 'stub-token', entities: [], refreshSeconds: 20 };
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

  const ask = async (id, property, field) => {
    await page.evaluate((q) => window.__wwPush(Object.assign({ type: 'ww-discover' }, q)), { id, property, field });
    for (let i = 0; i < 50; i++) {
      const got = await page.evaluate((k) => (window.__discovered || {})[k] || null, id);
      if (got) return got;
      await page.waitForTimeout(100);
    }
    return null;
  };

  const listed = await ask('f1', 'entities', 'entity');
  const opts = listed && Array.isArray(listed.options) ? listed.options : [];
  const values = opts.map((o) => (typeof o === 'string' ? o : o.value));
  const kitchen = opts.find((o) => o && o.value === 'light.kitchen');
  check('F1 every entity is listed, sorted by id, labelled with its friendly name',
    JSON.stringify(values) === JSON.stringify(WANT) && !!kitchen && kitchen.label === 'Kitchen',
    JSON.stringify(opts));
  check('F1b ...asked with the saved token', auth.length >= 1 && auth.every((a) => a === 'Bearer stub-token'), JSON.stringify(auth));
  const setupCard = await frame.evaluate(() => document.body.textContent.includes('Not configured yet')
    && document.body.textContent.includes('Add entities'));
  check('F2 it answers while no entity is configured (the widget is on its setup card)',
    setupCard && values.length === WANT.length, `setup card shown: ${setupCard}`);

  const other = await ask('f3', 'refreshSeconds', null);
  check('F3 any other setting gets no answer from this widget', !!(other && other.unsupported), JSON.stringify(other));

  statesStatus = 401;
  const rejected = await ask('f4', 'entities', 'entity');
  check('F4 a rejected token comes back as the widget\'s own message',
    !!(rejected && typeof rejected.error === 'string' && /token was rejected/i.test(rejected.error) && !rejected.options),
    JSON.stringify(rejected));
  statesStatus = 200;

  await page.evaluate(() => window.__wwReinit({ baseUrl: '', accessToken: '', entities: [], refreshSeconds: 20 }));
  await page.waitForTimeout(300);
  const empty = await ask('f5', 'entities', 'entity');
  check('F5 with no address or token, Find says what is missing',
    !!(empty && typeof empty.error === 'string' && /address and an access token/i.test(empty.error)),
    JSON.stringify(empty));

  // F6 · back to a configured server that then goes silent.
  await page.evaluate(() => window.__wwReinit({ baseUrl: 'https://ha1.test', accessToken: 'stub-token', entities: [], refreshSeconds: 20 }));
  await page.waitForTimeout(300);
  statesHang = true;
  const t0 = Date.now();
  await page.evaluate((q) => window.__wwPush(Object.assign({ type: 'ww-discover' }, q)), { id: 'f6', property: 'entities', field: 'entity' });
  let silent = null;
  for (let i = 0; i < 250 && !silent; i++) {
    silent = await page.evaluate((k) => (window.__discovered || {})[k] || null, 'f6');
    if (!silent) await page.waitForTimeout(100);
  }
  const took = Date.now() - t0;
  check('F6 a server that never answers is reported by the widget inside the shell\'s 20 s wait',
    !!(silent && typeof silent.error === 'string' && /did not answer in time/i.test(silent.error)) && took < 19000,
    `${took} ms: ${JSON.stringify(silent)}`);
  statesHang = false;

  await browser.close();
  console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
