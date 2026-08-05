#!/usr/bin/env node
// Codex round 2 on #171 — all seven are consequences of round 1. Modes:
//   sirensvc    an armed siren hold sent siren/open_cover, a service that does not exist,
//               because moving sirens into the armed set did not extend the service picker.
//   rebuildhold a poll rebuilds the grid while a finger is holding a security tile. The
//               old tile is detached but its timer is not, so releasing early no longer
//               reaches any cancel listener and the abandoned hold fires anyway.
//   gateway     a 502 from a reverse proxy in front of Home Assistant. HA may have acted
//               before the answer was lost, so this is not a refusal.
//   fastdouble  a tap, the POST settles, then a second tap BEFORE the reconciling poll
//               lands. `states` still holds the pre-command value, so the second tap sends
//               the opposite service and undoes the first.
//   flashseq    an unresolved command leaves pending-flash on the tile; a later success
//               must still be visible, not masked by the finished pending animation.
//   stopconfig  every entity removed while a poll is in flight, address and token
//               unchanged. Nothing invalidates the poll, so it lands, paints an empty
//               "Live" grid over the setup card, and re-arms itself.
'use strict';
const fs = require('fs'); const path = require('path');
const SHELL = '/home/user/Waveshare-Widgets/src/WaveshareWidgets/Shell';
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css' };
const folder = process.argv[2];
const mode = process.argv[3] || 'sirensvc';
function pw(){ for (const c of ['playwright','/opt/node22/lib/node_modules/playwright']) { try { return require(c);} catch(e){} } throw new Error('no playwright'); }
const sent = [];
let stateHits = 0, slowStates = false, failNext = false;
(async () => {
  const { chromium } = pw();
  const shim = fs.readFileSync(path.join(SHELL,'widget-api.js'),'utf8')+'\n'+fs.readFileSync(path.join(SHELL,'icue-compat.js'),'utf8');
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport:{width:640,height: mode === 'rebuildhold' ? 200 : 400} });
  await page.route('https://app.wsw/**', (r) => {
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
  // rebuildhold: enough entities that a band cannot show them all, so a state change
  // reshuffles the ranking and forces build() while the finger is down.
  const many = Array.from({length:12}, (_, i) => ({ entity_id:'light.l' + i, state:'off', attributes:{} }));
  const bodyFor = () => {
    if (mode === 'rebuildhold') {
      // After the first poll, one of the hidden lights turns on, which changes who gets a
      // tile and triggers the rebuild.
      const m = many.map((e) => ({ ...e }));
      if (stateHits > 1) m[11].state = 'on';
      return [ { entity_id:'lock.front', state:'locked', attributes:{} } ].concat(m);
    }
    if (mode === 'sirensvc') return [ { entity_id:'siren.alarm', state:'off', attributes:{} } ];
    return [ { entity_id:'light.kitchen', state:'off', attributes:{} } ];
  };
  await page.route(/https?:\/\/(?!(?:app\.wsw|widget\.test|shell\.test)(?:[:/?#]|$)).*/, async (r) => {
    const u = r.request().url();
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status:204, headers: CORS });
    if (u.includes('/api/services/')) {
      sent.push(u.split('/api/services/')[1]);
      if (mode === 'gateway') return r.fulfill({ status:502, headers:{ ...CORS, 'content-type':'text/html' },
        body:'<html><body>502 Bad Gateway</body></html>' });
      if (failNext) return r.fulfill({ status:200, headers: JSONH, body:'{}' });
      if (mode === 'flashseq' && sent.length === 1) return;      // first one never answers
      return r.fulfill({ status:200, headers: JSONH, body:'{}' });
    }
    if (u.includes('/api/states')) {
      stateHits++;
      if (slowStates) await new Promise((res) => setTimeout(res, 4000));
      return r.fulfill({ status:200, headers: JSONH, body: JSON.stringify(bodyFor()) });
    }
    return r.abort();
  });
  const entities = mode === 'sirensvc' ? [ { entity:'siren.alarm', control:'allow' } ]
    : mode === 'rebuildhold' ? [ { entity:'lock.front', control:'allow' } ]
        .concat(Array.from({length:12}, (_, i) => ({ entity:'light.l' + i })))
    : [ { entity:'light.kitchen' } ];
  await page.addInitScript(shim);
  await page.addInitScript((ents) => {
    if (window.top !== window) return;
    let frame = null;
    window.__ents = ents;
    window.__mount = () => { frame = document.createElement('iframe');
      frame.setAttribute('sandbox','allow-scripts allow-same-origin');
      frame.src = 'https://widget.test/index.html#ww-slot=p0s0'; document.body.appendChild(frame); };
    window.__send = () => frame.contentWindow.postMessage({ type:'ww-init',
      game:{active:false,process:''},
      settings:{ refreshSeconds: 5, baseUrl: 'http://127.0.0.1:8123',
        accessToken: 'llat_probe', entities: window.__ents },
      sensors:[], media:null,
      theme:{'--accent':'#e0a33e'}, status:{elevated:false,apiVersion:1} }, 'https://widget.test');
    window.__clearEntities = () => { window.__ents = []; window.__send(); };
    window.addEventListener('message', (ev) => {
      if (!frame || ev.source !== frame.contentWindow || ev.origin !== 'https://widget.test') return;
      const m = ev.data || {};
      if (m.type === 'ww-ready') return window.__send();
      if (m.type === 'ww-fetch') return ev.source.postMessage({ type:'ww-fetch-result', id:m.id,
        error:'no route to host' }, ev.origin);
    });
  }, entities);
  await page.goto('https://shell.test/host.html');
  await page.evaluate(() => window.__mount());
  const el = await page.waitForSelector('iframe');
  const frame = await el.contentFrame();
  await frame.waitForLoadState('domcontentloaded');
  const text = () => frame.evaluate(() => document.body.innerText.replace(/\s+/g,' ').trim());
  await page.waitForTimeout(2500);

  if (mode === 'stopconfig') {
    slowStates = true;
    await page.waitForTimeout(5500);          // a poll is now away and slow
    const before = stateHits;
    await page.evaluate(() => window.__clearEntities());
    await page.waitForTimeout(7000);
    const t = await text();
    console.log('  ', t);
    console.log('   state calls before clearing:', before, '| after 7s:', stateHits);
    const ok = /Not configured|Add entities/i.test(t) && !/LIVE/.test(t) && stateHits <= before + 1;
    console.log(ok ? '  PASS the emptied configuration stopped, and the in-flight poll did not paint over it'
                   : '  FAIL a poll landed after the configuration was emptied and kept polling');
    await browser.close(); process.exitCode = ok ? 0 : 1; return;
  }

  if (mode === 'rebuildhold') {
    // Put a finger on the armed lock and hold it. Partway through, the poll lands with a
    // changed ranking and rebuilds the grid under the finger. Then release — before the
    // 700ms hold would have completed.
    await frame.evaluate(() => {
      const t = Array.from(document.querySelectorAll('.ent')).find((n) => n.classList.contains('armed'));
      if (!t) throw new Error('no armed tile');
      t.dispatchEvent(new PointerEvent('pointerdown', { pointerId:1, button:0, bubbles:true }));
    });
    await frame.evaluate(() => {
      // Force the rebuild the poll would cause, at the moment the finger is down.
      window.dispatchEvent(new Event('resize'));
    });
    await page.waitForTimeout(250);
    await frame.evaluate(() => {
      const t = Array.from(document.querySelectorAll('.ent')).find((n) => n.classList.contains('armed'));
      if (t) t.dispatchEvent(new PointerEvent('pointerup', { pointerId:1, button:0, bubbles:true }));
    });
    await page.waitForTimeout(1800);
    console.log('   services sent after a hold abandoned across a rebuild:', JSON.stringify(sent));
    const ok = sent.length === 0;
    console.log(ok ? '  PASS the rebuild called off the hold'
                   : '  FAIL a hold survived its own tile and operated the device');
    await browser.close(); process.exitCode = ok ? 0 : 1; return;
  }

  const tile = await frame.$('.ent');
  if (!tile) { console.log('  SETUP FAILED — no tile'); await browser.close(); process.exitCode = 2; return; }

  if (mode === 'sirensvc') {
    await frame.evaluate(() => {
      const t = document.querySelector('.ent');
      t.dispatchEvent(new PointerEvent('pointerdown', { pointerId:1, button:0, bubbles:true }));
    });
    await page.waitForTimeout(2000);
    console.log('   services sent:', JSON.stringify(sent));
    const ok = sent.length === 1 && /^siren\/turn_(on|off)$/.test(sent[0]);
    console.log(ok ? '  PASS the siren got a siren service'
                   : '  FAIL the siren was sent a service that does not exist for it');
    await browser.close(); process.exitCode = ok ? 0 : 1; return;
  }

  if (mode === 'gateway') {
    await frame.evaluate(() => document.querySelector('.ent').click());
    let pending = false, failed = false;
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(400);
      pending = pending || await frame.evaluate(() => !!document.querySelector('.ent.pending-flash'));
      failed = failed || await frame.evaluate(() => !!document.querySelector('.ent.fail-flash'));
    }
    console.log('   pending flash:', pending, '| fail flash:', failed, '| sent:', JSON.stringify(sent));
    const ok = pending && !failed;
    console.log(ok ? '  PASS a gateway error stayed ambiguous instead of claiming refusal'
                   : '  FAIL a 502 was reported as the device refusing');
    await browser.close(); process.exitCode = ok ? 0 : 1; return;
  }

  if (mode === 'fastdouble') {
    // Tap, wait for the POST to settle but NOT for the reconciling poll, tap again.
    // The reconciling poll has to be SLOW, so the second tap lands while the state is
    // still unreconciled. Answering it instantly with an unchanged state — which is what
    // the first version of this did — models a server that accepts a toggle and then
    // denies it happened, and the widget is right to allow another press in that case.
    slowStates = true;
    await frame.evaluate(() => document.querySelector('.ent').click());
    await page.waitForTimeout(400);
    await frame.evaluate(() => document.querySelector('.ent').click());
    await page.waitForTimeout(2000);
    console.log('   services sent:', JSON.stringify(sent));
    const ok = sent.length === 1;
    console.log(ok ? '  PASS the second tap was still held while the state was unreconciled'
                   : '  FAIL the second tap undid the first');
    await browser.close(); process.exitCode = ok ? 0 : 1; return;
  }

  // flashseq: the first command never answers (pending), the second succeeds and must show.
  await frame.evaluate(() => document.querySelector('.ent').click());
  await page.waitForTimeout(9500);            // past ACT_DEADLINE so pending has landed
  const sawPending = await frame.evaluate(() => !!document.querySelector('.ent.pending-flash'));
  failNext = true;
  await page.waitForTimeout(500);
  await frame.evaluate(() => document.querySelector('.ent').click());
  // The class being PRESENT proves nothing — the defect is that the leftover
  // pending-flash rule is later and more specific, so the confirm animation never runs.
  // Ask the browser which animation is actually computed on the tile.
  let confirmed = false, anim = '';
  for (let i = 0; i < 10 && !confirmed; i++) {
    await page.waitForTimeout(300);
    anim = await frame.evaluate(() => {
      const t = document.querySelector('.ent');
      return t ? getComputedStyle(t).animationName : '';
    });
    confirmed = /confirm/.test(anim);
  }
  console.log('   pending seen:', sawPending, '| animation computed after the later success:',
    JSON.stringify(anim), '| sent:', JSON.stringify(sent));
  const ok = confirmed;
  console.log(ok ? '  PASS a later success is visible over a finished pending animation'
                 : '  FAIL the stale pending class masked every later answer');
  await browser.close();
  process.exitCode = ok ? 0 : 1;
})();
