#!/usr/bin/env node
// Data-path harness — the populated twin of widget-harness.js.
//
// widget-harness aborts every non-shell request on purpose, so it can only ever prove
// a widget's OFFLINE state. That leaves the state a user actually looks at all day
// untested: the one with data in it. This runner serves the widget's API from a stub
// file instead, so the happy path, the shapes it has to survive, and the error paths a
// server can hand back are all exercised in real Chromium.
//
//   node tools/widget-datapath.js widgets/kev --stubs tests/fixtures/widgets/kev.json
//   node tools/widget-datapath.js widgets/kev --slot half --shot kev.png --expect "CVE-"
//
// The stub file is a JSON array; the first entry whose `match` is a substring of the
// request URL wins:
//
//   [{ "match": "cisa.gov", "json": { ... } },
//    { "match": "example.com/slow", "status": 503, "body": "" },
//    { "match": "api.private", "tier": "proxy", "json": { ... } }]
//
// `"tier": "proxy"` makes the DIRECT request fail the way a CORS-refusing API does, so
// WW.fetch escalates and the host-proxy path is what answers. Without it every matched
// response is directly readable, the fallback is never exercised, and a widget that
// used native fetch (or proxy:'never') passes here while being blocked in production.
//
// Every request that matches nothing is aborted exactly as widget-harness does, so a
// widget calling an endpoint you did not stub still lands in its designed failure
// state rather than hanging.
//
// TOPOLOGY. The widget is mounted in an IFRAME owned by a shell page, because that is
// the only arrangement in which the injected shims are alive. shell.js builds every slot
// as an iframe, and both shims read the frame tree to decide whether they are in one:
// icue-compat.js returns immediately at `if (window.top === window)`, and widget-api.js
// derives SLOT_TOPOLOGY from `window.parent !== window && window.parent === window.top`.
// Loading the widget top-level — which this runner did at first — therefore ran every
// iCUE-surface widget with no iCUE surface at all, and silenced widget-api's diagnostics
// channel. A widget could pass here and be blank on the panel. The shell page also has to
// be the one that answers host-bound messages: the shim drops anything whose `ev.source`
// is not `window.parent`, so a reply posted by the widget's own document is ignored.
'use strict';
const fs = require('fs');
const path = require('path');

global.window = {};
require(path.join(__dirname, '../src/WaveshareWidgets/Shell/palette.js'));
const derive = global.window.WWPalette.derive;

const SHELL = path.join(__dirname, '../src/WaveshareWidgets/Shell');
const SLOTS = {
  quarter: [320, 400], half: [640, 400], 'three-quarter': [960, 400], full: [1280, 400],
  'quarter-upper': [320, 200], 'half-upper': [640, 200], 'three-quarter-upper': [960, 200], 'full-upper': [1280, 200],
  'quarter-lower': [320, 200], 'half-lower': [640, 200], 'three-quarter-lower': [960, 200], 'full-lower': [1280, 200],
};
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.woff2': 'font/woff2', '.gif': 'image/gif', '.webp': 'image/webp' };

const args = process.argv.slice(2);
const folder = args.find((a) => !a.startsWith('--'));
const opt = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
};
if (!folder) {
  console.error('usage: widget-datapath.js <widget-folder> --stubs <file.json> [--slot half] '
    + '[--theme dark|light] [--settings {json}] [--expect "text"] [--reject "text"] [--allow-state] '
    + '[--wait 1500] [--shot out.png] [--json]');
  process.exit(1);
}

const slot = opt('slot', 'half');
const [W, H] = SLOTS[slot] || slot.split('x').map(Number);
const themeArg = opt('theme', 'dark');
const theme = themeArg === 'dark' ? derive({})
  : themeArg === 'light' ? derive({ background: '#e8e6e1', text: '#12161a', accent: '#b04a2f' })
  : derive(JSON.parse(themeArg));
