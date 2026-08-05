#!/usr/bin/env node
// Codex round 3 on #168. Modes:
//   runschema  /actions/runs answers 200 with JSON that is not a run list. Treated as "no
//              workflow runs", the row said "none" and the pill went green over a result
//              never obtained. An EMPTY workflow_runs array must still be a real answer.
//   rejected   one entry is not owner/name. It was dropped in silence and left looking
//              configured in Settings, while the pill reported on the survivors.
//   wipe       one good sweep, then every request fails. The last-known counts were
//              replaced with a fault-only map instead of being kept and dimmed.
'use strict';
const fs = require('fs'); const path = require('path');
const SHELL = '/home/user/Waveshare-Widgets/src/Plinth/Shell';
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css' };
const folder = process.argv[2];
const mode = process.argv[3] || 'runschema';
function pw(){ for (const c of ['playwright','/opt/node22/lib/node_modules/playwright']) { try { return require(c);} catch(e){} } throw new Error('no playwright'); }
let breakAll = false;
(async () => {
  const { chromium } = pw();
  const shim = fs.readFileSync(path.join(SHELL,'widget-api.js'),'utf8')+'\n'+fs.readFileSync(path.join(SHELL,'icue-compat.js'),'utf8');
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport:{width:640,height:400} });
  await page.route('https://app.plinth/**', (r) => {
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
  await page.route(/https?:\/\/(?!(?:app\.plinth|widget\.test|shell\.test)(?:[:/?#]|$)).*/, (r) => {
    const u = r.request().url();
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status:204, headers: CORS });
    if (breakAll) return r.fulfill({ status:500, headers: JSONH, body: '{}' });
    if (u.includes('/search/issues')) return r.fulfill({ status:200, headers: JSONH,
      body: JSON.stringify({ total_count: mode === 'rejected' ? 0 : 2, items: [] }) });
    if (u.includes('/actions/runs')) {
      if (mode === 'runschema') return r.fulfill({ status:200, headers: JSONH,
        body: JSON.stringify({ error: 'authentication required', login_url: 'https://portal.example' }) });
      return r.fulfill({ status:200, headers: JSONH,
        body: JSON.stringify({ workflow_runs: [ { status:'completed', conclusion:'success' } ] }) });
    }
    return r.abort();
  });
  const repos = mode === 'rejected'
    ? [ { repo:'binaryzero/alpha' }, { repo:'not a repo' }, { repo:'' } ]
    : [ { repo:'binaryzero/alpha' } ];
  await page.addInitScript(shim);
  await page.addInitScript((repoList) => {
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
        settings:{ refreshMinutes: 1, apiToken: 'ghp_probe', repos: repoList },
        sensors:[], media:null,
        theme:{'--accent':'#e0a33e'}, status:{elevated:false,apiVersion:1} }, ev.origin);
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

  if (mode === 'wipe') {
    await page.waitForTimeout(3000);
    const good = await text();
    console.log('   after a good sweep :', good);
    if (!/2 to review/.test(good)) {
      console.log('  SETUP FAILED — no good data to lose; the rest proves nothing');
      await browser.close(); process.exitCode = 2; return;
    }
    breakAll = true;
    // Waiting out the real cadence. A visibilitychange nudge does NOT force a poll — the
    // handler only re-polls once the interval has elapsed — so the first version of this
    // probe never triggered a second sweep at all, and both builds "failed" for the same
    // reason: nothing had been re-fetched to lose.
    await page.waitForTimeout(66000);          // refreshMinutes is 1
    const after = await text();
    console.log('   after all fail     :', after);
    const kept = /2 to review/.test(after);
    const dim = await frame.evaluate(() => document.body.classList.contains('stale'));
    console.log('   stale class:', dim);
    const ok = kept && dim;
    console.log(ok ? '  PASS the last good counts were kept and dimmed, not thrown away'
                   : '  FAIL a minute of trouble wiped counts that were true a minute ago');
    await browser.close(); process.exitCode = ok ? 0 : 1; return;
  }

  await page.waitForTimeout(3500);
  const t = await text();
  console.log('  ', t);
  let ok, why;
  if (mode === 'runschema') {
    ok = !/CLEAR/.test(t) && /unavailable/i.test(t);
    why = ok ? 'PASS a reply that was not a run list is a fault, not "no runs"'
             : 'FAIL a workflow result never obtained is reported as none/Clear';
  } else {
    ok = /not owner\/name/.test(t);
    why = ok ? 'PASS the rejected entries are declared instead of vanishing'
             : 'FAIL a malformed entry was dropped in silence';
  }
  console.log('  ' + why);
  await browser.close();
  process.exitCode = ok ? 0 : 1;
})();
