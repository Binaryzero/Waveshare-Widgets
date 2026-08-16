#!/usr/bin/env node
// The #206 edge-reservation audit itself — proof that tools/tap-audit.js `auditEdgeReservation`
// DISCRIMINATES, so its all-clear across the widget sweep means something.
//
// touchpan-run.js proves the SHELL behaves (a real tap near the edge toggles instead of paging)
// and pins a hand-maintained list of the controls known to sit there. This file proves the
// GENERAL tool that now guards every widget in tools/widget-harness.js and widget-datapath.js:
// that it flags a control poking into the rail, on every route a control becomes tappable by,
// with a boundary that tracks the shipped rail width — and that it does NOT false-positive on
// an invisible control or measure a control in a nested embed whose coordinates do not map to
// the slot edge. Without this, the sweep's "all clear" could mean "measured nothing" and no
// test on this head would tell the difference.
//
//   G0 · the shipped rail is a real width, and the audit is fed the same one shell.css ships
//   G1 · a control flush to an inline edge is flagged — via EACH discovery route (native,
//        [role=button], inline on*, addEventListener) and on the correct side (L/R)
//   G2 · a control that reserves EXACTLY the rail is allowed (the boundary is inclusive)
//   G3 · a control reserving one pixel less than the rail IS flagged (the boundary is the rail,
//        not something looser — so a retune of EDGE_W retunes this)
//   G4 · a hidden control at the edge is not flagged (no false positive on what cannot be tapped)
//   G5 · a sub-4px sliver is not flagged (the documented visible-content threshold; stated so
//        the limit is a decision on the record, not a silent gap)
//   G6 · the real notifications eye at the 320px quarter slot clears the rail (a real widget,
//        the exact control #206 named, through the exact aggregator the sweep uses)
//   G7 · a control flush to the edge of a NESTED child frame is NOT reported — only the
//        immediate widget frame maps 1:1 to the slot; a deeper embed's rail is the parent's job
'use strict';
const fs = require('fs');
const path = require('path');
const { tapInitScript, auditEdgeReservation } = require('../../tools/tap-audit.js');

const REPO = path.resolve(__dirname, '..', '..');
const SHELL = path.join(REPO, 'src', 'Plinth', 'Shell');
const NOTIF = path.join(REPO, 'widgets', 'notifications');
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

// The rail is READ from shell.css (base `.edge {` rule, not the `body.editing .edge` 36px
// override), the same source widget-harness.js/widget-datapath.js read, so this suite and the
// sweep it validates always agree on the number, and a retune moves both together.
const EDGE_BLOCK = (fs.readFileSync(path.join(SHELL, 'shell.css'), 'utf8')
  .match(/(?:^|\n)\.edge\s*\{[^}]*\}/) || [''])[0];
const EDGE_W = Number((EDGE_BLOCK.match(/width:\s*(\d+)px/) || [])[1]);

const W = 320;   // the quarter slot — the tightest rail, where percentage insets are smallest

// A shell (top frame) holding ONE widget frame, so the audit's immediate-widget-frame filter
// (parent is the top frame) selects exactly the widget document, the way the real sweep does.
const SHELL_PAGE = '<!doctype html><meta charset="utf-8"><title>ww shell</title>'
  + '<style>html,body{margin:0;height:100%}iframe{border:0;width:100vw;height:100vh;display:block}</style>'
  + '<iframe id="w" src="https://widget.test/index.html"></iframe>';

