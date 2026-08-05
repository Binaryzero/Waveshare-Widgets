#!/usr/bin/env node
// Screenshot each design POC at exactly 1280x400, @2x for crisp chat viewing.
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const REPO = '/home/user/Waveshare-Widgets';
const OUT = process.argv[2] || '/tmp/claude-0/-home-user-Waveshare-Widgets/d6b97a67-e62c-511f-8bda-cbc09a953f4e/scratchpad';

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const dirs = fs.readdirSync(path.join(REPO, 'design/poc'))
    .filter((d) => fs.existsSync(path.join(REPO, 'design/poc', d, 'index.html')));
  for (const d of dirs) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 400 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
    page.on('requestfailed', (r) => errs.push('REQFAIL ' + r.url().slice(0, 120)));
    await page.goto('file://' + path.join(REPO, 'design/poc', d, 'index.html'));
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(900);
    const size = await page.evaluate(() => [document.body.scrollWidth, document.body.scrollHeight]);
    await page.screenshot({ path: path.join(OUT, `poc-${d}.png`) });
    console.log(`${d}: shot -> poc-${d}.png  body=${size[0]}x${size[1]}${errs.length ? '  ISSUES: ' + errs.join(' | ') : ''}`);
    await ctx.close();
  }
  await browser.close();
})();
