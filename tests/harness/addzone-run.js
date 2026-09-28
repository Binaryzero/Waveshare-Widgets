#!/usr/bin/env node
// Issue #84 — in edit mode a visibly empty region offered no way to add a widget.
// `positionAddZone` searched for the single largest free rectangle and placed ONE zone
// there, so a page with two disjoint holes showed "Add widget" in one and left the other
// dead.
//
// Edit mode lives in the settings window's live preview: the shell booted as a replica
// (index.html?preview=1) and switched on by the settings window's `edit-mode` message.
// The panel itself only displays. So this boots the replica, drives it the way
// settings.js does, and reads what it posts up.
//
//   A0 · the panel offers no way into edit mode at all, and ignores `edit-mode`
//   A0e · a panel whose pages hold no tile shows the hint pointing at the settings window
//   A1 · every free region gets an add affordance, not just the biggest
//   A2 · the zones tile the free space: no overlap with each other or with a slot
//   A3 · tapping a zone hands the add to the settings window naming THAT region
//   A4 · a full page offers none
//   A5 · a region nothing fits says so rather than going silent (#77)
//   A6 · a fit that spans two partition rectangles is offered (#86)
//
// And two checks on the replica's size chips, which lived in panelsecret-run.js while the
// panel had an editor of its own:
//
//   N11 · a stored size the widget no longer allows cycles to the NEXT size up (#77)
//   N7b · the notice a size tap raises is visible but not hit-testable
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const http = require('http');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const SHELL = path.join(REPO, 'src', 'Plinth', 'Shell');
const PORT = 8955;

function staticServer(rootDir, port) {
  const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
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

const manifest = (slug) => JSON.parse(fs.readFileSync(path.join(REPO, 'widgets', slug, 'manifest.json'), 'utf8'));
function catalogEntry(slug) {
  const m = manifest(slug);
  return {
    id: m.id, name: m.name, author: m.author, version: m.version,
    url: `https://${slug}.widgets.plinth/index.html`,
    supportedSlots: m.supported_slots, properties: m.properties || [],
  };
}

function mapHosts(page) {
  const serve = (route, dir, name) => {
    const file = path.join(dir, name);
    if (!file.startsWith(dir) || !fs.existsSync(file) || !fs.statSync(file).isFile())
      return route.fulfill({ status: 404, body: '' });
    const type = name.endsWith('.css') ? 'text/css'
      : name.endsWith('.js') ? 'application/javascript' : 'text/html';
    route.fulfill({ status: 200, contentType: type, body: fs.readFileSync(file) });
  };
  const rel = (u) => new URL(u).pathname.replace(/^\/+/, '');
  return Promise.all([
    page.route('https://app.plinth/**', (r) => serve(r, SHELL, rel(r.request().url()))),
    page.route('https://*.widgets.plinth/**', (r) => {
      const u = new URL(r.request().url());
      serve(r, path.join(REPO, 'widgets', u.hostname.replace(/\.widgets\.plinth$/, '')), rel(r.request().url()));
    }),
  ]);
}

const GEN = 7;   // the settings window's init generation, echoed on every handoff

/** Boot the shell as the settings window's replica (index.html?preview=1) with a layout,
 *  and switch edit mode on the way settings.js does. The page is its own parent here, so
 *  the replica's ww-shell posts land on this window and are recorded in `__up`, and
 *  ww-host messages posted to it pass the replica's `ev.source === window.parent` check. */
async function boot(browser, layout, widgets) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 400 } });
  await mapHosts(page);
  await page.addInitScript((init) => {
    window.__up = [];
    const host = (message) => window.postMessage({ type: 'ww-host', message }, '*');
    window.addEventListener('message', (ev) => {
      const msg = ev.data || {};
      if (msg.type !== 'ww-shell') return;
      const m = msg.message || {};
      window.__up.push(m);
      if (m.type === 'ready') {
        host({ type: 'init', data: init });
        host({ type: 'edit-mode', on: true });
      }
    });
  }, { gen: GEN, layout, widgets, sensors: [], status: { elevated: false, version: 'probe' } });
  await page.goto(`http://127.0.0.1:${PORT}/src/Plinth/Shell/index.html?preview=1`);
  await page.waitForTimeout(1200);
  return page;
}

/** Taps the zone whose computed grid placement matches, and returns the add-widget
 *  handoff it produced (or null). */
