#!/usr/bin/env node
// Issue #76 — widget text must fit the SLOT, not just one axis of it.
//
// Widgets render in an iframe sized to their slot, which makes `vh` and `vw` look like
// they measure the tile. They do — but a rule written against one axis says nothing
// about the other. The clock sized its time on `34vh` alone: fine at full width, and in
// a 320x400 quarter it asked for 136px glyphs across 320px of tile, so "09:11:52" came
// out as "9:11:5" with a digit missing from each end.
//
//   F1 · the time fits every supported slot size, in both axes
//   F2 · it fits with the longest string the settings can produce (12-hour + seconds)
//   F3 · it fits the shortest one too, without leaving the tile mostly empty
//   F4 · the date fits, and does not crowd the time out
//   F5 · a resized slot re-fits without a settings change
//   F6 · the size sliders can only shrink, so no setting can push text back out
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const SHELL = path.join(REPO, 'src', 'WaveshareWidgets', 'Shell');
const WIDGET = path.join(REPO, 'widgets', 'clock');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };

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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The real slot geometries on a 1280x400 panel.
const SLOTS = [
  { name: 'quarter', width: 320, height: 400 },
  { name: 'half', width: 640, height: 400 },
  { name: 'three-quarter', width: 960, height: 400 },
  { name: 'full', width: 1280, height: 400 },
  // Bands halve the height; a short tile is where a height-only rule looks fine and a
  // width-only one fails, so both are represented.
  { name: 'half-upper', width: 640, height: 200 },
  { name: 'quarter-lower', width: 320, height: 200 },
];

