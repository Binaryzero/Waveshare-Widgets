#!/usr/bin/env node
// Do the two fetch tiers show a widget the same response headers? (#169)
//
//   node tests/harness/proxy-headers-run.js
//   node tests/harness/proxy-headers-run.js --shim path/to/widget-api.js
//
// WHY THIS EXISTS. WW.fetch has two tiers and a widget cannot ask which one served it —
// the remote server's status code decides that, and the shim escalates every direct 403
// or 429 through the host proxy. So any difference between the tiers is a difference a
// widget cannot detect, cannot branch on, and will meet only in the field.
//
// The proxy hop used to return status, statusText, contentType and the body, and nothing
// else. A widget reading a header therefore saw it on the direct tier and lost it on the
// escalation — and because the escalation is triggered by 403/429, the responses most
// likely to carry rate-limit metadata were exactly the ones served by the tier that
// dropped it. A primary rate limit arrived as a bare "Forbidden".
//
// The allow-list is read from tools/proxy-response-headers.json, the same file the host
// is checked against by tools/ProxyHeaders, so this runner cannot drift into asserting
// parity for a list the host no longer forwards.
//
// TOPOLOGY mirrors widget-datapath.js: the shim runs in an IFRAME whose parent answers
// ww-fetch, because that is the only arrangement in which the shim is alive at all.
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};

const SHELL = path.join(__dirname, '../../src/Plinth/Shell');
// --shim points at a DIFFERENT copy of widget-api.js, which is how a change to the shim
// gets falsified: run these cases against the version before it and require the ones it
// fixes to fail there.
const shimPath = opt('shim', path.join(SHELL, 'widget-api.js'));

const FORWARD = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../tools/proxy-response-headers.json'), 'utf8')).forward;

function loadPlaywright() {
  for (const c of ['playwright', '/opt/node22/lib/node_modules/playwright',
    path.join(process.env.HOME || '', 'node_modules/playwright')]) {
    try { return require(c); } catch (e) { /* next */ }
  }
  console.error('playwright not found');
  process.exit(2);
}

