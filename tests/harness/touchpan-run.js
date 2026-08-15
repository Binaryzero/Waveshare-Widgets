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
const SHELL = path.join(REPO, 'src', 'Plinth', 'Shell');
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

// The runtime edge width is READ from shell.css rather than hardcoded, so these tests track
// the shipped value: #213 narrowed the page-swipe strip from 36px so it stops covering a
// control near a screen edge, and #245 narrowed it further to 8px — the minimum stock
// control inset — after 16px was found to still cover the notifications eye in a 320px
// quarter slot. A regression toward either wider value re-covers the eye and fails E2 (640px)
// or E5 (320px) below. The `.edge {` base rule is matched (not the `body.editing .edge`
// override, which keeps the full 36px for the drop target).
const EDGE_CSS = fs.readFileSync(path.join(SHELL, 'shell.css'), 'utf8');
const EDGE_BLOCK = (EDGE_CSS.match(/(?:^|\n)\.edge\s*\{[^}]*\}/) || [''])[0];
const EDGE_W = Number((EDGE_BLOCK.match(/width:\s*(\d+)px/) || [])[1]);

// The shell, reduced to the part that matters: a horizontal snap scroller with two pages,
// PLUS the two .edge overlays (#213) — fixed strips above the iframes that page on a tap.
// bindEdge is mirrored from shell.js:1214 and the width comes from EDGE_W, so the overlap
// geometry the E-tests measure is the shipped one. Without a SECOND page there is nothing
// to scroll to and T3/E3 would pass against an unfixed build.
const SHELL_PAGE = '<!doctype html><meta charset="utf-8"><title>ww shell</title><style>'
  + 'html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#000;'
  + 'touch-action:manipulation}'
  + '#pages{height:100%;display:flex;overflow-x:auto;overflow-y:hidden;'
  + 'scroll-snap-type:x mandatory;scrollbar-width:none}'
  + '#pages::-webkit-scrollbar{display:none}'
  + '.page{flex:0 0 100vw;height:100%;scroll-snap-align:start;scroll-snap-stop:always}'
  + 'iframe{display:block;border:0;width:100%;height:100%}'
  + '.edge{position:fixed;top:0;bottom:0;width:' + EDGE_W + 'px;z-index:5;touch-action:none}'
  + '.edge.left{left:0}.edge.right{right:0}'
  + '</style><div id="pages"><div class="page" id="p0"></div><div class="page" id="p1"></div></div>'
  + '<div id="edgeLeft" class="edge left"></div><div id="edgeRight" class="edge right"></div>'
  + '<script>(function(){function bindEdge(el,dir){var sx=null;'
  + 'el.addEventListener("pointerdown",function(e){sx=e.clientX;try{el.setPointerCapture(e.pointerId);}catch(_){}});'
  + 'el.addEventListener("pointerup",function(e){if(sx===null)return;var dx=e.clientX-sx;sx=null;'
  + 'var pg=document.getElementById("pages");var to=Math.abs(dx)<12?dir:(dx<0?1:-1);'
  + 'pg.scrollLeft=Math.max(0,Math.min(pg.scrollWidth-pg.clientWidth,pg.scrollLeft+to*pg.clientWidth));});'
  + 'el.addEventListener("pointercancel",function(){sx=null;});}'
  + 'bindEdge(document.getElementById("edgeLeft"),-1);bindEdge(document.getElementById("edgeRight"),1);})();<\/script>';

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
  await page.route('https://app.plinth/**', (r) =>
    serve(r, SHELL, decodeURIComponent(new URL(r.request().url()).pathname).replace(/^\/+/, '')));
  await page.route('https://widget.test/**', (r) =>
    serve(r, WIDGET, decodeURIComponent(new URL(r.request().url()).pathname).replace(/^\/+/, '') || 'index.html'));
  await page.route('https://shell.test/**', (r) => r.fulfill({ contentType: 'text/html', body: SHELL_PAGE }));
  await page.route(/https?:\/\/(?!(?:app\.plinth|widget\.test|shell\.test)(?:[/?#]|$)).*/, (r) => r.abort());

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
      sensors: [], media: null, theme: {},
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

  // ---- T7 · the case that decides the whole design ------------------------------------
  // T2 drags from blank space in the list. The interesting drag starts ON a control that
  // lives INSIDE the scroller — a mute row here, a scene chip in hue — because that is
  // where a too-broad touch-action turns a scrollable list into a dead one. Neither the
  // report nor the review named it, and it is the case that separates "ban panning on the
  // document" from "opt individual controls out".
  await frame.evaluate(() => { document.getElementById('list').scrollTop = 0; });
  await page.waitForTimeout(200);
  const rowBox = await frame.locator('.app-head').first().boundingBox();
  await drag(rowBox.x + rowBox.width * 0.4, rowBox.y + rowBox.height / 2, 0, -180);
  const rowScrolled = await listTop();
  check('T7 a drag that starts ON a control inside the list still scrolls the list',
    rowScrolled > 10, `scrollTop ${rowScrolled}`);

  // ---- T9 · the axis T7 cannot see ----------------------------------------------------
  // T7 drags vertically out of a control inside the list and the list scrolls. A HORIZONTAL
  // drag from the same control is a different question: the list is still the nearest
  // scrolling ancestor, so a rule on the document is not in the intersection at all — and
  // with the default `auto` the horizontal pan chains straight out to the shell's pager
  // (measured: scrollLeft 0 -> 612). `touch-action: pan-y` on the scroller is what stops
  // it, which is why the four stock scrollers carry it.
  await page.evaluate(() => { document.getElementById('pages').scrollLeft = 0; });
  await frame.evaluate(() => { document.getElementById('list').scrollTop = 0; });
  await page.waitForTimeout(250);
  const rowBox2 = await frame.locator('.app-head').first().boundingBox();
  const hBefore = await pagesLeft();
  await drag(rowBox2.x + rowBox2.width * 0.4, rowBox2.y + rowBox2.height / 2, -160, 0);
  const hAfter = await pagesLeft();
  check('T9 a HORIZONTAL drag from a control inside the list does not page the panel',
    Math.abs(hAfter - hBefore) < 5, `pages scrollLeft ${hBefore} -> ${hAfter}`);

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

  // ---- E1/E2/E3 · the edge overlay no longer steals a tap near the screen edge (#213) -----
  // T3/T4 exercised the widget-side fix (#212). This exercises the SHELL side: the .edge
  // strips page on a tap and sit above the iframes, so at 36px they covered the eye (~18px
  // from the right edge) and a tap on it paged instead of toggling. The strip is now EDGE_W,
  // read from shell.css, so a revert to 36 fails E2b. This pass runs at 640px; E4/E5 below
  // repeat the geometry at the 320px quarter slot, where the inset is tighter (#245).
  await page.evaluate(() => { document.getElementById('pages').scrollLeft = 0; });
  await page.waitForTimeout(200);
  const vw = await page.evaluate(() => window.innerWidth);
  // The frame fills the viewport at scrollLeft 0, so the eye's frame-local box IS its screen
  // box. Reset the eye first (T4 toggled it) so E2b's toggle assertion reads a clean edge.
  await frame.evaluate(() => { const b = document.getElementById('eyeBtn'); if (b.getAttribute('aria-pressed') === 'true') b.click(); });
  await page.waitForTimeout(150);
  const eb = await frame.locator('#eyeBtn').boundingBox();
  const eyeRight = eb.x + eb.width;
  const eyeMidY = eb.y + eb.height / 2;
  // A point on the eye inside the OLD 36px band but OUTSIDE the new EDGE_W band — the exact
  // sliver the bug lived in. If the eye no longer reaches the 36px band this test cannot
  // discriminate, so E1 fails LOUDLY to force a retune rather than passing hollow.
  const testX = Math.round(((vw - 36) + (vw - EDGE_W)) / 2);
  check('E1 setup: the eye reaches into the old 36px edge band, so this is discriminating',
    EDGE_W < 36 && eb.x <= testX && testX <= eyeRight && (vw - eyeRight) < 36,
    `EDGE_W ${EDGE_W}, eye ${Math.round(eb.x)}..${Math.round(eyeRight)}, testX ${testX}`);

  const topAt = await page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    return el ? (el.id || el.tagName.toLowerCase()) : null;
  }, [testX, eyeMidY]);
  // Two ways: the overlay is not the top element at the sliver point, AND the whole eye
  // clears the strip (guards an intermediate creep like 20px, not just a revert to 36).
  check('E2a the edge overlay does not cover the eye', topAt !== 'edgeRight' && eyeRight <= vw - EDGE_W,
    `top ${topAt}, eyeRight ${Math.round(eyeRight)} vs strip start ${vw - EDGE_W}`);

  const prBefore = await frame.evaluate(() => document.getElementById('eyeBtn').getAttribute('aria-pressed'));
  const slBefore = await pagesLeft();
  await page.touchscreen.tap(testX, eyeMidY);
  await page.waitForTimeout(400);
  const prAfter = await frame.evaluate(() => document.getElementById('eyeBtn').getAttribute('aria-pressed'));
  const slAfter = await pagesLeft();
  check('E2b a tap on the eye near the edge toggles it and does not page',
    prBefore !== prAfter && Math.abs(slAfter - slBefore) < 5,
    `aria-pressed ${prBefore} -> ${prAfter}, pages ${slBefore} -> ${slAfter}`);

  // The swipe surface survives the narrowing: a tap INSIDE the strip still pages.
  await page.evaluate(() => { document.getElementById('pages').scrollLeft = 0; });
  await page.waitForTimeout(200);
  const stripBefore = await pagesLeft();
  await page.touchscreen.tap(vw - 3, 200);
  await page.waitForTimeout(400);
  const stripAfter = await pagesLeft();
  check('E3 the narrowed edge still pages on a tap in the strip',
    stripAfter - stripBefore > 100, `pages ${stripBefore} -> ${stripAfter}`);

  // ---- E4/E5 · the same overlap at the 320px quarter slot (#245) -----------------------
  // Notifications supports the 320px quarter slot, and its horizontal padding is a clamp
  // that grows with width — 18px at 640px (which is what HID this), but only 10px at 320px.
  // So the eye sits closer to the edge here, and a 16px strip that cleared it at 640px still
  // covered it at 320px. Re-run the geometry at 320px, then restore the 640px viewport for
  // the checks that follow.
  await page.setViewportSize({ width: 320, height: 400 });
  await page.waitForTimeout(250);
  await page.evaluate(() => { document.getElementById('pages').scrollLeft = 0; });
  await frame.evaluate(() => { const b = document.getElementById('eyeBtn'); if (b.getAttribute('aria-pressed') === 'true') b.click(); });
  await page.waitForTimeout(150);
  const vw2 = await page.evaluate(() => window.innerWidth);
  const eb2 = await frame.locator('#eyeBtn').boundingBox();
  const eyeRight2 = eb2.x + eb2.width;
  const eyeMidY2 = eb2.y + eb2.height / 2;
  // Discriminating: at 320px the eye must reach into the OLD 16px band, so a strip that wide
  // WOULD have covered it — which is exactly what #245 measured. If it does not, this test
  // cannot tell a fixed build from a broken one, so it fails loudly to force a retune.
  check('E4 setup: at 320px the eye reaches into the old 16px edge band, so this discriminates',
    EDGE_W < 16 && (vw2 - eyeRight2) < 16 && eb2.x < vw2 - EDGE_W,
    `vw ${vw2}, eye ${Math.round(eb2.x)}..${Math.round(eyeRight2)}, old-band start ${vw2 - 16}, strip start ${vw2 - EDGE_W}`);
  const testX2 = Math.round(((vw2 - 16) + (vw2 - EDGE_W)) / 2);
  const topAt2 = await page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    return el ? (el.id || el.tagName.toLowerCase()) : null;
  }, [testX2, eyeMidY2]);
  check('E5a at 320px the edge overlay does not cover the eye', topAt2 !== 'edgeRight' && eyeRight2 <= vw2 - EDGE_W,
    `top ${topAt2}, eyeRight ${Math.round(eyeRight2)} vs strip start ${vw2 - EDGE_W}`);

  const prBefore2 = await frame.evaluate(() => document.getElementById('eyeBtn').getAttribute('aria-pressed'));
  const slBefore2 = await pagesLeft();
  await page.touchscreen.tap(testX2, eyeMidY2);
  await page.waitForTimeout(400);
  const prAfter2 = await frame.evaluate(() => document.getElementById('eyeBtn').getAttribute('aria-pressed'));
  const slAfter2 = await pagesLeft();
  check('E5b at 320px a tap on the eye near the edge toggles it and does not page',
    prBefore2 !== prAfter2 && Math.abs(slAfter2 - slBefore2) < 5,
    `aria-pressed ${prBefore2} -> ${prAfter2}, pages ${slBefore2} -> ${slAfter2}`);

  await page.setViewportSize({ width: 640, height: 400 });
  await page.waitForTimeout(200);

  // ---- T5/T6 · what the shared stylesheet must NOT do ---------------------------------
  // The first version of this fix put `touch-action: none` on the widget document in
  // widget-base.css. These checks do NOT show that rule broke anything — run against it,
  // all three stayed green. The reason it is not shipped is simply that widget-base is an
  // unversioned stylesheet installed third-party packages also link, so a document-level
  // rule lands on code that cannot be inspected or tested from here; an opt-in class does
  // the same job for the controls we can see. These stay as standing guards on the
  // invariant — third-party and embedded content keep scrolling — not as evidence.
  //
  // T5 · installed third-party .plinthwidget packages link this same unversioned stylesheet
  //      (WidgetLibrary hot-reloads them), and the standard has always told them to — so
  //      whatever this file does reaches scrollable regions nobody here can see.
  // T6 · the iframe, twitch and youtube widgets host CROSS-ORIGIN content in a nested
  //      frame, which cannot override an ancestor's touch-action from the inside.
  //
  // Neither is a claim that some past rule broke them: run against the document-wide
  // version, both stayed green. They pin the INVARIANT — this stylesheet keeps other
  // people's content scrollable — which is worth holding whether or not any particular
  // rule would have violated it.
  //
  // Both are synthetic stand-ins on purpose: they encode the CONSTRAINT on widget-base.css
  // rather than the current contents of any one widget.
  // A third-party widget that overrides `overflow: hidden` and scrolls the DOCUMENT itself,
  // rather than a child element as T5 does. Review raised this shape as the case a
  // document-level rule would kill; the shipped design has no document-level rule, so it is
  // here as a standing guard rather than as evidence for or against that claim.
  const ROOT_SCROLLER = '<!doctype html><meta charset="utf-8">'
    + '<link rel="stylesheet" href="https://app.plinth/widget-base.css">'
    + '<style>html,body{overflow:auto !important}.tall{height:2000px}</style>'
    + '<div class="tall">third-party root scroller</div>';
  const THIRD_PARTY = '<!doctype html><meta charset="utf-8">'
    + '<link rel="stylesheet" href="https://app.plinth/widget-base.css">'
    + '<style>#scroller{height:100%;overflow-y:auto}.tall{height:2000px}</style>'
    + '<div id="scroller"><div class="tall">third-party content</div></div>';
  const EMBEDDED = '<!doctype html><meta charset="utf-8">'
    + '<style>html,body{margin:0}.tall{height:2000px}</style><div class="tall">embedded</div>';
  // A widget whose content is a nested cross-origin frame, like iframe/twitch/youtube.
  const NESTER = '<!doctype html><meta charset="utf-8">'
    + '<link rel="stylesheet" href="https://app.plinth/widget-base.css">'
    + '<style>iframe{border:0;width:100%;height:100%}</style>'
    + '<iframe src="https://embedded.test/page.html"></iframe>';

  await page.route('https://thirdparty.test/**', (r) => r.fulfill({ contentType: 'text/html', body: THIRD_PARTY }));
  await page.route('https://rootscroll.test/**', (r) => r.fulfill({ contentType: 'text/html', body: ROOT_SCROLLER }));
  await page.route('https://nester.test/**', (r) => r.fulfill({ contentType: 'text/html', body: NESTER }));
  await page.route('https://embedded.test/**', (r) => r.fulfill({ contentType: 'text/html', body: EMBEDDED }));

  const scrollProbe = async (url, sel) => {
    const p = await context.newPage();
    await p.route('https://app.plinth/**', (r) =>
      serve(r, SHELL, decodeURIComponent(new URL(r.request().url()).pathname).replace(/^\/+/, '')));
    await p.route('https://thirdparty.test/**', (r) => r.fulfill({ contentType: 'text/html', body: THIRD_PARTY }));
    await p.route('https://rootscroll.test/**', (r) => r.fulfill({ contentType: 'text/html', body: ROOT_SCROLLER }));
    await p.route('https://nester.test/**', (r) => r.fulfill({ contentType: 'text/html', body: NESTER }));
    await p.route('https://embedded.test/**', (r) => r.fulfill({ contentType: 'text/html', body: EMBEDDED }));
    await p.goto(url);
    await p.waitForTimeout(400);
    // includes(), not indexOf()===0: the frame's url carries its scheme, so an
    // anchored match never hits and the probe dies rather than reporting a scroll.
    const target = sel.frame ? p.frames().find((f) => f.url().includes('embedded.test')) : p;
    if (sel.frame && !target) { await p.close(); return -1; }
    const box = { x: 320, y: 200 };
    const cdp2 = await context.newCDPSession(p);
    await cdp2.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x, y: box.y, id: 1 }] });
    for (let i = 1; i <= 10; i++) {
      await cdp2.send('Input.dispatchTouchEvent', { type: 'touchMove',
        touchPoints: [{ x: box.x, y: box.y - i * 12, id: 1 }] });
      await p.waitForTimeout(16);
    }
    await cdp2.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await p.waitForTimeout(500);
    // Read BOTH roots, not just document.scrollingElement. widget-base sets
    // `html, body { height: 100% }`, which makes BODY the scrolling box on a page that
    // opts back into overflow — scrollingElement is <html> and stays 0 there. Reading only
    // it reported a perfectly scrollable third-party widget as dead, and I revised a design
    // around that phantom before checking the probe itself.
    const top = await target.evaluate((s) => (s ? document.querySelector(s).scrollTop
      : Math.max(document.documentElement.scrollTop, document.body.scrollTop)), sel.el || null);
    await p.close();
    return top;
  };

  const tpTop = await scrollProbe('https://thirdparty.test/w.html', { el: '#scroller' });
  check('T5 a third-party widget scroller with no touch-action of its own still scrolls',
    tpTop > 10, `scrollTop ${tpTop}`);

  const rootTop = await scrollProbe('https://rootscroll.test/w.html', {});
  check('T8 a third-party widget that scrolls its ROOT document still scrolls',
    rootTop > 10, `scrollTop ${rootTop}`);

  const embTop = await scrollProbe('https://nester.test/w.html', { frame: true });
  check('T6 ...and cross-origin content in a nested iframe widget still scrolls',
    embTop > 10, `scrollTop ${embTop}`);

  // ---- T10 · the opt-in actually took effect ------------------------------------------
  // `.no-pan` is a CLASS, so any id-level `touch-action` in a widget's own CSS outranks it
  // and the control stays pannable — silently, because the markup still says no-pan. That
  // is exactly what hue's `#pairBtn { touch-action: manipulation }` did. Reading the
  // COMPUTED value is the only way to see it; the class list lies.
  // Every stock control that must not pan, however it gets there — the .no-pan class or a
  // widget's own rule. What matters is the computed value, not which mechanism won.
  const OPTED = [['hue', '#pairBtn'], ['hue', '#legacyBtn'], ['volume', '#masterMute'],
    ['volume', '#masterSlider'], ['notifications', '#eyeBtn'],
    ['media', '#controls .btn'], ['deck', '.key'], ['launcher', '.tile'],
    ['streamdeck', '.key'], ['streamdeck', '#live'], ['streamdeck', '#picker button'],
    ['vitals', '.meter-row'],
    // Hidden at load, which is why nothing reported them for so long — but PRESENT, so
    // their computed value is readable here. Withdrawing T11 took away the only thing
    // covering them; without these two the fixes in this very commit ship unguarded.
    ['forecast7', '#retry'], ['rest', '#retry']];
  const bad = [];
  for (const [w, sel] of OPTED) {
    const wp = await context.newPage();
    await wp.route('https://app.plinth/**', (r) =>
      serve(r, SHELL, decodeURIComponent(new URL(r.request().url()).pathname).replace(/^\/+/, '')));
    await wp.route('https://w.test/**', (r) => r.fulfill({ contentType: 'text/html',
      body: fs.readFileSync(path.join(REPO, 'widgets', w, 'index.html')) }));
    await wp.goto('https://w.test/index.html');
    await wp.waitForTimeout(250);
    // deck keys, launcher tiles and streamdeck keys are built by JS, so a static load has
    // none of them. Where the selector matches nothing, inject an element carrying the same
    // classes and read that: the question is what the widget's RULE computes to, and an
    // absent element would otherwise read as a silent pass.
    const ta = await wp.evaluate((s2) => {
      let e = document.querySelector(s2);
      if (!e) {
        // Build the last segment inside whatever the earlier segments select. The first
        // version handled only class selectors and returned '(absent)' for a bare tag
        // like `#picker button` — which reads as "checked and fine" in a list of
        // controls, the exact silent pass the injection exists to prevent.
        const parts = s2.trim().split(/\s+/);
        const leaf = parts[parts.length - 1];
        const host = parts.length > 1
          ? document.querySelector(parts.slice(0, -1).join(' ')) : null;
        if (parts.length > 1 && !host) return '(host absent: ' + parts.slice(0, -1).join(' ') + ')';
        const cls = (leaf.match(/\.[A-Za-z0-9_-]+/g) || []).map((c) => c.slice(1));
        const tag = leaf.match(/^[A-Za-z][A-Za-z0-9]*/);
        if (!cls.length && !tag) return '(absent)';
        e = document.createElement(tag ? tag[0] : 'div');
        if (cls.length) e.className = cls.join(' ');
        (host || document.body).appendChild(e);
      }
      return getComputedStyle(e).touchAction;
    }, sel);
    if (ta !== 'none') bad.push(`${w} ${sel} = ${ta}`);
    await wp.close();
  }
  check('T10 every control marked .no-pan actually computes to touch-action: none',
    bad.length === 0, bad.join(' | ') || `${OPTED.length} controls checked`);

  // NO T11. A sweep that enumerates controls instead of checking T10's hand-maintained
  // list is the right idea — it is what #214 asked for — but it cannot be built here.
  // Three inventories were tried and all three were narrower than the claim they made:
  // semantic tags miss Home Assistant's listener-backed `.ent` divs; adding `cursor:
  // pointer` still misses gallery's and reddit's whole-body click handlers, because
  // addEventListener changes no computed style; and a static load misses every control a
  // render path CREATES — streamdeck's own `#picker button` among them, so the guard
  // could not have caught the defect that prompted it.
  //
  // There is no static signal for "this is tappable". The one that works is instrumenting
  // addEventListener so surfaces declare themselves at registration, and that belongs in
  // tools/widget-harness.js, which already mounts every widget with a real ww-init and
  // already runs 162 times per sweep — covering listener-only surfaces, JS-created ones
  // and post-init reveals in one place. Filed as its own issue rather than left here as a
  // check that reads like coverage while provably missing real controls.

  await browser.close();
  console.log(failures > 0 ? `\n${failures} FAILURES` : '\nALL PASS');
  process.exit(failures > 0 ? 1 : 0);
})();
