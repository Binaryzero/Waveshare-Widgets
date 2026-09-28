#!/usr/bin/env node
// Reddit Photos picks which copy of an image to load by the TILE's real pixel size.
//
// It used to take the smallest resized copy at least 1280 wide: the Waveshare's width. That
// is not the measure on a Corsair XENEON EDGE, whose full tile is 2560 wide, nor on a quarter
// tile anywhere, and in practice it chose nothing at all: Reddit's resized copies stop at
// 1080, so every post fell through to the full-size original, whatever the tile.
//
//   K1 · a half tile (640x400, cover) takes the 640 copy of a 3:2 photo
//   K2 · a quarter (320x400) takes the 640 too, not the 320: cover crops, so a 3:2 photo
//        filling a 400-tall tile is drawn 600 wide
//   K3 · contain draws it whole, so the same quarter takes the 320
//   K4 · a tile wider than the largest copy (a full 1280x400) takes the original
//   K5 · the XENEON EDGE's quarter (640x720) takes the 1080 copy; its full tile the original
//   K6 · where a copy that wide exists, the EDGE's full tile takes it, not the first copy
//        past 1280 (the finding)
//   K7 · display scaling counts: the EDGE's quarter at 150% (427x480 CSS) needs 1080
//        device pixels, not 720
//   K8 · a gallery takes one of its resized copies too; an animated one keeps its original
//   K9 · a direct link is the one file there is; a copy with no size or no url is skipped;
//        copies listed in another order are still read smallest first
//
// Run: CHROMIUM=/path/to/chrome node tests/harness/redditpick-run.js
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const REPO = path.resolve(__dirname, '..', '..');
const SHELL = path.join(REPO, 'src', 'Plinth', 'Shell');
const WIDGET = path.join(REPO, 'widgets', 'reddit');
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

// A small PNG that decodes and clears the widget's 1 KB placeholder floor.
function png() {
  const raw = Buffer.alloc(64 * 64 * 4, 0x40);
  const idat = zlib.deflateSync(Buffer.concat(
    Array.from({ length: 64 }, (_, y) => Buffer.concat([Buffer.from([0]), raw.subarray(y * 256, y * 256 + 256)]))));
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0); ihdr.writeUInt32BE(64, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('twwP', Buffer.alloc(4096, 0x20)), chunk('IEND', Buffer.alloc(0))]);
}
let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}
const PNG = png();

// Reddit's resized widths for a 3:2 upload, and its original.
const W = [108, 216, 320, 640, 960, 1080];
const preview = (widths, extra) => ({
  data: {
    title: 'photo', author: 'someone', score: 1,
    preview: { images: [{
      source: { url: 'https://i.redd.it/original.png', width: 4000, height: 2667 },
      resolutions: widths.map((w) => ({ url: `https://preview.redd.it/r${w}.png?width=${w}&amp;s=x`, width: w, height: Math.round(w / 1.5) }))
        .concat(extra || []),
    }] },
  },
});
const listingOf = (...children) => JSON.stringify({ data: { children } });

