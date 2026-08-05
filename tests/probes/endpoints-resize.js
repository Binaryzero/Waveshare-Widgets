#!/usr/bin/env node
// The on-panel editor changes a slot's width by resizing the iframe in place — there is no
// second ww-init. Three targets: two columns at half, three at full, and the change must
// follow the resize rather than the next rebuild.
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
  await page.route(/https?:\/\/(?!(?:app\.wsw|widget\.test|shell\.test)(?:[:/?#]|$)).*/, (r) =>
    r.fulfill({ status:200, body:'ok', headers:{'access-control-allow-origin':'*'} }));
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
        settings:{ intervalSeconds: 900, targets:[
          { label:'A', url:'http://a.lan/' }, { label:'B', url:'http://b.lan/' }, { label:'C', url:'http://c.lan/' } ] },
        sensors:[], media:null, game:{active:false,process:''},
        theme:{'--accent':'#e0a33e'}, status:{elevated:false,apiVersion:1} }, ev.origin);
      if (m.type === 'ww-fetch') ev.source.postMessage({ type:'ww-fetch-result', id:m.id,
        status:200, statusText:'OK', contentType:'text/plain', bodyBase64:'b2s=' }, ev.origin);
    });
  });
  await page.goto('https://shell.test/host.html');
  await page.evaluate(() => window.__mount());
  const el = await page.waitForSelector('iframe');
  const frame = await el.contentFrame();
  await frame.waitForLoadState('domcontentloaded');
  const cols = () => frame.evaluate(() => {
    const t = getComputedStyle(document.getElementById('grid')).gridTemplateColumns;
    return String(t).trim().split(/\s+/).length;
  });
  await page.waitForTimeout(1500);
  const atHalf = await cols();
  // The slot is widened in place, exactly as the on-panel editor does it.
  await page.setViewportSize({ width: 1280, height: 400 });
  await page.waitForTimeout(800);
  const atFull = await cols();
  console.log('  columns at half (640px):', atHalf, '| after widening to full (1280px):', atFull);
  const ok = atHalf === 2 && atFull === 3;
  console.log(ok ? '  PASS the grid re-laid itself out when the slot was resized'
                 : '  FAIL the column count is frozen at whatever the first build saw');
  await browser.close();
  process.exitCode = ok ? 0 : 1;
})();