// The widget document. Controls are placed by inline offset so their geometry is exact and
// independent of layout. Each is tappable by a DIFFERENT route so discovery is exercised end to
// end, not just native tags. A nested same-origin child frame carries an edge-flush control the
// audit must NOT report (G7).
const RESERVE = EDGE_W;                 // exactly the rail — allowed
const NEAR = Math.max(0, EDGE_W - 1);   // one pixel inside the rail — flagged
const WIDGET_PAGE = '<!doctype html><meta charset="utf-8">'
  + '<style>html,body{margin:0;height:100%;position:relative}'
  + '.c{position:absolute;width:40px;height:40px}'
  + '#natR{top:10px;right:0}'                         // native button, flush right  -> [R]
  + '#roleL{top:60px;left:0}'                         // [role=button], flush left    -> [L]
  + '#onR{top:110px;right:0}'                         // inline onclick, flush right  -> [R]
  + '#lisR{top:160px;right:0}'                        // addEventListener, flush right -> [R]
  + '#good{top:210px;right:' + RESERVE + 'px}'        // reserves exactly the rail    -> clear
  + '#near{top:260px;right:' + NEAR + 'px}'           // one px inside the rail        -> [R]
  + '#hid{top:310px;right:0;display:none}'            // hidden at the edge            -> clear
  // a genuine sub-4px box: a <div> takes no UA padding/border, unlike a <button>, so width:3px
  // really is 3px wide (a <button width:3px> inflates to ~16px and is correctly flagged).
  + '#tiny{top:360px;right:0;width:3px;box-sizing:border-box}'  // sub-4px sliver at the edge -> clear
  + '#kid{position:absolute;bottom:0;left:0;width:100px;height:60px;border:0}'
  + '#vid{top:10px;right:0}'                           // <video controls>, flush right -> [R]
  + '#vidNo{top:60px;left:0}'                          // <video> no controls, flush left -> clear
  + '</style>'
  + '<button class="c" id="natR">r</button>'
  + '<div class="c" id="roleL" role="button">l</div>'
  + '<div class="c" id="onR" onclick="void 0">o</div>'
  + '<div class="c" id="lisR">e</div>'
  + '<button class="c" id="good">g</button>'
  + '<button class="c" id="near">n</button>'
  + '<button class="c" id="hid">h</button>'
  + '<div class="c" id="tiny" role="button">t</div>'
  + '<video class="c" id="vid" controls></video>'
  + '<video class="c" id="vidNo"></video>'
  + '<iframe id="kid" src="https://widget.test/child.html"></iframe>'
  + '<script>document.getElementById("lisR").addEventListener("click", function(){});<\/script>';

// The nested child: a button flush to ITS OWN right edge. Edge-flush, tappable — and off-limits
// to the audit, because the child frame's x is not the slot's x.
const CHILD_PAGE = '<!doctype html><meta charset="utf-8">'
  + '<style>html,body{margin:0;height:100%}#kidBtn{position:absolute;top:10px;right:0;width:30px;height:30px}</style>'
  + '<button id="kidBtn">k</button>';

