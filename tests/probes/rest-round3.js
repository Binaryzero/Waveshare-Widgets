#!/usr/bin/env node
// Codex round 3 on #174. Modes:
//   noneheader  a tile with a static auth header, switched to Authentication = none.
//               The header was sent regardless of authMode, so "none" disabled nothing.
//   legacy      the SAME tile as it exists in the field: header filled in, no authMode
//               stored at all. shell.js merges the manifest default, so this is the case
//               the fix must not break — it must still send the header.
//   shortlife   a token endpoint issuing expires_in=60. A fixed 60s freshness margin
//               rejects every token the instant it arrives, so the cache re-exchanges
//               on every poll instead of reusing a token that is still valid.
//   nosecret    OAuth selected, client secret empty (exactly what the settings preview
//               is handed). The exchange went out anyway, spending a failed
//               authentication against the real service on every poll.
//   clockstep   the wall clock steps BACKWARD mid-poll (a manual correction, a stepped
//               NTP sync). A deadline measured with Date.now() gains exactly the size of
//               the correction, so the cap it exists to enforce is extended by it.
'use strict';
const fs = require('fs'); const path = require('path');
const SHELL = '/home/user/Waveshare-Widgets/src/WaveshareWidgets/Shell';
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css' };
const folder = process.argv[2];
const mode = process.argv[3] || 'noneheader';
function pw(){ for (const c of ['playwright','/opt/node22/lib/node_modules/playwright']) { try { return require(c);} catch(e){} } throw new Error('no playwright'); }

