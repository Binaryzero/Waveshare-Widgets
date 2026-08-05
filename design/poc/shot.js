#!/usr/bin/env node
// Regenerates the POC screenshots in design/poc/shots/ — the images the directions are
// judged from, at exactly 1280x400 CSS px, rendered @2x so they read crisply when zoomed.
//
//   NODE_PATH=<dir with playwright> CHROMIUM=<chromium binary> node design/poc/shot.js [outDir]
//
// Needs Playwright and a Chromium, exactly like the runners in tests/harness/ (see that
// README): `npm i playwright` anywhere on NODE_PATH, or a global install, satisfies it —
// the module is resolved through the same candidate list tools/widget-harness.js uses, so
// any environment that can run the harnesses can regenerate these. There is deliberately
// no package.json here: the repo's convention is that Playwright is provided by the
// environment, and a second dependency manifest would drift from the one the harnesses
// document.
//
// Paths derive from THIS FILE's location, not from any absolute checkout path or authoring
// environment, so the script works from any clone. It writes the SAME filenames that are
// committed (meter.png, lume.png, ledger.png ...): regenerating updates the images people
// are choosing from rather than leaving them stale next to fresh duplicates.
'use strict';
function loadPlaywright() {
  const path = require('path');
  const candidates = ['playwright', '/opt/node22/lib/node_modules/playwright',
    path.join(process.env.HOME || '', 'node_modules/playwright')];
  for (const c of candidates) { try { return require(c); } catch (e) { /* next */ } }
  console.error('playwright not found — npm i playwright (and point CHROMIUM at a chromium binary), as for tests/harness');
  process.exit(1);
}
const { chromium } = loadPlaywright();
const fs = require('fs');
const path = require('path');

const POC = __dirname;                                   // design/poc/
const OUT = process.argv[2] || path.join(POC, 'shots');  // committed screenshot dir

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const dirs = fs.readdirSync(POC)
    .filter((d) => fs.existsSync(path.join(POC, d, 'index.html')));
  let failed = 0;
  for (const d of dirs) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 400 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
    page.on('requestfailed', (r) => errs.push('REQFAIL ' + r.url().slice(0, 120)));
    await page.goto('file://' + path.join(POC, d, 'index.html'));
    await page.evaluate(() => document.fonts.ready);
    // Freeze every animation at the SAME phase, one second into its cycle, instead of
    // letting wall-clock timing decide where each breathing dot and EQ bar happens to be.
    // animation:none would be wrong, not just blunt -- an element animated from its
    // keyframes can collapse to a base state the design never shows. And a negative
    // animation-delay is wrong too, which the first version of this learned from a 6x6px
    // pixel-diff localised to one breathing dot: changing the delay of an already-running
    // CSS animation shifts its elapsed time, it does not pin absolute phase, so the pause
    // still landed wherever font-load timing had let the animation get to. The Web
    // Animations API pins it exactly: pause, then set currentTime.
    await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; }' });
    await page.evaluate(() => {
      for (const a of document.getAnimations({ subtree: true })) { a.pause(); a.currentTime = 1000; }
    });
    await page.waitForTimeout(120);
    const [w, h] = await page.evaluate(() => [document.body.scrollWidth, document.body.scrollHeight]);
    await page.screenshot({ path: path.join(OUT, `${d}.png`) });
    if (w !== 1280 || h !== 400 || errs.length) failed++;
    console.log(`${d}: -> ${path.relative(process.cwd(), path.join(OUT, d + '.png'))}  body=${w}x${h}${errs.length ? '  ISSUES: ' + errs.join(' | ') : ''}`);
    await ctx.close();
  }
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
