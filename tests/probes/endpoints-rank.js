#!/usr/bin/env node
// A band that fits three cards, six targets: four SLOW ones configured first, then one
// DOWN, then a healthy one. Down and slow shared a rank, so configuration order handed
// every card to a yellow tile and the dead box stayed nameless behind a "1 down" pill —
// the same hole the ranking was added to close, one severity level down.
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
  const page = await browser.newPage({ viewport:{width:640,height:200} });   // a band: few rows
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
    if (/9401|9402|9403|9404/.test(u)) {            // answers, but late — slow
      await new Promise((res) => setTimeout(res, 300));
      return r.fulfill({ status:200, body:'ok', headers:{'access-control-allow-origin':'*'} });
    }
    if (u.includes('9405')) return r.abort();       // refused outright — down
    if (u.includes('9406')) return r.fulfill({ status:200, body:'ok', headers:{'access-control-allow-origin':'*'} });
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
          { label:'Slow1', url:'http://127.0.0.1:9401/' },
          { label:'Slow2', url:'http://127.0.0.1:9402/' },
          { label:'Slow3', url:'http://127.0.0.1:9403/' },
          { label:'Slow4', url:'http://127.0.0.1:9404/' },
          { label:'DEAD',  url:'http://127.0.0.1:9405/' },
          { label:'Fine',  url:'http://127.0.0.1:9406/' } ] },
        sensors:[], media:null,
        theme:{'--accent':'#e0a33e'}, status:{elevated:false,apiVersion:1} }, ev.origin);
      // The refused direct call escalates to the host proxy, which cannot reach a dead box
      // either. Without this the probe just hangs to the 10s deadline and the grid sits on
      // "checking" — which is a different bug being observed, not this one.
      if (m.type === 'ww-fetch') return ev.source.postMessage({ type:'ww-fetch-result',
        id:m.id, error:'connection refused' }, ev.origin);
    });
  });
  await page.goto('https://shell.test/host.html');
  await page.evaluate(() => window.__mount());
  const el = await page.waitForSelector('iframe');
  const frame = await el.contentFrame();
  await frame.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(3000);
  const text = await frame.evaluate(() => document.body.innerText.replace(/\s+/g,' ').trim());
  const shown = await frame.evaluate(() => Array.from(document.querySelectorAll('.target .name')).map((n) => n.textContent));
  console.log('  ', text);
  console.log('   cards on screen:', JSON.stringify(shown));
  const ok = shown.includes('DEAD') && /1 DOWN/.test(text) && shown.length < 6;
  console.log(ok ? '  PASS the dead box got one of the scarce cards, ahead of the slow ones'
                 : '  FAIL the pill says a box is down and no card names it');
  await browser.close();
  process.exitCode = ok ? 0 : 1;
})();
