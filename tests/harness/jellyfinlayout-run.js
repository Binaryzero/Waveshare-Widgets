#!/usr/bin/env node
// Jellyfin: no header, type that scales with the tile, and layout budgets that measure
// (beta.21: "pointless tiny text in the top corners", "everything is too TINY"). Against
// the stub server in tests/fixtures/widgets/jellyfin.json (three streams, a twelve-title
// shelf, the libraries), at every size the widget is offered:
//
//   L1 · no header row: no <header>, no "Jellyfin" label, no pill on a healthy tile
//   L2 · the stream titles are 13.5px times the tile scale (WW.tileScale)
//   L3 · nothing is cut off: every stream row and the whole shelf, captions included,
//        sit inside the body, and in a 200px band the shelf gives way to the streams
//   L4 · no dead band: the shelf takes the height the rows leave, and once its posters
//        are as tall as the art fetched for them (330px) the rows take the rest
//   L5 · the layout is settled: laying the tile out again changes nothing. (A first
//        answer that beat DOMContentLoaded, where the tile scale lands, sized a 1280x400
//        tile for text half its height — three rows and half a shelf.)
//   L6 · Stale moves out of the corner: a failed poll shows it in the footer, beside the
//        age of the data, on a 200px band too; the Player shows it in its browse bar
//   L7 · Retry reads as a retry: a spinner and "Retrying…", no setup card, no SETUP pill
//   L8 · the Player's page fits: the page it fetches is the one its grid draws, it asks
//        for it once, and the tab you are on stays in the row when the tabs overflow
//   L9 · theme: the genre sheet is the theme's surface, and its title and a poster's
//        watched mark read at 4.5:1 or better in a light theme (the sheet was a black
//        scrim, and the mark --text on a black disc)
//
// Run: CHROMIUM=/path/to/chrome node tests/harness/jellyfinlayout-run.js
'use strict';
const fs = require('fs');
const path = require('path');
const { textContrast } = require('./contrast.js');

function loadPlaywright() {
  const candidates = ['playwright', '/opt/node22/lib/node_modules/playwright',
    path.join(process.env.HOME || '', 'node_modules/playwright')];
  for (const c of candidates) { try { return require(c); } catch (e) { /* next */ } }
  console.error('playwright not found — npm i -g playwright (and provide a chromium via CHROMIUM)');
  process.exit(1);
}
const { chromium } = loadPlaywright();

const REPO = path.resolve(__dirname, '..', '..');
const SHELL = path.join(REPO, 'src', 'Plinth', 'Shell');
const WIDGET = path.join(REPO, 'widgets', 'jellyfin');
const FIXTURES = path.join(REPO, 'tests', 'fixtures', 'widgets');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'x-emby-token, content-type, range',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
};
// half and full, the three-quarter they imply, their 200px bands, and the XENEON EDGE's
// tiles for half (1280x360, 1280x720) and full (2560x360, 2560x720)
const SIZES = ['640x400', '960x400', '1280x400', '640x200', '960x200', '1280x200',
  '1280x360', '1280x720', '2560x360', '2560x720'];

global.window = {};
require(path.join(SHELL, 'palette.js'));
const derive = global.window.WWPalette.derive;
const DARK = derive({});
const LIGHT = derive({ background: '#e8e6e1', text: '#12161a', accent: '#b04a2f' });

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  if (!ok) failures++;
};

