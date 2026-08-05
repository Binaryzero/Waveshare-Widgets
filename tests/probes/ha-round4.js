#!/usr/bin/env node
// Codex round 4 on #171. A scheduled poll begins BETWEEN the command being sent and the
// command settling. It takes a higher sequence number than the stamp round 3 recorded at
// send time, so it satisfied `atSeq < seq` and released the guard — even though Home
// Assistant may still have been snapshotting the pre-command state when it started.
//
// Timeline the probe builds:
//   t+0.0  tap -> the POST is SLOW (3s)
//   t+0.5  the scheduled poll starts (fast) and lands
//   t+3.0  the POST settles
//   t+3.3  second tap        <- must still be refused
//
// (round 3's own case, kept below for reference)
// A periodic poll is ALREADY in flight when a command is sent. The
// command settles first and queues a follow-up, but the pre-command poll lands before that
// follow-up runs — and it released every guard, on the strength of a snapshot taken before
// the command existed. A second press in that window reads the stale state and sends the
// opposite service.
//
// Timeline the probe builds:
//   t+0.0  poll A starts (slow, 6s)
//   t+2.0  tap -> POST settles quickly, queues a follow-up behind poll A
//   t+6.0  poll A lands with the PRE-command snapshot
//   t+6.2  second tap        <- must still be refused
'use strict';
const fs = require('fs'); const path = require('path');
const SHELL = '/home/user/Waveshare-Widgets/src/WaveshareWidgets/Shell';
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css' };
const folder = process.argv[2];
function pw(){ for (const c of ['playwright','/opt/node22/lib/node_modules/playwright']) { try { return require(c);} catch(e){} } throw new Error('no playwright'); }
const sent = [];
let stateHits = 0;
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
  await page.route(/https?:\/\/(?!(?:app\.wsw|widget\.test|shell\.test)(?:[:/?#]|$)).*/, async (r) => {
    const u = r.request().url();
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status:204, headers: CORS });
    if (u.includes('/api/services/')) {
      sent.push(u.split('/api/services/')[1]);
      await new Promise((res) => setTimeout(res, 3000));   // settles slowly
      return r.fulfill({ status:200, headers: JSONH, body:'{}' });
    }
    if (u.includes('/api/states')) {
      stateHits++;
      // The first poll answers immediately so a tile exists; the SECOND is the slow one
      // that will still be in flight when the command goes out. Every reply reports the
      // same pre-command state, which is what makes a stale release dangerous.

      return r.fulfill({ status:200, headers: JSONH,
        body: JSON.stringify([{ entity_id:'light.kitchen', state:'off', attributes:{} }]) });
    }
    return r.abort();
  });
  await page.addInitScript(shim);
  await page.addInitScript(() => {
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
        settings:{ refreshSeconds: 5, baseUrl: 'http://127.0.0.1:8123',
          accessToken: 'llat_probe', entities: [ { entity:'light.kitchen' } ] },
        sensors:[], media:null,
        theme:{'--accent':'#e0a33e'}, status:{elevated:false,apiVersion:1} }, ev.origin);
      if (m.type === 'ww-fetch') return ev.source.postMessage({ type:'ww-fetch-result', id:m.id,
        error:'no route to host' }, ev.origin);
    });
  });
  await page.goto('https://shell.test/host.html');
  await page.evaluate(() => window.__mount());
  const el = await page.waitForSelector('iframe');
  const frame = await el.contentFrame();
  await frame.waitForLoadState('domcontentloaded');
  const tile = await page.waitForTimeout(1500).then(() => frame.$('.ent'));
  if (!tile) { console.log('  SETUP FAILED — no tile'); await browser.close(); process.exitCode = 2; return; }

  // Synchronise on the poll actually starting rather than guessing from the interval —
  // the first version tapped again BEFORE the slow poll landed, so the guard was still
  // held by the 8s backstop and both builds "passed" for a reason unrelated to the fix.
  // Tap just BEFORE the next scheduled poll is due, so that poll starts while the slow
  // POST is still in flight and takes a higher sequence than the send-time stamp.
  // Tap so that the next SCHEDULED poll (5s cadence) falls inside the 3s POST. Waiting
  // until ~3.5s after the last poll puts the next one about 1.5s into the command.
  const before = stateHits;
  await page.waitForTimeout(3500);
  await frame.evaluate(() => document.querySelector('.ent').click());
  const tappedAt = Date.now();
  while (stateHits === before) await page.waitForTimeout(50);
  const pollAt = Date.now() - tappedAt;
  console.log('   a scheduled poll began ' + pollAt + 'ms into the 3000ms POST');
  if (pollAt > 2600) {
    console.log('  SETUP FAILED — the poll did not fall inside the command window');
    await browser.close(); process.exitCode = 2; return;
  }
  // Press again while the FIRST command is still in flight. Nothing may accept this.
  await page.waitForTimeout(700);
  console.log('   pressing again at +' + (Date.now() - tappedAt) + 'ms, command still unsettled');
  await frame.evaluate(() => document.querySelector('.ent').click());
  await page.waitForTimeout(1500);
  console.log('   services sent:', JSON.stringify(sent), '| state calls:', stateHits);
  const ok = sent.length === 1;
  console.log(ok ? '  PASS a poll that began before the command settled did not release the guard'
                 : '  FAIL a mid-command poll released the guard and a second press went out');
  await browser.close();
  process.exitCode = ok ? 0 : 1;
})();
