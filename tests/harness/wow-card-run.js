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
//   W1 · identity renders: name, level + spec + class line, guild
//   W2 · professions rows show name and skill/max
//   W3 · reputations (no movement recorded yet) fall back to closest-to-done first
//   W4 · mount and pet counts are the collection sizes
//   W5 · the latest achievement is the newest completed one, with its recency
//   W6 · the almost list leads with the fewest-steps-left achievement and shows n/m
//   W7 · the portrait image actually loaded (stubbed render host)
//   W8 · none of the struck features appear anywhere in the card's text
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
    guild: { name: 'The Harness' } },
  media: { assets: [{ key: 'avatar', value: 'https://render.worldofwarcraft.com/us/character/pixel-avatar.png' }] },
  professions: { primaries: [
    { profession: { name: 'Alchemy' }, tiers: [
      { tier: { id: 9 }, skill_points: 87, max_skill_points: 100 },
      { tier: { id: 2 }, skill_points: 300, max_skill_points: 300 } ] },
    { profession: { name: 'Herbalism' }, tiers: [
      { tier: { id: 9 }, skill_points: 42, max_skill_points: 100 } ] },
  ] },
  reputations: { reputations: [
    { faction: { name: 'Council of Dornogal' }, standing: { value: 500, max: 1000, name: 'Honored' } },
    { faction: { name: 'The Assembly' }, standing: { value: 2400, max: 3000, renown_level: 24 } },
    { faction: { name: 'Quiet Grove' }, standing: { value: 100, max: 21000, name: 'Friendly' } },
  ] },
  mounts: { mounts: Array.from({ length: 214 }, () => ({})) },
  pets: { pets: Array.from({ length: 156 }, () => ({})) },
  achievements: { achievements: [
    { achievement: { name: 'Old One' }, completed_timestamp: days(40) },
    { achievement: { name: 'Latest Win' }, completed_timestamp: days(2) },
    { achievement: { name: 'Nine of Ten' }, criteria: leaves(9, 1) },
    { achievement: { name: 'Seventeen of Twenty' }, criteria: leaves(17, 3) },
    { achievement: { name: 'Half Done' }, criteria: leaves(5, 5) },
    { achievement: { name: 'Unjudgeable Single' }, criteria: { id: 1, is_completed: false } },
  ] },
};

// A real 1x1 PNG, so the <img> load event is a genuine decode.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64');

const SHELL_PAGE = '<!doctype html><meta charset="utf-8"><title>ww shell</title>'
  + '<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#000}'
  + 'iframe{display:block;border:0;width:100vw;height:100vh}</style>';

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
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

  const card = await frame.evaluate(() => {
    const rowsOf = (id) => [...document.querySelectorAll('#' + id + ' .trow')].map((row) => ({
      lbl: row.querySelector('.lbl').textContent,
      val: row.querySelector('.val').textContent,
    }));
    const img = document.getElementById('portrait');
    return {
      name: document.getElementById('cname').textContent,
      line: document.getElementById('cline').textContent,
      guild: document.getElementById('guild').textContent,
      profs: rowsOf('profs'), reps: rowsOf('reps'),
      latest: rowsOf('latest'), almost: rowsOf('almost'),
      mounts: document.getElementById('mounts').textContent,
      pets: document.getElementById('pets').textContent,
      portrait: { visible: !img.hidden, loaded: img.complete && img.naturalWidth > 0 },
      // innerText is the RENDERED text: the widget's own script (whose spec comment
      // names the struck features in order to ban them) must not trip the probe.
      text: document.body.innerText,
    };
  });

  check('W1 identity renders', card.name === 'Pixel'
    && card.line === 'Level 80 · Restoration Druid' && card.guild === '<The Harness>',
    `"${card.name}" / "${card.line}" / "${card.guild}"`);
  check('W2 professions show skill progress',
    JSON.stringify(card.profs) === JSON.stringify([
      { lbl: 'Alchemy', val: '87/100' }, { lbl: 'Herbalism', val: '42/100' }]),
    JSON.stringify(card.profs));
  check('W3 reputations fall back to closest-to-done first',
    card.reps.length === 3 && card.reps[0].lbl === 'The Assembly' && card.reps[0].val === 'Renown 24'
      && card.reps[1].lbl === 'Council of Dornogal' && card.reps[1].val === 'Honored',
    JSON.stringify(card.reps));
  check('W4 collection counts', card.mounts === '214' && card.pets === '156',
    `mounts=${card.mounts} pets=${card.pets}`);
  check('W5 latest achievement is the newest, with recency',
    card.latest.length === 1 && card.latest[0].lbl === 'Latest Win' && card.latest[0].val === '2d ago',
    JSON.stringify(card.latest));
  check('W6 almost list leads with fewest steps left',
    card.almost.length === 2 && card.almost[0].lbl === 'Nine of Ten' && card.almost[0].val === '9/10'
      && card.almost[1].lbl === 'Seventeen of Twenty' && card.almost[1].val === '17/20',
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

  const shot = path.join(__dirname, 'wow-card.png');
  await page.screenshot({ path: shot });
  console.log(`  shot ${shot}`);

  await browser.close();
  process.exit(failures ? 1 : 0);
})();
