#!/usr/bin/env node
// A service that serves the SAME large error page to HEAD and GET. HEAD answers 503, so
// the widget retries as GET; the direct call is CORS-refused, the proxy reads the reply,
// finds it over the cap and refuses it with no status. The oversize handling then had
// nothing but "bytes arrived" to go on and called the box healthy — green, for a service
// that had already said 503 out loud.
//
// mode `unsupported`: the same shape, except HEAD answers 405. That is the method being
// unsupported, not the service's verdict on itself, and it is the exact case the GET
// fallback exists for — so it must NOT be adopted as a failure.
'use strict';
const fs = require('fs'); const path = require('path');
const SHELL = '/home/user/Waveshare-Widgets/src/WaveshareWidgets/Shell';
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css' };
const folder = process.argv[2];
const mode = process.argv[3] || 'error';          // error | unsupported
const HEAD_STATUS = mode === 'unsupported' ? 405 : 503;
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
  await page.route(/https?:\/\/(?!(?:app\.wsw|widget\.test|shell\.test)(?:[:/?#]|$)).*/, (r) => {
    const u = r.request().url();
    // HEAD is answered directly (CORS allowed) so the widget sees its status. The GET is
    // refused at the browser, which is what pushes it onto the host proxy tier below.
    if (u.includes('127.0.0.1:9301')) {
      if (r.request().method() === 'HEAD') return r.fulfill({ status: HEAD_STATUS, body:'',
        headers:{'access-control-allow-origin':'*'} });
      return r.abort();
    }
    if (u.includes('127.0.0.1:9302')) return r.fulfill({ status:200, body:'ok', headers:{'access-control-allow-origin':'*'} });
    return r.abort();
  });
  await page.addInitScript(shim);
  await page.addInitScript((headStatus) => {
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
        settings:{ intervalSeconds: 15, targets:[
          { label:'Sick', url:'http://127.0.0.1:9301/' },
          { label:'Good', url:'http://127.0.0.1:9302/' } ] },
        sensors:[], media:null,
        theme:{'--accent':'#e0a33e'}, status:{elevated:false,apiVersion:1} }, ev.origin);
      if (m.type === 'ww-fetch') {
        // Verbatim from DashboardWindow.ReadCappedAsync's refusal: an error, and no status,
        // because the body is read and capped before the status is recorded.
        if (String(m.url||'').includes('9301')) return ev.source.postMessage({ type:'ww-fetch-result',
          id:m.id, error:'response too large: 102400 bytes exceeds 65536' }, ev.origin);
        if (String(m.url||'').includes('9302')) return ev.source.postMessage({ type:'ww-fetch-result',
          id:m.id, status:200, statusText:'OK', contentType:'text/plain', bodyBase64:'b2s=' }, ev.origin);
      }
    });
  }, HEAD_STATUS);
  await page.goto('https://shell.test/host.html');
  await page.evaluate(() => window.__mount());
  const el = await page.waitForSelector('iframe');
  const frame = await el.contentFrame();
  await frame.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(3000);
  const text = await frame.evaluate(() => document.body.innerText.replace(/\s+/g,' ').trim());
  const classes = await frame.evaluate(() => Array.from(document.querySelectorAll('.target'))
    .map((n) => (n.querySelector('.name')||{}).textContent + '=' + n.className).join(' | '));
  console.log('  ', text);
  console.log('  ', classes);
  let ok, why;
  if (mode === 'unsupported') {
    ok = /Sick=target (up|slow)/.test(classes) && /too large/.test(text);
    why = ok ? 'PASS a 405 on HEAD is the method, not the service — still counted as reached'
             : 'FAIL a 405 on HEAD was adopted as the service failing';
  } else {
    ok = /Sick=target down/.test(classes) && /503/.test(text) && /1 DOWN/.test(text);
    why = ok ? 'PASS the 503 HEAD already gave survived the unreadable GET'
             : 'FAIL a service that answered 503 is shown as reached and healthy';
  }
  console.log('  ' + why);
  await browser.close();
  process.exitCode = ok ? 0 : 1;
})();
