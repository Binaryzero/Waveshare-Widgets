#!/usr/bin/env node
// A tap on a widget control pages the panel sideways instead of acting (issue #206).
//
// "In some chips, like the notifications widget's eyeball, the top right-hand corner is so
// close to the scroll bar that it causes scrolling instead of toggling."
//
// THE MECHANISM, which is not where the report points. There is no scrollbar next to the
// eye — `#list` sets `scrollbar-width: none` and hides the WebKit one, and the eye sits in
// `<header>`, outside the list entirely. What is next to it is the SHELL: `#pages` is a
// horizontal `scroll-snap` container holding every page of the panel, and widget documents
// are `overflow: hidden` (widget-base.css). So a gesture that starts on a control with no
// scrollable ancestor INSIDE the iframe has nothing local to pan, and `touch-action`
// intersects up the ancestor chain across the frame boundary — shell.css says so in its own
// comment — which hands the pan to `#pages`. The finger moves a few pixels on the way to a
// tap, and the panel changes page instead of the eye toggling.
//
// That also explains "some": it happens to controls sitting outside any in-widget scroller,
// which is most of them. `widget-base.css` declared no `touch-action` at all, and five
// widgets had each patched it locally — the signature of a missing shared rule.
//
//   T1 · setup: the list really does overflow, and the shell really can page
//   T2 · a vertical drag inside the list still scrolls it — the fix must not buy T3 by
//        making scrollable regions unscrollable, which is the obvious way to get this wrong
//   T3 · a drag that starts on the eye does NOT page the panel
//   T4 · ...and a tap on it still toggles, so T3 is not satisfied by a dead control
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const SHELL = path.join(REPO, 'src', 'WaveshareWidgets', 'Shell');
const WIDGET = path.join(REPO, 'widgets', 'notifications');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

function loadPlaywright() {
  const candidates = ['playwright', '/opt/node22/lib/node_modules/playwright',
    path.join(process.env.HOME || '', 'node_modules/playwright')];
  for (const c of candidates) { try { return require(c); } catch (e) { /* next */ } }
  console.error('playwright not found');
  process.exit(1);
}

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  if (!ok) failures++;
};

// The shell, reduced to the part that matters: a horizontal snap scroller with two pages.
// Mirrors shell.css — #pages is overflow-x:auto with scroll-snap-type:x mandatory, and each
// page is a full-viewport snap target. Without a SECOND page there is nothing to scroll to
// and T3 would pass against the unfixed build.
const SHELL_PAGE = '<!doctype html><meta charset="utf-8"><title>ww shell</title><style>'
  + 'html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#000;'
  + 'touch-action:manipulation}'
  + '#pages{height:100%;display:flex;overflow-x:auto;overflow-y:hidden;'
  + 'scroll-snap-type:x mandatory;scrollbar-width:none}'
  + '#pages::-webkit-scrollbar{display:none}'
  + '.page{flex:0 0 100vw;height:100%;scroll-snap-align:start;scroll-snap-stop:always}'
  + 'iframe{display:block;border:0;width:100%;height:100%}'
  + '</style><div id="pages"><div class="page" id="p0"></div><div class="page" id="p1"></div></div>';

const ITEMS = Array.from({ length: 24 }, (_, i) => ({
  id: 'n' + i,
  app: 'App ' + (i % 4),
  appId: 'app' + (i % 4),
  title: 'Notification number ' + i,
  body: 'A body long enough to give the row some height and make the list overflow.',
  time: Date.now() - i * 60000,
}));

