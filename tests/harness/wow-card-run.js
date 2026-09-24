#!/usr/bin/env node
// WoW Panel: the card shows the character, not market data (issue #25 rework).
//
// The corrected spec strikes token price, sparklines, M+ rating, raid progression and
// affixes, and asks for: the character (portrait, name, level, spec, guild),
// professions with skill progress, the reputations most recently pushed, mount and
// pet counts, the latest achievement, and the almost-done achievements. This runner
// stubs the OAuth token exchange (which travels the HOST-PROXY tier by design —
// token endpoints must not be replayed, so the stub shell answers ww-fetch) plus the
// six profile endpoints on the direct tier, and asserts the card:
//
//   W1 · identity renders: name, level + spec + class line, race + realm, guild
//   W2 · every profession shows, primaries then secondaries, with skill/max
//   W3 · reputations (no movement recorded yet) fall back to the NEWEST factions first,
//        not the decade-old ones a sliver short of their next tier (#258)
//   W4 · item level, achievement points, and the mount and pet collection sizes
//   W5 · the latest achievements, newest first, each with its recency
//   W6 · the almost list leads with the fewest-steps-left achievement and shows n/m
//   W7 · the portrait image actually loaded (stubbed render host)
//   W8 · none of the struck features appear anywhere in the card's text
//   W9 · the meter fill is painted
//   W10-W15 · at every size the widget is offered (half, three-quarter and full at 400px,
//        the panel's 360px, and the 200px upper/lower bands): nothing is cut off, the
//        sections sit at a fixed rhythm instead of spreading into gaps, and no list was
//        trimmed — or dropped — while there was room for more (#258)
//
// Run: CHROMIUM=/path/to/chrome node tests/harness/wow-card-run.js
'use strict';
const fs = require('fs');
const path = require('path');

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
const WIDGET = path.join(REPO, 'widgets', 'wow');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  if (!ok) failures++;
};

const days = (n) => Date.now() - n * 86400000;
const leaves = (done, todo) => ({ child_criteria: [
  ...Array.from({ length: done }, (_, i) => ({ id: i + 1, is_completed: true })),
  ...Array.from({ length: todo }, (_, i) => ({ id: 100 + i, is_completed: false })),
] });

const PAYLOADS = {
  profile: { name: 'Pixel', level: 80,
    active_spec: { name: 'Restoration' }, character_class: { name: 'Druid' },
    guild: { name: 'The Harness' }, race: { name: 'Night Elf' }, realm: { name: 'Argent Dawn' },
    equipped_item_level: 639, achievement_points: 23450 },
  media: { assets: [{ key: 'avatar', value: 'https://render.worldofwarcraft.com/us/character/pixel-avatar.png' }] },
  professions: { primaries: [
    { profession: { name: 'Alchemy' }, tiers: [
      { tier: { id: 9 }, skill_points: 87, max_skill_points: 100 },
      { tier: { id: 2 }, skill_points: 300, max_skill_points: 300 } ] },
    { profession: { name: 'Herbalism' }, tiers: [
      { tier: { id: 9 }, skill_points: 42, max_skill_points: 100 } ] },
  ], secondaries: [
    { profession: { name: 'Cooking' }, tiers: [{ tier: { id: 9 }, skill_points: 52, max_skill_points: 100 }] },
    { profession: { name: 'Fishing' }, tiers: [{ tier: { id: 9 }, skill_points: 30, max_skill_points: 100 }] },
    { profession: { name: 'Archaeology' }, tiers: [{ tier: { id: 1 }, skill_points: 150, max_skill_points: 950 }] },
  ] },
  // The owner's #258 card: with nothing yet seen moving, the old closest-to-done rule
  // led with Gilneas and Tushui — old factions a sliver short of their next tier —
  // over every current-expansion faction. Faction ids rise with each release.
  reputations: { reputations: [
    { faction: { name: 'Gilneas', id: 1134 }, standing: { value: 2950, max: 3000, name: 'Friendly' } },
    { faction: { name: 'Tushui Pandaren', id: 1353 }, standing: { value: 2900, max: 3000, name: 'Friendly' } },
    { faction: { name: 'Council of Dornogal', id: 2590 }, standing: { value: 500, max: 1000, name: 'Honored' } },
    { faction: { name: 'The Assembly', id: 2594 }, standing: { value: 2400, max: 3000, renown_level: 24 } },
    { faction: { name: 'Hallowfall Arathi', id: 2570 }, standing: { value: 1200, max: 2500, renown_level: 9 } },
    { faction: { name: 'Quiet Grove', id: 2601 }, standing: { value: 100, max: 21000, name: 'Friendly' } },
    { faction: { name: 'Stormwind', id: 72 }, standing: { value: 999, max: 999, name: 'Exalted' } },
  ] },
  mounts: { mounts: Array.from({ length: 214 }, () => ({})) },
  pets: { pets: Array.from({ length: 156 }, () => ({})) },
  achievements: { achievements: [
    { achievement: { name: 'Old One' }, completed_timestamp: days(40) },
    { achievement: { name: 'Latest Win' }, completed_timestamp: days(2) },
    { achievement: { name: 'Ancient' }, completed_timestamp: days(400) },
    { achievement: { name: 'Middle' }, completed_timestamp: days(10) },
    { achievement: { name: 'Nine of Ten' }, criteria: leaves(9, 1) },
    { achievement: { name: 'Seventeen of Twenty' }, criteria: leaves(17, 3) },
    { achievement: { name: 'Jungle Stalker' }, criteria: leaves(59, 1) },
    { achievement: { name: 'Eighteen of Twenty' }, criteria: leaves(18, 2) },
    { achievement: { name: 'Killing Time' }, criteria: leaves(31, 1) },
    { achievement: { name: 'Half Done' }, criteria: leaves(5, 5) },
    { achievement: { name: 'Unjudgeable Single' }, criteria: { id: 1, is_completed: false } },
  ] },
};

