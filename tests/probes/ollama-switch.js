#!/usr/bin/env node
// Switching baseUrl: the first server answers with models, the second refuses the
// connection entirely. The tile must not go on showing the FIRST server's models as
// merely stale — they were never sent by the machine now configured.
'use strict';
const fs = require('fs'); const path = require('path');
const SHELL = '/home/user/Waveshare-Widgets/src/Plinth/Shell';
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css' };
const folder = process.argv[2];
const mode = process.argv[3] || 'plain';
function pw(){ for (const c of ['playwright','/opt/node22/lib/node_modules/playwright']) { try { return require(c);} catch(e){} } throw new Error('no playwright'); }
let hitsSecond = 0;
(async () => {
  const { chromium } = pw();
  const shim = fs.readFileSync(path.join(SHELL,'widget-api.js'),'utf8')+'\n'+fs.readFileSync(path.join(SHELL,'icue-compat.js'),'utf8');
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport:{width:640,height:400} });
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
  await page.route(/https?:\/\/(?!(?:app\.plinth|widget\.test|shell\.test)(?:[:/?#]|$)).*/, (r) => {
    const u = r.request().url();
    if (u.includes(':11434')) {
      const m = { name:'llama3.1:8b', model:'llama3.1:8b', size:6108916224, size_vram:6108916224 };
      // ticker mode: a countdown under a minute, so scheduleTicker arms a 1s repaint that
      // is still pending when the address changes.
      if (mode === 'ticker') m.expires_at = new Date(Date.now() + 30000).toISOString();
      return r.fulfill({ status:200, contentType:'application/json',
        headers:{'access-control-allow-origin':'*'}, body: JSON.stringify({ models:[m] }) });
    }
    hitsSecond++;
    if (mode === 'ticker') return;      // the new address hangs: only the ticker can paint
    return r.abort();                   // the second address is simply not there
  });
  await page.addInitScript(shim);
  await page.addInitScript(() => {
    if (window.top !== window) return;
    let frame = null;
    window.__mount = () => { frame = document.createElement('iframe');
      frame.setAttribute('sandbox','allow-scripts allow-same-origin');
      frame.src = 'https://widget.test/index.html#ww-slot=p0s0'; document.body.appendChild(frame); };
    window.__send = (baseUrl, game) => frame.contentWindow.postMessage({ type:'ww-init',
      settings:{ baseUrl, refreshSeconds: 300 }, sensors:[], media:null,
      game: game || {active:false,process:''},
      theme:{'--accent':'#e0a33e'}, status:{elevated:false,apiVersion:1} }, 'https://widget.test');
    window.__gameOff = () => frame.contentWindow.postMessage({ type:'ww-game',
      game:{ active:false, process:'' } }, 'https://widget.test');
    window.addEventListener('message', (ev) => {
      if (!frame || ev.source !== frame.contentWindow || ev.origin !== 'https://widget.test') return;
      const m = ev.data || {};
      if (m.type === 'ww-ready') return window.__send('http://localhost:11434');
      if (m.type === 'ww-game-req') return;
      if (m.type === 'ww-fetch') ev.source.postMessage({ type:'ww-fetch-result', id:m.id, error:'no proxy' }, ev.origin);
    });
  });
  await page.goto('https://shell.test/host.html');
  await page.evaluate(() => window.__mount());
  const el = await page.waitForSelector('iframe');
  const frame = await el.contentFrame();
  await frame.waitForLoadState('domcontentloaded');
  const text = () => frame.evaluate(() => document.body.innerText.replace(/\s+/g,' ').trim());
  await page.waitForTimeout(1800);
  console.log('  first server :', await text());
  if (mode === 'game') {
    // Switch the address WHILE a game is running, then end the game. The new address must
    // be contacted promptly, not after the previous endpoint's interval runs out.
    await page.evaluate(() => window.__send('http://127.0.0.1:9999', { active:true, process:'game.exe' }));
    await page.waitForTimeout(1200);
    console.log('  during game  :', await text(), '| requests to the new address:', hitsSecond);
    const during = hitsSecond;
    await page.evaluate(() => window.__gameOff());
    await page.waitForTimeout(1500);
    console.log('  game ended   :', await text(), '| requests to the new address:', hitsSecond);
    const ok = during === 0 && hitsSecond > 0;
    console.log(ok ? '  PASS the new address was contacted as soon as the game ended'
                   : '  FAIL the switch sat on Loading past the end of the game');
    await browser.close();
    process.exitCode = ok ? 0 : 1;
    return;
  }
  if (mode === 'ticker') {
    // The new address hangs, so nothing but the old countdown timer can repaint the tile.
    await page.evaluate(() => window.__send('http://127.0.0.1:9999'));
    await page.waitForTimeout(3000);
    const after = await text();
    console.log('  after switch :', after);
    const lied = /nothing is resident|GB resident/.test(after);
    console.log(lied ? '  FAIL a stale countdown repainted the tile as an answer from the new address'
                     : '  PASS the retired countdown did not speak for the new address');
    await browser.close();
    process.exitCode = lied ? 1 : 0;
    return;
  }
  await page.evaluate(() => window.__send('http://127.0.0.1:9999'));
  await page.waitForTimeout(2000);
  const after = await text();
  console.log('  after switch :', after);
  const leaked = /llama3\.1:8b/.test(after);
  console.log(leaked ? "  FAIL the first server's models are still on screen after switching address"
                     : '  PASS the previous server\'s answer was retired with its address');
  await browser.close();
  process.exitCode = leaked ? 1 : 0;
})();
