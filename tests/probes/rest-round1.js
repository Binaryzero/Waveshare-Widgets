#!/usr/bin/env node
// Codex round 1 on #174. Modes:
//   cachekeep   two REST tiles on one origin, both OAuth. The cache is meant to survive
//               so the second reuses the first's token — but `cfg` still holds the
//               none/empty defaults when prevAuth is captured, so applying saved settings
//               always looked like a credential EDIT and wiped the cache first. Every tile
//               and every reload bought a fresh exchange.
//   dupauth     a legacy tile whose custom header is spelled `authorization` switched to
//               OAuth. Object keys are case-sensitive, HTTP header names are not, so both
//               survived and were combined into `Bearer old, Bearer new`.
//   retarget    the tile is retargeted while the forced post-401 exchange is pending. That
//               catch had no generation check, so the old source's rejection charged the
//               new source's backoff and painted "Sign-in failed" over it.
'use strict';
const fs = require('fs'); const path = require('path');
const SHELL = '/home/user/Waveshare-Widgets/src/WaveshareWidgets/Shell';
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css' };
const folder = process.argv[2];
const mode = process.argv[3] || 'cachekeep';
function pw(){ for (const c of ['playwright','/opt/node22/lib/node_modules/playwright']) { try { return require(c);} catch(e){} } throw new Error('no playwright'); }
let tokenHits = 0, dataHits = 0, hangToken = false;
const otherAt = [];
const authSeen = [];
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
    body:'<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}iframe{display:block;border:0;width:100vw;height:50vh}</style>' }));
  const CORS = { 'access-control-allow-origin':'*', 'access-control-allow-headers':'*' };
  const JSONH = { ...CORS, 'content-type':'application/json' };
  await page.route(/https?:\/\/(?!(?:app\.wsw|widget\.test|shell\.test)(?:[:/?#]|$)).*/, async (r) => {
    const u = r.request().url();
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status:204, headers: CORS });
    if (u.includes('oauth.example/token')) {
      tokenHits++;
      if (hangToken) return;                 // accepted, never answers
      return r.fulfill({ status:200, headers: JSONH,
        body: JSON.stringify({ access_token:'tok' + tokenHits, token_type:'bearer', expires_in:86399 }) });
    }
    if (u.includes('api.example/value')) {
      dataHits++;
      // Record exactly what the API was asked to accept as credentials.
      const h = r.request().headers();
      authSeen.push(h.authorization === undefined ? '(none)' : h.authorization);
      if (mode === 'retarget' && dataHits === 1) {
        return r.fulfill({ status:401, headers: JSONH, body: JSON.stringify({ error:'expired' }) });
      }
      return r.fulfill({ status:200, headers: JSONH, body: JSON.stringify({ price: 42 }) });
    }
    if (u.includes('api.example/other')) {
      otherAt.push(Date.now());
      return r.fulfill({ status:200, headers: JSONH, body: JSON.stringify({ price: 99 }) });
    }
    return r.abort();
  });
  const oauth = {
    url: 'https://api.example/value', jsonPointer: '/price', label: 'Tile', decimals: 0,
    pollSeconds: 5,
    authMode: 'oauth2', tokenEndpoint: 'https://oauth.example/token',
    clientId: 'cid', clientSecret: 'csec', scope: '',
  };
  if (mode === 'dupauth') { oauth.headerName = 'authorization'; oauth.headerValue = 'Bearer legacy'; }
  await page.addInitScript(shim);
  await page.addInitScript((s) => {
    if (window.top !== window) return;
    const frames = [];
    window.__settings = s;
    window.__mount = (n) => {
      const f = document.createElement('iframe');
      f.setAttribute('sandbox','allow-scripts allow-same-origin');
      f.src = 'https://widget.test/index.html#ww-slot=p0s' + n;
      document.body.appendChild(f); frames.push(f); return f;
    };
    window.__retarget = () => {
      window.__settings = Object.assign({}, window.__settings, { url: 'https://api.example/other' });
      for (const f of frames) f.contentWindow.postMessage({ type:'ww-init',
        game:{active:false,process:''}, settings: window.__settings, sensors:[], media:null,
        theme:{'--accent':'#e0a33e'}, status:{elevated:false,apiVersion:1} }, 'https://widget.test');
    };
    window.addEventListener('message', (ev) => {
      const f = frames.find((x) => x.contentWindow === ev.source);
      if (!f || ev.origin !== 'https://widget.test') return;
      const m = ev.data || {};
      if (m.type === 'ww-ready') return ev.source.postMessage({ type:'ww-init',
        game:{active:false,process:''}, settings: window.__settings, sensors:[], media:null,
        theme:{'--accent':'#e0a33e'}, status:{elevated:false,apiVersion:1} }, ev.origin);
      if (m.type === 'ww-fetch') return ev.source.postMessage({ type:'ww-fetch-result', id:m.id,
        error:'no route to host' }, ev.origin);
    });
  }, oauth);
  await page.goto('https://shell.test/host.html');

  if (mode === 'cachekeep') {
    await page.evaluate(() => window.__mount(0));
    await page.waitForTimeout(2500);
    const afterFirst = tokenHits;
    // A SECOND tile on the same origin. It shares localStorage, and the cached token is
    // valid for the same endpoint/client/scope, so it must reuse rather than re-exchange.
    await page.evaluate(() => window.__mount(1));
    await page.waitForTimeout(2500);
    console.log('   token exchanges — after the first tile:', afterFirst, '| after the second:', tokenHits);
    const ok = afterFirst === 1 && tokenHits === 1;
    console.log(ok ? '  PASS the second tile reused the cached token'
                   : '  FAIL the cache is wiped on every init, so every tile buys its own exchange');
    await browser.close(); process.exitCode = ok ? 0 : 1; return;
  }

  if (mode === 'dupauth') {
    await page.evaluate(() => window.__mount(0));
    await page.waitForTimeout(3000);
    console.log('   Authorization the API actually received:', JSON.stringify(authSeen));
    const combined = authSeen.some((v) => /,/.test(v) || /legacy/.test(v));
    const ok = authSeen.length > 0 && !combined;
    console.log(ok ? '  PASS exactly one bearer was sent; the legacy header was replaced'
                   : '  FAIL the legacy and OAuth credentials were combined into one header');
    await browser.close(); process.exitCode = ok ? 0 : 1; return;
  }

  // retarget: first data call 401s, the forced exchange hangs, the tile is retargeted.
  hangToken = false;
  await page.evaluate(() => window.__mount(0));
  await page.waitForTimeout(2500);            // first exchange + first data call (401)
  hangToken = true;                           // the FORCED exchange will hang
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__retarget());
  await page.waitForTimeout(4000);
  // The card itself is TRANSIENT — the new source's own poll lands moments later and
  // paints over it, so sampling the text catches the defect only by luck. The durable
  // harm is the backoff: the retired rejection increments `failures` for the new source,
  // which doubles its next interval. With pollSeconds at 5 that is 10s instead of 5s,
  // and the gap between the new endpoint's polls measures it directly.
  await page.waitForTimeout(14000);
  const gaps = otherAt.slice(1).map((t, i) => t - otherAt[i]);
  console.log('   polls of the NEW endpoint:', otherAt.length, '| gaps (ms):', gaps.join(', '));
  if (gaps.length < 1) {
    console.log('  SETUP FAILED — the new endpoint was not polled twice; nothing to measure');
    await browser.close(); process.exitCode = 2; return;
  }
  const ok = gaps[0] < 8000;
  console.log(ok ? '  PASS the retired exchange did not charge the new source a failure'
                 : '  FAIL the new source was put on a backed-off cadence it never earned');
  await browser.close();
  process.exitCode = ok ? 0 : 1;
})();
