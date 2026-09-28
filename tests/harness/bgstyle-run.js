#!/usr/bin/env node
// A tile's Background (bgStyle) and the Theme's Panel opacity. The setting used to default
// to `solid`, which paints the tile opaque whatever the theme says, so the Theme's opacity
// slider reached only tiles someone had set to `glass`. The default is now `theme`: the
// tile at the theme's Panel opacity.
//
//   B1 · a tile that never chose, and one set to `theme`, paint at the theme's opacity
//   B2 · a layout saved with the old `glass` reads as `theme`
//   B3 · `solid` stays opaque and `transparent` has no tile, whatever the theme
//   B4 · a value that is not one of these reads as `theme`
//   B5 · the shell declares theme / solid / transparent, `theme` first and the default
//   B6 · a see-through theme tile gets the transparent tile's legibility shadow, in
//        proportion: none at the stock opacity, most of it at 0.15, never on solid
//
// Run: CHROMIUM=/path/to/chrome node tests/harness/bgstyle-run.js
'use strict';
const fs = require('fs');
const path = require('path');

function loadPlaywright() {
  const candidates = ['playwright', '/opt/node22/lib/node_modules/playwright',
    path.join(process.env.HOME || '', 'node_modules/playwright')];
  for (const c of candidates) { try { return require(c); } catch (e) { /* next */ } }
  console.error('playwright not found');
  process.exit(1);
}

const SHELL = path.resolve(__dirname, '..', '..', 'src', 'Plinth', 'Shell');
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  if (!ok) failures++;
};

(async () => {
  const win = {};
  new Function('window', fs.readFileSync(path.join(SHELL, 'palette.js'), 'utf8'))(win);
  new Function('window', fs.readFileSync(path.join(SHELL, 'appearance.js'), 'utf8'))(win);
  const theme = win.WWPalette.derive({ background: '#203040', panelAlpha: 0.6 });
  const decl = win.WWAppearance.universalProperties().find((p) => p.name === 'bgStyle');
  check('B5 the shell declares theme / solid / transparent, theme first and the default',
    decl && decl.default === 'theme' && decl.options.join(',') === 'theme,solid,transparent',
    decl && `${decl.default} ${decl.options.join(',')}`);

  const { chromium } = loadPlaywright();
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const base = fs.readFileSync(path.join(SHELL, 'widget-base.css'), 'utf8');
  const api = fs.readFileSync(path.join(SHELL, 'widget-api.js'), 'utf8');
  // A fresh page per case: setContent keeps the window, and with it the first case's shim.
  const paint = async (settings, withTheme) => {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><head><style>${base}</style></head><body><p>tile</p></body></html>`);
    await page.addScriptTag({ content: api });
    const out = await page.evaluate(({ settings, theme }) => new Promise((done) => {
      window.postMessage({ type: 'ww-init', settings, sensors: [], media: null, theme,
        status: { elevated: false, apiVersion: 1 } }, '*');
      setTimeout(() => done({ cls: document.body.className.trim(), bg: getComputedStyle(document.body).backgroundColor,
        shadow: getComputedStyle(document.querySelector('p')).textShadow }), 150);
    }), { settings, theme: withTheme || theme });
    await page.close();
    return out;
  };
  const at = (alpha) => alpha === 1 ? 'rgb(32, 48, 64)' : `rgba(32, 48, 64, ${alpha})`;

  let r = await paint({});
  check('B1 a tile that never chose paints at the theme\'s opacity', r.bg === at(0.6), JSON.stringify(r));
  r = await paint({ bgStyle: 'theme' });
  check('B1b ...and so does one set to theme', r.bg === at(0.6), JSON.stringify(r));
  r = await paint({ bgStyle: 'glass' });
  check('B2 a layout saved with the old glass reads as theme', r.bg === at(0.6), JSON.stringify(r));
  r = await paint({ bgStyle: 'solid' });
  check('B3 solid stays opaque whatever the theme', r.bg === at(1), JSON.stringify(r));
  r = await paint({ bgStyle: 'transparent' });
  check('B3b ...and transparent has no tile', r.bg === 'rgba(0, 0, 0, 0)' || r.bg === at(0), JSON.stringify(r));
  r = await paint({ bgStyle: 'neon' });
  check('B4 a value that is not one of these reads as theme', r.bg === at(0.6), JSON.stringify(r));

  // B6 · the strongest shadow alpha in the computed text-shadow ('none' is 0).
  const shadowAlpha = (s) => Math.max(0, ...[...String(s).matchAll(/rgba\([^)]*,\s*([\d.]+)\)/g)].map((m) => Number(m[1])));
  const faint = win.WWPalette.derive({ background: '#203040', panelAlpha: 0.15 });
  const stock = win.WWPalette.derive({});
  r = await paint({}, faint);
  const a15 = shadowAlpha(r.shadow);
  check('B6 a default tile at Panel opacity 0.15 gets a legibility shadow', a15 >= 0.35 && a15 <= 0.55, `${a15} ${r.shadow}`);
  r = await paint({}, stock);
  check('B6b ...and none at the stock opacity', shadowAlpha(r.shadow) === 0, r.shadow);
  r = await paint({ bgStyle: 'solid' }, faint);
  check('B6c ...and never on a solid tile', shadowAlpha(r.shadow) === 0, r.shadow);
  r = await paint({ bgStyle: 'transparent' }, stock);
  check('B6d the transparent tile keeps its full shadow', shadowAlpha(r.shadow) === 0.55, r.shadow);

  await browser.close();
  console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
