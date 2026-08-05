#!/usr/bin/env node
// Home Assistant slice. Modes:
//   hang       the server accepts the connection and goes quiet. Neither WW.fetch tier
//              bounds a direct request, so the await never settles: inFlight stays true,
//              nothing re-arms, and the panel shows the last states it had, forever.
//   game       a game is already running at init — no polling until it ends.
//   notjson    a router page answers 200 with an object instead of a state array. Coerced
//              to [], every entity read as "unknown" and the footer blamed the entity ids.
//   dupe       the same entity listed twice: one tile is orphaned and never updates.
//   malformed  every entry is rejected by validation, so the list reads empty and the
//              generic "add entities" card appears over a full settings list.
//   band       a 200px band with 16 entities: tiles past the fold are polled and counted
//              but cannot be seen.
//   act        a control POST that never answers. The optimistic flip has to come back.
'use strict';
const fs = require('fs'); const path = require('path');
const SHELL = '/home/user/Waveshare-Widgets/src/Plinth/Shell';
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css' };
const folder = process.argv[2];
const mode = process.argv[3] || 'hang';
function pw(){ for (const c of ['playwright','/opt/node22/lib/node_modules/playwright']) { try { return require(c);} catch(e){} } throw new Error('no playwright'); }
let stateHits = 0, svcHits = 0;
const STATES = [
  {entity_id:'light.kitchen', state:'on',  attributes:{friendly_name:'Kitchen'}},
  {entity_id:'switch.desk',   state:'off', attributes:{friendly_name:'Desk'}},
];
(async () => {
  const { chromium } = pw();
  const shim = fs.readFileSync(path.join(SHELL,'widget-api.js'),'utf8')+'\n'+fs.readFileSync(path.join(SHELL,'icue-compat.js'),'utf8');
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport:{width:640,height: mode === 'band' ? 200 : 400} });
  await page.route('https://app.plinth/**', (r) => {
    const f = path.resolve(SHELL, decodeURIComponent(new URL(r.request().url()).pathname).replace(/^\/+/,''));
    return fs.existsSync(f) ? r.fulfill({ contentType: MIME[path.extname(f)]||'text/plain', body: fs.readFileSync(f) }) : r.fulfill({status:404,body:''});
  });
  await page.route('https://widget.test/**', (r) => {
    const f = path.resolve(folder, decodeURIComponent(new URL(r.request().url()).pathname).replace(/^\/+/,'')||'index.html');
    return fs.existsSync(f)&&fs.statSync(f).isFile() ? r.fulfill({ contentType: MIME[path.extname(f)]||'text/plain', body: fs.readFileSync(f) }) : r.fulfill({status:404,body:''});
  });
  await page.route('https://shell.test/**', (r) => r.fulfill({ contentType:'text/html',
    body:'<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}iframe{display:block;border:0;width:100vw;height:100vh}</style>' }));
  const CORS = { 'access-control-allow-origin':'*', 'access-control-allow-headers':'*' };
  const JSONH = { ...CORS, 'content-type':'application/json' };
  const all = mode === 'band'
    ? Array.from({length:16}, (_, i) => ({ entity_id:'light.l' + i, state: i === 15 ? 'on' : 'off',
        attributes:{ friendly_name:'Lamp ' + i } }))
    : STATES;
  await page.route(/https?:\/\/(?!(?:app\.plinth|widget\.test|shell\.test)(?:[:/?#]|$)).*/, (r) => {
    const u = r.request().url();
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status:204, headers: CORS });
    if (u.includes('/api/services/')) {
      svcHits++;
      if (mode === 'act') return;                       // accepted, never answers
      return r.fulfill({ status:200, headers: JSONH, body:'{}' });
    }
    if (u.includes('/api/states')) {
      stateHits++;
      if (mode === 'hang') return;                      // accepted, never answers
      if (mode === 'notjson') return r.fulfill({ status:200, headers: JSONH,
        body: JSON.stringify({ error: 'authentication required', portal: true }) });
      return r.fulfill({ status:200, headers: JSONH, body: JSON.stringify(all) });
    }
    return r.abort();
  });
  const entities = mode === 'dupe'
      ? [ { entity:'light.kitchen' }, { entity:'light.kitchen' }, { entity:'switch.desk' } ]
    : mode === 'malformed'
      ? [ { entity:'kitchen light' }, { entity:'not-an-entity' } ]
    : mode === 'band'
      ? Array.from({length:16}, (_, i) => ({ entity:'light.l' + i }))
    : [ { entity:'light.kitchen' }, { entity:'switch.desk' } ];
  await page.addInitScript(shim);
  await page.addInitScript((ents) => {
    if (window.top !== window) return;
    let frame = null;
    window.__gameOff = () => frame.contentWindow.postMessage({ type:'ww-game',
      game:{ active:false, process:'' } }, 'https://widget.test');
    window.__mount = () => { frame = document.createElement('iframe');
      frame.setAttribute('sandbox','allow-scripts allow-same-origin');
      frame.src = 'https://widget.test/index.html#ww-slot=p0s0'; document.body.appendChild(frame); };
    window.addEventListener('message', (ev) => {
      if (!frame || ev.source !== frame.contentWindow || ev.origin !== 'https://widget.test') return;
      const m = ev.data || {};
      if (m.type === 'ww-ready') return ev.source.postMessage({ type:'ww-init',
        game: window.__g ? {active:true,process:'game.exe'} : {active:false,process:''},
        settings:{ refreshSeconds: 5, baseUrl: 'http://127.0.0.1:8123',
          accessToken: 'llat_probe', entities: ents },
        sensors:[], media:null,
        theme:{'--accent':'#e0a33e'}, status:{elevated:false,apiVersion:1} }, ev.origin);
      if (m.type === 'ww-fetch') return ev.source.postMessage({ type:'ww-fetch-result', id:m.id,
        error:'no route to host' }, ev.origin);
    });
  }, entities);
  if (mode === 'game') await page.addInitScript(() => { window.__g = true; });
  await page.goto('https://shell.test/host.html');
  await page.evaluate(() => window.__mount());
  const el = await page.waitForSelector('iframe');
  const frame = await el.contentFrame();
  await frame.waitForLoadState('domcontentloaded');
  const text = () => frame.evaluate(() => document.body.innerText.replace(/\s+/g,' ').trim());

  if (mode === 'game') {
    await page.waitForTimeout(2500);
    console.log('   during game :', await text(), '| state calls:', stateHits);
    const during = stateHits;
    await page.evaluate(() => window.__gameOff());
    await page.waitForTimeout(2000);
    console.log('   game ended  :', await text(), '| state calls:', stateHits);
    const ok = during === 0 && stateHits > 0;
    console.log(ok ? '  PASS polling was held for the game and resumed when it ended'
                   : '  FAIL the panel polled straight through a running game');
    await browser.close(); process.exitCode = ok ? 0 : 1; return;
  }

  if (mode === 'hang') {
    await page.waitForTimeout(3000);
    console.log('   at t+3s  :', await text());
    await page.waitForTimeout(22000);            // POLL_DEADLINE is 20s
    const after = await text();
    console.log('   at t+25s :', after);
    const stuck = !/unavailable|did not answer|Error/i.test(after);
    console.log(stuck ? '  FAIL the silent server never timed out — the panel is frozen for good'
                      : '  PASS the request was cut off and the panel said so');
    await browser.close(); process.exitCode = stuck ? 1 : 0; return;
  }

  if (mode === 'act') {
    await page.waitForTimeout(2000);
    const before = await frame.evaluate(() => document.querySelectorAll('.ent.on').length);
    await frame.evaluate(() => {
      // The tile label is derived from the entity id when no settings label is given, so
      // it is "desk", not the payload's friendly_name "Desk".
      const t = Array.from(document.querySelectorAll('.ent')).find((n) =>
        (n.querySelector('.name') || {}).textContent === 'desk');
      if (!t) throw new Error('no desk tile — the probe is looking at the wrong thing');
      t.click();
    });
    await page.waitForTimeout(1200);
    const during = await frame.evaluate(() => document.querySelectorAll('.ent.on').length);
    // Counting lit tiles proves nothing here: the next poll re-renders every tile from
    // the authoritative state five seconds later, so the optimistic flip is corrected in
    // BOTH builds and for a reason that has nothing to do with the command's fate. What
    // actually differs is whether the person who pressed it is ever told it failed.
    // A hung POST is an AMBIGUOUS outcome, not a failure: aborting the request does not
    // recall it, so Home Assistant may well have acted. The panel must say "I don't know
    // yet" and go and look — claiming failure would invite a second press that undoes
    // what the first one did. So the signal to watch for is the pending flash, and the
    // absence of the definite one.
    let pending = false, failed = false;
    for (let i = 0; i < 20 && !pending; i++) {
      await page.waitForTimeout(600);
      pending = await frame.evaluate(() => !!document.querySelector('.ent.pending-flash'));
      failed = failed || await frame.evaluate(() => !!document.querySelector('.ent.fail-flash'));
    }
    const after = await frame.evaluate(() => document.querySelectorAll('.ent.on').length);
    console.log('   tiles lit — before:', before, 'right after the tap:', during, 'later:', after,
      '| service calls:', svcHits, '| pending flash:', pending, '| fail flash:', failed);
    const ok = during === before + 1 && pending && !failed;
    console.log(ok ? '  PASS a command with no answer was cut off and reported as unresolved, not failed'
                   : '  FAIL a command with no answer is silently forgotten, or wrongly called failed');
    await browser.close(); process.exitCode = ok ? 0 : 1; return;
  }

  await page.waitForTimeout(3000);
  const t = await text();
  const tiles = await frame.evaluate(() => Array.from(document.querySelectorAll('.ent .name')).map((n) => n.textContent));
  const unclipped = await frame.evaluate(() => {
    const g = document.getElementById('grid');
    if (!g) return [];
    const lim = g.getBoundingClientRect().bottom + 1;
    return Array.from(g.querySelectorAll('.ent'))
      .filter((n) => n.getBoundingClientRect().bottom <= lim)
      .map((n) => (n.querySelector('.name') || {}).textContent);
  });
  console.log('  ', t);
  console.log('   tiles:', JSON.stringify(tiles), '| unclipped:', JSON.stringify(unclipped));
  let ok, why;
  if (mode === 'notjson') {
    ok = /not Home Assistant|portal|router/i.test(t) && !/not found in Home Assistant/.test(t);
    why = ok ? 'PASS a reply that was not a state list is named as such, not blamed on the entity ids'
             : 'FAIL something that is not Home Assistant is reported as missing entities';
  } else if (mode === 'dupe') {
    ok = tiles.length === 2 && !/--/.test(t);
    why = ok ? 'PASS the duplicate collapsed to one live tile'
             : 'FAIL a repeated entity left an orphaned tile stuck on --';
  } else if (mode === 'malformed') {
    ok = /rejected/i.test(t);
    why = ok ? 'PASS the rejected entries are named instead of reading as an empty list'
             : 'FAIL a full settings list is answered with "add entities"';
  } else {
    // The tile label comes from the SETTINGS entry, not the state payload's
    // friendly_name, so this is "l15" and not "Lamp 15" — the first version of this
    // assertion looked for the wrong string and failed the fixed build.
    ok = unclipped.includes('l15') && /no room/.test(t);
    why = ok ? 'PASS the entity worth seeing got one of the tiles that fit, and the rest are declared'
             : 'FAIL tiles are clipped silently';
  }
  console.log('  ' + why);
  await browser.close();
  process.exitCode = ok ? 0 : 1;
})();