(async () => {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  // hasTouch is what makes the browser apply touch-action at all — without it every gesture
  // below is a mouse drag, which touch-action does not govern and which would make this
  // whole file pass no matter what the CSS says.
  const context = await browser.newContext({ viewport: { width: 640, height: 400 }, hasTouch: true });
  const page = await context.newPage();
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
    serve(r, WIDGET, decodeURIComponent(new URL(r.request().url()).pathname).replace(/^\/+/, '') || 'index.html'));
  await page.route('https://shell.test/**', (r) => r.fulfill({ contentType: 'text/html', body: SHELL_PAGE }));
  await page.route(/https?:\/\/(?!(?:app\.wsw|widget\.test|shell\.test)(?:[/?#]|$)).*/, (r) => r.abort());

  const shim = fs.readFileSync(path.join(SHELL, 'widget-api.js'), 'utf8') + '\n'
             + fs.readFileSync(path.join(SHELL, 'icue-compat.js'), 'utf8');
  await page.addInitScript(shim);
  await page.addInitScript(({ widgetUrl, widgetOrigin, init, notif }) => {
    if (window.top !== window) return;
    let frame = null;
    window.__wwMount = () => {
      frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      frame.src = widgetUrl + '#ww-slot=p0s0';
      document.getElementById('p0').appendChild(frame);
    };
    window.__wwPush = (msg) => { if (frame && frame.contentWindow) frame.contentWindow.postMessage(msg, widgetOrigin); };
    window.addEventListener('message', (ev) => {
      if (!frame || ev.source !== frame.contentWindow || ev.origin !== widgetOrigin) return;
      const m = ev.data || {};
      if (m.type === 'ww-ready') { window.__wwPush(init); window.__wwPush(notif); }
    });
  }, {
    widgetUrl: 'https://widget.test/index.html',
    widgetOrigin: 'https://widget.test',
    init: { type: 'ww-init',
      settings: { bgStyle: 'solid', maxItems: 24 },
      sensors: [], media: null, theme: {}, game: { active: false, process: '' },
      status: { elevated: false, apiVersion: 1 } },
    // `data`, not `payload` — widget-api.js reads msg.data. Getting this wrong renders an
    // empty tile that still mounts cleanly, which is why T1 asserts the list overflowed
    // rather than trusting the push to have landed.
    notif: { type: 'ww-notifications', data: { items: ITEMS, supported: true } },
  });

  await page.goto('https://shell.test/host.html');
  await page.evaluate(() => window.__wwMount());
  const frameEl = await page.waitForSelector('#p0 iframe', { timeout: 10000 });
  const frame = await frameEl.contentFrame();
  if (!frame) { console.log('  FAIL mount: widget frame never attached'); await browser.close(); process.exit(1); }
  await frame.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(1500);

  const cdp = await context.newCDPSession(page);
  // Playwright's touchscreen only taps. A DRAG is what turns a tap into a pan, so the
  // gesture is dispatched by hand: one touchStart, several touchMoves far enough apart to
  // pass the browser's slop threshold, then touchEnd.
  const drag = async (x, y, dx, dy, steps = 10) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart',
      touchPoints: [{ x, y, id: 1 }] });
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove',
        touchPoints: [{ x: x + (dx * i) / steps, y: y + (dy * i) / steps, id: 1 }] });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(600);
  };

  const pagesLeft = () => page.evaluate(() => document.getElementById('pages').scrollLeft);
  const listTop = () => frame.evaluate(() => document.getElementById('list').scrollTop);

  // ---- T1 · the preconditions, asserted rather than assumed ---------------------------
  const setup = await frame.evaluate(() => {
    const l = document.getElementById('list');
    const b = document.getElementById('eyeBtn');
    return { overflow: l ? l.scrollHeight - l.clientHeight : 0, eyeVisible: !!(b && !b.hidden) };
  });
  const canPage = await page.evaluate(() => {
    const p = document.getElementById('pages');
    return p.scrollWidth - p.clientWidth;
  });
  check('T1 setup: the list overflows and the shell has somewhere to page to',
    setup.overflow > 20 && setup.eyeVisible && canPage > 100,
    `list overflow ${setup.overflow}px, eye visible ${setup.eyeVisible}, page slack ${canPage}px`);

  // ---- T2 · scrolling the list still works --------------------------------------------
  // First, because the cheapest way to pass T3 is to forbid panning everywhere, and that
  // would leave this widget's list stuck at the top forever.
  const listBox = await frame.locator('#list').boundingBox();
  await drag(listBox.x + listBox.width / 2, listBox.y + listBox.height * 0.75, 0, -listBox.height * 0.5);
  const scrolled = await listTop();
  check('T2 a vertical drag inside the list still scrolls it', scrolled > 10, `scrollTop ${scrolled}`);

  // ---- T3 · the reported bug -----------------------------------------------------------
  await page.evaluate(() => { document.getElementById('pages').scrollLeft = 0; });
  await page.waitForTimeout(300);
  const eyeBox = await frame.locator('#eyeBtn').boundingBox();
  const before = await pagesLeft();
  await drag(eyeBox.x + eyeBox.width / 2, eyeBox.y + eyeBox.height / 2, -160, 0);
  const after = await pagesLeft();
  check('T3 a drag that starts on the eye does not page the panel',
    Math.abs(after - before) < 5, `pages scrollLeft ${before} -> ${after}`);

  // ---- T4 · ...and the control still does its job ---------------------------------------
  await page.evaluate(() => { document.getElementById('pages').scrollLeft = 0; });
  await page.waitForTimeout(300);
  const pressedBefore = await frame.evaluate(() => document.getElementById('eyeBtn').getAttribute('aria-pressed'));
  await frame.locator('#eyeBtn').tap();
  await page.waitForTimeout(400);
  const pressedAfter = await frame.evaluate(() => document.getElementById('eyeBtn').getAttribute('aria-pressed'));
  check('T4 ...and a tap on it still toggles, so T3 is not a dead control',
    pressedBefore !== pressedAfter, `aria-pressed ${pressedBefore} -> ${pressedAfter}`);

  await browser.close();
  console.log(failures > 0 ? `\n${failures} FAILURES` : '\nALL PASS');
  process.exit(failures > 0 ? 1 : 0);
})();