let tokenHits = 0;
const dataAuth = [];        // every credential the DATA endpoint was offered

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
  const CORS = { 'access-control-allow-origin':'*', 'access-control-allow-headers':'*' };
  const JSONH = { ...CORS, 'content-type':'application/json' };
  await page.route(/https?:\/\/(?!(?:app\.wsw|widget\.test|shell\.test)(?:[:/?#]|$)).*/, async (r) => {
    const u = r.request().url();
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status:204, headers: CORS });
    if (u.includes('/token')) {
      tokenHits++;
      if (mode === 'clockstep') await new Promise((res) => setTimeout(res, 7000));
      return r.fulfill({ status:200, headers: JSONH, body: JSON.stringify({
        access_token:'tok' + tokenHits, token_type:'bearer',
        // A COMPLIANT short-lived token. 60s is inside the fixed margin, so the old
        // code could never consider it fresh — not even one second after issuing it.
        expires_in: mode === 'shortlife' ? 60 : 86399 }) });
    }
    if (u.includes('api.example/value')) {
      // clockstep: both legs are slow, so the deadline is what decides the outcome.
      if (mode === 'clockstep') await new Promise((res) => setTimeout(res, 7000));
      const h = r.request().headers();
      dataAuth.push(h['x-api-key'] !== undefined ? 'x-api-key:' + h['x-api-key']
        : h.authorization !== undefined ? 'authorization:' + h.authorization : '(none)');
      return r.fulfill({ status:200, headers: JSONH, body: JSON.stringify({ price: 42 }) });
    }
    return r.abort();
  });

  // The legacy field tile: a static header, and NO authMode key at all. shell.js seeds
  // the manifest default before overlaying stored settings, so replicate that exactly —
  // read the default out of the manifest under test rather than assuming it.
  const manifest = JSON.parse(fs.readFileSync(path.join(folder,'manifest.json'),'utf8'));
  const defaults = {};
  for (const p of manifest.properties || []) if (p.name) defaults[p.name] = p.default;

  const stored = { url: 'https://api.example/value', jsonPointer: '/price', label: 'Tile',
    decimals: 0, pollSeconds: 5 };
  if (mode === 'noneheader' || mode === 'legacy') {
    stored.headerName = 'X-Api-Key';
    stored.headerValue = 'secret-key-123';
    // `legacy` stores NO authMode — the whole point. `noneheader` stores the explicit choice.
    if (mode === 'noneheader') stored.authMode = 'none';
  } else {
    Object.assign(stored, { authMode:'oauth2', tokenEndpoint:'https://oauth.example/token',
      clientId:'cid', clientSecret: mode === 'nosecret' ? '' : 'csec', scope:'' });
  }
  const settings = Object.assign({}, defaults, stored);

  if (mode === 'clockstep') {
    // Step the WALL clock back 60s, once, shortly after the poll starts — and leave
    // performance.now() alone, because a real clock correction does exactly that.
    // Anything measuring elapsed time with Date.now() gains the whole 60s.
    await page.addInitScript(() => {
      const real = Date.now;
      const started = real();
      let shifted = false;
      Date.now = function () {
        const t = real();
        if (!shifted && t - started > 2500) shifted = true;
        return shifted ? t - 60000 : t;
      };
    });
  }

  await page.addInitScript(shim);
  await page.addInitScript((s) => {
    if (window.top !== window) return;
    let frame = null;
    window.__mount = () => { frame = document.createElement('iframe');
      frame.setAttribute('sandbox','allow-scripts allow-same-origin');
      frame.src = 'https://widget.test/index.html#ww-slot=p0s0'; document.body.appendChild(frame); };
    window.addEventListener('message', (ev) => {
      if (!frame || ev.source !== frame.contentWindow || ev.origin !== 'https://widget.test') return;
      const m = ev.data || {};
      if (m.type === 'ww-ready') return ev.source.postMessage({ type:'ww-init',
        game:{active:false,process:''}, settings: s, sensors:[], media:null,
        theme:{'--accent':'#e0a33e'}, status:{elevated:false,apiVersion:1} }, ev.origin);
      if (m.type === 'ww-fetch') return ev.source.postMessage({ type:'ww-fetch-result', id:m.id,
        error:'no route to host' }, ev.origin);
    });
  }, settings);
  await page.goto('https://shell.test/host.html');
  await page.evaluate(() => window.__mount());

  let ok = false;
  if (mode === 'noneheader' || mode === 'legacy') {
    await page.waitForTimeout(3000);
    console.log('   manifest default authMode:', JSON.stringify(defaults.authMode),
      '| effective:', JSON.stringify(settings.authMode));
    console.log('   credentials the API was offered:', JSON.stringify(dataAuth));
    const sentKey = dataAuth.some((v) => v.includes('secret-key-123'));
    if (mode === 'noneheader') {
      ok = dataAuth.length > 0 && !sentKey;
      console.log(ok ? '  PASS choosing none actually stopped the static credential'
                     : '  FAIL "none" was selected and the secret went out anyway');
    } else {
      ok = dataAuth.length > 0 && sentKey;
      console.log(ok ? '  PASS the legacy tile still sends the header it always sent'
                     : '  FAIL a tile configured before this option existed lost its credential');
    }
  } else if (mode === 'shortlife') {
    // Four polls at 5s. A 60s token is valid for every one of them, so one exchange
    // should cover the lot.
    await page.waitForTimeout(21000);
    console.log('   token exchanges across ~4 polls of a 60s token:', tokenHits);
    console.log('   data calls:', dataAuth.length);
    ok = dataAuth.length >= 3 && tokenHits === 1;
    console.log(ok ? '  PASS the short-lived token was reused while it was still valid'
                   : '  FAIL every poll re-exchanged a token that had not expired');
  } else if (mode === 'clockstep') {
    const t0 = Date.now();
    let settled = null;
    while (Date.now() - t0 < 25000 && !settled) {
      settled = await (await (await page.$('iframe')).contentFrame()).evaluate(() => {
        const body = document.getElementById('body'), title = document.getElementById('stateTitle');
        if (body && !body.hidden) return { kind:'value' };
        if (title && !title.hidden) return { kind:'card', text: title.textContent };
        return null;
      }).catch(() => null);
      if (!settled) await page.waitForTimeout(200);
    }
    const at = Date.now() - t0;
    console.log('   budget 10000ms, two 7000ms legs, wall clock steps back 60s mid-poll');
    console.log('   settled:', JSON.stringify(settled), 'after', at + 'ms');
    ok = !!settled && at <= 12500;
    console.log(ok ? '  PASS the deadline held; a wall-clock correction could not extend it'
                   : '  FAIL the poll ran past its cap by the size of the clock correction');
  } else if (mode === 'nosecret') {
    await page.waitForTimeout(12000);
    const card = await (await (await page.$('iframe')).contentFrame()).evaluate(() => {
      const t = document.getElementById('stateTitle');
      return t && !t.hidden ? t.textContent : null;
    }).catch(() => null);
    console.log('   exchanges attempted with an empty secret:', tokenHits, '| card:', JSON.stringify(card));
    ok = tokenHits === 0 && !!card && /client secret/i.test(card);
    console.log(ok ? '  PASS refused locally; no failed authentication was spent'
                   : '  FAIL empty credentials were posted to the real token endpoint');
  }
  await browser.close();
  process.exitCode = ok ? 0 : 1;
})();
