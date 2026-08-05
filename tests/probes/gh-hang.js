#!/usr/bin/env node
// api.github.com accepts the connection and then goes silent — a proxy or captive portal
// swallowing the request, which is the ordinary way this fails on a home network.
//
// Neither tier of WW.fetch bounds a DIRECT browser request, so that await never settles:
// the `finally` never runs, `inFlight` stays true forever, and nothing re-arms the timer.
// The widget is not slow, it is dead — and it keeps showing whatever was last on screen.
//
// modes:  hang       one silent request, watch whether the widget ever recovers
//         game       a game is already running at init — no polling until it ends
//         badjson    200 with a body that is not JSON: a format fault, not "unreachable"
'use strict';
const fs = require('fs'); const path = require('path');
const SHELL = '/home/user/Waveshare-Widgets/src/WaveshareWidgets/Shell';
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css' };
const folder = process.argv[2];
const mode = process.argv[3] || 'hang';
function pw(){ for (const c of ['playwright','/opt/node22/lib/node_modules/playwright']) { try { return require(c);} catch(e){} } throw new Error('no playwright'); }
let searchHits = 0, runHits = 0;
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
  await page.route(/https?:\/\/(?!(?:app\.wsw|widget\.test|shell\.test)(?:[:/?#]|$)).*/, (r) => {
    const u = r.request().url();
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status:204, headers: CORS });
    if (u.includes('/search/issues')) {
      searchHits++;
      if (mode === 'hang') return;                                  // accepted, never answers
      if (mode === 'badjson') return r.fulfill({ status:200, body:'<!doctype html><h1>proxy login</h1>',
        headers:{ ...CORS, 'content-type':'text/html' } });
      return r.fulfill({ status:200, headers:{ ...CORS, 'content-type':'application/json' },
        body: JSON.stringify({ total_count: 2, items: [] }) });
    }
    if (u.includes('/actions/runs')) {
      runHits++;
      return r.fulfill({ status:200, headers:{ ...CORS, 'content-type':'application/json' },
        body: JSON.stringify({ workflow_runs: [ { status:'completed', conclusion:'success' } ] }) });
    }
    return r.abort();
  });
  await page.addInitScript(shim);
  await page.addInitScript(() => {
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
        settings:{ refreshMinutes: 1, apiToken: 'ghp_probe', repos:[ { repo:'binaryzero/waveshare-widgets' } ] },
        sensors:[], media:null,
        theme:{'--accent':'#e0a33e'}, status:{elevated:false,apiVersion:1} }, ev.origin);
      if (m.type === 'ww-fetch') return ev.source.postMessage({ type:'ww-fetch-result', id:m.id,
        error:'no route to host' }, ev.origin);
    });
  });
  if (mode === 'game') await page.addInitScript(() => { window.__g = true; });
  await page.goto('https://shell.test/host.html');
  await page.evaluate(() => window.__mount());
  const el = await page.waitForSelector('iframe');
  const frame = await el.contentFrame();
  await frame.waitForLoadState('domcontentloaded');
  const text = () => frame.evaluate(() => document.body.innerText.replace(/\s+/g,' ').trim());

  if (mode === 'game') {
    await page.waitForTimeout(2500);
    console.log('  during game :', await text(), '| search calls:', searchHits);
    const during = searchHits;
    await page.evaluate(() => window.__gameOff());
    await page.waitForTimeout(2000);
    console.log('  game ended  :', await text(), '| search calls:', searchHits);
    const ok = during === 0 && searchHits > 0;
    console.log(ok ? '  PASS polling was held for the game and resumed when it ended'
                   : '  FAIL the widget polled straight through a running game');
    await browser.close(); process.exitCode = ok ? 0 : 1; return;
  }

  if (mode === 'badjson') {
    await page.waitForTimeout(3000);
    const t = await text();
    console.log('  ', t);
    // The claim is that the reply is NAMED as malformed. The tag build says "check the
    // token has access to those repositories" for this — specific, and wrong.
    const ok = /JSON/i.test(t) && !/token has access|couldn.t reach/i.test(t);
    console.log(ok ? '  PASS a non-JSON 200 is named as a bad reply, not as a network failure'
                   : '  FAIL a server that answered is reported as unreachable');
    await browser.close(); process.exitCode = ok ? 0 : 1; return;
  }

  await page.waitForTimeout(3000);
  console.log('  at t+3s  :', await text(), '| search:', searchHits, 'runs:', runHits);
  await page.waitForTimeout(17000);        // past any sane per-request deadline
  const after = await text();
  console.log('  at t+20s :', after, '| search:', searchHits, 'runs:', runHits);
  // Recovery means the probe SETTLED and the widget carried on: it reached a verdict
  // instead of sitting on the spinner forever with nothing armed.
  const stuck = runHits === 0 && !/unavailable|Error|Stale|GitHub unavailable/i.test(after);
  console.log(stuck ? '  FAIL the silent request never timed out — the widget is frozen for good'
                    : '  PASS the request was cut off and the widget reached a verdict');
  await browser.close();
  process.exitCode = stuck ? 1 : 0;
})();
