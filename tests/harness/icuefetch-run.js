#!/usr/bin/env node
// Issue #37 — "iCUE-compat fetch relief: Reddit answers 403 through the shim's
// proxy path (works for the stock Reddit widget)". Investigation found the
// transport tiers were already shared; the REAL deltas were client-side:
//   - the shim dropped every request header on the proxy hop (an Authorization
//     header vanishing turns a private feed into a bot-wall-looking 403 no
//     proxy tier can rescue),
//   - the shim had no proxy-first session memory (every poll re-fired the
//     doomed CORS attempt),
//   - widget-api's own proxyFetch dropped Headers-instance headers (plain
//     objects only).
// These probes prove the unified behavior end-to-end through the REAL shell
// relay: shim escalation forwards Headers/pairs/plain headers (content-type
// excluded — it rides the dedicated field), binary bodies survive, the memo
// skips the doomed native attempt, and WW.fetch serializes Headers instances.
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const http = require('http');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const SHELL = path.join(REPO, 'src', 'Plinth', 'Shell');
const FIXTURES = path.join(__dirname, 'fixtures');

// Minimal static file server so the suite is fully self-contained.
function staticServer(rootDir, port) {
  const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
  const srv = http.createServer((req, res) => {
    try {
      const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = path.join(rootDir, path.normalize(p).replace(/^([/\\.])+/, ''));
      if (!file.startsWith(rootDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      res.end(fs.readFileSync(file));
    } catch (e) { res.writeHead(500); res.end(); }
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  if (!ok) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const widgets = [
  { id: 'icue', name: 'iCUE Fixture', author: 'WW', url: 'http://localhost:8942/icuefetch/index.html', supportedSlots: ['half'], properties: [] },
  { id: 'stock', name: 'Stock Fixture', author: 'WW', url: 'http://localhost:8942/wwfetch/index.html', supportedSlots: ['half'], properties: [] },
];

(async () => {
  const shellSrv = await staticServer(REPO, 8941);
  const fixtureSrv = await staticServer(FIXTURES, 8942);

  // Counting cross-origin server WITHOUT CORS headers: native fetches from the
  // widget origin get CORS-rejected while the hit still counts (CORS is
  // enforced on the response), so hit counts expose whether the memo skipped
  // the doomed native attempt.
  const hits = { feed: 0, form: 0, req: 0, reqget: 0, cred: 0, wcred: 0 };
  const noCors = http.createServer((req, res) => {
    const u = String(req.url);
    if (u.includes('form')) hits.form++;
    else if (u.includes('reqget')) hits.reqget++;
    else if (u.includes('req')) hits.req++;
    else if (u.includes('wcred')) hits.wcred++;
    else if (u.includes('cred')) hits.cred++;
    else hits.feed++;
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(Buffer.from(Array.from({ length: 256 }, (_, i) => i)));
  });
  await new Promise((r) => noCors.listen(8931, '127.0.0.1', r));

  // Bot-wall-shaped server: CORS is fully allowed but every GET answers 403 —
  // the "block page WITH CORS headers" case that triggers the 403 retry branch.
  const walled = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    res.writeHead(403, Object.assign({ 'Content-Type': 'text/plain' }, cors));
    res.end('blocked');
  });
  await new Promise((r) => walled.listen(8932, '127.0.0.1', r));

  // Two-path origin for the memoized-proxy fallback probe: /seed has no CORS
  // (native fails once, setting the memo), /gate is fully CORS-open and
  // answers 200 — the request the PROXY answers 403 for but the native path
  // can still win (the ambient-cookie shape).
  let gateHits = 0;
  const twoPath = http.createServer((req, res) => {
    if (req.url.includes('seed')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('seed');
      return;
    }
    gateHits++;
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('native-ok');
  });
  await new Promise((r) => twoPath.listen(8933, '127.0.0.1', r));

  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 400 } });
  page.on('pageerror', (e) => { failures++; console.log('[pageerror]', String(e).slice(0, 300)); });

  const layout = { pages: [{ name: 'F', slots: [
    { widgetId: 'icue', size: 'half', settings: {}, instanceId: 'fi' },
    { widgetId: 'stock', size: 'half', settings: {}, instanceId: 'fw' },
  ] }] };

  // Host mock: record every proxied fetch and answer like the real host would
  // after its ladder — 200 with the binary body for feed.bin, 200 "rescued"
  // for blocked.json (as if the hidden-browser tier succeeded).
  const fetchMsgs = [];
  await page.exposeFunction('__hostRecv', async (json) => {
    const msg = JSON.parse(json);
    if (msg.type === 'ready') {
      page.evaluate((d) => window.__hostPush(d), JSON.stringify({
        type: 'init',
        data: { layout, widgets, sensors: [], media: null, backgroundHost: 'backgrounds.plinth', status: { elevated: false, apiVersion: 1 } },
      })).catch(() => {});
    } else if (msg.type === 'fetch') {
      fetchMsgs.push(JSON.parse(JSON.stringify(msg)));
      const url = String(msg.url);
      const isFeed = url.includes('feed.bin');
      // The 8933 gate plays the "proxy cannot authenticate" role: the host
      // ladder answers 403 there, everything else succeeds. 'nocontent' plays
      // a REST API's 204; 'slowabort' replies late so the caller can abort a
      // pending retry.
      const isGate = url.includes('8933') && url.includes('gate');
      const is204 = url.includes('nocontent');
      const data = {
        id: msg.id,
        status: isGate ? 403 : is204 ? 204 : 200,
        statusText: isGate ? 'Forbidden' : is204 ? 'No Content' : 'OK',
        contentType: isFeed ? 'application/octet-stream' : 'text/plain',
        bodyBase64: (isFeed
          ? Buffer.from(Array.from({ length: 256 }, (_, i) => i))
          : Buffer.from(is204 ? '' : isGate ? 'proxy-blocked' : 'rescued')).toString('base64'),
        // The allow-listed response headers the host carries back (#169), plus one it
        // must NOT: the host filters before sending, so a name outside the list reaching
        // a widget would mean the shim invented it. See tools/proxy-response-headers.json.
        headers: {
          'ETag': 'W/"rescued-1"',
          'Retry-After': '90',
          'X-RateLimit-Remaining': '0',
        },
      };
      const send = () =>
        page.evaluate((d) => window.__hostPush(d), JSON.stringify({ type: 'fetch-result', data })).catch(() => {});
      if (url.includes('slowabort')) setTimeout(send, 1500); else send();
    }
  });
  await page.addInitScript(() => {
    if (window.top !== window) return;
    const listeners = new Set();
    window.chrome = { webview: {
      addEventListener(t, cb) { if (t === 'message') listeners.add(cb); },
      postMessage(m) { window.__hostRecv(JSON.stringify(m)); },
    } };
    window.__hostPush = (json) => { const data = JSON.parse(json); listeners.forEach((cb) => { try { cb({ data }); } catch (e) {} }); };
  });
  await page.addInitScript(fs.readFileSync(SHELL + '/widget-api.js', 'utf8') + '\n' + fs.readFileSync(SHELL + '/icue-compat.js', 'utf8'));
  await page.goto('http://127.0.0.1:8941/src/Plinth/Shell/index.html');

  // Wait for both fixtures to finish their scripted sequences.
  const frameFor = (part) => page.frames().find((f) => f.url().includes(part));
  for (let i = 0; i < 80; i++) {
    await wait(250);
    const a = frameFor('icuefetch');
    const b = frameFor('wwfetch');
    if (!a || !b) continue;
    const done = await Promise.all([a, b].map((f) => f.evaluate(() => window.__done).catch(() => false)));
    if (done.every(Boolean)) break;
  }

  const icue = await frameFor('icuefetch').evaluate(() => window.__results);
  const stock = await frameFor('wwfetch').evaluate(() => window.__results);
  const byName = (list, n) => list.find((r) => r.name === n) || {};
  const headerKeys = (m) => Object.keys(m.headers || {}).map((k) => k.toLowerCase());
  // HTTP header names are case-insensitive and Headers instances normalize to
  // lowercase — compare accordingly.
  const header = (m, name) => {
    for (const k of Object.keys(m.headers || {})) if (k.toLowerCase() === name.toLowerCase()) return m.headers[k];
    return undefined;
  };

  // ---- S1 · shim escalation carries the auth header + binary integrity
  const feedMsgs = fetchMsgs.filter((m) => String(m.url).includes('feed.bin'));
  const first = feedMsgs[0] || {};
  check('S1 CORS-rejected fetch escalated with the Headers-instance auth intact',
    header(first, 'Authorization') === 'Bearer SECRET-T' && header(first, 'X-Custom') === 'yes',
    JSON.stringify(first.headers));
  check('S1b content-type rides the dedicated field, not the headers object',
    first.contentType === 'application/json' && !headerKeys(first).includes('content-type'),
    JSON.stringify({ ct: first.contentType, keys: headerKeys(first) }));
  check('S1c the proxied binary body survives byte-for-byte',
    byName(icue, 'cors-auth').status === 200 && byName(icue, 'cors-auth').bytesOk === true,
    JSON.stringify(byName(icue, 'cors-auth')));

  // ---- S2 · proxy-first memo: no second doomed native attempt
  check('S2 second fetch to the failed origin goes proxy-first (server saw ONE hit)',
    hits.feed === 1 && feedMsgs.length === 2 && byName(icue, 'memo').status === 200,
    JSON.stringify({ feedHits: hits.feed, proxied: feedMsgs.length, memo: byName(icue, 'memo') }));
  check('S2b the memo is recorded under the shared ww-proxy-first key',
    byName(icue, 'memo').memo === '1', JSON.stringify(byName(icue, 'memo')));

  // ---- S3 · 403-with-CORS branch retries via proxy; pairs-shape headers serialize
  const blockedMsgs = fetchMsgs.filter((m) => String(m.url).includes('blocked.json'));
  const pairs = blockedMsgs.find((m) => header(m, 'Authorization') === 'Bearer PAIRS');
  check('S3 bot-wall 403 retried through the host with [[k,v]]-pairs headers intact',
    !!pairs && byName(icue, 'walled').status === 200 && byName(icue, 'walled').body === 'rescued',
    JSON.stringify({ pairs: pairs && pairs.headers, result: byName(icue, 'walled') }));

  // ---- S4 · widget-api parity: WW.fetch serializes Headers instances too
  const wwh = blockedMsgs.find((m) => header(m, 'Authorization') === 'Bearer WWH');
  check('S4 WW.fetch(proxy:always) forwards a Headers-instance Authorization',
    !!wwh && byName(stock, 'ww-headers').status === 200 && byName(stock, 'ww-headers').body === 'rescued',
    JSON.stringify({ wwh: wwh && wwh.headers, result: byName(stock, 'ww-headers') }));

  // ---- S5 · tuple-pair Content-Type on a proxied POST rides the dedicated field
  const post = fetchMsgs.find((m) => String(m.url).includes('post.json')) || {};
  check('S5 tuple-pair Content-Type crosses as contentType, auth stays in headers',
    post.method === 'POST' && post.contentType === 'application/json' &&
    post.body === '{"a":1}' && header(post, 'Authorization') === 'Bearer P4' &&
    !headerKeys(post).includes('content-type') && byName(icue, 'post-ct').status === 200,
    JSON.stringify({ method: post.method, ct: post.contentType, body: post.body, headers: post.headers, result: byName(icue, 'post-ct') }));

  // ---- S6 · memoized proxy answering 403 falls back to the native path (shim)
  check('S6 shim: auth-shaped proxy answer retries native and returns its success',
    byName(icue, 'memo-authwall').status === 200 && byName(icue, 'memo-authwall').body === 'native-ok' && gateHits >= 1,
    JSON.stringify({ result: byName(icue, 'memo-authwall'), gateHits }));

  // ---- S7 · same through WW.fetch's memo branch
  check('S7 WW.fetch: auth-shaped proxy answer retries native and returns its success',
    byName(stock, 'ww-memo-authwall').status === 200 && byName(stock, 'ww-memo-authwall').body === 'native-ok',
    JSON.stringify(byName(stock, 'ww-memo-authwall')));

  // ---- S8 · repeated tuple names combine like native Headers, not overwrite
  const multi = fetchMsgs.find((m) => String(m.url).includes('multi=1')) || {};
  check('S8 repeated tuple header names combine case-insensitively ("a, b, c")',
    header(multi, 'X-Multi') === 'a, b, c' && byName(icue, 'multi').status === 200,
    JSON.stringify({ headers: multi.headers, result: byName(icue, 'multi') }));

  // ---- S9 · non-replayable body: native leads (the mutation reaches the
  // server) and there is NO empty proxy replay — the real error surfaces
  // instead of a second, corrupted delivery.
  check('S9 URLSearchParams POST leads native (server saw it) and is never replayed empty',
    hits.form === 1 && !!byName(icue, 'form-post').error &&
    !fetchMsgs.some((m) => String(m.url).includes('form.bin')),
    JSON.stringify({ formHits: hits.form, result: byName(icue, 'form-post') }));

  // ---- S11 · Request-object POST: native leads and is never replayed empty
  check('S11 Request-object POST leads native on a memoized origin, never replayed empty',
    hits.req === 1 && !!byName(icue, 'req-post').error &&
    !fetchMsgs.some((m) => String(m.url).includes('req.bin')),
    JSON.stringify({ reqHits: hits.req, result: byName(icue, 'req-post') }));

  // ---- S12 · GET Request object is replayable: proxy-first, headers intact
  const reqGet = fetchMsgs.find((m) => String(m.url).includes('reqget.bin')) || {};
  check('S12 GET Request object goes proxy-first with its headers intact',
    hits.reqget === 0 && reqGet.method === 'GET' && header(reqGet, 'X-ReqGet') === 'g' &&
    byName(icue, 'req-get').status === 200,
    JSON.stringify({ reqgetHits: hits.reqget, method: reqGet.method, headers: reqGet.headers, result: byName(icue, 'req-get') }));

  // ---- S13 · caller aborts are not network failures: no memo, no escalation
  check('S13 an aborted fetch surfaces AbortError — no memo, no proxy escalation',
    byName(icue, 'aborted').errName === 'AbortError' && byName(icue, 'aborted').memo === null &&
    !fetchMsgs.some((m) => String(m.url).includes('8934')),
    JSON.stringify(byName(icue, 'aborted')));

  // ---- S10 · WW.fetch moves a Headers-instance Content-Type to the dedicated field
  const wwct = fetchMsgs.find((m) => String(m.url).includes('wwct=1')) || {};
  check('S10 WW.fetch extracts Content-Type into contentType (no duplicate in headers)',
    wwct.contentType === 'application/json' && header(wwct, 'Authorization') === 'Bearer WWCT' &&
    !headerKeys(wwct).includes('content-type') && wwct.body === '{"b":2}' &&
    byName(stock, 'ww-ct').status === 200,
    JSON.stringify({ ct: wwct.contentType, headers: wwct.headers, body: wwct.body, result: byName(stock, 'ww-ct') }));

  // ---- S14 · memoized origin + pre-aborted signal: AbortError, no proxy hop
  check('S14 memoized origin + pre-aborted signal still rejects AbortError (no proxy hop)',
    byName(icue, 'memo-abort').errName === 'AbortError' &&
    !fetchMsgs.some((m) => String(m.url).includes('memoabort')),
    JSON.stringify(byName(icue, 'memo-abort')));

  // ---- S15 · shim escalation retries the SENT headers, not later mutations
  const snapMsg = fetchMsgs.find((m) => String(m.url).includes('snap=1') && !String(m.url).includes('wsnap=1')) || {};
  check('S15 escalation retries the headers that were SENT, not the mutated live object',
    header(snapMsg, 'Authorization') === 'Bearer LIVE' && byName(icue, 'snap').status === 200,
    JSON.stringify({ headers: snapMsg.headers, result: byName(icue, 'snap') }));

  // ---- S26 · both shims rebuild the proxied response's headers, identically ------
  //
  // widget-api.js and icue-compat.js are injected independently and EACH rebuilds the
  // Response the host proxy describes. Fixing one and not the other is not hypothetical:
  // it is what happened, and the shim missed was the one an iCUE or marketplace widget
  // reaches the ladder through — plain window.fetch — so that widget went on reading
  // nothing but Content-Type. Nothing lets these two share a helper, so this asserts they
  // answer the same. Driven from the FIXTURE FRAMES, because icue-compat.js returns
  // immediately at top level and a fetch from the shell page exercises neither shim.
  const shimHdrs = byName(icue, 'hdrs');
  const apiHdrs = byName(stock, 'hdrs');
  check('S26 the icue shim rebuilds the forwarded response headers',
    shimHdrs.etag === 'W/"rescued-1"' && shimHdrs.retry === '90' && shimHdrs.rl === '0',
    JSON.stringify(shimHdrs));
  check('S26b ...and widget-api answers identically, so the two cannot drift',
    !!shimHdrs.etag && shimHdrs.etag === apiHdrs.etag && shimHdrs.retry === apiHdrs.retry
    && shimHdrs.rl === apiHdrs.rl,
    'shim=' + JSON.stringify(shimHdrs) + ' api=' + JSON.stringify(apiHdrs));
  check('S26c a header the host never forwards is absent on both',
    shimHdrs.cookie == null && apiHdrs.cookie == null,
    JSON.stringify([shimHdrs.cookie, apiHdrs.cookie]));

  // ---- S16 · WW.fetch's async retry sends the entry-time snapshot too
  const wsnapMsg = fetchMsgs.find((m) => String(m.url).includes('wsnap=1')) || {};
  check('S16 WW.fetch retry also sends the entry-time header snapshot',
    header(wsnapMsg, 'Authorization') === 'Bearer WLIVE' && byName(stock, 'ww-snap').status === 200,
    JSON.stringify({ headers: wsnapMsg.headers, result: byName(stock, 'ww-snap') }));

  // ---- S17 · WW.fetch pre-aborted: AbortError, no proxy hop
  check('S17 WW.fetch with a pre-aborted signal rejects AbortError (no proxy hop)',
    byName(stock, 'ww-abort').errName === 'AbortError' &&
    !fetchMsgs.some((m) => String(m.url).includes('wwabort')),
    JSON.stringify(byName(stock, 'ww-abort')));

  // ---- S18/S19 · proxied 204 resolves as a bodyless Response (no hang)
  check('S18 shim: a proxied 204 resolves bodyless instead of stranding the promise',
    byName(icue, 'no-content').status === 204 && byName(icue, 'no-content').len === 0,
    JSON.stringify(byName(icue, 'no-content')));
  check('S19 WW.fetch: a proxied 204 resolves bodyless too',
    byName(stock, 'ww-204').status === 204,
    JSON.stringify(byName(stock, 'ww-204')));

  // ---- S20/S21 · aborting a PENDING retry surfaces AbortError, not the 403
  check('S20 shim: abort during the pending 403-retry surfaces AbortError',
    byName(icue, 'mid-abort').errName === 'AbortError',
    JSON.stringify(byName(icue, 'mid-abort')));
  check('S21 WW.fetch: abort during the pending 403-retry surfaces AbortError',
    byName(stock, 'ww-mid-abort').errName === 'AbortError',
    JSON.stringify(byName(stock, 'ww-mid-abort')));

  // ---- S22/S23 · credentialed requests lead native even on a memoized origin
  check('S22 shim: credentials:include leads native on a memoized origin (server saw the hit)',
    hits.cred === 1 && byName(icue, 'cred').status === 200,
    JSON.stringify({ credHits: hits.cred, result: byName(icue, 'cred') }));
  check('S23 WW.fetch: credentials:include also leads native on a memoized origin',
    hits.wcred === 1 && byName(stock, 'ww-cred').status === 200,
    JSON.stringify({ wcredHits: hits.wcred, result: byName(stock, 'ww-cred') }));

  // ---- S24 · a reused signal's abort listeners are removed as requests settle
  check('S24 reused AbortSignal: one listener added AND removed per settled proxy request',
    byName(icue, 'leak').adds === 3 && byName(icue, 'leak').removes === 3,
    JSON.stringify(byName(icue, 'leak')));

  // ---- S25 · bodyless Request POST keeps proxy relief (proxy-first, no native hit)
  const bodyless = fetchMsgs.find((m) => String(m.url).includes('bodyless.bin')) || {};
  check('S25 bodyless Request POST is replayable: proxy-first as POST with no native hit',
    bodyless.method === 'POST' && bodyless.body === null && byName(icue, 'bodyless').status === 200,
    JSON.stringify({ method: bodyless.method, body: bodyless.body, result: byName(icue, 'bodyless') }));

  await browser.close();
  noCors.close();
  walled.close();
  twoPath.close();
  shellSrv.close();
  fixtureSrv.close();
  console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