const settings = (() => {
  const given = JSON.parse(opt('settings', '{}'));
  const merged = {};
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
    for (const prop of manifest.properties || []) if (prop.name) merged[prop.name] = prop.default;
  } catch (e) { /* validator owns manifest errors */ }
  return Object.assign(merged, given);
})();
// The slot fragment shell.js puts on every frame src. The iCUE shim reads its property
// globals out of ww-settings BEFORE the widget's own scripts run, and uniqueId — the
// per-instance storage key — out of ww-slot; a frame mounted without it hands ported
// widgets defaults where the panel hands them their settings.
const slotHash = (() => {
  try { return '#ww-slot=p0s0&ww-settings=' + encodeURIComponent(JSON.stringify(settings)); }
  catch (e) { return '#ww-slot=p0s0'; }   // unserializable: ww-init still applies them
})();
const stubs = (() => {
  const file = opt('stubs', null);
  if (!file) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8'));
})();
const expects = [];
const rejects = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--expect') expects.push(args[i + 1]);
  if (args[i] === '--reject') rejects.push(args[i + 1]);
}
// The escape hatch cannot be used alone. Without --expect it removes the only check
// that tells the INTENDED state card from an arbitrary spinner or error, so it would
// turn a failing populated run into a pass by itself — which is precisely how escape
// hatches get misused.
if (args.includes('--allow-state') && expects.length === 0) {
  console.error('--allow-state requires at least one --expect: the state card still has to be ASSERTED, '
    + 'not merely permitted. Under --allow-state, --expect matches the state layer\'s own text.');
  process.exit(2);
}
const waitMs = Number(opt('wait', 1500));
const shot = opt('shot', null);
const asJson = args.includes('--json');

function loadPlaywright() {
  const candidates = ['playwright', '/opt/node22/lib/node_modules/playwright',
    path.join(process.env.HOME || '', 'node_modules/playwright')];
  for (const c of candidates) {
    try { return require(c); } catch (e) { /* next */ }
  }
  console.error('playwright not found — npm i -g playwright (and provide a chromium via PLAYWRIGHT_BROWSERS_PATH or CHROMIUM)');
  process.exit(1);
}

const bodyOf = (stub) => (stub.json !== undefined ? JSON.stringify(stub.json) : String(stub.body == null ? '' : stub.body));