async function tapZone(page, colStart, row) {
  const before = await page.evaluate(() => window.__up.length);
  await page.evaluate(([c, r]) => {
    const z = [...document.querySelectorAll('.add-zone')].find((e) => {
      const cs = getComputedStyle(e);
      return !e.disabled && new RegExp('^' + c + '(\\s*\\/|$)').test(cs.gridColumn)
        && (r == null || new RegExp('^' + r + '(\\s*\\/|$)').test(cs.gridRow));
    });
    if (z) z.click();
  }, [colStart, row]);
  await page.waitForTimeout(300);
  const sent = await page.evaluate((n) => window.__up.slice(n), before);
  return sent.find((m) => m.type === 'add-widget') || null;
}

const sameRegion = (t, want) => !!t && t.col === want.col && t.row === want.row
  && t.w === want.w && t.h === want.h;

/** Zones and slots as CELL RECTANGLES, read from the resolved grid placement. Reading
 *  the grid rather than pixels keeps the assertions in the same units the layout code
 *  reasons in, so a failure names a cell rather than a coordinate. */
const cells = (page) => page.evaluate(() => {
  const span = (v, max) => {
    const m = String(v).match(/^(\d+)\s*(?:\/\s*span\s*(\d+))?/);
    if (!m) return null;
    return { start: parseInt(m[1], 10) - 1, len: m[2] ? parseInt(m[2], 10) : 1 };
  };
  const rect = (el) => {
    const cs = getComputedStyle(el);
    const c = span(cs.gridColumn), r = span(cs.gridRow);
    return c && r ? { c: c.start, w: c.len, r: r.start, h: r.len } : null;
  };
  const read = (sel) => [...document.querySelectorAll(sel)]
    .filter((e) => getComputedStyle(e).display !== 'none')
    .map((e) => Object.assign(rect(e) || {}, {
      label: (e.querySelector('.az-label') || {}).textContent || null,
      disabled: e.disabled === true,
    }));
  return { zones: read('.page .add-zone'), slots: read('.page .slot') };
});

const overlaps = (a, b) =>
  a.c < b.c + b.w && b.c < a.c + a.w && a.r < b.r + b.h && b.r < a.r + a.h;

