#!/usr/bin/env node
// Codex round 2 on #168. Modes:
//   undercount  a band that fits three of six repos, every one with a review pending. The
//               pill counted only the rows it drew, so it contradicted its own footer.
//   hidden      the panel goes hidden mid-sweep. The between-request gate checked the game
//               but not document.hidden, so the remaining calls went out anyway.
//   schema      a 200 carrying valid JSON that is not a search result. The count stayed
//               null, the row showed "·" and the pill went green: nothing was checked.
//   collide     team-a/api and team-b/api both render as "api" — two rows nobody can tell
//               apart, one of them in trouble.
//   newtoken    a rate-limited token is replaced. The gate belonged to the OLD credential
//               and kept refusing to try, for up to an hour.
'use strict';
const fs = require('fs'); const path = require('path');
const SHELL = '/home/user/Waveshare-Widgets/src/WaveshareWidgets/Shell';
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css' };
const folder = process.argv[2];
const mode = process.argv[3] || 'undercount';
function pw(){ for (const c of ['playwright','/opt/node22/lib/node_modules/playwright']) { try { return require(c);} catch(e){} } throw new Error('no playwright'); }
let searchHits = 0, runHits = 0, limitOn = (m => m === 'newtoken')(mode);
(async () => {
  const { chromium } = pw();
  const shim = fs.readFileSync(path.join(SHELL,'widget-api.js'),'utf8')+'\n'+fs.readFileSync(path.join(SHELL,'icue-compat.js'),'utf8');
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport:{width:640,height: mode === 'undercount' ? 200 : 400} });
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
  const CORS = { 'access-control-allow-origin':'*', 'access-control-allow-headers':'*',
    'access-control-expose-headers':'*' };
  const JSONH = { ...CORS, 'content-type':'application/json' };
  await page.route(/https?:\/\/(?!(?:app\.wsw|widget\.test|shell\.test)(?:[:/?#]|$)).*/, async (r) => {
    const u = r.request().url();
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status:204, headers: CORS });
    if (u.includes('/search/issues')) {
      searchHits++;
      if (limitOn) return r.fulfill({ status:403, headers:{ ...JSONH,
        'x-ratelimit-remaining':'0', 'x-ratelimit-reset': String(Math.floor(Date.now()/1000) + 3600) },
        body: JSON.stringify({ message: 'API rate limit exceeded for user ID 1.' }) });
      if (mode === 'schema') return r.fulfill({ status:200, headers: JSONH,
        body: JSON.stringify({ error: 'authentication required', login_url: 'https://portal.example' }) });
      // hidden mode: the FIRST call is slow, so the panel can go hidden while it is away.
      if (mode === 'hidden' && searchHits === 1) await new Promise((res) => setTimeout(res, 2500));
      return r.fulfill({ status:200, headers: JSONH, body: JSON.stringify({ total_count: 1, items: [] }) });
    }
    if (u.includes('/actions/runs')) {
      runHits++;
      return r.fulfill({ status:200, headers: JSONH, body: JSON.stringify({
        workflow_runs: [ { status:'completed', conclusion:'success' } ] }) });
    }
    return r.abort();
  });
  const repos = mode === 'undercount' ? Array.from({length:6}, (_, i) => ({ repo:'binaryzero/repo' + i }))
    : mode === 'hidden' ? Array.from({length:8}, (_, i) => ({ repo:'binaryzero/repo' + i }))
    : mode === 'collide' ? [ { repo:'team-a/api' }, { repo:'team-b/api' }, { repo:'team-a/web' } ]
    : [ { repo:'binaryzero/alpha' } ];
  await page.addInitScript(shim);
  await page.addInitScript((repoList) => {
    if (window.top !== window) return;
    let frame = null;
    window.__token = 'ghp_first';
    window.__mount = () => { frame = document.createElement('iframe');
      frame.setAttribute('sandbox','allow-scripts allow-same-origin');
      frame.src = 'https://widget.test/index.html#ww-slot=p0s0'; document.body.appendChild(frame); };
    window.__send = () => frame.contentWindow.postMessage({ type:'ww-init',
      game:{active:false,process:''},
      settings:{ refreshMinutes: 1, apiToken: window.__token, repos: repoList },
      sensors:[], media:null,
      theme:{'--accent':'#e0a33e'}, status:{elevated:false,apiVersion:1} }, 'https://widget.test');
    window.__swapToken = () => { window.__token = 'ghp_second'; window.__send(); };
    window.__resend = () => window.__send();
    window.addEventListener('message', (ev) => {
      if (!frame || ev.source !== frame.contentWindow || ev.origin !== 'https://widget.test') return;
      const m = ev.data || {};
      if (m.type === 'ww-ready') return window.__send();
      if (m.type === 'ww-fetch') return ev.source.postMessage({ type:'ww-fetch-result', id:m.id,
        error:'no route to host' }, ev.origin);
    });
  }, repos);
  await page.goto('https://shell.test/host.html');
  await page.evaluate(() => window.__mount());
  const el = await page.waitForSelector('iframe');
  const frame = await el.contentFrame();
  await frame.waitForLoadState('domcontentloaded');
  const text = () => frame.evaluate(() => document.body.innerText.replace(/\s+/g,' ').trim());

  if (mode === 'hidden') {
    await page.waitForTimeout(400);            // sweep is away on its slow first call
    const atHide = searchHits + runHits;
    // The real signal the shell delivers when the panel is not on screen.
    await page.emulateMedia({ reducedMotion: null });
    await frame.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
      Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(4000);
    const after = searchHits + runHits;
    console.log('   calls when hidden:', atHide, '-> after 4s hidden:', after);
    const ok = after - atHide <= 2;            // the in-flight one settling, and no more
    console.log(ok ? '  PASS the sweep stopped when the panel went away'
                   : '  FAIL a hidden panel kept working through the rest of the repo list');
    await browser.close(); process.exitCode = ok ? 0 : 1; return;
  }

  if (mode === 'newtoken') {
    await page.waitForTimeout(2500);
    console.log('   rate limited :', await text(), '| search calls:', searchHits);
    const before = searchHits;
    limitOn = false;                            // the new token is not limited
    await page.evaluate(() => window.__swapToken());
    await page.waitForTimeout(2500);
    const t = await text();
    console.log('   new token    :', t, '| search calls:', searchHits);
    const ok = searchHits > before && /1 TO REVIEW|CLEAR/.test(t) && !/Rate limited/i.test(t);
    console.log(ok ? '  PASS a replaced token was tried instead of serving the old one’s limit'
                   : '  FAIL the new token was refused on a limit it never earned');
    await browser.close(); process.exitCode = ok ? 0 : 1; return;
  }

  await page.waitForTimeout(4000);
  const t = await text();
  const names = await frame.evaluate(() => Array.from(document.querySelectorAll('.repo .name')).map((n) => n.textContent));
  console.log('  ', t);
  console.log('   rows:', JSON.stringify(names));
  let ok, why;
  if (mode === 'undercount') {
    ok = /6 TO REVIEW/.test(t);
    why = ok ? 'PASS the pill counted every repo it checked, not just the ones on screen'
             : 'FAIL the summary counts only visible rows and contradicts its own footer';
  } else if (mode === 'schema') {
    ok = !/CLEAR/.test(t) && /JSON|search result/i.test(t);
    why = ok ? 'PASS a reply that was not a search result is a fault, not an empty queue'
             : 'FAIL an unchecked queue is reported as Clear';
  } else {
    ok = names.includes('team-a/api') && names.includes('team-b/api') && names.includes('web');
    why = ok ? 'PASS the colliding names carry their owner, the unique one stays short'
             : 'FAIL two different repositories render as the same row';
  }
  console.log('  ' + why);
  await browser.close();
  process.exitCode = ok ? 0 : 1;
})();