// What each list SHOULD lead with, in order. A size may show a prefix of these — fitting
// drops rows from the end — but never a different order.
const EXPECT = {
  profs: ['Alchemy', 'Herbalism', 'Cooking', 'Fishing', 'Archaeology'],
  reps: ['Quiet Grove', 'The Assembly', 'Council of Dornogal', 'Hallowfall Arathi', 'Tushui Pandaren', 'Gilneas'],
  latest: ['Latest Win', 'Middle', 'Old One'],
  almost: ['Jungle Stalker', 'Killing Time', 'Nine of Ten', 'Eighteen of Twenty', 'Seventeen of Twenty'],
};
const isPrefix = (got, want) => got.length > 0 && got.every((g, i) => g === want[i]);

// A real 1x1 PNG, so the <img> load event is a genuine decode.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64');

const SHELL_PAGE = '<!doctype html><meta charset="utf-8"><title>ww shell</title>'
  + '<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#000}'
  + 'iframe{display:block;border:0;width:100vw;height:100vh}</style>';

// One card in its own browser context (so each size starts with empty localStorage and
// no reputation movement), mounted the way the shell mounts it.
async function mount(browser, viewport) {
  const page = await browser.newPage({ viewport });
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
  await page.route('https://shell.test/**', (r) =>
    r.fulfill({ contentType: 'text/html', body: SHELL_PAGE }));

  // The profile endpoints, on the direct tier with honest CORS (Authorization makes
  // every call preflighted).
  const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  };
  const json = (r, body) => r.fulfill({ status: 200, contentType: 'application/json',
    headers: CORS, body: JSON.stringify(body) });
  await page.route('https://us.api.blizzard.com/**', (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS, body: '' });
    const p = new URL(r.request().url()).pathname;
    if (p.endsWith('/character-media')) return json(r, PAYLOADS.media);
    if (p.endsWith('/professions')) return json(r, PAYLOADS.professions);
    if (p.endsWith('/reputations')) return json(r, PAYLOADS.reputations);
    if (p.endsWith('/collections/mounts')) return json(r, PAYLOADS.mounts);
    if (p.endsWith('/collections/pets')) return json(r, PAYLOADS.pets);
    if (p.endsWith('/achievements')) return json(r, PAYLOADS.achievements);
    if (p.endsWith('/pixel')) return json(r, PAYLOADS.profile);
    return r.fulfill({ status: 404, headers: CORS, body: '{}' });
  });
  await page.route('https://render.worldofwarcraft.com/**', (r) =>
    r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  // oauth.battle.net is deliberately NOT routed to a direct answer: the widget sends
  // the token exchange proxy-only, so it must arrive as a ww-fetch message below —
  // the same tier the panel uses. A direct request here is a contract break.
  await page.route('https://oauth.battle.net/**', (r) => { failures++;
    console.log('  FAIL token exchange hit the direct tier (must be proxy-only)'); return r.abort(); });
  await page.route(/https?:\/\/(?!(?:app\.plinth|widget\.test|shell\.test|us\.api\.blizzard\.com|render\.worldofwarcraft\.com|oauth\.battle\.net)(?:[/?#]|$)).*/,
    (r) => r.abort());

  const shim = fs.readFileSync(path.join(SHELL, 'widget-api.js'), 'utf8') + '\n'
             + fs.readFileSync(path.join(SHELL, 'icue-compat.js'), 'utf8');
  await page.addInitScript(shim);
  await page.addInitScript(({ widgetUrl, widgetOrigin, initMessage, tokenBody }) => {
    if (window.top !== window) return;
    let frame = null;
    window.__wwMount = () => {
      frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      frame.src = widgetUrl + '#ww-slot=p0s0';
      (document.body || document.documentElement).appendChild(frame);
    };
    window.__wwPush = (msg) => { if (frame && frame.contentWindow) frame.contentWindow.postMessage(msg, widgetOrigin); };
    window.addEventListener('message', (ev) => {
      if (!frame || ev.source !== frame.contentWindow || ev.origin !== widgetOrigin) return;
      const m = ev.data || {};
      if (m.type === 'ww-ready') return window.__wwPush(initMessage);
      if (m.type === 'ww-fetch') {
        // The stub host proxy: answers the token exchange exactly once per ask, and
        // refuses everything else so no data call can quietly succeed on this tier.
        const url = String((m.init && m.url) || m.url || '');
        if (url.startsWith('https://oauth.battle.net/token'))
          return window.__wwPush({ type: 'ww-fetch-result', id: m.id, status: 200,
            contentType: 'application/json', bodyBase64: btoa(tokenBody) });
        return window.__wwPush({ type: 'ww-fetch-result', id: m.id, error: 'offline probe' });
      }
    });
  }, {
    widgetUrl: 'https://widget.test/index.html',
    widgetOrigin: 'https://widget.test',
    tokenBody: JSON.stringify({ access_token: 'stub-bearer', token_type: 'bearer', expires_in: 86400 }),
    initMessage: { type: 'ww-init',
      settings: { region: 'us', realm: 'Argent Dawn', character: 'Pixel',
        clientId: 'stub-id', clientSecret: 'stub-secret', refreshMinutes: 30 },
      sensors: [], media: null, theme: {},
      status: { elevated: false, apiVersion: 1 } },
  });

  await page.goto('https://shell.test/host.html');
  await page.evaluate(() => window.__wwMount());
  const frameEl = await page.waitForSelector('iframe', { timeout: 10000 });
  const frame = await frameEl.contentFrame();
  if (!frame) { console.log('  FAIL W0 widget frame never attached'); await browser.close(); process.exit(1); }
  await frame.waitForSelector('#card:not([hidden])', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
  return { page, frame };
}

// The layout at one size, measured: per column, whether anything is cut off, the gaps
// between its sections, how many rows each list kept, and the room left at the bottom
// against the height of one more row.
const measure = (frame) => frame.evaluate(() => [...document.querySelectorAll('#card .col')].map((col) => {
  const cr = col.getBoundingClientRect();
  const kids = [...col.children].filter((k) => !k.hidden && k.getBoundingClientRect().height > 0);
  const gaps = kids.slice(1).map((k, i) => Math.round(k.getBoundingClientRect().top - kids[i].getBoundingClientRect().bottom));
  const rows = [...col.querySelectorAll('.sect:not([hidden]) .trow:not([hidden])')];
  const rowH = rows.length ? Math.max(...rows.map((r) => r.getBoundingClientRect().height)) : 0;
  const lastBottom = kids.length ? kids[kids.length - 1].getBoundingClientRect().bottom : cr.top;
  return {
    clipped: col.scrollHeight > col.clientHeight + 1
      || rows.some((r) => r.getBoundingClientRect().bottom > cr.bottom + 0.5),
    gaps,
    rowGap: parseFloat(getComputedStyle(col.querySelector('.sect') || col).rowGap) || 0,
    rowH: Math.round(rowH),
    spare: Math.round(cr.bottom - lastBottom),
    colGap: parseFloat(getComputedStyle(col).rowGap) || 0,
    kickerH: Math.round(Math.max(0, ...[...col.querySelectorAll('.sect:not([hidden]) > .kicker')]
      .map((k) => k.getBoundingClientRect().height))),
    lists: Object.fromEntries([...col.querySelectorAll('.sect[id]:not([hidden])')].map((sct) =>
      [sct.id, [...sct.querySelectorAll('.trow:not([hidden]) .lbl')].map((l) => l.textContent)])),
    dropped: [...col.querySelectorAll('.sect[id][hidden]')].map((sct) => sct.id),
  };
}));

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  // The panel's full slot as the owner's #258 screenshots show it: 1280 x 360.
  const { page, frame } = await mount(browser, { width: 1280, height: 360 });

  const card = await frame.evaluate(() => {
    const rowsOf = (id) => [...document.querySelectorAll('#' + id + ' .trow:not([hidden])')].map((row) => ({
      lbl: row.querySelector('.lbl').textContent,
      val: row.querySelector('.val').textContent,
    }));
    const img = document.getElementById('portrait');
    return {
      name: document.getElementById('cname').textContent,
      line: document.getElementById('cline').textContent,
      from: document.getElementById('cfrom').textContent,
      guild: document.getElementById('guild').textContent,
      profs: rowsOf('profs'), reps: rowsOf('reps'),
      latest: rowsOf('latest'), almost: rowsOf('almost'),
      ilvl: document.getElementById('ilvlStat').hidden ? null : document.getElementById('ilvl').textContent,
      points: document.getElementById('pointsStat').hidden ? null : document.getElementById('points').textContent,
      mounts: document.getElementById('mounts').textContent,
      pets: document.getElementById('pets').textContent,
      portrait: { visible: !img.hidden, loaded: img.complete && img.naturalWidth > 0 },
      // innerText is the RENDERED text: the widget's own script (whose spec comment
      // names the struck features in order to ban them) must not trip the probe.
      text: document.body.innerText,
    };
  });

  const names = (rows) => rows.map((r) => r.lbl);
  check('W1 identity renders', card.name === 'Pixel'
    && card.line === 'Level 80 · Restoration Druid' && card.from === 'Night Elf · Argent Dawn'
    && card.guild === '<The Harness>',
    `"${card.name}" / "${card.line}" / "${card.from}" / "${card.guild}"`);
  check('W2 every profession shows, primaries then secondaries',
    JSON.stringify(card.profs) === JSON.stringify([
      { lbl: 'Alchemy', val: '87/100' }, { lbl: 'Herbalism', val: '42/100' },
      { lbl: 'Cooking', val: '52/100' }, { lbl: 'Fishing', val: '30/100' },
      { lbl: 'Archaeology', val: '150/950' }]),
    JSON.stringify(card.profs));
  check('W3 reputations fall back to the newest factions, not the stalled old ones (#258)',
    card.reps.length >= 3 && isPrefix(names(card.reps), EXPECT.reps)
      && card.reps[1].val === 'Renown 24' && card.reps[2].val === 'Honored',
    JSON.stringify(card.reps));
  check('W4 item level, achievement points and collection counts',
    card.ilvl === '639' && card.points === '23,450' && card.mounts === '214' && card.pets === '156',
    `ilvl=${card.ilvl} points=${card.points} mounts=${card.mounts} pets=${card.pets}`);
  check('W5 the latest achievements, newest first, with recency',
    card.latest.length >= 1 && isPrefix(names(card.latest), EXPECT.latest)
      && card.latest[0].val === '2d ago' && (!card.latest[1] || card.latest[1].val === '10d ago'),
    JSON.stringify(card.latest));
  check('W6 almost list leads with fewest steps left',
    card.almost.length >= 3 && isPrefix(names(card.almost), EXPECT.almost)
      && card.almost[0].val === '59/60',
    JSON.stringify(card.almost));
  check('W7 the portrait image loaded', card.portrait.visible && card.portrait.loaded,
    JSON.stringify(card.portrait));
  const struck = /token price|affix|mythic|raid progress|m\+/i.exec(card.text);
  check('W8 no struck feature appears on the card', !struck, struck ? `found "${struck[0]}"` : 'clean');

  // W9 · the skill/renown/achievement bars are actually PAINTED (#258). The card built
  // its meter fill as `<div class="fill">`, but widget-base styles the shared meter fill
  // as `.meter > i` — a bare .fill outside a .scale block gets no background and no
  // height, so every progress bar rendered as an empty track with an invisible fill.
  // Assert the first profession's fill has a non-transparent colour AND a non-zero box:
  // both are false for the old div, so this fails against the pre-fix card.
  const bar = await frame.evaluate(() => {
    const fill = document.querySelector('#profs .trow .meter > i')
      || document.querySelector('#profs .trow .meter > *');
    if (!fill) return { present: false };
    const cs = getComputedStyle(fill);
    const box = fill.getBoundingClientRect();
    const m = /rgba?\(([^)]+)\)/.exec(cs.backgroundColor || '');
    const alpha = m ? (m[1].split(',')[3] === undefined ? 1 : parseFloat(m[1].split(',')[3])) : 0;
    return { present: true, tag: fill.tagName.toLowerCase(), bg: cs.backgroundColor,
      painted: alpha > 0, w: Math.round(box.width), h: Math.round(box.height) };
  });
  check('W9 the meter fill is painted, not an invisible track (#258)',
    bar.present && bar.painted && bar.h > 0 && bar.w > 0,
    JSON.stringify(bar));

  const shotDir = process.env.SHOT_DIR || __dirname;
  await page.screenshot({ path: path.join(shotDir, 'wow-card-1280x360.png') });
  await page.close();

  // W10-W12 · the layout at every size the widget supports. The owner's #258 card had
  // three short lists spread over a 360px column with ~100px canyons between them and
  // the rest of the data cut by fixed three-row caps. Here: nothing is clipped, the
  // sections sit at a fixed rhythm, and a list only loses rows when the next row would
  // not have fit.
  const SIZES = [
    ['W10', 'half 640x400', { width: 640, height: 400 }],
    ['W11', 'three-quarter 960x400', { width: 960, height: 400 }],
    ['W12', 'full 1280x400', { width: 1280, height: 400 }],
    ['W13', 'full 1280x360 (the panel)', { width: 1280, height: 360 }],
    ['W14', 'half band 640x200', { width: 640, height: 200 }],
    ['W15', 'full band 1280x200', { width: 1280, height: 200 }],
  ];
  for (const [tag, label, viewport] of SIZES) {
    const m = await mount(browser, viewport);
    const cols = await measure(m.frame);
    const clipped = cols.some((c) => c.clipped);
    const bigGap = Math.max(0, ...cols.flatMap((c) => c.gaps));
    // A list shows a prefix of its expected order; it may be short only if the column
    // has no room left for one more row.
    const cut = [];
    for (const c of cols) for (const [id, got] of Object.entries(c.lists)) {
      if (!isPrefix(got, EXPECT[id])) cut.push(`${id} out of order: ${JSON.stringify(got)}`);
      else if (got.length < EXPECT[id].length && c.spare >= c.rowH + c.rowGap)
        cut.push(`${id} trimmed to ${got.length} with ${c.spare}px spare (row ${c.rowH}px)`);
    }
    // A section dropped whole needs its heading AND a row back; any less room is fine.
    for (const c of cols) for (const id of c.dropped) {
      if (c.spare >= c.kickerH + c.rowGap + c.rowH + c.colGap)
        cut.push(`${id} dropped with ${c.spare}px spare`);
    }
    check(`${tag} ${label}: nothing is cut off`, !clipped, JSON.stringify(cols.map((c) => c.clipped)));
    check(`${tag} ${label}: sections at a fixed rhythm, no canyons`, bigGap <= 24, `largest gap ${bigGap}px`);
    check(`${tag} ${label}: lists fill the room they have`, cut.length === 0,
      cut.length ? cut.join('; ') : cols.map((c) => Object.entries(c.lists).map(([k, v]) => k + ' ' + v.length)
        .concat(c.dropped.map((d) => d + ' dropped')).join(', ')).join(' | '));
    await m.page.screenshot({ path: path.join(shotDir, `wow-card-${viewport.width}x${viewport.height}.png`) });
    await m.page.close();
  }
  console.log(`  shots in ${shotDir}`);

  await browser.close();
  process.exit(failures ? 1 : 0);
})();
