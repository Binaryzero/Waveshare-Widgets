#!/usr/bin/env node
// Codex round 2 on #174. Modes:
//   plaintext  an http:// token endpoint. The widget lives on https, so the direct POST
//              is mixed-content blocked — but WW.fetch reads that as "the browser is in
//              the way" and escalates to the host proxy, which accepts http and forwards
//              Authorization. The client secret leaves the machine in the clear.
//   loopback   the same shape against http://127.0.0.1. Potentially trustworthy, never
//              blocked, never escalated, never leaves the PC — this must KEEP working.
//   cachekey   two OAuth identities on one origin (one localStorage). A single cache
//              entry meant the second tile's exchange overwrote the first's, so the
//              first re-authenticated on every reload.
//   onebudget  a slow token exchange followed by a slow data request. Per-leg deadlines
//              let a tile documented to give up after `budget` stay frozen for 2x that.
//   retryerr   401 -> forced exchange SUCCEEDS -> the retried request dies. The retry sat
//              inside the sign-in try, so this was reported as a credential problem.
'use strict';
const fs = require('fs'); const path = require('path');
const SHELL = '/home/user/Waveshare-Widgets/src/Plinth/Shell';
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css' };
const folder = process.argv[2];
const mode = process.argv[3] || 'plaintext';
function pw(){ for (const c of ['playwright','/opt/node22/lib/node_modules/playwright']) { try { return require(c);} catch(e){} } throw new Error('no playwright'); }

let tokenHits = 0, dataHits = 0;
const tokenBy = [];         // which clientId each exchange was for
const proxied = [];         // { url, hasAuth } for every request that reached the host tier
const SLOW = 7000;          // both slow legs; budget floors at 10s

