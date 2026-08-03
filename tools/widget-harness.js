#!/usr/bin/env node
// Headless widget harness — loads a widget in real Chromium with the real
// widget-base.css + widget-api.js, delivers a ww-init, and checks the standard's
// runtime contract. Self-contained: everything is served route-fulfilled from disk.
//
//   node tools/widget-harness.js widgets/clock
//   node tools/widget-harness.js widgets/cpu --slot quarter --theme light --shot cpu.png
//   node tools/widget-harness.js widgets/hue --settings '{"bgStyle":"transparent"}' --json
//
// Checks: loads with zero page errors; renders visible content after init; the
// bgStyle class contract (body background = rgba(surface-rgb, alpha)); pushed theme
// tokens actually land; no horizontal overflow at the slot size. Machine-readable
// with --json; exit 0 only when every check passes. Needs playwright + a chromium
// (PLAYWRIGHT_BROWSERS_PATH or executablePath via CHROMIUM env).
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
  // -lower bands are dimensionally identical to -upper (bottom 200px half); listed so
  // a claimed lower slot tests at 200px instead of silently becoming a NaN viewport.
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
  console.error('usage: widget-harness.js <widget-folder> [--slot half] [--theme dark|light|{json}] [--settings {json}] [--shot out.png] [--game] [--json]');
  process.exit(1);
}

const slot = opt('slot', 'half');
const [W, H] = SLOTS[slot] || slot.split('x').map(Number);
const themeArg = opt('theme', 'dark');
const theme = themeArg === 'dark' ? derive({})
  : themeArg === 'light' ? derive({ background: '#e8e6e1', text: '#12161a', accent: '#b04a2f' })
  : derive(JSON.parse(themeArg));
// Merge manifest defaults under the provided settings, exactly like the host does —
// a widget must see the same payload here as on the panel.
const settings = (() => {
  const given = JSON.parse(opt('settings', '{}'));
  const merged = {};
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
    for (const prop of manifest.properties || []) if (prop.name) merged[prop.name] = prop.default;
  } catch (e) { /* validator owns manifest errors */ }
  return Object.assign(merged, given);
})();
const shot = opt('shot', null);
const asJson = args.includes('--json');
// Drive the game-mode gate. Several widgets suspend polling while a fullscreen game is
// foreground, and with no way to say so offline that branch was unreachable here.
const gameActive = args.includes('--game');

// The slot fragment shell.js puts on every frame src. The iCUE shim reads its property
// globals out of ww-settings BEFORE the widget's own scripts run, and uniqueId — the
// per-instance storage key — out of ww-slot; a frame mounted without it hands ported
// widgets defaults where the panel hands them their settings.
const slotHash = (() => {
  try { return '#ww-slot=p0s0&ww-settings=' + encodeURIComponent(JSON.stringify(settings)); }
  catch (e) { return '#ww-slot=p0s0'; }   // unserializable: ww-init still applies them
})();

function loadPlaywright() {
  const candidates = ['playwright', '/opt/node22/lib/node_modules/playwright',
    path.join(process.env.HOME || '', 'node_modules/playwright')];
  for (const c of candidates) {
    try { return require(c); } catch (e) { /* next */ }
  }
  console.error('playwright not found — npm i -g playwright (and provide a chromium via PLAYWRIGHT_BROWSERS_PATH or CHROMIUM)');
  process.exit(1);
}