(async () => {
  const { chromium } = loadPlaywright();
  const shim = fs.readFileSync(path.join(SHELL, 'widget-api.js'), 'utf8') + '\n' +
               fs.readFileSync(path.join(SHELL, 'icue-compat.js'), 'utf8');
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: W, height: H } });

  const checks = [];
  const consoleErrors = [];
  const served = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail === undefined ? null : String(detail) });
  page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 300)));

  // Contained the same way the widget.test route below is. The subtlety is worth
  // recording because it is the opposite of what it looks like:
  //
  //   new URL('https://app.wsw/../../../x').pathname  ->  '/x'
  //   new URL('https://app.wsw/%2e%2e/%2e%2e/x').pathname -> '/x'
  //
  // The URL parser normalizes dot segments, INCLUDING the %2e spelling, so a route that
  // joins the raw pathname cannot be walked out of with either. But an encoded SLASH
  // survives it untouched:
  //
  //   new URL('https://app.wsw/..%2f..%2fx').pathname  ->  '/..%2f..%2fx'
  //
  // so the moment anything calls decodeURIComponent on that pathname — which this route
  // must, for filenames with spaces, and which the sibling route already did — '../../x'
  // becomes expressible again. The decode and this containment check therefore belong
  // together: adding the decode without the check is what would create the hole.
  await page.route('https://app.wsw/**', (route) => {
    const shellRoot = path.resolve(SHELL);
    const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\/+/, '');
    const file = path.resolve(shellRoot, rel);
    if (file.startsWith(shellRoot + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile())
      return route.fulfill({ contentType: MIME[path.extname(file)] || 'text/plain', body: fs.readFileSync(file) });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.route('https://widget.test/**', (route) => {
    // Root PLUS SEPARATOR, not a bare prefix: `widgets/rest` is a string-prefix of
    // `widgets/rest-private`, so a decoded traversal into a sibling whose name merely
    // starts with the folder name passed the old test. Same defect the app.wsw route
    // had, in the route that already looked guarded.
    const widgetRoot = path.resolve(folder);
    const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(widgetRoot, rel);
    if ((file === widgetRoot || file.startsWith(widgetRoot + path.sep)) && fs.existsSync(file) && fs.statSync(file).isFile())
      return route.fulfill({ contentType: MIME[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
    return route.fulfill({ status: 404, body: '' });
  });
  // The shell page. Markup only — the iframe is created from script (see __wwMount) so
  // the message listener that answers it is registered before it can exist, and so the
  // frame is never half-built by the HTML parser. Its own origin is distinct from the
  // widget's, exactly as on the panel, where each widget gets a virtual host of its own.
  await page.route('https://shell.test/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><title>ww shell</title>'
      + '<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#000}'
      + 'iframe{display:block;border:0;width:100vw;height:100vh}</style>',
  }));
  // The stubs. Anything unmatched aborts, same as widget-harness — an un-stubbed
  // endpoint must still land the widget in a designed state, never a hang.
  // The exclusions need a HOST BOUNDARY. Without one, `https://app.wswevil.com/`
  // starts with `app.wsw`, so it was excluded from the abort handler while matching
  // neither local route — and the browser then made a real network request out of a
  // runner whose whole contract is that unmatched requests are deterministic.
  await page.route(/https?:\/\/(?!(?:app\.wsw|widget\.test|shell\.test)(?:[:/?#]|$)).*/, (route) => {
    const url = route.request().url();
    // A CORS preflight is not the data request — it is the browser ASKING to make one.
    // Counting it as served let a widget whose real call was then blocked satisfy the
    // data-path check on the preflight alone, and answering it without the allow-
    // headers/methods is what blocked that call in the first place.
    if (route.request().method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, PUT, HEAD, DELETE, PATCH, OPTIONS',
          'access-control-allow-headers': '*',
          'access-control-max-age': '0',
        },
        body: '',
      });
    }
    const stub = stubs.find((s) => url.includes(s.match));
    if (!stub) return route.abort();
    // A proxy-tier fixture refuses the direct call. WW.fetch treats a network-layer
    // failure as its cue to escalate, which is exactly what a CORS-refusing API causes.
    if (stub.tier === 'proxy') return route.abort();
    served.push(url);
    return route.fulfill({
      status: stub.status || 200,
      contentType: stub.contentType || (stub.json !== undefined ? 'application/json' : 'text/plain'),
      headers: Object.assign({ 'access-control-allow-origin': '*' }, stub.headers || {}),
      body: bodyOf(stub),
    });
  });

  // Errors are collected IN each document as well as via page.on('pageerror'). The
  // widget now lives in a cross-origin child frame, which Chromium may host in a
  // separate process; a runner whose only error channel is the page-level event is one
  // browser-internals change away from reporting a clean run for a widget that threw.
  await page.addInitScript(() => {
    window.__wwErrors = [];
    window.addEventListener('error', (ev) => {
      window.__wwErrors.push(String((ev && (ev.message || ev.error)) || 'error').slice(0, 300));
    });
    window.addEventListener('unhandledrejection', (ev) => {
      const r = ev && ev.reason;
      window.__wwErrors.push(('unhandled rejection: ' + ((r && (r.stack || r.message)) || r)).slice(0, 300));
    });
  });
  await page.addInitScript(shim);
  // Host-bound messages, answered by the SHELL document — the widget's shim drops any
  // message whose ev.source is not window.parent, so a reply the widget's own document
  // posts to itself is discarded. ww-fetch is answered from the SAME stub table the
  // direct route uses, because a widget that escalates to the host proxy must reach the
  // same data it would have reached directly — otherwise the stub only covers whichever
  // tier happened to win.
  await page.addInitScript(({ table, ceiling, widgetUrl, widgetOrigin, slotHash, initMessage }) => {
    if (window.top !== window) return;   // shell-side only; the widget frame gets the shim
    window.__wwProxyServed = [];
    window.__wwReady = false;
    window.__wwInitSent = false;
    let frame = null;
    window.__wwMount = () => {
      frame = document.createElement('iframe');
      // Mirrors shell.js buildSlot: allow-same-origin keeps the widget on its own
      // virtual host (its localStorage, its stored credentials) rather than an opaque
      // origin, and the fragment carries the slot tag + merged settings so the iCUE
      // shim can inject property globals before the widget's own scripts run.
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      frame.src = widgetUrl + slotHash;
      const attach = () => (document.body || document.documentElement).appendChild(frame);
      if (document.body) attach();
      else document.addEventListener('DOMContentLoaded', attach, { once: true });
    };
    // The panel answers ww-ready with the init (shell.js), and so does this: a widget
    // that registers WW.onInit after its scripts load must not race a fixed timer.
    // `force` is what a ww-ready passes, because shell.js answers EVERY ww-ready even
    // for an already-initialized slot — a widget that reloads its own frame (several do,
    // on a settings change) would otherwise run the rest of the session on its defaults.
    window.__wwSendInit = (force) => {
      if (!frame || !frame.contentWindow) return false;
      if (window.__wwInitSent && !force) return false;
      window.__wwInitSent = true;
      frame.contentWindow.postMessage(initMessage, widgetOrigin);
      return true;
    };
    window.addEventListener('message', (ev) => {
      // Identity AND origin, both, exactly as shell.js:275-284 does — and for its
      // reasons, which apply here unchanged:
      //
      //   postMessage reaches window.top from ANY descendant, so a page a widget frames
      //   can speak this protocol. Three stock widgets do frame third-party content
      //   (twitch, youtube) and one frames a URL the user types (iframe), so a runner
      //   that answers nested frames is answering pages the panel ignores — serving them
      //   proxy fixtures, and letting one of them mark the shim ready.
      //
      //   Identity alone is not enough either: a slot frame that navigates away keeps
      //   the same WindowProxy. Identity says WHICH frame is speaking, origin says
      //   whether the widget is still the one speaking.
      //
      // This also subsumes the self-post case — the shim injected into THIS document
      // posts its own ww-ready upward, and in a top-level document `parent` is itself.
      if (!frame || ev.source !== frame.contentWindow || ev.origin !== widgetOrigin) return;
      const m = ev.data || {};
      const target = ev.origin && ev.origin !== 'null' ? ev.origin : '*';
      const reply = (obj) => { try { ev.source.postMessage(obj, target); } catch (e) { /* frame gone */ } };
      if (m.type === 'ww-ready') { window.__wwReady = true; window.__wwSendInit(true); return; }
      if (m.type === 'ww-fetch') {
        // The host REFUSES some calls before it ever looks at the target, and a runner
        // that answers them anyway lets a widget pass here and fail on the real panel.
        // DashboardWindow.HandleProxyFetchAsync: absolute http(s) only, and only
        // GET/POST/PUT/HEAD.
        let abs = null;
        try { abs = new URL(String(m.url || '')); } catch (e) { abs = null; }
        if (!abs || (abs.protocol !== 'http:' && abs.protocol !== 'https:')) {
          return reply({ type: 'ww-fetch-result', id: m.id, error: 'only absolute http(s) URLs are allowed' });
        }
        const method = String(m.method || 'GET').toUpperCase();
        if (!['GET', 'POST', 'PUT', 'HEAD'].includes(method)) {
          return reply({ type: 'ww-fetch-result', id: m.id, error: 'method ' + method + ' not allowed' });
        }
        // Match the CANONICAL form, and ONLY that — the same string the direct route
        // matches against. The browser normalizes a URL before it reaches page.route
        // (spaces encoded, dot segments resolved, IDN punycoded) while m.url is whatever
        // the widget passed, so a raw-string fallback here is strictly more permissive
        // than the direct matcher. A fixture whose `match` only fits the raw spelling
        // then misses the direct request, the widget escalates, and the proxy answers —
        // so the run reports proxy-tier traffic and exercises the proxy response shape
        // for a call the browser would have made directly. The host parses the URL too,
        // so canonical is also what it would send.
        const canonical = abs.href;
        const stub = table.find((s) => canonical.includes(s.match));
        if (!stub) return reply({ type: 'ww-fetch-result', id: m.id, error: 'offline harness' });
        window.__wwProxyServed.push(String(m.url || ''));
        // The proxy tier's contract is bodyBase64 + contentType, NOT a body string and
        // a headers map — the shim rebuilds a Response from exactly those fields. Note
        // it carries no response headers beyond Content-Type, so anything reading an
        // ETag off a proxied call legitimately sees nothing; that is the host's shape,
        // and a widget has to survive it.
        // Chunked: String.fromCharCode(...bytes) blows the argument limit long before
        // the 5 MiB body ceiling, so a realistic full-size fixture threw inside the
        // responder instead of exercising the widget's proxy path.
        // A real HEAD response carries no body, and the host issues a real HEAD. Sending
        // one lets a widget consume payload data here and receive nothing in production.
        const bytes = new TextEncoder().encode(method === 'HEAD' ? '' : (stub.bodyText || ''));
        // The host applies the cap BEFORE it produces a result, so a widget that only
        // inspects status/headers never sees the body at all. Returning the full body
        // and leaving the shim's client-side cap to catch it later let such a widget
        // pass here and be refused in production.
        const asked = Number(m.maxBytes);
        const cap = Math.min(ceiling, Number.isFinite(asked) && asked > 0 ? asked : ceiling);
        if (bytes.length > cap) {
          return reply({ type: 'ww-fetch-result', id: m.id,
            error: 'response too large: ' + bytes.length + ' bytes exceeds ' + cap });
        }
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        const b64 = btoa(bin);
        return reply({
          type: 'ww-fetch-result', id: m.id, status: stub.status || 200,
          // statusText and contentType both travel on the real result
          // (DashboardWindow.cs) — omitting them tested widgets against a proxy
          // contract the host does not have.
          statusText: stub.statusText || '',
          contentType: stub.contentType || (stub.json !== undefined ? 'application/json' : 'text/plain'),
          bodyBase64: b64,
        });
      }
      if (m.type === 'ww-ping') reply({ type: 'ww-ping-result', id: m.id, results: [] });
      else if (m.type === 'ww-media-list') reply({ type: 'ww-media-list-result', id: m.id, files: [] });
      else if (m.type === 'ww-audio-get') reply({ type: 'ww-audio-result', id: m.id, available: false });
    });
  }, {
    ceiling: 5 * 1024 * 1024,   // the host's own body ceiling; init.maxBytes only LOWERS it
    widgetUrl: 'https://widget.test/index.html',
    widgetOrigin: 'https://widget.test',
    slotHash,
    initMessage: { type: 'ww-init', settings, sensors: [], media: null, theme, status: { elevated: false, apiVersion: 1 } },
    table: stubs.map((s) => ({
      match: s.match, status: s.status, statusText: s.statusText,
      contentType: s.contentType, json: s.json, bodyText: bodyOf(s),
    })),
  });

  await page.goto('https://shell.test/host.html');
  await page.evaluate(() => window.__wwMount());
  const frameEl = await page.waitForSelector('iframe', { timeout: 10000 });
  const frame = await frameEl.contentFrame();
  if (!frame) {
    console.error('widget frame never attached');
    await browser.close();
    process.exit(1);
  }
  await frame.waitForLoadState('domcontentloaded').catch(() => { /* asserted below */ });
  // ww-ready normally carries the init already; this covers a widget whose document
  // failed to run the shim at all, so the run reports its real state rather than hanging.
  await page.evaluate(() => window.__wwSendInit());
  await page.waitForTimeout(waitMs);

  const frameErrors = await frame.evaluate(() => window.__wwErrors || []).catch(() => []);
  for (const e of frameErrors) if (!consoleErrors.includes(e)) consoleErrors.push(e);
  check('no page errors', consoleErrors.length === 0, consoleErrors.join(' | '));
  check('shim reached the widget (ww-ready, framed topology)',
    await page.evaluate(() => window.__wwReady === true));

  // The offline twin checks this and this one dropped it: with no --expect, an entirely
  // blank widget passed every remaining check — no errors, no state layer, nothing to
  // overflow. A script that clears the UI or never builds it would have been a green run.
  check('visible content rendered', await frame.evaluate(() =>
    [...document.body.querySelectorAll('*')].some((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 4 && r.height > 4 && getComputedStyle(el).visibility !== 'hidden';
    })));

  // A populated widget must have left its state layer: the whole point of this runner
  // is that a spinner or an error card is a FAILURE when the data was served.
  //
  // --allow-state opts out, for the runs where the state card IS the expected result:
  // an unconfigured widget with no token, a deliberately un-stubbed endpoint. Those
  // still need their text asserted, which is what --expect is for.
  // EVERY state layer, not the first one. querySelector returns the earliest match in
  // document order, so a widget that keeps a hidden loading card above its error card
  // (forecast7, hue) reported "no state visible" while showing an error — defeating the
  // one assertion this runner exists to make.
  const stateLayer = await frame.evaluate(() => {
    const shown = [...document.querySelectorAll('.state-card, .spinner')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 4 && r.height > 4 && getComputedStyle(el).visibility !== 'hidden';
    });
    return { visible: shown.length > 0, text: shown.map((el) => el.innerText || '').join(' ').replace(/\s+/g, ' ').trim() };
  });
  const allowState = args.includes('--allow-state');
  if (!allowState) check('state layer cleared (data is showing, not a spinner or error card)', !stateLayer.visible);
  else check('a state layer is showing (--allow-state asserts one)', stateLayer.visible);

  // Scope matters here. --allow-state runs exist to pin down WHICH state card appears —
  // "not configured", not "rate limited" — and matching the expectation against the whole
  // document let any other text in the widget satisfy it: a heading, a unit label, the
  // widget's own name. A run whose error card said something entirely different still
  // passed. So under --allow-state the expectations are matched against the visible state
  // layer's own text. --reject stays document-wide: that one asks whether a string appears
  // ANYWHERE, and narrowing it would weaken it.
  const bodyText = await frame.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());
  const haystack = allowState ? stateLayer.text : bodyText;
  const scope = allowState ? 'state layer' : 'widget';
  for (const want of expects)
    check(`${scope} renders ${JSON.stringify(want)}`, haystack.includes(want), haystack.slice(0, 220));
  for (const nope of rejects)
    check(`does NOT render ${JSON.stringify(nope)}`, !bodyText.includes(nope), bodyText.slice(0, 220));

  // A DATA-PATH run that touched no data proves nothing. Without this, a widget that
  // stopped calling WW.fetch entirely — but still painted a title or an empty card —
  // satisfied every other check whenever --expect was omitted. The one exemption is
  // --allow-state, where not reaching the network IS the expected outcome (an
  // unconfigured widget makes no request at all).
  const proxyServed = await page.evaluate(() => window.__wwProxyServed || []);
  if (!allowState) {
    check('a stubbed endpoint was actually requested (direct or proxy tier)',
      served.length + proxyServed.length > 0,
      served.length + ' direct, ' + proxyServed.length + ' proxied');
  }

  check('no horizontal overflow', await frame.evaluate(() =>
    document.documentElement.scrollWidth <= window.innerWidth &&
    document.body.scrollWidth <= window.innerWidth),
    await frame.evaluate(() => document.body.scrollWidth + 'w vs viewport ' + window.innerWidth));

  if (shot) await page.screenshot({ path: shot });
  await browser.close();

  const ok = checks.every((c) => c.ok);
  if (asJson) console.log(JSON.stringify({ folder, slot, theme: themeArg, ok, checks, served, proxyServed, consoleErrors }, null, 1));
  else {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${folder} @ ${slot} (${themeArg}) — data path`);
    for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ' - ' + c.detail : ''}`);
  }
  process.exit(ok ? 0 : 1);
})();
