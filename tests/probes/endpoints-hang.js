#!/usr/bin/env node
// One target accepts the connection and then goes silent. The widget's own claim is that
// a hung box delays only its OWN next check — so that target's tile must reach a verdict
// and its chain must keep going, while the healthy targets are unaffected throughout.
'use strict';
const fs = require('fs'); const path = require('path');
const SHELL = '/home/user/Waveshare-Widgets/src/WaveshareWidgets/Shell';
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css' };
const folder = process.argv[2];
const mode = process.argv[3] || 'hang';
function pw(){ for (const c of ['playwright','/opt/node22/lib/node_modules/playwright']) { try { return require(c);} catch(e){} } throw new Error('no playwright'); }
let hungHits = 0, okHits = 0;
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
    // oversize: a CORS-blocked LAN web interface. The DIRECT call is refused, so WW.fetch
    // escalates to the host proxy — which is where the defect lives: DashboardWindow reads
    // and caps the body BEFORE it records a status, so an over-cap reply comes back as an
    // error with no status at all. The shell below answers with exactly that shape.
    if (mode === 'oversize' && u.includes('127.0.0.1:9101')) { hungHits++; return r.abort(); }
    if (u.includes('127.0.0.1:9101')) { hungHits++; return; }          // accepted, never answers
    if (u.includes('127.0.0.1:9102')) { okHits++;
      return r.fulfill({ status:200, body:'ok', headers:{'access-control-allow-origin':'*'} }); }
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
        settings:{ intervalSeconds: 15, targets:[
          { label:'Hung', url:'http://127.0.0.1:9101/' },
          { label:'Good', url:'http://127.0.0.1:9102/' } ] },
        sensors:[], media:null,
        theme:{'--accent':'#e0a33e'}, status:{elevated:false,apiVersion:1} }, ev.origin);
      // No host proxy in this probe: the direct tier is what hangs, and that is the point.
      if (m.type === 'ww-fetch') {
        if (window.__oversize && String(m.url||'').includes('9101')) {
          // Verbatim from DashboardWindow.ReadCappedAsync's refusal: an error, no status.
          return ev.source.postMessage({ type:'ww-fetch-result', id:m.id,
            error:'response too large: 102400 bytes exceeds 65536' }, ev.origin);
        }
        if (String(m.url||'').includes('9102')) ev.source.postMessage({ type:'ww-fetch-result', id:m.id,
          status:200, statusText:'OK', contentType:'text/plain', bodyBase64:'b2s=' }, ev.origin);
      }
    });
  });
  if (mode === 'game') await page.addInitScript(() => { window.__g = true; });
  if (mode === 'oversize') await page.addInitScript(() => { window.__oversize = true; });
  await page.goto('https://shell.test/host.html');
  await page.evaluate(() => window.__mount());
  const el = await page.waitForSelector('iframe');
  const frame = await el.contentFrame();
  await frame.waitForLoadState('domcontentloaded');
  const text = () => frame.evaluate(() => document.body.innerText.replace(/\s+/g,' ').trim());
  if (mode === 'game') {
    await page.waitForTimeout(2500);
    console.log('  during game :', await text(), '| probes to the healthy target:', okHits);
    const during = okHits;
    await page.evaluate(() => window.__gameOff());
    await page.waitForTimeout(1500);
    console.log('  game ended  :', await text(), '| probes to the healthy target:', okHits);
    const ok = during === 0 && okHits > 0;
    console.log(ok ? '  PASS probing was suspended for the game and resumed when it ended'
                   : '  FAIL the grid probed straight through a running game');
    await browser.close();
    process.exitCode = ok ? 0 : 1;
    return;
  }
  if (mode === 'oversize') {
    await page.waitForTimeout(3000);
    const t = await text();
    console.log('  ', t);
    const wrong = /unreachable/.test(t) || /1 DOWN/.test(t);
    console.log(wrong ? '  FAIL a server that answered with a large page is reported unreachable'
                      : '  PASS the oversized reply counted as reached');
    await browser.close();
    process.exitCode = wrong ? 1 : 0;
    return;
  }
  await page.waitForTimeout(3000);
  console.log('  at t+3s  :', await text());
  await page.waitForTimeout(9500);          // PROBE_DEADLINE is 10s
  const after = await text();
  console.log('  at t+12s :', after);
  const stuck = /checking…/.test(after);
  console.log(stuck ? '  FAIL the hung target never reached a verdict — its chain is dead'
                    : '  PASS the hung target was cut off and reported unreachable');
  await browser.close();
  process.exitCode = stuck ? 1 : 0;
})();
