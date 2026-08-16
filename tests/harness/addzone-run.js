#!/usr/bin/env node
// Issue #84 — in on-panel edit mode a visibly empty region offered no way to add a
// widget. `positionAddZone` searched for the single largest free rectangle and placed
// ONE zone there, so a page with two disjoint holes showed "Add widget" in one and
// left the other dead.
//
// This is also the first coverage the on-panel editor has had. Every other suite
// drives the dashboard or the settings window; none of them enters edit mode, which
// is why a control that simply was not drawn went unnoticed until a field screenshot.
//
//   A1 · every free region gets an add affordance, not just the biggest
//   A2 · the zones tile the free space: no overlap with each other or with a slot
//   A3 · adding from a zone lands in THAT region — the tap and the result agree
//   A4 · a full page offers none
//   A5 · a region nothing fits says so rather than going silent (#77)
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

/** Boot the real shell (not the preview replica) with a layout, and enter edit mode. */
async function boot(browser, layout, widgets) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 400 } });
  await mapHosts(page);
  await page.addInitScript(() => {
    const L = new Set();
    window.chrome = { webview: {
      addEventListener: (t, c) => { if (t === 'message') L.add(c); },
      postMessage: (m) => window.__rec(JSON.stringify(m)),
    } };
    window.__push = (j) => { const data = JSON.parse(j); L.forEach((c) => { try { c({ data }); } catch (e) {} }); };
  });
  await page.exposeFunction('__rec', async (j) => {
    const m = JSON.parse(j);
    if (m.type === 'ready') {
      page.evaluate((d) => window.__push(d), JSON.stringify({ type: 'init', data: {
        layout, widgets, sensors: [], status: { elevated: false, version: 'probe' },
      } })).catch(() => {});
    }
  });
  await page.goto(`http://127.0.0.1:${PORT}/src/Plinth/Shell/index.html`);
  await page.waitForTimeout(1200);
  await page.evaluate(() => document.getElementById('editBtn').click());
  await page.waitForTimeout(600);
  return page;
}

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

  // A3c · sizing must come from the REGION, not the page. This fixture has a big hole
  // and a small one, which is what makes the difference visible: sized against the
  // page the widest fit is a half, the small zone's anchor cannot hold a half, and the
  // add falls back to flow — filling the 2x2 block the user did not tap. Sized against
  // the region it is a quarter and it stays put. (The other fixture cannot see this:
  // there both paths choose a quarter.)
  await page.evaluate(() => {
    const z = [...document.querySelectorAll('.add-zone')].find((e) => {
      const cs = getComputedStyle(e);
      return /^2\s*\//.test(cs.gridColumn) && cs.gridRow === '2';
    });
    if (z) z.click();
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const b = document.querySelector('#palette button:not([disabled])');
    if (b) b.click();
  });
  await page.waitForTimeout(900);
  view = await cells(page);
  const inSmall = view.slots.find((s) => s.c === 1 && s.r === 1 && s.w === 1 && s.h === 1);
  check('A3c the widget is sized for the region tapped, so it stays in the small hole',
    !!inSmall && view.slots.length === 3,
    `${view.slots.length} slots: ${JSON.stringify(view.slots.map((s) => [s.c, s.r, s.w, s.h]))}`);

  await page.close();

  // ---- A3 · the tap and the result must agree --------------------------------------
  // Its own fixture, because the obvious one cannot tell the two apart. With holes at
  // row 1 col 1 and the 2x2 block, first-fit happens to land a quarter in the same
  // cell the tap targeted, so removing the anchor changed nothing and the probe passed
  // against a broken implementation — caught by falsifying, not by reading.
  //
  // Here the free cells are row 0 col 1 and row 0 col 3. Tapping the col 3 zone must
  // put the widget at col 3; unanchored first-fit scans left to right and would drop
  // it at col 1 instead.
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
  await page.evaluate(() => {
    const z = [...document.querySelectorAll('.add-zone')]
      .find((e) => /^4\s*\//.test(getComputedStyle(e).gridColumn));   // the LATER cell
    if (z) z.click();
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const b = document.querySelector('#palette button:not([disabled])');
    if (b) b.click();
  });
  await page.waitForTimeout(900);
  view = await cells(page);
  const landed = view.slots.find((s) => s.c === 3 && s.r === 0);
  check('A3b adding from a zone lands in THAT region, not where first-fit would flow',
    !!landed && view.slots.length === 4,
    `${view.slots.length} slots: ${JSON.stringify(view.slots.map((s) => [s.c, s.r, s.w, s.h]))}`);
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
  // Tap the 2x2 zone (grid-column "1 / span 2") and add the one installed widget.
  await page.evaluate(() => {
    const z = [...document.querySelectorAll('.add-zone')]
      .find((e) => !e.disabled && /^1\s*\//.test(getComputedStyle(e).gridColumn));
    if (z) z.click();
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const b = document.querySelector('#palette button:not([disabled])');
    if (b) b.click();
  });
  await page.waitForTimeout(900);
  view = await cells(page);
  const spanned = view.slots.find((s) => s.r === 0 && s.c === 0 && s.w === 3);
  check('A6b it lands as a three-quarter-upper across c0-c2, past the tapped zone',
    !!spanned && view.slots.length === 3,
    `${view.slots.length} slots: ${JSON.stringify(view.slots.map((s) => [s.c, s.r, s.w, s.h]))}`);
  await page.close();

  await browser.close();
  srv.close();
  console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