(async () => {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const context = await browser.newContext({ viewport: { width: W, height: 400 }, hasTouch: true });
  const page = await context.newPage();
  page.on('pageerror', (e) => { failures++; console.log('[pageerror]', String(e).slice(0, 300)); });

  check('G0 the shipped rail is a real, positive width', Number.isFinite(EDGE_W) && EDGE_W > 0, `EDGE_W ${EDGE_W}`);

  const serve = (route, dir, rel) => {
    const root = path.resolve(dir);
    const file = path.resolve(root, rel);
    if ((file === root || file.startsWith(root + path.sep)) && fs.existsSync(file) && fs.statSync(file).isFile())
      return route.fulfill({ contentType: MIME[path.extname(file)] || 'text/plain', body: fs.readFileSync(file) });
    return route.fulfill({ status: 404, body: '' });
  };
  await page.addInitScript(tapInitScript);
  await page.route('https://shell.test/**', (r) => r.fulfill({ contentType: 'text/html', body: SHELL_PAGE }));
  await page.route('https://widget.test/child.html', (r) => r.fulfill({ contentType: 'text/html', body: CHILD_PAGE }));
  await page.route('https://widget.test/**', (r) => r.fulfill({ contentType: 'text/html', body: WIDGET_PAGE }));
  await page.route(/https?:\/\/(?!(?:shell\.test|widget\.test)(?:[/?#]|$)).*/, (r) => r.abort());

  await page.goto('https://shell.test/host.html');
  await page.waitForSelector('#w', { timeout: 10000 });
  await page.waitForTimeout(400);

  const intr = await auditEdgeReservation(page.frames(), W, EDGE_W);
  // descriptors look like "button#natR x=280..320 [R]"; match on the id substring and side
  const flagged = (id, side) => intr.some((s) => s.includes('#' + id) && (side ? s.includes('[' + side + ']') : true));

  check('G1a a native <button> flush to the right edge is flagged [R]', flagged('natR', 'R'), intr.join(' | '));
  check('G1b a [role=button] flush to the left edge is flagged [L]', flagged('roleL', 'L'));
  check('G1c an inline onclick element flush right is flagged [R] (on* route)', flagged('onR', 'R'));
  check('G1d an addEventListener element flush right is flagged [R] (listener route)', flagged('lisR', 'R'));
  check('G2 a control that reserves exactly the rail is NOT flagged', !flagged('good'), intr.join(' | '));
  check('G3 a control one pixel inside the rail IS flagged (boundary tracks EDGE_W)',
    EDGE_W === 0 || flagged('near', 'R'), `near reserves ${NEAR}px, EDGE_W ${EDGE_W}`);
  check('G4 a hidden control at the edge is NOT flagged', !flagged('hid'));
  check('G5 a sub-4px sliver at the edge is NOT flagged (documented visible threshold)', !flagged('tiny'));
  check('G7 an edge-flush control in a NESTED child frame is NOT reported (immediate frame only)',
    !flagged('kidBtn'), intr.join(' | '));
  // G8 · the embed HOST itself is measured. The #kid <iframe> sits flush to the left edge, and
  // an <iframe> declares itself through none of the discovery routes, so this is the only thing
  // that would catch an embed widget (iframe/twitch/youtube) dropping its inline inset — the
  // gap Codex flagged. Its cross-origin interior stays out of scope (G7); its box does not.
  check('G8 an <iframe> embed host flush to an edge IS flagged (embed containers are measured)',
    flagged('kid', 'L'), intr.join(' | '));
  // G9 · a <video controls>/<audio controls> exposes the browser's own transport (seek/volume/
  // fullscreen) with no author listener, so it is a native interaction surface like an iframe and
  // must be measured; a media element WITHOUT controls is a visual (gallery's slideshow,
  // jellyfin's widget-driven player) and must NOT be, or every full-bleed video would false-flag.
  check('G9a a <video controls> flush to an edge IS flagged (native media transport)',
    flagged('vid', 'R'), intr.join(' | '));
  check('G9b a <video> WITHOUT controls is NOT flagged (a visual, not a tap surface)',
    !flagged('vidNo'), intr.join(' | '));

  // ---- G6 · the real widget, the real control the report named -------------------------
  const notifPage = await context.newPage();
  await notifPage.addInitScript(tapInitScript);
  // Drive the fixture from the PARENT frame. widget-api.js accepts protocol messages only when
  // ev.source === window.parent (widget-api.js:379), so a self-post from inside the widget is
  // dropped — the eye would never render and G6 would pass vacuously (its own absence read as
  // "clears the rail"). On the widget's ww-ready the shell answers with ww-init then
  // ww-notifications, the same handshake the real shell and touchpan-run.js use, so the eye is
  // really on screen when the audit measures it. The listener is registered before the frame so
  // it cannot miss ww-ready.
  const NSHELL = '<!doctype html><meta charset="utf-8"><title>ww shell</title>'
    + '<style>html,body{margin:0;height:100%}iframe{border:0;width:100vw;height:100vh;display:block}</style>'
    + '<script>window.addEventListener("message",function(ev){'
    + 'var f=document.getElementById("w");if(!f||ev.source!==f.contentWindow)return;'
    + 'var m=ev.data||{};if(m.type!=="ww-ready")return;var o="https://widget.test";'
    + 'f.contentWindow.postMessage({type:"ww-init",settings:{bgStyle:"solid",maxItems:24},'
    + 'sensors:[],media:null,theme:{},status:{elevated:false,apiVersion:1}},o);'
    + 'f.contentWindow.postMessage({type:"ww-notifications",data:{items:[{id:"x",app:"A",'
    + 'title:"hi",time:Date.now()}],supported:true}},o);});<\/script>'
    + '<iframe id="w" src="https://widget.test/index.html#ww-slot=p0s0"></iframe>';
  await notifPage.route('https://app.plinth/**', (r) =>
    serve(r, SHELL, decodeURIComponent(new URL(r.request().url()).pathname).replace(/^\/+/, '')));
  await notifPage.route('https://shell.test/**', (r) => r.fulfill({ contentType: 'text/html', body: NSHELL }));
  await notifPage.route('https://widget.test/**', (r) =>
    serve(r, NOTIF, decodeURIComponent(new URL(r.request().url()).pathname).replace(/^\/+/, '') || 'index.html'));
  await notifPage.route(/https?:\/\/(?!(?:app\.plinth|shell\.test|widget\.test)(?:[/?#]|$)).*/, (r) => r.abort());
  await notifPage.goto('https://shell.test/host.html');
  await notifPage.waitForSelector('#w', { timeout: 10000 });
  const nframe = notifPage.frames().find((f) => f.url().includes('widget.test'));
  // The eye must actually be on screen. If it never un-hides, G6 would be vacuous — so this is
  // an assertion, not a swallowed wait: a regression that stops the eye rendering fails here.
  const eyeShown = nframe
    ? await nframe.waitForSelector('#eyeBtn:not([hidden])', { timeout: 8000 }).then(() => true).catch(() => false)
    : false;
  check('G6a the notifications eye actually rendered (guards against a vacuous G6)', eyeShown);
  await notifPage.waitForTimeout(200);
  const notifIntr = await auditEdgeReservation(notifPage.frames(), W, EDGE_W);
  check('G6b the real notifications eye clears the rail at the 320px quarter slot',
    eyeShown && !notifIntr.some((s) => s.includes('#eyeBtn')), notifIntr.join(' | ') || 'all clear');

  await browser.close();
  console.log(failures > 0 ? `\n${failures} FAILURES` : '\nALL PASS');
  process.exit(failures > 0 ? 1 : 0);
})();
