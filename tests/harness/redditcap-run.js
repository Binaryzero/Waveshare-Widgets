#!/usr/bin/env node
// Issue #116 — Reddit Photos materialised whatever the remote server sent as a Blob.
//
// WW.fetch now caps every widget at 5 MiB, which stops the renderer being exhausted. That
// is not the same as this widget being right: the panel is 1280x400, and the paths that run
// to megabytes here (a gallery's largest rendition, a preview `source` for a 6000x4000
// upload, a direct link to the original file) are exactly the ones it does not want. So it
// carries a ceiling of its own, far below the shared one, passed as init.maxBytes.
//
//   D1 · an ordinary image still loads and paints
//   D2 · one over the widget's OWN ceiling — comfortably under the shared 5 MiB — is refused
//   D3 · ...and a refusal is a skipped post, not a broken tile: the next image shows
//   D4 · when every candidate is oversized the tile SAYS so, rather than blaming the network
//   D5 · a listing past its own ceiling is named too
//   D6 · an ordinary failure still reads as an ordinary failure
//
// The ceilings are the point of this file, so the fixture serves exact byte counts either
// side of them. Everything is routed; no request leaves the machine.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const REPO = path.resolve(__dirname, '..', '..');
const SHELL = path.join(REPO, 'src', 'WaveshareWidgets', 'Shell');
const WIDGET = path.join(REPO, 'widgets', 'reddit');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };

// Must match widgets/reddit/index.html. Read out of the widget rather than repeated, so the
// probe cannot pass because both halves drifted the same way.
const SRC = fs.readFileSync(path.join(WIDGET, 'index.html'), 'utf8');
const constant = (name) => {
  const m = SRC.match(new RegExp('const\\s+' + name + '\\s*=\\s*([\\d*\\s]+);'));
  // eslint-disable-next-line no-eval
  return m ? eval(m[1]) : null;
};
const IMAGE_MAX = constant('IMAGE_MAX_BYTES');
const LISTING_MAX = constant('LISTING_MAX_BYTES');
const SHARED_MAX = 5 * 1024 * 1024;   // the WW.fetch default, from widget-api.js

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

// A real PNG, padded to an exact length. It has to DECODE: the widget probes every blob
// with an Image() and counts anything undecodable as a failed attempt, so a buffer of zeroes
// would be refused for the wrong reason and D1 would pass without the ceiling doing anything.
function png(bytes) {
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
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const head = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat)]);
  const tail = chunk('IEND', Buffer.alloc(0));
  // Pad with a comment chunk so the file reaches the exact size the probe asked for. PNG
  // decoders skip unknown ancillary chunks, so the image still decodes at any length.
  const overhead = head.length + tail.length + 12;
  const pad = Math.max(0, bytes - overhead);
  return Buffer.concat([head, chunk('twwP', Buffer.alloc(pad, 0x20)), tail]);
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

/** A Reddit listing whose posts point at the given image URLs, via the direct-link path. */
const listing = (urls, padTo) => {
  const children = urls.map((u, i) => ({
    data: { title: 'post ' + i, author: 'someone', score: 10 + i, url_overridden_by_dest: u },
  }));
  const json = { data: { children } };
  if (padTo) {
    json.data.children.push({ data: { title: 'x'.repeat(padTo), author: '', score: 0 } });
  }
  return JSON.stringify(json);
};