(async () => {
  const { chromium } = pw();
  const shim = fs.readFileSync(path.join(SHELL,'widget-api.js'),'utf8')+'\n'+fs.readFileSync(path.join(SHELL,'icue-compat.js'),'utf8');
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport:{width:640,height:400} });
  await page.exposeFunction('__proxied', (rec) => { proxied.push(rec); });
  await page.route('https://app.plinth/**', (r) => {
    const f = path.resolve(SHELL, decodeURIComponent(new URL(r.request().url()).pathname).replace(/^\/+/,''));
    return fs.existsSync(f) ? r.fulfill({ contentType: MIME[path.extname(f)]||'text/plain', body: fs.readFileSync(f) }) : r.fulfill({status:404,body:''});
  });
  await page.route('https://widget.test/**', (r) => {
    const f = path.resolve(folder, decodeURIComponent(new URL(r.request().url()).pathname).replace(/^\/+/,'')||'index.html');
    return fs.existsSync(f)&&fs.statSync(f).isFile() ? r.fulfill({ contentType: MIME[path.extname(f)]||'text/plain', body: fs.readFileSync(f) }) : r.fulfill({status:404,body:''});
  });
  await page.route('https://shell.test/**', (r) => r.fulfill({ contentType:'text/html',
    body:'<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}iframe{display:block;border:0;width:100vw;height:33vh}</style>' }));
  const CORS = { 'access-control-allow-origin':'*', 'access-control-allow-headers':'*' };
  const JSONH = { ...CORS, 'content-type':'application/json' };
  await page.route(/https?:\/\/(?!(?:app\.plinth|widget\.test|shell\.test)(?:[:/?#]|$)).*/, async (r) => {
    const u = r.request().url();
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status:204, headers: CORS });
    if (u.includes('/token')) {
      tokenHits++;
      // The Basic value names the client; record WHO each exchange was for.
      const auth = r.request().headers().authorization || '';
      let who = '?';
      try { who = Buffer.from(auth.replace(/^Basic\s+/i,''), 'base64').toString('utf8').split(':')[0]; } catch (e) {}
      tokenBy.push(who);
      // A direct hit means the browser did NOT block it — record it the same way the
      // proxy tier is recorded, so "did the credential leave" is one question.
      proxied.push({ url: u, hasAuth: !!auth, tier: 'direct' });
      if (mode === 'onebudget') await new Promise((res) => setTimeout(res, SLOW));
      return r.fulfill({ status:200, headers: JSONH,
        body: JSON.stringify({ access_token:'tok' + tokenHits, token_type:'bearer', expires_in:86399 }) });
    }
    if (u.includes('api.example/value')) {
      dataHits++;
      if (mode === 'retryerr') {
        if (dataHits === 1) return r.fulfill({ status:401, headers: JSONH, body: JSON.stringify({ error:'expired' }) });
        return r.abort();                       // the RETRY dies at the network
      }
      if (mode === 'onebudget') await new Promise((res) => setTimeout(res, SLOW));
      return r.fulfill({ status:200, headers: JSONH, body: JSON.stringify({ price: 42 }) });
    }
    return r.abort();
  });

  const base = {
    url: 'https://api.example/value', jsonPointer: '/price', label: 'Tile', decimals: 0,
    pollSeconds: 5, authMode: 'oauth2',
    tokenEndpoint: 'https://oauth.example/token', clientId: 'cid', clientSecret: 'csec', scope: '',
  };
  if (mode === 'plaintext') base.tokenEndpoint = 'http://plain.example/token';
  if (mode === 'loopback')  base.tokenEndpoint = 'http://127.0.0.1:8123/token';

  await page.addInitScript(shim);
  await page.addInitScript(() => {
    if (window.top !== window) return;
    const frames = [];
    window.__mount = (settings) => {
      const f = document.createElement('iframe');
      f.setAttribute('sandbox','allow-scripts allow-same-origin');
      f.src = 'https://widget.test/index.html#ww-slot=p0s' + frames.length;
      f.__settings = settings;
      document.body.appendChild(f); frames.push(f); return frames.length - 1;
    };
    window.addEventListener('message', (ev) => {
      const f = frames.find((x) => x.contentWindow === ev.source);
      if (!f || ev.origin !== 'https://widget.test') return;
      const m = ev.data || {};
      if (m.type === 'ww-ready') return ev.source.postMessage({ type:'ww-init',
        game:{active:false,process:''}, settings: f.__settings, sensors:[], media:null,
        theme:{'--accent':'#e0a33e'}, status:{elevated:false,apiVersion:1} }, ev.origin);
      if (m.type === 'ww-fetch') {
        // This is the host tier. Anything arriving here was NOT sent by the browser —
        // it is the escalation, and it carries whatever headers the widget chose.
        const h = m.headers || {};
        const hasAuth = Object.keys(h).some((k) => k.toLowerCase() === 'authorization');
        window.__proxied({ url: String(m.url || ''), hasAuth, tier: 'proxy' });
        return ev.source.postMessage({ type:'ww-fetch-result', id:m.id, error:'no route to host' }, ev.origin);
      }
    });
  });
  await page.goto('https://shell.test/host.html');

  // "Has this tile stopped loading?" — a value on screen, or a titled card.
  const settledState = async (i) => {
    const fr = (await (await page.$$('iframe'))[i].contentFrame());
    if (!fr) return null;
    return await fr.evaluate(() => {
      const body = document.getElementById('body'), title = document.getElementById('stateTitle');
      if (body && !body.hidden) return { kind:'value', text: (document.getElementById('value')||{}).textContent || '' };
      if (title && !title.hidden) return { kind:'card', text: title.textContent || '' };
      return null;
    }).catch(() => null);
  };
  const waitSettled = async (i, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const s = await settledState(i);
      if (s) return { ...s, at: Date.now() - t0 };
      await page.waitForTimeout(200);
    }
    return null;
  };

  let ok = false;
  if (mode === 'plaintext' || mode === 'loopback') {
    await page.evaluate((s) => window.__mount(s), base);
    const settled = await waitSettled(0, 12000);
    const host = mode === 'plaintext' ? 'plain.example' : '127.0.0.1';
    const leaked = proxied.filter((p) => p.url.includes(host) && p.hasAuth);
    console.log('   settled:', JSON.stringify(settled), '| exchanges:', tokenHits);
    console.log('   requests carrying a credential to ' + host + ':',
      JSON.stringify(proxied.filter((p) => p.url.includes(host))));
    if (mode === 'plaintext') {
      ok = leaked.length === 0 && !!settled && settled.kind === 'card' && /insecure/i.test(settled.text);
      console.log(ok ? '  PASS refused before the request; the client secret never left'
                     : '  FAIL the client secret was sent over plaintext http');
    } else {
      ok = tokenHits >= 1 && !!settled && settled.kind === 'value' && settled.text.trim() === '42';
      console.log(ok ? '  PASS loopback is still allowed to authenticate'
                     : '  FAIL the loopback exception is broken — a local token endpoint is refused');
    }
  } else if (mode === 'cachekey') {
    // Two DIFFERENT identities, then a fresh frame for the first one. A fresh frame is a
    // reload: module state is empty, so it can only answer from localStorage.
    await page.evaluate((s) => window.__mount(s), { ...base, clientId: 'alpha' });
    await page.waitForTimeout(2500);
    await page.evaluate((s) => window.__mount(s), { ...base, clientId: 'beta' });
    await page.waitForTimeout(2500);
    const before = tokenHits;
    await page.evaluate((s) => window.__mount(s), { ...base, clientId: 'alpha' });
    await page.waitForTimeout(2500);
    console.log('   exchanges after the two tiles:', before, '| after alpha reloads:', tokenHits);
    console.log('   who exchanged, in order:', JSON.stringify(tokenBy));
    ok = before === 2 && tokenHits === 2;
    console.log(ok ? '  PASS both identities are cached; the reload reused alpha\'s token'
                   : '  FAIL one entry per origin — the second identity evicted the first');
  } else if (mode === 'onebudget') {
    // pollSeconds 5 -> budget floors at 10s. Each leg sleeps 7s, so a per-leg deadline
    // lets the pair run 14s; one absolute deadline must cut it at ~10s.
    await page.evaluate((s) => window.__mount(s), base);
    const settled = await waitSettled(0, 25000);
    console.log('   settled:', JSON.stringify(settled), '| budget 10000ms, two 7000ms legs');
    ok = !!settled && settled.at <= 12000;
    console.log(ok ? '  PASS the whole authenticated poll honoured one deadline'
                   : '  FAIL each leg got its own full budget, so the tile froze past the cap');
  } else if (mode === 'retryerr') {
    await page.evaluate((s) => window.__mount(s), base);
    const settled = await waitSettled(0, 15000);
    console.log('   settled:', JSON.stringify(settled), '| exchanges:', tokenHits, '| data calls:', dataHits);
    ok = !!settled && settled.kind === 'card' && !/sign-in/i.test(settled.text);
    console.log(ok ? '  PASS a dead retry is reported as an endpoint failure, not a bad credential'
                   : '  FAIL a working credential was blamed for the request dying');
  }
  await browser.close();
  process.exitCode = ok ? 0 : 1;
})();