(async () => {
  const { chromium } = loadPlaywright();
  const shim = fs.readFileSync(path.join(SHELL, 'widget-api.js'), 'utf8');
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});

  // One tile: a page at a size and scale, serving `listing`, returning the first image the
  // widget asked for.
  async function firstAsked(width, height, scale, listing, fit) {
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale || 1 });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { failures++; console.log('[pageerror]', String(e).slice(0, 300)); });
    const asked = [];
    await page.route('https://app.plinth/**', (route) => {
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
    await page.route('https://www.reddit.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: listing }));
    await page.route(/https:\/\/(i|preview)\.redd\.it\/.*/, (route) => {
      const u = new URL(route.request().url());
      asked.push(u.host + u.pathname);
      return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    });
    await page.route(/https?:\/\/(?!app\.plinth|widget\.test|www\.reddit\.com|i\.redd\.it|preview\.redd\.it).*/, (route) => route.abort());
    await page.addInitScript(shim);
    await page.addInitScript(() => {
      window.addEventListener('message', (ev) => {
        const m = ev.data || {};
        if (m.type === 'ww-fetch') window.postMessage({ type: 'ww-fetch-result', id: m.id, error: 'no host in probe' }, '*');
      });
    });
    await page.goto('https://widget.test/index.html');
    await page.evaluate((s) => {
      window.postMessage({ type: 'ww-init', settings: s, sensors: [], media: null, theme: null,
        status: { elevated: false, apiVersion: 1 } }, '*');
    }, { subreddit: 'probe', sort: 'hot', dwell: 120, showTitle: 'on', fit: fit || 'cover', bgStyle: 'solid' });
    await wait(1500);
    const painted = await page.evaluate(() => !!document.querySelector('.layer.visible'));
    await ctx.close();
    return { first: asked[0] || null, painted };
  }

  const photo = listingOf(preview(W));
  let r;

  r = await firstAsked(640, 400, 1, photo);
  check('K1 a half tile (640x400, cover) takes the 640 copy', r.first === 'preview.redd.it/r640.png' && r.painted, JSON.stringify(r));
  r = await firstAsked(320, 400, 1, photo);
  check('K2 a quarter (320x400) takes the 640 too: cover draws a 3:2 photo 600 wide there',
    r.first === 'preview.redd.it/r640.png', JSON.stringify(r));
  r = await firstAsked(320, 400, 1, photo, 'contain');
  check('K3 contain draws it whole, so the same quarter takes the 320', r.first === 'preview.redd.it/r320.png', JSON.stringify(r));
  r = await firstAsked(1280, 400, 1, photo);
  check('K4 a tile wider than the largest copy (full, 1280x400) takes the original', r.first === 'i.redd.it/original.png', JSON.stringify(r));
  r = await firstAsked(640, 720, 1, photo);
  check('K5 the XENEON EDGE\'s quarter (640x720) takes the 1080 copy', r.first === 'preview.redd.it/r1080.png', JSON.stringify(r));
  r = await firstAsked(2560, 720, 1, photo);
  check('K5b ...and its full tile the original', r.first === 'i.redd.it/original.png', JSON.stringify(r));
  const wide = listingOf(preview(W, [1440, 2880].map((w) => ({ url: `https://preview.redd.it/r${w}.png`, width: w, height: w / 1.5 }))));
  r = await firstAsked(2560, 720, 1, wide);
  check('K6 where a copy that wide exists, the EDGE\'s full tile takes it, not the first past 1280',
    r.first === 'preview.redd.it/r2880.png', JSON.stringify(r));
  r = await firstAsked(427, 480, 1.5, photo);
  check('K7 display scaling counts: the EDGE\'s quarter at 150% needs 1080 device pixels, not 720',
    r.first === 'preview.redd.it/r1080.png', JSON.stringify(r));

  const gallery = (s) => ({ data: {
    title: 'album', author: 'someone', score: 1, is_gallery: true,
    gallery_data: { items: [{ media_id: 'm1' }] },
    media_metadata: { m1: { s, p: W.map((w) => ({ u: `https://preview.redd.it/g${w}.png?width=${w}&amp;s=y`, x: w, y: Math.round(w / 1.5) })) } },
  } });
  r = await firstAsked(640, 400, 1, listingOf(gallery({ u: 'https://i.redd.it/galorig.png', x: 4000, y: 2667 })));
  check('K8 a gallery takes one of its resized copies too', r.first === 'preview.redd.it/g640.png', JSON.stringify(r));
  r = await firstAsked(640, 400, 1, listingOf(gallery({ gif: 'https://i.redd.it/anim.gif', x: 800, y: 600 })));
  check('K8b ...and an animated one keeps its original, since its resized copies are still frames',
    r.first === 'i.redd.it/anim.gif', JSON.stringify(r));

  r = await firstAsked(640, 400, 1, listingOf({ data: { title: 'direct', author: 'a', score: 1, url_overridden_by_dest: 'https://i.redd.it/direct.png' } }));
  check('K9 a direct link is the one file there is', r.first === 'i.redd.it/direct.png', JSON.stringify(r));
  const odd = listingOf(preview([], [
    { url: 'https://preview.redd.it/nosize.png' },
    { url: '', width: 700, height: 467 },
    { url: 'https://preview.redd.it/r700.png', width: 700, height: 467 },
  ]));
  r = await firstAsked(640, 400, 1, odd);
  check('K9b a copy with no size, or no url, is skipped for one that has both', r.first === 'preview.redd.it/r700.png', JSON.stringify(r));
  r = await firstAsked(640, 400, 1, listingOf(preview(W.slice().reverse())));
  check('K9c copies listed largest first are still read smallest first', r.first === 'preview.redd.it/r640.png', JSON.stringify(r));
  // A copy with no size cannot be ordered: left in, its comparisons are all NaN and the
  // sort can leave the others as they came, so the 1080 would be read before the 640.
  r = await firstAsked(640, 400, 1, listingOf(preview([], [
    { url: 'https://preview.redd.it/r1080.png', width: 1080, height: 720 },
    { url: 'https://preview.redd.it/nosize.png' },
    { url: 'https://preview.redd.it/r640.png', width: 640, height: 427 },
    { url: 'https://preview.redd.it/r320.png', width: 320, height: 213 },
  ])));
  check('K9d ...and a copy with no size among them does not stop that', r.first === 'preview.redd.it/r640.png', JSON.stringify(r));

  await browser.close();
  console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