(async () => {
  check('D0 setup: the widget declares both ceilings, and both are under the shared one',
    IMAGE_MAX > 0 && LISTING_MAX > 0 && IMAGE_MAX < SHARED_MAX && LISTING_MAX < SHARED_MAX,
    `image=${IMAGE_MAX} listing=${LISTING_MAX} shared=${SHARED_MAX}`);

  const { chromium } = loadPlaywright();
  const shim = fs.readFileSync(path.join(SHELL, 'widget-api.js'), 'utf8');
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  page.on('pageerror', (e) => { failures++; console.log('[pageerror]', String(e).slice(0, 300)); });

  let listingBody = listing([]);
  let listingStatus = 200;
  const imageBytes = {};        // path -> size to serve
  const served = [];            // which images were actually requested

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
  await page.route('https://www.reddit.com/**', (route) =>
    route.fulfill({ status: listingStatus, contentType: 'application/json', body: listingBody }));
  await page.route('https://i.redd.it/**', (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    served.push(name);
    const size = imageBytes[name];
    if (size === undefined) return route.abort();
    return route.fulfill({ status: 200, contentType: 'image/png', body: png(size) });
  });
  await page.route(/https?:\/\/(?!app\.wsw|widget\.test|www\.reddit\.com|i\.redd\.it).*/, (route) => route.abort());

  await page.addInitScript(shim);
  // No host behind the shim: WW.fetch escalates to the proxy when the browser attempt
  // fails, and an unanswered escalation never settles. Everything here is meant to be
  // served by the routes above, so a proxy request means the probe set something up wrong.
  await page.addInitScript(() => {
    window.__proxyAsked = [];
    window.addEventListener('message', (ev) => {
      const m = ev.data || {};
      if (m.type === 'ww-fetch') {
        window.__proxyAsked.push(m.url);
        window.postMessage({ type: 'ww-fetch-result', id: m.id, error: 'no host in probe' }, '*');
      }
    });
  });
  await page.goto('https://widget.test/index.html');

  const init = (settings) => page.evaluate((s) => {
    window.postMessage({ type: 'ww-init', settings: s, sensors: [], media: null, theme: null,
      game: { active: false, process: '' }, status: { elevated: false, apiVersion: 1 } }, '*');
  }, settings);

  const read = () => page.evaluate(() => {
    const msg = document.getElementById('message');
    const shown = msg.style.display !== 'none' && msg.style.display !== '';
    const layers = [document.getElementById('layerA'), document.getElementById('layerB')];
    const visible = layers.find((l) => l.classList.contains('visible'));
    return {
      messageShown: shown,
      title: (msg.querySelector('.state-title') || {}).textContent || '',
      detail: (msg.querySelector('small') || {}).textContent || '',
      painted: !!visible,
      caption: (document.querySelector('#caption .title') || {}).textContent || '',
    };
  });

  const base = { subreddit: 'probe', sort: 'hot', dwell: 120, showTitle: 'on', fit: 'cover', bgStyle: 'solid' };

  // ---- D1 · an ordinary image loads --------------------------------------------------
  imageBytes['small.png'] = 64 * 1024;
  listingBody = listing(['https://i.redd.it/small.png']);
  await init(base);
  await wait(2500);
  let s = await read();
  check('D1 an ordinary image loads and paints', s.painted && !s.messageShown,
    `painted=${s.painted} message=${s.title}`);

  // ---- D2/D3 · over the widget's own ceiling, but UNDER the shared one ----------------
  // The size matters: at 5 MiB this would prove only that WW.fetch's default works, which
  // it already does. Half way between the two ceilings can only be refused by the widget's.
  const between = Math.floor((IMAGE_MAX + SHARED_MAX) / 2);
  served.length = 0;
  imageBytes['huge.png'] = between;
  imageBytes['next.png'] = 48 * 1024;
  listingBody = listing(['https://i.redd.it/huge.png', 'https://i.redd.it/next.png']);
  await init(Object.assign({}, base, { sort: 'top' }));
  await wait(3500);
  s = await read();
  check('D2 setup: the oversized fixture sits between the two ceilings',
    between > IMAGE_MAX && between < SHARED_MAX, `${between} in (${IMAGE_MAX}, ${SHARED_MAX})`);
  check('D2 the oversized image was requested, so the ceiling is what refused it',
    served.includes('huge.png'), served.join(','));
  check('D3 a refusal skips the post rather than breaking the tile — the next image shows',
    s.painted && !s.messageShown && /post 1/.test(s.caption),
    `painted=${s.painted} caption="${s.caption}" message="${s.title}"`);

  // ---- D4 · every candidate oversized: the tile names the reason ----------------------
  imageBytes['b1.png'] = between;
  imageBytes['b2.png'] = between;
  listingBody = listing(['https://i.redd.it/b1.png', 'https://i.redd.it/b2.png']);
  await init(Object.assign({}, base, { sort: 'new' }));
  await wait(4000);
  s = await read();
  check('D4 when every image is oversized the tile says so, not "check the app log"',
    s.messageShown && /too large/i.test(s.title), `${s.title} — ${s.detail}`);

  // ---- D5 · the listing has a ceiling of its own too ----------------------------------
  listingBody = listing(['https://i.redd.it/small.png'], LISTING_MAX);
  await init(Object.assign({}, base, { subreddit: 'bigjson' }));
  await wait(3000);
  s = await read();
  check('D5 setup: the fixture listing really is over the listing ceiling',
    Buffer.byteLength(listingBody) > LISTING_MAX,
    `${Buffer.byteLength(listingBody)} > ${LISTING_MAX}`);
  check('D5 an oversized listing is named, not reported as a load failure',
    s.messageShown && /too large/i.test(s.title), `${s.title} — ${s.detail}`);

  // ---- D6 · and an ordinary failure still reads as one --------------------------------
  // The discrimination has to hold in both directions: naming everything "too large" would
  // pass D4 and D5 while telling the field to find smaller pictures for a dead network.
  listingBody = listing(['https://i.redd.it/missing.png']);   // routed to abort
  delete imageBytes['missing.png'];
  await init(Object.assign({}, base, { subreddit: 'broken' }));
  await wait(4000);
  s = await read();
  check('D6 an ordinary image failure does not claim the images were too large',
    s.messageShown && !/too large/i.test(s.title), `${s.title} — ${s.detail}`);

  listingStatus = 500;
  listingBody = 'nope';
  await init(Object.assign({}, base, { subreddit: 'down' }));
  await wait(2500);
  s = await read();
  check('D6b nor does an ordinary listing failure', s.messageShown && !/too large/i.test(s.title),
    `${s.title} — ${s.detail}`);

  await browser.close();
  console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
