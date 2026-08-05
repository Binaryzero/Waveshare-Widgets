#!/usr/bin/env node
// Codex round 1 on #168. Modes:
//   split      the token can read issues but not Actions. The review count arrived and is
//              correct; a combined per-repo error threw it away and printed "unavailable".
//   dupe       the same repo listed twice. Both rows share a key, so the first keeps its
//              placeholder, both endpoints are called twice, and the count is added twice.
//   conclusion the last run ended `action_required`. The row goes amber and the summary
//              pill says "Clear" — green, nothing to do — over the top of it.
//   ratelimit  a primary rate limit answered 403. WW.fetch retries every direct 403 via
//              the host proxy, whose Response carries only Content-Type, so the header the
//              classifier reads is gone and a real limit reads as a permissions problem.
//   band       a 200px band with eight repos: rows past the third are clipped by
//              overflow:hidden, silently, including the one that is failing.
'use strict';
const fs = require('fs'); const path = require('path');
const SHELL = '/home/user/Waveshare-Widgets/src/WaveshareWidgets/Shell';
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css' };
const folder = process.argv[2];
const mode = process.argv[3] || 'split';
function pw(){ for (const c of ['playwright','/opt/node22/lib/node_modules/playwright']) { try { return require(c);} catch(e){} } throw new Error('no playwright'); }
const calls = { search: 0, runs: 0 };
(async () => {
  const { chromium } = pw();
  const shim = fs.readFileSync(path.join(SHELL,'widget-api.js'),'utf8')+'\n'+fs.readFileSync(path.join(SHELL,'icue-compat.js'),'utf8');
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const height = mode === 'band' ? 200 : 400;
  const page = await browser.newPage({ viewport:{width:640,height} });
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
  await page.route(/https?:\/\/(?!(?:app\.wsw|widget\.test|shell\.test)(?:[:/?#]|$)).*/, (r) => {
    const u = r.request().url();
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status:204, headers: CORS });
    if (u.includes('/search/issues')) {
      calls.search++;
      if (mode === 'ratelimit') {
        // Exactly what api.github.com sends for a primary limit — including the headers,
        // which is the point: the DIRECT tier has them, and the escalation loses them.
        return r.fulfill({ status:403, headers:{ ...JSONH, 'x-ratelimit-remaining':'0',
          'x-ratelimit-reset': String(Math.floor(Date.now()/1000) + 1800) },
          body: JSON.stringify({ message: "API rate limit exceeded for user ID 1.",
            documentation_url: 'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api' }) });
      }
      // conclusion mode needs an EMPTY review queue: with reviews pending the pill reads
      // "4 to review" and never reaches the Clear branch, so the defect cannot show and
      // the probe passes against the unfixed build for a reason that is not the fix.
      const count = mode === 'conclusion' ? 0 : 4;
      return r.fulfill({ status:200, headers: JSONH, body: JSON.stringify({ total_count: count, items: [] }) });
    }
    if (u.includes('/actions/runs')) {
      calls.runs++;
      if (mode === 'split') {
        // A fine-grained PAT without the Actions scope: issues read fine, this one 403s.
        return r.fulfill({ status:403, headers: JSONH,
          body: JSON.stringify({ message: 'Resource not accessible by personal access token' }) });
      }
      if (mode === 'conclusion') return r.fulfill({ status:200, headers: JSONH,
        body: JSON.stringify({ workflow_runs: [ { status:'completed', conclusion:'action_required' } ] }) });
      const failing = /repo7/.test(u);
      return r.fulfill({ status:200, headers: JSONH, body: JSON.stringify({
        workflow_runs: [ { status:'completed', conclusion: failing ? 'failure' : 'success' } ] }) });
    }
    return r.abort();
  });
  const repos = mode === 'dupe'
    ? [ { repo:'binaryzero/alpha' }, { repo:'binaryzero/alpha' }, { repo:'binaryzero/beta' } ]
    : mode === 'band'
      ? Array.from({length:8}, (_, i) => ({ repo:'binaryzero/repo' + i }))
      : [ { repo:'binaryzero/alpha' } ];
  await page.addInitScript(shim);
  if (mode === 'ratelimit') await page.addInitScript(() => { window.__rl = true; });
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
      if (m.type === 'ww-fetch') {
        // The escalated tier, answering the way the host actually answers. This matters:
        // making the proxy ERROR here let widget-api.js:733-742 hand back the original
        // direct response, headers and all — so the probe never entered the state Codex
        // described and passed against the unfixed build. The host replies with a real
        // 403 and, per DashboardWindow.cs:686-689, sends only status, statusText,
        // contentType and the body. No x-ratelimit-* anything.
        if (window.__rl && String(m.url||'').includes('/search/issues')) {
          const body = JSON.stringify({ message: 'API rate limit exceeded for user ID 1.' });
          return ev.source.postMessage({ type:'ww-fetch-result', id:m.id, status:403,
            statusText:'Forbidden', contentType:'application/json',
            bodyBase64: btoa(body) }, ev.origin);
        }
        return ev.source.postMessage({ type:'ww-fetch-result', id:m.id,
          error:'no route to host' }, ev.origin);
      }
    });
  }, repos);
  await page.goto('https://shell.test/host.html');
  await page.evaluate(() => window.__mount());
  const el = await page.waitForSelector('iframe');
  const frame = await el.contentFrame();
  await frame.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4000);
  const text = await frame.evaluate(() => document.body.innerText.replace(/\s+/g,' ').trim());
  const names = await frame.evaluate(() => Array.from(document.querySelectorAll('.repo .name')).map((n) => n.textContent));
  // A row clipped by overflow:hidden still EXISTS in the DOM, so counting rows proves
  // nothing — measure what is actually inside the scroll box.
  const visible = await frame.evaluate(() => {
    const box = document.getElementById('repos');
    if (!box) return [];
    const lim = box.getBoundingClientRect().bottom + 1;
    return Array.from(box.querySelectorAll('.repo'))
      .filter((n) => n.getBoundingClientRect().bottom <= lim)
      .map((n) => (n.querySelector('.name') || {}).textContent);
  });
  console.log('  ', text);
  console.log('   rows:', JSON.stringify(names), '| unclipped:', JSON.stringify(visible),
    '| calls:', JSON.stringify(calls));
  let ok, why;
  if (mode === 'split') {
    ok = /4 to review/.test(text);
    why = ok ? 'PASS the review count survived a workflow request that failed'
             : 'FAIL an Actions permission error erased a review count that arrived fine';
  } else if (mode === 'dupe') {
    // Two DISTINCT repos at 4 apiece is 8. The unfixed build calls three times and sums
    // 12, with a dead placeholder row. My first assertion demanded the absence of "8 TO
    // REVIEW" — which is the correct answer, so the fixed build failed its own probe.
    ok = calls.search === 2 && names.length === 2 && !/·/.test(text) && /8 TO REVIEW/.test(text);
    why = ok ? 'PASS the duplicate collapsed: one row, one pair of calls, counted once'
             : 'FAIL a repeated repo left a dead row, doubled the calls and doubled the count';
  } else if (mode === 'conclusion') {
    ok = !/CLEAR/.test(text) && /ACTION_REQUIRED/i.test(text);
    why = ok ? 'PASS a run that needs attention is not reported as Clear'
             : 'FAIL an amber row sits under a green Clear pill';
  } else if (mode === 'ratelimit') {
    ok = /rate limit/i.test(text);
    why = ok ? 'PASS the rate limit was recognised even with the headers gone'
             : 'FAIL a rate limit was reported as a repository-access problem';
  } else {
    ok = visible.includes('repo7') && /no room/.test(text);
    why = ok ? 'PASS the failing repo got one of the rows that fit, and the rest are declared'
             : 'FAIL rows are clipped silently and the failing repo is not among them';
  }
  console.log('  ' + why);
  await browser.close();
  process.exitCode = ok ? 0 : 1;
})();