(async () => {
  const srv = await staticServer(REPO, PORT);
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const clock = catalogEntry('clock');

  // ---- A0 · the panel only displays ---------------------------------------------------
  // The same shell as the dashboard (no ?preview), handed an edit-mode message anyway. It
  // must not enter edit mode: nothing on the panel can add, move or remove a tile.
  {
    const panel = await browser.newPage({ viewport: { width: 1280, height: 400 } });
    await mapHosts(panel);
    await panel.addInitScript((init) => {
      const L = new Set();
      window.__sent = [];
      window.chrome = { webview: {
        addEventListener: (t, c) => { if (t === 'message') L.add(c); },
        postMessage: (m) => {
          window.__sent.push(m);
          if (m && m.type === 'ready') setTimeout(() => {
            L.forEach((c) => c({ data: { type: 'init', data: init } }));
            L.forEach((c) => c({ data: { type: 'edit-mode', on: true } }));
          }, 0);
        },
      } };
    }, { layout: { pages: [{ name: 'Holes', slots: [
      { widgetId: clock.id, size: 'half-upper', instanceId: 'a' },
    ] }] }, widgets: [clock], sensors: [], status: { elevated: false, version: 'probe' } });
    await panel.goto(`http://127.0.0.1:${PORT}/src/Plinth/Shell/index.html`);
    await panel.waitForTimeout(1200);
    const state = await panel.evaluate(() => ({
      editing: document.body.classList.contains('editing'),
      zones: [...document.querySelectorAll('.add-zone')].filter((e) => getComputedStyle(e).display !== 'none').length,
      controls: ['editBtn', 'editBar', 'palette', 'stylePanel', 'propSheet'].filter((id) => document.getElementById(id)),
      saves: window.__sent.filter((m) => m && m.type === 'save-layout').length,
      empty: !document.getElementById('empty').hidden,
    }));
    check('A0 the panel has no edit entry point, palette or editor sheet in its DOM',
      state.controls.length === 0, JSON.stringify(state.controls));
    check('A0b ...and an edit-mode message does not put it into edit mode',
      !state.editing && state.zones === 0, JSON.stringify(state));
    check('A0c ...and it never posts a save', state.saves === 0, `${state.saves} save(s)`);
    check('A0d ...and with a tile on screen it shows no "nothing here" hint', state.empty === false,
      JSON.stringify(state));
    await panel.close();
  }

  // ---- A0e · a panel left with an empty page still says where to go ------------------
  // Removing the last tile in Settings can leave a page with no slots. The panel has no way
  // to add one, so a blank screen there must point at the settings window, as a panel with
  // no pages at all does.
  {
    const panel = await browser.newPage({ viewport: { width: 1280, height: 400 } });
    await mapHosts(panel);
    await panel.addInitScript((init) => {
      const L = new Set();
      window.chrome = { webview: {
        addEventListener: (t, c) => { if (t === 'message') L.add(c); },
        postMessage: (m) => {
          if (m && m.type === 'ready') setTimeout(() => L.forEach((c) => c({ data: { type: 'init', data: init } })), 0);
        },
      } };
    }, { layout: { pages: [{ name: 'Empty', slots: [] }] }, widgets: [clock], sensors: [],
      status: { elevated: false, version: 'probe' } });
    await panel.goto(`http://127.0.0.1:${PORT}/src/Plinth/Shell/index.html`);
    await panel.waitForTimeout(800);
    const hint = await panel.evaluate(() => {
      const e = document.getElementById('empty');
      return { shown: !!e && !e.hidden && getComputedStyle(e).display !== 'none', text: e ? e.textContent.trim() : '' };
    });
    check('A0e a panel whose only page is empty shows the hint pointing at the settings window',
      hint.shown && /settings window/i.test(hint.text), JSON.stringify(hint));
    await panel.close();
  }

  // ---- A1/A2/A3 · two disjoint holes ------------------------------------------------
  // half-upper at cols 0-1, quarter-lower at col 0. Free: the 2x2 block at cols 2-3,
  // and the lone quarter at row 1 col 1. That second one is the region the field
  // report was about — visibly empty, and previously unfillable.
  let page = await boot(browser, { pages: [{ name: 'Holes', slots: [
    { widgetId: clock.id, size: 'half-upper', instanceId: 'a' },
    { widgetId: clock.id, size: 'quarter-lower', instanceId: 'b' },
  ] }] }, [clock]);

  let view = await cells(page);
  check('A1 every free region gets an add affordance, not just the largest',
    view.zones.length === 2, `${view.zones.length} zones: ${JSON.stringify(view.zones.map((z) => [z.c, z.r, z.w, z.h]))}`);
  const small = view.zones.find((z) => z.w === 1 && z.h === 1 && z.c === 1 && z.r === 1);
  check('A1b including the lone quarter the report was about (row 2, col 2)', !!small,
    JSON.stringify(view.zones.map((z) => [z.c, z.r, z.w, z.h])));

  let clash = [];
  for (let i = 0; i < view.zones.length; i++) {
    for (let j = i + 1; j < view.zones.length; j++)
      if (overlaps(view.zones[i], view.zones[j])) clash.push(`zone${i}/zone${j}`);
    for (const s of view.slots) if (overlaps(view.zones[i], s)) clash.push(`zone${i}/slot`);
  }
  check('A2 the zones tile the free space — no overlap with each other or a slot',
    clash.length === 0, clash.join(' '));

  // A3c · the add is sized on the settings side, from the REGION the tap names — not
  // from the page. This fixture has a big hole and a small one, which is what makes the
  // difference visible: sized against the page the widest fit is a half, which the small
  // hole cannot hold. So the handoff has to name the small hole itself.
  let sent = await tapZone(page, 2, 2);
  check('A3c tapping the small hole hands the add over naming THAT region',
    !!sent && sameRegion(sent.target, { col: 1, row: 1, w: 1, h: 1 }) && sent.index === 0 && sent.gen === GEN,
    JSON.stringify(sent));
  view = await cells(page);
  const palette = await page.evaluate(() => !!document.getElementById('palette'));
  check('A3d the replica adds nothing itself — the gallery is the settings window\'s',
    view.slots.length === 2 && !palette, `${view.slots.length} slots, palette=${palette}`);

  await page.close();

  // ---- A3 · the tap and the result must agree --------------------------------------
  // Its own fixture, because the obvious one cannot tell the two apart. With holes at
  // row 1 col 1 and the 2x2 block, first-fit happens to land a quarter in the same
  // cell the tap targeted, so removing the anchor changed nothing and the probe passed
  // against a broken implementation — caught by falsifying, not by reading.
  //
  // Here the free cells are row 0 col 1 and row 0 col 3. Tapping the col 3 zone must
  // name col 3; unanchored first-fit scans left to right and would drop the widget at
  // col 1 instead, so a handoff that named no region would land it there.
  page = await boot(browser, { pages: [{ name: 'Flow', slots: [
    { widgetId: clock.id, size: 'quarter-upper', col: 1, instanceId: 'p' },
    { widgetId: clock.id, size: 'quarter-upper', col: 3, instanceId: 'q' },
    { widgetId: clock.id, size: 'full-lower', instanceId: 'r' },
  ] }] }, [clock]);
  view = await cells(page);
  check('A3 setup: the two free cells are row 1 cols 2 and 4, and flow order prefers col 2',
    view.zones.length === 2
      && view.zones.some((z) => z.c === 1 && z.r === 0)
      && view.zones.some((z) => z.c === 3 && z.r === 0),
    JSON.stringify(view.zones.map((z) => [z.c, z.r, z.w, z.h])));
  sent = await tapZone(page, 4, 1);   // the LATER cell
  check('A3b tapping a zone names THAT region, not where first-fit would flow',
    !!sent && sameRegion(sent.target, { col: 3, row: 0, w: 1, h: 1 }),
    JSON.stringify(sent && sent.target));
  await page.close();

  // ---- A4 · a full page offers nothing ---------------------------------------------
  page = await boot(browser, { pages: [{ name: 'Full', slots: [
    { widgetId: clock.id, size: 'full', instanceId: 'f' },
  ] }] }, [clock]);
  view = await cells(page);
  check('A4 a full page shows no add zone at all', view.zones.length === 0,
    `${view.zones.length} zones`);
  await page.close();

  // ---- A5 · unavailable WITH a reason (#77) ----------------------------------------
  // A catalog whose only widget needs the full width, and a page leaving a single
  // quarter free. Nothing can go there, and the rule from #77 is that the zone says
  // so rather than being silently absent — an empty tile with no explanation is the
  // very thing this issue reported.
  const fullOnly = Object.assign({}, clock, { id: 'test.fullonly', name: 'Full Only', supportedSlots: ['full'] });
  page = await boot(browser, { pages: [{ name: 'Tight', slots: [
    { widgetId: fullOnly.id, size: 'full-upper', instanceId: 'x' },
    { widgetId: fullOnly.id, size: 'three-quarter-lower', instanceId: 'y' },
  ] }] }, [fullOnly]);
  view = await cells(page);
  const dead = view.zones.find((z) => z.w === 1 && z.h === 1);
  check('A5 a region nothing fits still shows a zone rather than dead space',
    !!dead, `${view.zones.length} zones: ${JSON.stringify(view.zones.map((z) => [z.c, z.r, z.w, z.h]))}`);
  check('A5b and it says why, and cannot be tapped',
    !!dead && dead.disabled && /nothing fits/i.test(dead.label || ''),
    dead ? `${JSON.stringify(dead.label)} disabled=${dead.disabled}` : 'no zone');
  await page.close();

  // ---- A6 · a fit that spans two partition rectangles (#86) --------------------------
  // Occupy upper c3 and lower c2-c3. Free cells: upper c0-c2, lower c0-c1. The area-first
  // partition splits that into a 2x2 (c0-c1) and a lone upper c2. A widget declaring only
  // `full` is also offered at three-quarter, and three-quarter-upper across c0-c2 fits the
  // free space EXACTLY — but measured against either partition rectangle in isolation (2
  // wide, then 1 wide) it is rejected, so the widget has no way in. Sized against free space
  // anchored at the tapped cell it fits, spilling past the tapped rectangle into the lone
  // cell — the accepted trade ("tap a small hole, get a wider widget that fills the row").
  page = await boot(browser, { pages: [{ name: 'Span', slots: [
    { widgetId: fullOnly.id, size: 'quarter-upper', col: 4, instanceId: 'u3' },
    { widgetId: fullOnly.id, size: 'half-lower', col: 3, instanceId: 'l23' },
  ] }] }, [fullOnly]);
  view = await cells(page);
  check('A6 setup: free space is a 2x2 at c0-c1 plus a lone upper c2',
    view.zones.length === 2
      && view.zones.some((z) => z.c === 0 && z.r === 0 && z.w === 2 && z.h === 2)
      && view.zones.some((z) => z.c === 2 && z.r === 0 && z.w === 1 && z.h === 1),
    JSON.stringify(view.zones.map((z) => [z.c, z.r, z.w, z.h])));
  check('A6 the three-quarter-upper fit that spans both rectangles is offered, not hidden',
    view.zones.some((z) => !z.disabled),
    JSON.stringify(view.zones.map((z) => ({ cell: [z.c, z.r, z.w, z.h], disabled: z.disabled }))));
  // Tap the 2x2 zone (grid-column "1 / span 2"). The settings side sizes the add against
  // free space anchored there, which is where the three-quarter-upper comes from.
  sent = await tapZone(page, 1, null);
  check('A6b tapping the 2x2 zone hands over that region, for the settings side to size',
    !!sent && sameRegion(sent.target, { col: 0, row: 0, w: 2, h: 2 }),
    JSON.stringify(sent && sent.target));
  await page.close();

  // ---- N11 · cycling from a size the widget no longer allows (#77) -------------------
  // `test.narrow` allows [half, full] — so allowedWidths gives [half, three-quarter,
  // full] — while its slot is STORED as quarter. indexOf returns -1 for that, and
  // clamping it to 0 made the first candidate whatever sat at index 0: three-quarter,
  // vaulting past the adjacent half. Every size stayed reachable by cycling, so this is
  // an ordering defect rather than the unreachability it first looked like.
  //
  // The page is a quarter plus this quarter, so BOTH half and three-quarter fit. That
  // is what makes the probe discriminate: if only one fitted, either order would land
  // on it and the check would pass regardless.
  const narrow = Object.assign({}, clock, { id: 'test.narrow', name: 'Narrow Only', supportedSlots: ['half', 'full'] });
  page = await boot(browser, { pages: [{ name: 'Cycle', slots: [
    { widgetId: clock.id, size: 'quarter', instanceId: 'c1' },
    { widgetId: narrow.id, size: 'quarter', instanceId: 'nar1' },
  ] }] }, [clock, narrow]);
  const savedSizes = () => page.evaluate(() => {
    const saves = window.__up.filter((m) => m.type === 'save-layout');
    const last = saves[saves.length - 1];
    return last ? last.layout.pages[0].slots.map((s) => s.size) : null;
  });
  const beforeSizes = await savedSizes();
  await page.locator('.slot').nth(1).locator('.edit-overlay .size').click();
  await page.waitForTimeout(900);
  const afterSizes = await savedSizes();
  check('N11 the tap changed the stored size, so there is something to judge',
    !!afterSizes && JSON.stringify(beforeSizes) !== JSON.stringify(afterSizes),
    `${JSON.stringify(beforeSizes)} -> ${JSON.stringify(afterSizes)}`);
  check('N11b an unsupported stored size cycles to the NEXT size up, not past it',
    !!afterSizes && afterSizes[1] === 'half', JSON.stringify(afterSizes));
  await page.close();

  // ---- N7b · the notice must not eat the taps it is telling the user to make ---------
  // A size tap that cannot change anything says why (#77), in a notice that rides at
  // z-index 90 for six seconds, bottom-centre — right where a tile's size and band chips
  // are — over an edit overlay at z-index 3. It carries no controls, so it is inert;
  // without that, the one banner that says "move or remove a widget first" is also the
  // thing blocking you from doing it.
  const single = Object.assign({}, clock, { id: 'test.single', name: 'Single Size', supportedSlots: ['quarter'] });
  page = await boot(browser, { pages: [{ name: 'Notice', slots: [
    { widgetId: single.id, size: 'quarter', instanceId: 's1' },
  ] }] }, [single]);
  await page.locator('.slot').nth(0).locator('.edit-overlay .size').click();
  await page.waitForTimeout(300);
  const notice = page.locator('#panelNotice');
  check('N7 a size tap that changes nothing says why',
    await notice.count() === 1 && await notice.isVisible()
      && /only one size/i.test(await notice.textContent() || ''),
    await notice.textContent().catch(() => '(absent)'));
  const hitTest = await page.evaluate(() => {
    const el = document.getElementById('panelNotice');
    if (!el) return { ok: false, why: 'no notice' };
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      ok: at !== el && !el.contains(at),
      why: at ? (at.id || at.className || at.tagName) : 'nothing',
      visible: r.width > 0 && r.height > 0,
    };
  });
  check('N7b the notice is visible but not hit-testable, so it cannot swallow the next tap',
    hitTest.ok && hitTest.visible, `point resolves to: ${hitTest.why}`);
  await page.close();

  await browser.close();
  srv.close();
  console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
