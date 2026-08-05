#!/usr/bin/env node
// The slow branch. slowMs clamps to the manifest's floor of 100, so a stub that answers
// instantly can never exercise it — this one answers after 400ms. A target that replies
// 200 but takes too long must read as slow (amber), not up, and must not read as down.
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
  await page.route(/https?:\/\/(?!(?:app\.wsw|widget\.test|shell\.test)(?:[:/?#]|$)).*/, async (r) => {
    const u = r.request().url();
    if (u.includes('127.0.0.1:9201')) {                 // answers, but only after 400ms
      await new Promise((res) => setTimeout(res, 400));
      return r.fulfill({ status:200, body:'ok', headers:{'access-control-allow-origin':'*'} });
    }
    if (u.includes('127.0.0.1:9202')) return r.fulfill({ status:200, body:'ok', headers:{'access-control-allow-origin':'*'} });
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
        settings:{ intervalSeconds: 15, slowMs: 100, targets:[
          { label:'Molasses', url:'http://127.0.0.1:9201/' },
          { label:'Snappy',   url:'http://127.0.0.1:9202/' } ] },
        sensors:[], media:null,
        theme:{'--accent':'#e0a33e'}, status:{elevated:false,apiVersion:1} }, ev.origin);
    });
  });
  await page.goto('https://shell.test/host.html');
  await page.evaluate(() => window.__mount());
  const el = await page.waitForSelector('iframe');
  const frame = await el.contentFrame();
  await frame.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2500);
  const text = await frame.evaluate(() => document.body.innerText.replace(/\s+/g,' ').trim());
  const classes = await frame.evaluate(() => Array.from(document.querySelectorAll('.target'))
    .map((n) => (n.querySelector('.name')||{}).textContent + '=' + n.className).join(' | '));
  console.log('  ', text);
  console.log('  ', classes);
  const ok = /1 SLOW/.test(text) && /Molasses=target slow/.test(classes)
             && /Snappy=target up/.test(classes) && !/DOWN/.test(text);
  console.log(ok ? '  PASS the late-but-healthy target read as slow, the quick one as up'
                 : '  FAIL the slow branch did not land');
  await browser.close();
  process.exitCode = ok ? 0 : 1;
})();