(async () => {
  const { chromium } = loadPlaywright();
  const shim = fs.readFileSync(path.join(SHELL, 'widget-api.js'), 'utf8') + '\n' +
               fs.readFileSync(path.join(SHELL, 'icue-compat.js'), 'utf8');
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: W, height: H } });

  const checks = [];
  const consoleErrors = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail === undefined ? null : String(detail) });
  page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 300)));

  // The widget's own files + the shell foundation, all from disk.
  // Contained the same way the widget.test route below is — the two now agree, which
  // the comment used to claim while that route checked a bare prefix.
  // `new URL().pathname` normalizes dot
  // segments (including the %2e spelling), so the previous raw join could not be walked
  // out of — but an encoded slash (`..%2f..%2f`) survives normalization, so any decode
  // of that pathname makes traversal expressible again. The decode and this check go
  // together. See the fuller note in widget-datapath.js, where this was flagged.
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
    // starts with this folder's name passed the old test — the same defect the app.wsw
    // route above already guards against, in the route that looked guarded. Fixed in
    // widget-datapath.js when it was found there; this copy still had it.
    // path.resolve, not path.join, so the comparison is against a normalized path.
    const widgetRoot = path.resolve(folder);
    const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(widgetRoot, rel);
    if ((file === widgetRoot || file.startsWith(widgetRoot + path.sep))
        && fs.existsSync(file) && fs.statSync(file).isFile())
      return route.fulfill({ contentType: MIME[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
    return route.fulfill({ status: 404, body: '' });
  });
  // The shell page. Markup only — the iframe is created from script (__wwMount) so the
  // listener that answers it is registered before it can exist. Its own origin is
  // distinct from the widget's, exactly as on the panel, where each widget is served
  // from a virtual host of its own.
  // The backdrop is the THEME's, not black. shell.css:7 paints the panel with
  // `var(--bg)`, and a glass or transparent widget composites against it — so a
  // hardcoded black here would show a light-theme tile against a background the device
  // never puts behind it, and --shot would produce a screenshot that reads as legible
  // (or illegible) for the wrong reason.
  const shellBg = /^#[0-9a-fA-F]{3,8}$/.test(String(theme['--bg'] || '')) ? theme['--bg'] : '#000';
  await page.route('https://shell.test/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><title>ww shell</title>'
      + '<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:'
      + shellBg + '}'
      + 'iframe{display:block;border:0;width:100vw;height:100vh}</style>',
  }));
  // Anything else (widget data fetches) fails fast and deterministically — the
  // standard requires a graceful state for exactly this.
  // The exclusions need a HOST BOUNDARY. Without one `https://app.wswevil.com/` starts
  // with `app.wsw`, so it escaped the abort while matching no local route, and the
  // browser made a real network request out of a runner whose whole contract is that
  // unmatched requests are deterministic.
  // The boundary deliberately does NOT include ':'. Every local route above is
  // portless (`https://app.wsw/**`), so a port-bearing `https://app.wsw:444/x` matches
  // none of them — and treating ':' as a boundary would exempt it from the abort as
  // well, leaving the one URL shape that reaches the real network. Exempt only what a
  // local route can actually serve.
  // Counted before the abort, because the abort is what makes an ungated widget look
  // identical to a gated one here: a widget that ignores state.game keeps fetching, every
  // request fails, it renders its ordinary offline card, and every remaining check passes.
  // Without this the --game flag only changed the payload and could not tell a working
  // gate from a regression.
  // EVERY method counts, including OPTIONS. Measured first: Playwright's interception
  // hands this handler the real request and never delivers a CORS preflight at all —
  // checked on this Chromium both ways (aborting, and fulfilling with the allow-headers
  // a preflight wants) against a custom-header GET and an application/json POST, and no
  // OPTIONS appeared in any of the six. So the method filter that used to sit here was
  // discarding nothing today. It is gone because it is a trap if that ever changes: an
  // ABORTED preflight is the end of the exchange — the request it was asking permission
  // for is never issued — so a filtered OPTIONS would hide every non-simple cross-origin
  // call completely, in the one runner that aborts everything. The method is kept in the
  // string so a failure line says which half was seen.
  const attempted = [];
  await page.route(/https?:\/\/(?!(?:app\.wsw|widget\.test|shell\.test)(?:[/?#]|$)).*/,
    (route) => {
      attempted.push(route.request().method() + ' ' + route.request().url());
      return route.abort();
    });
  // A WebSocket passes through NONE of the above. page.route intercepts HTTP(S) only, so
  // `new WebSocket('wss://…')` left this runner and reached the real network — not merely
  // unseen by the game gate, but a hole in the contract that every unmatched request here
  // is deterministic and offline. Nothing this handler receives is connected upstream
  // (the socket is only forwarded if connectToServer() is called), so every one is
  // refused; the non-local ones are also counted, with the same host boundary the abort
  // route uses.
  await page.routeWebSocket(/.*/, (ws) => {
    const url = ws.url();
    if (!/^wss?:\/\/(?:app\.wsw|widget\.test|shell\.test)(?:[/?#]|$)/.test(url)) attempted.push('WS ' + url);
    ws.close();
  });

  // Errors are collected IN each document as well as through page.on('pageerror'). The
  // widget now lives in a cross-origin child frame, which Chromium may host in its own
  // process; a runner whose only error channel is the page-level event is one
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
  // Host-bound messages, answered by the SHELL document. The widget's shim drops any
  // message whose ev.source is not window.parent, so a reply the widget's own document
  // posts to itself is discarded — which is exactly what the previous top-level harness
  // relied on, and why it had to run the widget unframed to work at all (#161).
  await page.addInitScript(({ widgetUrl, widgetOrigin, slotHash, initMessage }) => {
    if (window.top !== window) return;   // shell-side only; the widget frame gets the shim
    // The two channels that leave the machine WITHOUT passing page.route: the shim posts
    // them to the shell and the HOST dials out. `WW.fetch(url, { proxy: 'always' })`
    // skips the browser fetch entirely, and WW.ping is real ICMP — so a game gate built
    // on the route alone was blind to both. Everything else a widget can post
    // (ww-media-list, ww-audio-*, ww-sd-*, ww-secure-*, ww-log, ww-action, ww-open-url)
    // is answered inside the host process and reaches no network.
    window.__wwHostCalls = [];
    window.__wwReady = false;
    window.__wwInitSent = false;
    let frame = null;
    window.__wwMount = () => {
      frame = document.createElement('iframe');
      // Mirrors shell.js buildSlot: allow-same-origin keeps the widget on its own
      // virtual host rather than an opaque origin, and the fragment carries the slot tag
      // plus merged settings so the iCUE shim can inject property globals before the
      // widget's own scripts run.
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      frame.src = widgetUrl + slotHash;
      const attach = () => (document.body || document.documentElement).appendChild(frame);
      if (document.body) attach();
      else document.addEventListener('DOMContentLoaded', attach, { once: true });
    };
    // The panel answers ww-ready with the init (shell.js), and so does this: a widget
    // that registers WW.onInit after its scripts load must not race a fixed timer.
    window.__wwSendInit = (force) => {
      if (!frame || !frame.contentWindow) return false;
      if (window.__wwInitSent && !force) return false;
      window.__wwInitSent = true;
      frame.contentWindow.postMessage(initMessage, widgetOrigin);
      return true;
    };
    window.addEventListener('message', (ev) => {
      // Identity AND origin, both, exactly as shell.js does. Identity says WHICH frame
      // is speaking; origin says whether the widget is still the one in it. Three stock
      // widgets frame third-party content and one frames a URL the user types, so a
      // runner that answered nested frames would be answering pages the panel ignores.
      if (!frame || ev.source !== frame.contentWindow || ev.origin !== widgetOrigin) return;
      const m = ev.data || {};
      const target = ev.origin && ev.origin !== 'null' ? ev.origin : '*';
      const reply = (obj) => { try { ev.source.postMessage(obj, target); } catch (e) { /* frame gone */ } };
      if (m.type === 'ww-ready') { window.__wwReady = true; window.__wwSendInit(true); return; }
      if (m.type === 'ww-fetch') {
        // Counted only once the host's OWN admission tests pass, BOTH of them —
        // DashboardWindow.HandleProxyFetchAsync refuses a non-absolute or non-http(s)
        // URL and any method outside GET/POST/PUT/HEAD before it dials. A call the host
        // throws out is not a network call in production, so counting one here would
        // fail the game gate for a widget that never crossed it.
        let abs = null;
        try { abs = new URL(String(m.url || '')); } catch (e) { abs = null; }
        const method = String(m.method || 'GET').toUpperCase();
        if (abs && (abs.protocol === 'http:' || abs.protocol === 'https:')
            && ['GET', 'POST', 'PUT', 'HEAD'].includes(method))
          window.__wwHostCalls.push('ww-fetch ' + method + ' ' + abs.href);
        reply({ type: 'ww-fetch-result', id: m.id, error: 'offline harness' });
      } else if (m.type === 'ww-ping') {
        // Same rule, from HandlePingAsync: each target is trimmed, empties are dropped,
        // and at most 16 survive. WW.ping([]) — a legal call — and a list of blanks both
        // start zero Ping tasks and put nothing on the wire, so neither is an attempt.
        const targets = (Array.isArray(m.hosts) ? m.hosts : [])
          .map((h) => String(h == null ? '' : h).trim()).filter((h) => h).slice(0, 16);
        if (targets.length) window.__wwHostCalls.push('ww-ping ' + targets.join(','));
        reply({ type: 'ww-ping-result', id: m.id, results: [] });
      } else if (m.type === 'ww-media-list') reply({ type: 'ww-media-list-result', id: m.id, files: [] });
      else if (m.type === 'ww-audio-get') reply({ type: 'ww-audio-result', id: m.id, available: false });
      // The Stream Deck pair must be answered, and answering them is only necessary now.
      // At top level `parent === window`, so a widget's own ww-sd-profile echoed back
      // into its own document, matched its own tracked id, and self-delivered — which is
      // how the unframed harness produced Stream Deck's "No Virtual Stream Deck found"
      // card by accident. Framed, that echo is gone, and a request nobody answers means
      // onStreamDeck never fires and the tile renders EMPTY while every check passes.
      // A null profile/data is what widget-api turns into { available: false }, so this
      // is the honest offline answer rather than a stub.
      else if (m.type === 'ww-sd-profile') reply({ type: 'ww-sd-profile', id: m.id, profile: null });
      else if (m.type === 'ww-sd-capture') reply({ type: 'ww-sd-capture-result', id: m.id, data: null });
    });
    // Deliver a message into the widget after mount — see the follow-up push below.
    window.__wwPush = (msg) => {
      if (frame && frame.contentWindow) frame.contentWindow.postMessage(msg, widgetOrigin);
    };
  }, {
    widgetUrl: 'https://widget.test/index.html',
    widgetOrigin: 'https://widget.test',
    slotHash,
    // The panel's ww-init carries EIGHT fields (shell.js initMessage); this used to send
    // six. `game` was the gap that mattered: shell.js always sends it, so a widget reading
    // state.game got an object there and undefined here, and the game-mode gate several
    // widgets now use could not be exercised offline at all. `notifications` is null
    // unless a slot subscribed, which is what a non-subscribing widget gets on the panel
    // too — stated rather than omitted, so the difference is a decision.
    initMessage: { type: 'ww-init', settings, sensors: [], media: null, theme,
      notifications: null, game: { active: gameActive, process: gameActive ? 'game.exe' : '' },
      status: { elevated: false, apiVersion: 1 } },
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
  // One follow-up SENSORS push, because only onInit replays. widget-api's onInit calls
  // back immediately when an init has already arrived (`if (state.ready) cb(state)`), but
  // onSensors/onMedia/onTheme/onNotifications/onGame do not. Answering ww-ready lands
  // the init DURING document parse — while the widget-api script tag still blocks the
  // parser — so a widget that registers WW.onSensors further down its own script misses
  // the init's sensors emit permanently. widgets/gpu silently lost its "No GPU sensors
  // found" line to exactly this.
  //
  // Sensors ONLY, and the asymmetry is the point: SensorHub pushes a sensor frame every
  // poll (SensorHub.cs:60-65) but emits media strictly on change — `if (media !=
  // LatestMedia)`, SensorHub.cs:67. So replaying sensors models what the panel does,
  // while replaying media would invent an update the panel never sends, and let a
  // late-registered media handler paint here while the same widget stays blank on the
  // device. The panel's opening media value is also MediaState.None, a truthy object,
  // not the null this used to synthesize — so that push was wrong twice over.
  await page.waitForTimeout(150);
  await page.evaluate(() => window.__wwPush({ type: 'ww-sensors', sensors: [] }));
  await page.waitForTimeout(1200);

  const frameErrors = await frame.evaluate(() => window.__wwErrors || []).catch(() => []);
  for (const e of frameErrors) if (!consoleErrors.includes(e)) consoleErrors.push(e);
  check('no page errors', consoleErrors.length === 0, consoleErrors.join(' | '));

  // ---- setup: the topology is the one production uses -------------------------------
  // Every check below reads from inside the frame, and each would pass just as happily
  // against the SHELL document, which has no widget in it and nothing to overflow. These
  // two say the frame is real and the widget is living in it.
  check('shim reached the widget (ww-ready, framed topology)',
    await page.evaluate(() => window.__wwReady === true));
  // The point of #161. icue-compat.js sets __wwIcue immediately after its
  // `window.top === window` guard, so this is true only when the widget is genuinely
  // framed — which is what the whole iCUE surface (property globals, uniqueId,
  // window.plugins, the lifecycle events) is gated behind. Mounting a frame and
  // asserting nothing about the shim would leave the harness able to regress silently
  // back to a topology that never occurs on the panel.
  check('iCUE compatibility shim ran (framed topology)',
    await frame.evaluate(() => window.__wwIcue === true));

  check('visible content rendered', await frame.evaluate(() =>
    [...document.body.querySelectorAll('*')].some((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 4 && r.height > 4 && getComputedStyle(el).visibility !== 'hidden';
    })));

  const themed = await frame.evaluate(() => document.documentElement.style.getPropertyValue('--accent').trim());
  check('theme tokens landed on :root', themed === theme['--accent'], `${themed} vs ${theme['--accent']}`);

  const bg = await frame.evaluate(() => ({
    color: getComputedStyle(document.body).backgroundColor,
    cls: document.body.className,
  }));
  const alpha = settings.bgStyle === 'transparent' ? 0 : settings.bgStyle === 'glass' ? Number(theme['--panel-alpha']) : 1;
  const rgb = theme['--surface-rgb'];
  // Chromium ≥ 141 serializes a transparent computed background with its color
  // components preserved (rgba(r, g, b, 0)), older builds normalized to
  // rgba(0, 0, 0, 0) — the contract is "alpha 0", so accept both.
  const expected = alpha === 0 ? ['rgba(0, 0, 0, 0)', `rgba(${rgb}, 0)`]
    : alpha === 1 ? [`rgb(${rgb})`, `rgba(${rgb}, 1)`]
    : [`rgba(${rgb}, ${alpha})`];
  check('bgStyle contract (body background)', expected.some((e) => bg.color === e),
    `got ${bg.color} (class "${bg.cls}"), expected ${expected.join(' or ')}`);

  // The game gate, asserted rather than merely enabled. Only under --game: without it a
  // widget is SUPPOSED to reach the network, and the offline routes refusing it is the
  // designed state this runner tests everywhere else.
  if (gameActive) {
    // Both routes out: HTTP the browser made (page.route) and HTTP/ICMP the HOST would
    // have made on the widget's behalf (ww-fetch, ww-ping). Asserting on the first alone
    // let a proxy-first widget ignore the gate and still report zero.
    const hostCalls = await page.evaluate(() => window.__wwHostCalls || []);
    const net = attempted.concat(hostCalls);
    check('no network request while a game is running',
      net.length === 0,
      net.length + ' attempted (' + attempted.length + ' by the browser, '
        + hostCalls.length + ' via the host)' + (net.length ? ': ' + net[0].slice(0, 80) : ''));
  }

  check('no horizontal overflow', await frame.evaluate(() =>
    document.documentElement.scrollWidth <= window.innerWidth &&
    document.body.scrollWidth <= window.innerWidth),
    await frame.evaluate(() => document.body.scrollWidth + 'w vs viewport ' + window.innerWidth));

  if (shot) await page.screenshot({ path: shot });
  await browser.close();

  const ok = checks.every((c) => c.ok);
  if (asJson) console.log(JSON.stringify({ folder, slot, theme: themeArg, ok, checks, consoleErrors }, null, 1));
  else {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${folder} @ ${slot} (${themeArg})`);
    for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ' - ' + c.detail : ''}`);
  }
  process.exit(ok ? 0 : 1);
})();