// The headers a well-behaved API sends alongside a rate limit, plus the ones that must
// NOT cross the hop. Set-Cookie is the one that matters: the proxy holds cookies the page
// cannot see, and handing their values to widget script would undo exactly that.
const RESPONSE_HEADERS = {
  'ETag': 'W/"abc123"',
  'Last-Modified': 'Wed, 21 Oct 2026 07:28:00 GMT',
  'Retry-After': '120',
  'Link': '<https://api.test/items?page=2>; rel="next", <https://api.test/items?page=9>; rel="last"',
  'X-RateLimit-Limit': '5000',
  'X-RateLimit-Remaining': '0',
  'X-RateLimit-Reset': '1785740000',
  'X-RateLimit-Used': '5000',
  'X-RateLimit-Resource': 'core',
  // Refused, all of them.
  'Set-Cookie': 'session=supersecret; Path=/; HttpOnly',
  'Server': 'nginx/1.25.3',
  'WWW-Authenticate': 'Bearer realm="api"',
  'X-Internal-Trace': 'abcdef',
};
const MUST_NOT_CROSS = ['Set-Cookie', 'Server', 'WWW-Authenticate', 'X-Internal-Trace'];

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ' - ' + detail}`);
  if (!ok) failures++;
};

(async () => {
  const { chromium } = loadPlaywright();
  const shim = fs.readFileSync(shimPath, 'utf8');
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage();
  const pageErrors = [];
  let directHits = 0, proxyTargetHits = 0;
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));

  await page.route('https://shell.test/**', (r) => r.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><title>tier parity</title>',
  }));
  await page.route('https://widget.test/**', (r) => r.fulfill({
    contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>w</title>',
  }));

  // The DIRECT tier. Answered 200, NOT 403 — and that detail is the whole reason this
  // arm is trustworthy. The shim escalates every direct 403 and 429 through the proxy, so
  // a 403 fixture here would be served by the PROXY on both arms, and the parity
  // assertions would compare the proxy tier against itself: green on a build where the
  // direct tier reads nothing at all. The first version of this runner did exactly that.
  // Rate-limit headers on a 200 are the ordinary case anyway — GitHub sends X-RateLimit-*
  // on every response, not only on the refusal.
  //
  // A cross-origin read exposes only the CORS-safelisted names unless the server says
  // otherwise, so the fixture models an API whose metadata is meant to be read.
  await page.route('https://direct.test/**', (r) => {
    directHits++;
    if (r.request().method() === 'OPTIONS') {
      return r.fulfill({ status: 204, headers: {
        'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    }
    return r.fulfill({
      status: 200,
      headers: Object.assign({
        'access-control-allow-origin': '*',
        'access-control-expose-headers': Object.keys(RESPONSE_HEADERS).join(', '),
        'content-type': 'application/json',
      }, RESPONSE_HEADERS),
      body: JSON.stringify({ message: 'ok' }),
    });
  });
  // The PROXY tier's target: refused outright at the browser layer, exactly as a
  // CORS-blocking API is, so WW.fetch escalates and the host answers.
  await page.route('https://proxied.test/**', (r) => { proxyTargetHits++; return r.abort(); });

  await page.addInitScript(shim);
  await page.addInitScript((forward) => {
    if (window.top !== window) return;
    window.__forward = forward;
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    frame.src = 'https://widget.test/index.html#ww-slot=p0s0';
    const attach = () => document.body.appendChild(frame);
    if (document.body) attach(); else document.addEventListener('DOMContentLoaded', attach, { once: true });
    window.addEventListener('message', (ev) => {
      if (!frame.contentWindow || ev.source !== frame.contentWindow) return;
      if (ev.origin !== 'https://widget.test') return;
      const m = ev.data || {};
      if (m.type === 'ww-ready') {
        return ev.source.postMessage({ type: 'ww-init', settings: {}, sensors: [], media: null,
          theme: {}, status: { elevated: false, apiVersion: 1 } }, ev.origin);
      }
      if (m.type !== 'ww-fetch') return;
      // The HOST's shape: status, statusText, contentType, bodyBase64, and an
      // allow-listed header map. Anything outside the list is dropped here, which is
      // what DashboardWindow.ForwardableResponseHeaders does.
      const all = window.__responseHeaders;
      const headers = {};
      for (const name of Object.keys(all)) {
        if (forward.includes(name.toLowerCase())) headers[name] = all[name];
      }
      const body = JSON.stringify({ message: 'ok' });
      const bytes = new TextEncoder().encode(body);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      window.__proxyServed = (window.__proxyServed || 0) + 1;
      ev.source.postMessage({ type: 'ww-fetch-result', id: m.id, status: 200,
        statusText: 'OK', contentType: 'application/json',
        bodyBase64: btoa(bin), headers }, ev.origin);
    });
  }, FORWARD.map((n) => n.toLowerCase()));

  await page.addInitScript((h) => { window.__responseHeaders = h; }, RESPONSE_HEADERS);
  await page.goto('https://shell.test/host.html');
  const frameEl = await page.waitForSelector('iframe', { timeout: 10000 });
  const frame = await frameEl.contentFrame();
  await frame.waitForFunction(() => typeof window.WW !== 'undefined' && typeof window.WW.fetch === 'function',
    null, { timeout: 10000 });

  // Read every header of interest off each tier, from inside the widget frame.
  // Content-Type is queried too though it is not in the fixture map: it rides its own
  // field rather than the header map, and the point is that it still arrives.
  const names = Object.keys(RESPONSE_HEADERS).concat(['Content-Type']);
  const direct = await frame.evaluate(async ({ target, names }) => {
    const res = await WW.fetch(target);
    const out = { status: res.status, headers: {} };
    for (const n of names) out.headers[n] = res.headers.get(n);
    return out;
  }, { target: 'https://direct.test/items', names });
  const proxied = await frame.evaluate(async ({ target, names }) => {
    const res = await WW.fetch(target);
    const out = { status: res.status, headers: {} };
    for (const n of names) out.headers[n] = res.headers.get(n);
    return out;
  }, { target: 'https://proxied.test/items', names });

  const proxyServed = await page.evaluate(() => window.__proxyServed || 0);
  console.log('proxy/direct tier response-header parity');
  check('setup: the direct tier answered', direct.status === 200, 'status ' + direct.status);
  check('setup: the proxy tier answered', proxied.status === 200, 'status ' + proxied.status);
  // The arms have to be DIFFERENT tiers, and nothing else in this file proves that. The
  // first version compared the proxy against itself and reported agreement.
  check('setup: the direct arm was served DIRECTLY, without escalating',
    directHits > 0 && proxyServed === 1,
    `direct-target hits=${directHits}, host proxy answered ${proxyServed} request(s)`);
  check('setup: the proxy arm really did escalate',
    proxyTargetHits > 0 && proxyServed === 1,
    `proxy-target hits=${proxyTargetHits}`);
  check('setup: the direct tier really does expose the metadata',
    direct.headers['X-RateLimit-Remaining'] === '0',
    JSON.stringify(direct.headers['X-RateLimit-Remaining']));

  // THE POINT. Every forwarded name reads the same on both tiers.
  for (const name of names) {
    if (MUST_NOT_CROSS.includes(name)) continue;
    check(`both tiers agree on ${name}`,
      proxied.headers[name] === direct.headers[name],
      `direct=${JSON.stringify(direct.headers[name])} proxy=${JSON.stringify(proxied.headers[name])}`);
  }
  // Link is sent as one header with two comma-joined values; a widget parsing pagination
  // needs both, and "whichever arrived last" is the shape this gets wrong.
  check('a multi-value Link survives the hop whole',
    /rel="next"/.test(proxied.headers.Link || '') && /rel="last"/.test(proxied.headers.Link || ''),
    JSON.stringify(proxied.headers.Link));

  // And the allow-list is an allow-list.
  for (const name of MUST_NOT_CROSS) {
    check(`${name} does NOT cross the hop`, proxied.headers[name] === null,
      JSON.stringify(proxied.headers[name]));
  }
  // Content-Type still arrives on its own field rather than through the map.
  check('Content-Type still arrives on the proxy tier',
    /application\/json/.test(proxied.headers['Content-Type'] || ''),
    JSON.stringify(proxied.headers['Content-Type']));

  if (pageErrors.length) check('no page errors', false, pageErrors.join(' | '));
  await browser.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nboth tiers agree on every forwarded header');
  process.exit(failures ? 1 : 0);
})();
