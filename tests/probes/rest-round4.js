#!/usr/bin/env node
// Codex round 4 on #174. Modes:
//   tokentype    the server issues a NON-bearer token (DPoP). It was sent as
//                "Bearer <token>" regardless, which is not using it but misusing it.
//   omittedtype  token_type absent entirely. REQUIRED by RFC 6749 but widely omitted —
//                this must keep working on both builds, or the guard above broke every
//                server that already works. (The "one branch short" check.)
//   corsreplay   a token endpoint with NO CORS headers, which is normal for
//                server-to-server OAuth. The browser DELIVERS the POST and blocks only
//                the reply; WW.fetch cannot tell that from a transport failure and
//                replays it through the host, so one sign-in grants TWO tokens.
//   nopersist    the bearer must not be written to plaintext localStorage, and a fresh
//                frame (= a reload) must therefore re-exchange rather than read one off
//                disk that anyone with the WebView profile could have taken.
'use strict';
const fs = require('fs'); const path = require('path');
const SHELL = '/home/user/Waveshare-Widgets/src/Plinth/Shell';
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css' };
const folder = process.argv[2];
const mode = process.argv[3] || 'tokentype';
function pw(){ for (const c of ['playwright','/opt/node22/lib/node_modules/playwright']) { try { return require(c);} catch(e){} } throw new Error('no playwright'); }

let directTokenHits = 0, proxyTokenHits = 0;
const dataAuth = [];
const tokenBody = (n) => {
  const b = { access_token: 'tok' + n, expires_in: 86399 };
  if (mode === 'tokentype') b.token_type = 'DPoP';
  else if (mode !== 'omittedtype') b.token_type = 'bearer';
  return JSON.stringify(b);
};

