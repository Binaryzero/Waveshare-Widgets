#!/usr/bin/env node
// Does the unload countdown actually count? A model expiring ~40s out, a 300-second poll
// interval, and four seconds of watching: the poll cannot explain any change, so any
// change is the local ticker.
'use strict';
const fs = require('fs'); const path = require('path');
const SHELL = '/home/user/Waveshare-Widgets/src/WaveshareWidgets/Shell';
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css' };
const folder = process.argv[2];
function pw(){ for (const c of ['playwright','/opt/node22/lib/node_modules/playwright']) { try { return require(c);} catch(e){} } throw new Error('no playwright'); }
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
  let hits = 0;
  await page.route(/https?:\/\/(?!(?:app\.wsw|widget\.test|shell\.test)(?:[:/?#]|$)).*/, (r) => {
    if (!r.request().url().includes('11434')) return r.abort();
    hits++;
    // Expiry is stamped when the request arrives, so the countdown starts near 40s.
    return r.fulfill({ status:200, contentType:'application/json', headers:{'access-control-allow-origin':'*'},
      body: JSON.stringify({ models:[{ name:'llama3.1:8b', model:'llama3.1:8b', size:6108916224,
        size_vram:6108916224, expires_at:new Date(Date.now()+40000).toISOString() }] }) });
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
        settings:{ refreshSeconds: 300 }, sensors:[], media:null, game:{active:false,process:''},
        theme:{'--accent':'#e0a33e'}, status:{elevated:false,apiVersion:1} }, ev.origin);
      if (m.type === 'ww-fetch') ev.source.postMessage({ type:'ww-fetch-result', id:m.id, error:'no proxy' }, ev.origin);
    });
  });
  await page.goto('https://shell.test/host.html');
  await page.evaluate(() => window.__mount());
  const el = await page.waitForSelector('iframe');
  const frame = await el.contentFrame();
  await frame.waitForLoadState('domcontentloaded');
  const readTtl = () => frame.evaluate(() => (document.querySelector('.ttl') || {}).textContent || '(none)');
  await page.waitForTimeout(1500);
  const first = await readTtl();
  await page.waitForTimeout(4000);
  const later = await readTtl();
  console.log('  countdown at t+1.5s:', first, '| at t+5.5s:', later, '| feed requests:', hits);
  const ok = first !== '(none)' && later !== '(none)' && first !== later && hits === 1;
  console.log(ok ? '  PASS the countdown advanced with no new poll to explain it'
                 : '  FAIL the countdown is a screenshot, not a countdown');
  await browser.close();
  process.exitCode = ok ? 0 : 1;
})();