// One widget on one stub server. `failSessions` turns /Sessions into a 503 from then on.
async function mount(browser, size, opts) {
  const [W, H] = size.split('x').map(Number);
  const page = await browser.newPage({ viewport: { width: W, height: H } });
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
  await page.route('https://shell.test/**', (r) => r.fulfill({ contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><body style="margin:0;background:#000"></body>' }));
  const stubs = JSON.parse(fs.readFileSync(path.join(FIXTURES, opts.fixture || 'jellyfin.json'), 'utf8'));
  const state = { failSessions: false, slow: false, asked: [] };
  await page.route('https://jf1.test/**', async (r) => {
    const req = r.request();
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS, body: '' });
    const url = req.url();
    state.asked.push(url);
    if (state.slow) await new Promise((res) => setTimeout(res, 2500));
    if (state.failSessions && url.includes('/Sessions')) return r.fulfill({ status: 503, headers: CORS, body: '' });
    const stub = stubs.find((s) => url.includes(s.match));
    if (!stub) return r.fulfill({ status: 404, headers: CORS, body: '{}' });
    if (stub.status && stub.status !== 200) return r.fulfill({ status: stub.status, headers: CORS, body: '' });
    return r.fulfill({ status: 200, headers: CORS, contentType: stub.contentType || 'application/json',
      body: stub.json !== undefined ? JSON.stringify(stub.json) : String(stub.body || '') });
  });
  await page.route(/https?:\/\/(?!(?:app\.plinth|widget\.test|shell\.test|jf1\.test)(?:[/?#:]|$)).*/, (r) => r.abort());
  await page.addInitScript(fs.readFileSync(path.join(SHELL, 'widget-api.js'), 'utf8'));
  const settings = Object.assign({ baseUrl: 'https://jf1.test', apiKey: 'stub-key', userName: '', hideLibraries: [],
    view: 'Server overview', latestTypes: 'Movies & episodes', refreshSeconds: 5,
    certValidation: 'Require a valid certificate' }, opts.settings || {});
  await page.addInitScript(({ settings, theme }) => {
    if (window.top !== window) return;
    let frame = null;
    window.__wwMount = () => {
      frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      frame.style.cssText = 'display:block;border:0;width:100vw;height:100vh';
      frame.src = 'https://widget.test/index.html#ww-slot=p0s0';
      document.body.appendChild(frame);
    };
    const push = (msg) => frame.contentWindow.postMessage(msg, 'https://widget.test');
    window.addEventListener('message', (ev) => {
      if (!frame || ev.source !== frame.contentWindow || ev.origin !== 'https://widget.test') return;
      const m = ev.data || {};
      if (m.type === 'ww-ready') push({ type: 'ww-init', settings, sensors: [], media: null, theme,
        status: { elevated: false, apiVersion: 1 } });
      if (m.type === 'ww-fetch') push({ type: 'ww-fetch-result', id: m.id, error: 'no host in this harness' });
    });
  }, { settings, theme: opts.theme || DARK });
  await page.goto('https://shell.test/host.html');
  await page.evaluate(() => window.__wwMount());
  const frame = await (await page.waitForSelector('iframe', { timeout: 10000 })).contentFrame();
  await frame.waitForLoadState('load');
  await frame.evaluate(() => document.fonts.ready);
  // The first answers, the slow lane (shelf, counts, server name) and the relayout the
  // tile scale and the fonts trigger (150 ms after them).
  await page.waitForTimeout(opts.wait || 1500);
  return { page, frame, state };
}

// Where everything in the overview sits, in the frame's own pixels.
const overview = () => {
  const box = (e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
  const main = document.getElementById('main');
  const sec = document.getElementById('latestSec');
  const rows = [...document.querySelectorAll('#sessions .sess')];
  const strip = document.getElementById('strip');
  const tiles = [...strip.querySelectorAll('.tile')];
  const lastTile = tiles[tiles.length - 1];
  const t1 = document.querySelector('.sess .t1');
  return {
    ts: WW.tileScale,
    mainShown: !main.hidden,
    main: box(main),
    rows: rows.map(box),
    shelf: !sec.hidden ? box(sec) : null,
    lastTileBottom: lastTile ? lastTile.getBoundingClientRect().bottom : null,
    ph: parseFloat(strip.style.getPropertyValue('--ph')) || 0,
    t1Px: t1 ? parseFloat(getComputedStyle(t1).fontSize) : 0,
    header: !!document.querySelector('header'),
    label: [...document.querySelectorAll('.kicker')].some((k) => /jellyfin/i.test(k.textContent)),
    pills: [...document.querySelectorAll('.pill')].filter((p) => p.getClientRects().length > 0).map((p) => p.textContent),
    axis: !document.getElementById('axis').hidden,
    sig: rows.length + '|' + strip.style.getPropertyValue('--ph') + '|' + tiles.length,
  };
};

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});

  for (const size of SIZES) {
    const band = Number(size.split('x')[1]) < 260;
    const { page, frame } = await mount(browser, size, {});
    const o = await frame.evaluate(overview);
    check(`L1 ${size} no header row: no <header>, no Jellyfin label, no pill on a healthy tile`,
      o.mainShown && !o.header && !o.label && o.pills.length === 0, JSON.stringify({ header: o.header, label: o.label, pills: o.pills }));
    check(`L2 ${size} stream titles are 13.5px x the tile scale`,
      Math.abs(o.t1Px - 13.5 * o.ts) < 0.6, `${o.t1Px}px at ${o.ts}`);
    const floor = o.main.bottom + 0.5;
    const rowsFit = o.rows.length > 0 && o.rows.every((r) => r.bottom <= floor);
    const shelfFits = !o.shelf || (o.shelf.bottom <= floor && o.lastTileBottom <= floor);
    check(`L3 ${size} nothing cut off: ${o.rows.length} stream row(s)${o.shelf ? ' and the shelf' : ''} inside the body`
      + (band ? ', and no shelf while streaming on a band' : ''),
      rowsFit && shelfFits && (!band || !o.shelf),
      JSON.stringify({ main: o.main, rows: o.rows.map((r) => Math.round(r.bottom)), shelf: o.shelf }));
    if (o.shelf) {
      const gap = o.main.bottom - o.shelf.bottom;
      check(`L4 ${size} no dead band: the shelf and the rows take the whole height`,
        gap <= 2, `gap ${gap.toFixed(1)}px, posters ${o.ph}px`);
    }
    const again = await frame.evaluate(() => { render(); return document.querySelectorAll('#sessions .sess').length + '|'
      + document.getElementById('strip').style.getPropertyValue('--ph') + '|' + document.querySelectorAll('#strip .tile').length; });
    check(`L5 ${size} the layout is settled: laying it out again changes nothing`, again === o.sig, `${o.sig} then ${again}`);
    await page.close();
  }

  // L6 · Stale, overview (a full tile and a band) and Player.
  for (const size of ['640x400', '640x200']) {
    const { page, frame, state } = await mount(browser, size, {});
    state.failSessions = true;
    await page.waitForTimeout(6500);   // the next poll (refreshSeconds 5) fails
    const s = await frame.evaluate(() => {
      const foot = document.querySelector('footer');
      const flag = document.getElementById('flag');
      return { stale: document.body.classList.contains('stale'), footShown: getComputedStyle(foot).display !== 'none' && !foot.hidden,
        flag: flag.getClientRects().length > 0 ? flag.textContent : '', meta: document.getElementById('meta').textContent };
    });
    check(`L6 ${size} a failed poll shows Stale in the footer beside the data's age`,
      s.stale && s.footShown && s.flag === 'Stale' && /updated/.test(s.meta), JSON.stringify(s));
    await page.close();
  }
  {
    const { page, frame, state } = await mount(browser, '640x400', { settings: { view: 'Player' } });
    state.failSessions = true;
    await page.waitForTimeout(6500);
    const s = await frame.evaluate(() => {
      const bar = document.getElementById('pbar').getBoundingClientRect();
      const p = document.getElementById('pstale');
      const r = p.getBoundingClientRect();
      return { shown: p.getClientRects().length > 0, text: p.textContent, inBar: r.top >= bar.top - 1 && r.bottom <= bar.bottom + 1 };
    });
    check('L6 Player: Stale shows in the browse bar', s.shown && s.text === 'Stale' && s.inBar, JSON.stringify(s));
    await page.close();
  }

  // L7 · Retry.
  {
    const { page, frame, state } = await mount(browser, '640x400', { fixture: 'jellyfin-badkey.json' });
    const before = await frame.evaluate(() => document.getElementById('state').innerText);
    state.slow = true;
    await frame.locator('#state .btn', { hasText: 'Retry' }).click();
    await page.waitForTimeout(300);
    const r = await frame.evaluate(() => {
      const s = document.getElementById('state');
      return { text: s.innerText.trim(), spinner: !!s.querySelector('.spinner'), shown: !s.hidden,
        icon: !!s.querySelector('.state-icon'), pills: [...document.querySelectorAll('.pill')]
          .filter((p) => p.getClientRects().length > 0).map((p) => p.textContent) };
    });
    check('L7 Retry shows a spinner and "Retrying…" — no setup card, no SETUP pill',
      /rejected/i.test(before) && r.shown && r.spinner && r.text === 'Retrying…' && !r.icon && r.pills.length === 0,
      JSON.stringify(r));
    await page.close();
  }

  // L8 · the Player's page, at the panel's half tile and a band.
  for (const size of ['640x400', '1280x400', '640x200']) {
    const { page, frame, state } = await mount(browser, size, { settings: { view: 'Player', userName: 'will' } });
    // Movies may have collapsed behind the ⋯ at this size — reach it the way a finger would.
    if (await frame.locator('#ptabs .btn', { hasText: 'Movies' }).count()) await frame.locator('#ptabs .btn', { hasText: 'Movies' }).click();
    else { await frame.locator('#ptabs .btn', { hasText: '⋯' }).click(); await frame.locator('#chGrid .btn', { hasText: 'Movies' }).click(); }
    await page.waitForTimeout(2500);
    const movies = state.asked.filter((u) => u.includes('IncludeItemTypes=Movie&Recursive'));
    const limit = movies.length ? Number(new URL(movies[movies.length - 1]).searchParams.get('Limit')) : 0;
    const g = await frame.evaluate(() => {
      const strip = document.getElementById('pstrip').getBoundingClientRect();
      const tiles = [...document.querySelectorAll('#pstrip .tile')];
      const first = tiles[0] && tiles[0].getBoundingClientRect();
      const on = document.querySelector('#ptabs .btn.on');
      // The stub answers with its whole list whatever the Limit, so what is compared is
      // the page size the fetch was sized with and the one the grid measures now.
      return { pageSize: browse.pageSize, measured: playerBudget(false).count,
        firstFits: !!first && first.bottom <= strip.bottom + 0.5,
        on: on ? on.textContent : '', counts: document.getElementById('counts').textContent };
    });
    check(`L8 ${size} Player: the page fetched is the page the grid measures, asked for once, its first row whole`,
      movies.length === 1 && limit > 0 && limit === g.pageSize && g.pageSize === g.measured && g.firstFits,
      `${movies.length} fetch(es), Limit=${limit}, measured ${g.measured}, ${g.counts}`);
    check(`L8 ${size} Player: the tab you are on stays in the row`, g.on === 'Movies', g.on);
    await page.close();
  }

  // L9 · light theme: the sheet and the marks.
  {
    const { page, frame } = await mount(browser, '640x400', { theme: LIGHT, settings: { view: 'Player', userName: 'will' } });
    if (await frame.locator('#ptabs .btn', { hasText: 'Movies' }).count()) await frame.locator('#ptabs .btn', { hasText: 'Movies' }).click();
    else { await frame.locator('#ptabs .btn', { hasText: '⋯' }).click(); await frame.locator('#chGrid .btn', { hasText: 'Movies' }).click(); }
    await page.waitForTimeout(2000);
    const seen = await textContrast(frame.locator('#pstrip .art .marks .seen').first());
    check('L9 light theme: a poster\'s watched mark reads at 4.5:1 or better', seen.ratio >= 4.5, seen.ratio.toFixed(2) + ':1');
    await frame.locator('#pgenre').click();
    await page.waitForTimeout(600);
    const bg = await frame.evaluate(() => getComputedStyle(document.getElementById('chooser')).backgroundColor);
    const surface = LIGHT['--surface-rgb'].replace(/\s+/g, '');
    check('L9 light theme: the genre sheet is the theme\'s surface, not a black scrim',
      bg.replace(/\s+/g, '').startsWith('rgba(' + surface + ','), bg + ' vs ' + surface);
    const title = await textContrast(frame.locator('#chTitle'));
    check('L9 light theme: the genre sheet\'s title reads at 4.5:1 or better', title.ratio >= 4.5, title.ratio.toFixed(2) + ':1');
    await page.close();
  }

  await browser.close();
  console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
