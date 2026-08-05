#!/usr/bin/env node
// A model expiring three seconds out, against a 300-second poll interval. When that
// deadline passes the held list is WRONG — Ollama has evicted it — so the tile must stop
// presenting it as current, and must go and ask, rather than waiting out the interval.
'use strict';
const fs = require('fs'); const path = require('path');
const SHELL = '/home/user/Waveshare-Widgets/src/WaveshareWidgets/Shell';
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css' };
const folder = process.argv[2];
const mode = process.argv[3] || 'plain';
function pw(){ for (const c of ['playwright','/opt/node22/lib/node_modules/playwright']) { try { return require(c);} catch(e){} } throw new Error('no playwright'); }
let hits = 0;
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
  await page.route(/https?:\/\/(?!(?:app\.wsw|widget\.test|shell\.test)(?:[:/?#]|$)).*/, (r) => {
    if (!r.request().url().includes('11434')) return r.abort();
    hits++;
    // First answer: resident, evicted in 3s. Any LATER poll: Ollama has unloaded it.
    const body = hits === 1
      ? { models:[{ name:'llama3.1:8b', model:'llama3.1:8b', size:6108916224, size_vram:6108916224,
                    expires_at:new Date(Date.now()+3000).toISOString() }] }
      : { models: [] };
    return r.fulfill({ status:200, contentType:'application/json',
      headers:{'access-control-allow-origin':'*'}, body: JSON.stringify(body) });
  });
  await page.addInitScript(shim);
  await page.addInitScript(() => {
    if (window.top !== window) return;
    let frame = null;
    window.__game = (active) => frame.contentWindow.postMessage({ type:'ww-game',
      game:{ active, process: active ? 'game.exe' : '' } }, 'https://widget.test');
    window.__mount = () => { frame = document.createElement('iframe');
      frame.setAttribute('sandbox','allow-scripts allow-same-origin');
      frame.src = 'https://widget.test/index.html#ww-slot=p0s0'; document.body.appendChild(frame); };
    window.addEventListener('message', (ev) => {
      if (!frame || ev.source !== frame.contentWindow || ev.origin !== 'https://widget.test') return;
      const m = ev.data || {};
      if (m.type === 'ww-ready') return ev.source.postMessage({ type:'ww-init',
        settings:{ baseUrl:'http://localhost:11434', refreshSeconds: 300 }, sensors:[], media:null,
        game:{active:false,process:''}, theme:{'--accent':'#e0a33e'}, status:{elevated:false,apiVersion:1} }, ev.origin);
      if (m.type === 'ww-fetch') ev.source.postMessage({ type:'ww-fetch-result', id:m.id, error:'no proxy' }, ev.origin);
      window.__slot = ev.source; window.__slotOrigin = ev.origin;
    });
  });
  await page.goto('https://shell.test/host.html');
  await page.evaluate(() => window.__mount());
  const el = await page.waitForSelector('iframe');
  const frame = await el.contentFrame();
  await frame.waitForLoadState('domcontentloaded');
  const text = () => frame.evaluate(() => document.body.innerText.replace(/\s+/g,' ').trim());
  await page.waitForTimeout(1500);
  console.log('  while resident  :', await text(), '| polls:', hits);
  if (mode === 'game') {
    // A game starts BEFORE the model expires and ends AFTER it: the ticker is cleared for
    // the duration, so the crossing has no witness unless resuming looks for elapsed ones.
    await page.evaluate(() => window.__game(true));
    await page.waitForTimeout(2500);
    console.log('  during the game :', await text(), '| polls:', hits);
    await page.evaluate(() => window.__game(false));
    await page.waitForTimeout(1500);
  } else {
    await page.waitForTimeout(4000);
  }
  const after = await text();
  console.log('  past its unload :', after, '| polls:', hits);
  const stillClaiming = /llama3\.1:8b/.test(after) && hits === 1;
  console.log(stillClaiming
    ? '  FAIL the tile still counts a model Ollama has evicted, and has not asked'
    : '  PASS the eviction was noticed rather than waited out');
  await browser.close();
  process.exitCode = stillClaiming ? 1 : 0;
})();