(async () => {
  const { chromium } = pw();
  const shim = fs.readFileSync(path.join(SHELL,'widget-api.js'),'utf8')+'\n'+fs.readFileSync(path.join(SHELL,'icue-compat.js'),'utf8');
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport:{width:640,height:400} });
  await page.exposeFunction('__proxyToken', () => { proxyTokenHits++; return tokenBody(directTokenHits + proxyTokenHits); });
  await page.route('https://app.plinth/**', (r) => {
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
  await page.route(/https?:\/\/(?!(?:app\.plinth|widget\.test|shell\.test)(?:[:/?#]|$)).*/, async (r) => {
    const u = r.request().url();
    // corsreplay: the preflight is refused too, exactly like an endpoint that has never
    // heard of CORS. The POST is still DELIVERED — that is the whole point.
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status:204, headers: CORS });
    if (u.includes('/token')) {
      directTokenHits++;                       // the SERVER has now granted a token
      // corsreplay models the exact shape of the finding: the POST reaches the server and
      // is processed, and only then does the browser refuse to hand the reply to the
      // page. Fulfilling without CORS headers does not reproduce that here — Playwright's
      // fulfilled responses do not go through the renderer's CORS pipeline, so the first
      // version of this probe passed against the unfixed build. Aborting AFTER counting
      // is what the widget actually experiences: a grant it cannot see.
      if (mode === 'corsreplay') return r.abort('failed');
      return r.fulfill({ status:200, headers: JSONH, body: tokenBody(directTokenHits + proxyTokenHits) });
    }
    if (u.includes('api.example/value')) {
      dataAuth.push(r.request().headers().authorization || '(none)');
      return r.fulfill({ status:200, headers: JSONH, body: JSON.stringify({ price: 42 }) });
    }
    return r.abort();
  });

  const settings = { url:'https://api.example/value', jsonPointer:'/price', label:'Tile',
    decimals:0, pollSeconds:60, authMode:'oauth2',
    tokenEndpoint:'https://oauth.example/token', clientId:'cid', clientSecret:'csec', scope:'' };

  await page.addInitScript(shim);
  await page.addInitScript(() => {
    if (window.top !== window) return;
    const frames = [];
    window.__mount = () => { const f = document.createElement('iframe');
      f.setAttribute('sandbox','allow-scripts allow-same-origin');
      f.src = 'https://widget.test/index.html#ww-slot=p0s' + frames.length;
      document.body.appendChild(f); frames.push(f); };
    window.addEventListener('message', async (ev) => {
      const f = frames.find((x) => x.contentWindow === ev.source);
      if (!f || ev.origin !== 'https://widget.test') return;
      const m = ev.data || {};
      if (m.type === 'ww-ready') return ev.source.postMessage({ type:'ww-init',
        game:{active:false,process:''}, settings: window.__s, sensors:[], media:null,
        theme:{'--accent':'#e0a33e'}, status:{elevated:false,apiVersion:1} }, ev.origin);
      if (m.type === 'ww-fetch') {
        // The HOST tier. Answer the way DashboardWindow does — status + base64 body — so
        // the widget's proxy path behaves as it does in production.
        if (String(m.url||'').includes('/token')) {
          const body = await window.__proxyToken();
          return ev.source.postMessage({ type:'ww-fetch-result', id:m.id, status:200,
            statusText:'OK', contentType:'application/json', bodyBase64: btoa(body) }, ev.origin);
        }
        return ev.source.postMessage({ type:'ww-fetch-result', id:m.id, error:'no route to host' }, ev.origin);
      }
    });
  });
  await page.addInitScript((s) => { window.__s = s; }, settings);
  await page.goto('https://shell.test/host.html');
  await page.evaluate(() => window.__mount());
  await page.waitForTimeout(4000);

  const cardOf = async (i) => (await (await (await page.$$('iframe'))[i].contentFrame()).evaluate(() => {
    const t = document.getElementById('stateTitle'), b = document.getElementById('body');
    if (b && !b.hidden) return { kind:'value', text:(document.getElementById('value')||{}).textContent||'' };
    return t && !t.hidden ? { kind:'card', text:t.textContent } : null;
  }).catch(() => null));

  let ok = false;
  if (mode === 'tokentype') {
    const settled = await cardOf(0);
    console.log('   settled:', JSON.stringify(settled));
    console.log('   Authorization the API was offered:', JSON.stringify(dataAuth));
    ok = dataAuth.length === 0 && !!settled && settled.kind === 'card' && /unsupported token type/i.test(settled.text);
    console.log(ok ? '  PASS a non-bearer token was refused instead of misused'
                   : '  FAIL a DPoP token was sent as a Bearer token');
  } else if (mode === 'omittedtype') {
    const settled = await cardOf(0);
    console.log('   settled:', JSON.stringify(settled), '| Authorization:', JSON.stringify(dataAuth));
    ok = !!settled && settled.kind === 'value' && settled.text.trim() === '42';
    console.log(ok ? '  PASS a token_type-less response still works'
                   : '  FAIL enforcing token_type broke servers that omit it');
  } else if (mode === 'corsreplay') {
    console.log('   token grants — direct(delivered):', directTokenHits, '| via host proxy:', proxyTokenHits,
      '| TOTAL:', directTokenHits + proxyTokenHits);
    ok = (directTokenHits + proxyTokenHits) === 1;
    console.log(ok ? '  PASS one sign-in bought exactly one token'
                   : '  FAIL a CORS-blocked POST was replayed, so one sign-in bought two tokens');
  } else if (mode === 'nopersist') {
    const stored = await (await (await page.$$('iframe'))[0].contentFrame()).evaluate(() => {
      const out = {};
      try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); out[k] = localStorage.getItem(k); } }
      catch (e) { return { '(unreadable)': String(e) }; }
      return out;
    }).catch(() => ({}));
    const leaked = Object.entries(stored).filter(([, v]) => /tok\d/.test(String(v)));
    const before = directTokenHits + proxyTokenHits;
    // A FRESH frame is a reload: empty module state, so it can only reuse a token that
    // was written to disk.
    await page.evaluate(() => window.__mount());
    await page.waitForTimeout(3500);
    const after = directTokenHits + proxyTokenHits;
    console.log('   localStorage after a successful exchange:', JSON.stringify(stored));
    console.log('   grants before the reload:', before, '| after:', after);
    ok = leaked.length === 0 && after > before;
    console.log(ok ? '  PASS the bearer was never written to disk; the reload re-exchanged'
                   : '  FAIL a usable bearer is sitting in plaintext localStorage');
  }
  await browser.close();
  process.exitCode = ok ? 0 : 1;
})();
