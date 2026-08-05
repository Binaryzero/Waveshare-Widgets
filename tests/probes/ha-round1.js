#!/usr/bin/env node
// Codex round 1 on #171 — the safety set. Modes:
//   bodystall   headers arrive, then the body stalls. The deadline was cleared the moment
//               WW.fetch resolved, so res.json() hung forever: same dead panel, one step
//               further along.
//   unknownlock an armed lock reporting `unavailable`. isOn is false for that exactly as
//               it is for `locked`, so the press chose UNLOCK — the unsafe direction,
//               picked from the absence of a state.
//   siren       a siren was in the tap-to-toggle list: one brush sounds a physical alarm.
//   twofinger   two fingers on an armed tile, both lifted early. The second pointerdown
//               overwrote the timer handle without clearing the first, so the abandoned
//               gesture still fired.
//   doubletap   two taps on a light send two toggles; the light ends where it started.
//   uppercase   `Light.Kitchen` was accepted and kept, so the lowercase id from the server
//               never matched and the tile read unknown forever.
'use strict';
const fs = require('fs'); const path = require('path');
const SHELL = '/home/user/Waveshare-Widgets/src/WaveshareWidgets/Shell';
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css' };
const folder = process.argv[2];
const mode = process.argv[3] || 'unknownlock';
function pw(){ for (const c of ['playwright','/opt/node22/lib/node_modules/playwright']) { try { return require(c);} catch(e){} } throw new Error('no playwright'); }
const sent = [];
(async () => {
  const { chromium } = pw();
  const shim = fs.readFileSync(path.join(SHELL,'widget-api.js'),'utf8')+'\n'+fs.readFileSync(path.join(SHELL,'icue-compat.js'),'utf8');
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport:{width:640,height:400} });
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
  const STATES = {
    unknownlock: [{entity_id:'lock.front', state:'unavailable', attributes:{}}],
    siren:       [{entity_id:'siren.alarm', state:'off', attributes:{}}],
    twofinger:   [{entity_id:'lock.front', state:'locked', attributes:{}}],
    doubletap:   [{entity_id:'light.kitchen', state:'off', attributes:{}}],
    uppercase:   [{entity_id:'light.kitchen', state:'on', attributes:{}}],
    bodystall:   [{entity_id:'light.kitchen', state:'on', attributes:{}}],
  }[mode];
  await page.route(/https?:\/\/(?!(?:app\.wsw|widget\.test|shell\.test)(?:[:/?#]|$)).*/, async (r) => {
    const u = r.request().url();
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status:204, headers: CORS });
    if (u.includes('/api/services/')) {
      sent.push(u.split('/api/services/')[1]);
      return r.fulfill({ status:200, headers: JSONH, body:'{}' });
    }
    if (u.includes('/api/states')) {
      if (mode === 'bodystall') {
        // Headers land, the body never finishes. Playwright cannot half-send a body, and
        // a delay BEFORE fulfilling is indistinguishable from a slow connect — so this
        // holds the route open past any sane deadline, which is the same observable:
        // WW.fetch has not resolved, and whatever bounds it must fire.
        await new Promise(() => {});
        return;
      }
      return r.fulfill({ status:200, headers: JSONH, body: JSON.stringify(STATES) });
    }
    return r.abort();
  });
  const entities = {
    unknownlock: [ { entity:'lock.front', control:'allow' } ],
    siren:       [ { entity:'siren.alarm' } ],
    twofinger:   [ { entity:'lock.front', control:'allow' } ],
    doubletap:   [ { entity:'light.kitchen' } ],
    uppercase:   [ { entity:'Light.Kitchen' } ],
    bodystall:   [ { entity:'light.kitchen' } ],
  }[mode];
  await page.addInitScript(shim);
  await page.addInitScript((ents) => {
    if (window.top !== window) return;
    let frame = null;
    window.__mount = () => { frame = document.createElement('iframe');
      frame.setAttribute('sandbox','allow-scripts allow-same-origin');
      frame.src = 'https://widget.test/index.html#ww-slot=p0s0'; document.body.appendChild(frame); };
    window.addEventListener('message', (ev) => {
      if (!frame || ev.source !== frame.contentWindow || ev.origin !== 'https://widget.test') return;
      const m = ev.data || {};
      if (m.type === 'ww-ready') return ev.source.postMessage({ type:'ww-init',
        game:{active:false,process:''},
        settings:{ refreshSeconds: 30, baseUrl: 'http://127.0.0.1:8123',
          accessToken: 'llat_probe', entities: ents },
        sensors:[], media:null,
        theme:{'--accent':'#e0a33e'}, status:{elevated:false,apiVersion:1} }, ev.origin);
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

  if (mode === 'bodystall') {
    await page.waitForTimeout(3000);
    console.log('   at t+3s  :', await text());
    await page.waitForTimeout(22000);              // POLL_DEADLINE is 20s
    const after = await text();
    console.log('   at t+25s :', after);
    const stuck = !/did not answer|unavailable|Error/i.test(after);
    console.log(stuck ? '  FAIL the body never finished and nothing cut it off — panel frozen'
                      : '  PASS the deadline covered the body read too');
    await browser.close(); process.exitCode = stuck ? 1 : 0; return;
  }

  await page.waitForTimeout(2500);
  const tile = await frame.$('.ent');
  if (!tile) { console.log('  SETUP FAILED — no tile rendered'); await browser.close(); process.exitCode = 2; return; }

  if (mode === 'twofinger') {
    // Two fingers down, both lifted well before the 700ms hold completes. Nothing at all
    // should be sent.
    await frame.evaluate(() => {
      const t = document.querySelector('.ent');
      const down = (id) => t.dispatchEvent(new PointerEvent('pointerdown', { pointerId:id, button:0, bubbles:true }));
      const up = (id) => t.dispatchEvent(new PointerEvent('pointerup', { pointerId:id, button:0, bubbles:true }));
      down(1); down(2); up(2); up(1);
    });
    await page.waitForTimeout(1800);
    console.log('   services sent after an abandoned two-finger gesture:', JSON.stringify(sent));
    const ok = sent.length === 0;
    console.log(ok ? '  PASS the abandoned gesture sent nothing'
                   : '  FAIL an abandoned gesture still operated the device');
    await browser.close(); process.exitCode = ok ? 0 : 1; return;
  }

  if (mode === 'doubletap') {
    await frame.evaluate(() => { const t = document.querySelector('.ent'); t.click(); t.click(); });
    await page.waitForTimeout(2500);
    console.log('   services sent for a double tap:', JSON.stringify(sent));
    const ok = sent.length === 1;
    console.log(ok ? '  PASS the second tap was suppressed while the first was in flight'
                   : '  FAIL two toggles went out and the device ends where it started');
    await browser.close(); process.exitCode = ok ? 0 : 1; return;
  }

  if (mode === 'uppercase') {
    const t = await text();
    console.log('  ', t);
    const ok = /on/.test(t) && !/--/.test(t) && !/not found/.test(t);
    console.log(ok ? '  PASS the id was normalised and the tile matched the server'
                   : '  FAIL an accepted id could never match what the server returns');
    await browser.close(); process.exitCode = ok ? 0 : 1; return;
  }

  // unknownlock / siren: hold the tile past the long-press threshold, or tap it.
  const isSecurity = mode === 'unknownlock' || mode === 'siren';
  await frame.evaluate(() => {
    const t = document.querySelector('.ent');
    if (t.classList.contains('armed')) {
      t.dispatchEvent(new PointerEvent('pointerdown', { pointerId:1, button:0, bubbles:true }));
    } else {
      t.click();
    }
  });
  await page.waitForTimeout(2500);
  const hint = await frame.evaluate(() => (document.querySelector('.ent .hint') || {}).textContent);
  console.log('   hint on the tile:', JSON.stringify(hint), '| services sent:', JSON.stringify(sent));
  let ok, why;
  if (mode === 'unknownlock') {
    ok = !sent.some((s) => /unlock/.test(s));
    why = ok ? 'PASS an indeterminate lock was not sent the unsafe direction'
             : 'FAIL a lock in an unknown state was sent unlock';
  } else {
    ok = sent.length === 0 && hint !== 'tap';
    why = ok ? 'PASS the siren is not a tap-to-fire tile'
             : 'FAIL one tap sounds a physical alarm';
  }
  console.log('  ' + why);
  await browser.close();
  process.exitCode = ok ? 0 : 1;
})();