(async () => {
  const { chromium } = loadPlaywright();
  const shim = fs.readFileSync(path.join(SHELL, 'widget-api.js'), 'utf8');
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});

  async function open(size) {
    const page = await browser.newPage({ viewport: { width: size.width, height: size.height } });
    page.on('pageerror', (e) => { failures++; console.log('[pageerror]', String(e).slice(0, 300)); });
    await page.route('https://app.wsw/**', (route) => {
      const file = path.join(SHELL, new URL(route.request().url()).pathname);
      if (fs.existsSync(file)) return route.fulfill({ contentType: MIME[path.extname(file)] || 'text/plain', body: fs.readFileSync(file) });
      return route.fulfill({ status: 404, body: '' });
    });
    await page.route('https://widget.test/**', (route) => {
      const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\//, '') || 'index.html';
      const file = path.join(WIDGET, rel);
      if (file.startsWith(WIDGET) && fs.existsSync(file) && fs.statSync(file).isFile())
        return route.fulfill({ contentType: MIME[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
      return route.fulfill({ status: 404, body: '' });
    });
    await page.route(/https?:\/\/(?!app\.wsw|widget\.test).*/, (route) => route.abort());
    await page.addInitScript(shim);
    await page.goto('https://widget.test/index.html');
    return page;
  }

  const init = (p, s) => p.evaluate((settings) => {
    window.postMessage({ type: 'ww-init', settings, sensors: [], media: null, theme: null }, '*');
  }, s);

  // Overflow, in both axes, for the two text lines and the body as a whole. A single
  // pixel over is a clipped glyph edge on a panel this size, so the tolerance is 1px
  // for sub-pixel rounding and nothing more.
  const overflow = (p) => p.evaluate(() => {
    const box = document.body;
    const out = {};
    for (const id of ['time', 'date']) {
      const el = document.getElementById(id);
      const r = el.getBoundingClientRect();
      out[id] = {
        text: el.textContent,
        w: r.width, h: r.height,
        font: parseFloat(getComputedStyle(el).fontSize),
      };
    }
    out.body = { w: box.clientWidth, h: box.clientHeight,
      scrollW: box.scrollWidth, scrollH: box.scrollHeight };
    return out;
  });

  // ---- F1/F2/F3 · every slot size, with the longest and shortest strings -------------
  // 12-hour + seconds is the widest the widget can ever be asked to draw ("12:34:56 PM");
  // 24-hour without seconds is the narrowest ("12:34"). If the fit only works for one of
  // them it is a coincidence of the default settings, not a fit.
  const LONGEST = { hour12: 'on', showSeconds: 'on' };
  const SHORTEST = { hour12: 'off', showSeconds: 'off' };

  for (const slot of SLOTS) {
    const page = await open(slot);
    for (const [label, settings] of [['longest', LONGEST], ['shortest', SHORTEST]]) {
      await init(page, settings);
      await wait(400);
      const m = await overflow(page);
      const fitsW = m.time.w <= m.body.w + 1;
      const fitsH = m.time.h + m.date.h <= m.body.h + 1;
      const noScroll = m.body.scrollW <= m.body.w + 1 && m.body.scrollH <= m.body.h + 1;
      check(`F1 clock ${slot.name} (${label}) — time fits the tile`,
        fitsW && fitsH && noScroll,
        `"${m.time.text}" ${Math.round(m.time.w)}x${Math.round(m.time.h)} in ${m.body.w}x${m.body.h} @${Math.round(m.time.font)}px`);
      check(`F4 clock ${slot.name} (${label}) — the date fits beside it`,
        m.date.w <= m.body.w + 1 && m.date.h > 0,
        `"${m.date.text}" ${Math.round(m.date.w)} wide in ${m.body.w}`);
    }
    // F3 · fitting must not mean "tiny". A rule that shrank everything to 10px would
    // pass every overflow check above, so the time has to actually use the tile.
    await init(page, SHORTEST);
    await wait(400);
    const m = await overflow(page);
    check(`F3 clock ${slot.name} — the time USES the tile rather than hiding in it`,
      m.time.w >= m.body.w * 0.45 || m.time.h >= m.body.h * 0.3,
      `${Math.round(m.time.w)}x${Math.round(m.time.h)} of ${m.body.w}x${m.body.h}`);
    await page.close();
  }

  // ---- F5 · a resized slot re-fits with no settings change ---------------------------
  // Dragging a tile or cycling its size changes the iframe geometry and nothing else;
  // if the fit only ran on ww-init the widget would keep the old size until it happened
  // to be re-initialised.
  const rp = await open({ width: 1280, height: 400 });
  await init(rp, LONGEST);
  await wait(400);
  const wide = await overflow(rp);
  await rp.setViewportSize({ width: 320, height: 400 });
  await wait(600);
  const narrow = await overflow(rp);
  check('F5 shrinking the slot re-fits the time without a settings change',
    narrow.time.font < wide.time.font && narrow.time.w <= narrow.body.w + 1,
    `${Math.round(wide.time.font)}px @1280 -> ${Math.round(narrow.time.font)}px @320`);
  await rp.close();

  // ---- F6 · the size sliders cannot push text back out -------------------------------
  // The old sliders multiplied a viewport guess and ran to 200%, so a user could undo
  // the fit by hand. They are fractions of the fitted size now, and anything stored
  // above 100 clamps rather than overflowing — old layouts hold values up to 200.
  const sp = await open({ width: 320, height: 400 });
  await init(sp, Object.assign({ timeSize: 200, dateSize: 200 }, LONGEST));
  await wait(400);
  const big = await overflow(sp);
  check('F6 a stored 200% size clamps to the fit instead of overflowing',
    big.time.w <= big.body.w + 1 && big.body.scrollW <= big.body.w + 1,
    `${Math.round(big.time.w)} in ${big.body.w}`);
  await init(sp, Object.assign({ timeSize: 50, dateSize: 100 }, LONGEST));
  await wait(400);
  const small = await overflow(sp);
  check('F6b and the slider still shrinks, so it is not simply ignored',
    small.time.font < big.time.font * 0.75,
    `${Math.round(big.time.font)}px @200 -> ${Math.round(small.time.font)}px @50`);
  await sp.close();

  await browser.close();
  console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
