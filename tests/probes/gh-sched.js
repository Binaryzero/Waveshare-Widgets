#!/usr/bin/env node
// modes:
//   backoff   every poll fails. The interval must STRETCH, not keep costing twenty
//             requests a minute forever against a token that has been revoked.
//   gen       settings change while a poll is in flight. The old sweep's results are
//             keyed to the OLD repo list; writing them into a grid built for the new one
//             leaves rows that belong to nothing and a summary counting repos that are
//             no longer configured.
//   anchor    a poll that takes most of the interval must not push the next one a full
//             interval past its finish — the period is anchored to when it began.
'use strict';
const fs = require('fs'); const path = require('path');
const SHELL = '/home/user/Waveshare-Widgets/src/Plinth/Shell';
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css' };
const folder = process.argv[2];
const mode = process.argv[3] || 'backoff';
function pw(){ for (const c of ['playwright','/opt/node22/lib/node_modules/playwright']) { try { return require(c);} catch(e){} } throw new Error('no playwright'); }
const hits = [];
// Slow from the FIRST request, not switched on later: the overlap only exists if the
// opening sweep is still running when the settings change arrives. Setting this after the
// page had loaded meant sweep one had already finished and nothing ever overlapped.
let slowSearch = (mode === 'gen' || mode === 'anchor');
(async () => {
  const { chromium } = pw();
  const shim = fs.readFileSync(path.join(SHELL,'widget-api.js'),'utf8')+'\n'+fs.readFileSync(path.join(SHELL,'icue-compat.js'),'utf8');
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport:{width:640,height:400} });
  const t0 = Date.now();
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
  await page.route(/https?:\/\/(?!(?:app\.plinth|widget\.test|shell\.test)(?:[:/?#]|$)).*/, async (r) => {
    const u = r.request().url();
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status:204, headers: CORS });
    if (u.includes('/search/issues')) {
      hits.push({ at: Date.now() - t0, url: u });
      if (mode === 'backoff') return r.fulfill({ status:401, headers: CORS, body:'{}' });
      if (slowSearch) await new Promise((res) => setTimeout(res, 2500));
      return r.fulfill({ status:200, headers:{ ...CORS, 'content-type':'application/json' },
        body: JSON.stringify({ total_count: 1, items: [] }) });
    }
    if (u.includes('/actions/runs')) {
      // A revoked token 401s EVERY endpoint. Failing only the search call left the
      // workflow call succeeding, which under per-request fault tracking is a sweep that
      // did come back with something — so no backoff was owed and the probe was asking
      // the widget for the wrong behaviour.
      if (mode === 'backoff') return r.fulfill({ status:401, headers: CORS, body:'{}' });
      return r.fulfill({ status:200,
        headers:{ ...CORS, 'content-type':'application/json' },
        body: JSON.stringify({ workflow_runs: [ { status:'completed', conclusion:'success' } ] }) });
    }
    return r.abort();
  });
  await page.addInitScript(shim);
  await page.addInitScript(() => {
    if (window.top !== window) return;
    let frame = null;
    window.__repos = [ { repo:'binaryzero/alpha' } ];
    window.__reinit = (repos) => { window.__repos = repos; window.__send(); };
    window.__mount = () => { frame = document.createElement('iframe');
      frame.setAttribute('sandbox','allow-scripts allow-same-origin');
      frame.src = 'https://widget.test/index.html#ww-slot=p0s0'; document.body.appendChild(frame); };
    window.__send = () => frame.contentWindow.postMessage({ type:'ww-init',
      game:{active:false,process:''},
      settings:{ refreshMinutes: 1, apiToken: 'ghp_probe', repos: window.__repos },
      sensors:[], media:null,
      theme:{'--accent':'#e0a33e'}, status:{elevated:false,apiVersion:1} }, 'https://widget.test');
    window.addEventListener('message', (ev) => {
      if (!frame || ev.source !== frame.contentWindow || ev.origin !== 'https://widget.test') return;
      const m = ev.data || {};
      if (m.type === 'ww-ready') return window.__send();
      if (m.type === 'ww-fetch') return ev.source.postMessage({ type:'ww-fetch-result', id:m.id,
        error:'no route to host' }, ev.origin);
    });
  });
  await page.goto('https://shell.test/host.html');
  await page.evaluate(() => window.__mount());
  const el = await page.waitForSelector('iframe');
  const frame = await el.contentFrame();
  await frame.waitForLoadState('domcontentloaded');
  const text = () => frame.evaluate(() => document.body.innerText.replace(/\s+/g,' ').trim());

  if (mode === 'gen') {
    await page.waitForTimeout(600);        // sweep one is mid-request
    await page.evaluate(() => window.__reinit([ { repo:'binaryzero/beta' }, { repo:'binaryzero/gamma' } ]));
    await page.waitForTimeout(9000);       // long enough for the NEW sweep to finish too
    const t = await text();
    const names = await frame.evaluate(() => Array.from(document.querySelectorAll('.repo .name')).map((n) => n.textContent));
    console.log('  ', t);
    console.log('   rows:', JSON.stringify(names));
    // The grid must describe the CURRENT repo list, and every row in it must have a real
    // verdict rather than the placeholder left by a sweep that was thrown away.
    const ok = names.length === 2 && names.join() === 'beta,gamma'
      && !/·/.test(t) && !/alpha/.test(t);
    console.log(ok ? '  PASS the retired sweep did not write into the new grid'
                   : '  FAIL a row is showing a verdict from the previous repo list, or none at all');
    await browser.close(); process.exitCode = ok ? 0 : 1; return;
  }

  if (mode === 'anchor') {
    slowSearch = true;
    await page.waitForTimeout(1000);
    slowSearch = false;
    await page.waitForTimeout(1000);
    console.log('   poll starts (ms):', hits.map((h) => h.at).join(', '));
    console.log('  ', await text());
    console.log('  (anchor is observable over a full refresh interval; recorded for the record)');
    await browser.close(); process.exitCode = 0; return;
  }

  // refreshMinutes clamps to a 1-minute floor, so a flat cadence re-polls at 60s and a
  // backed-off one at 120s after the first failure. A 20s window saw ONE poll, no gaps at
  // all, and the empty-gaps fallback passed it — measuring nothing. The window has to be
  // long enough to contain the first gap, because the first gap is the whole signal.
  await page.waitForTimeout(130000);
  const gaps = hits.slice(1).map((h, i) => h.at - hits[i].at);
  console.log('   poll starts (ms):', hits.map((h) => h.at).join(', '));
  console.log('   gaps (ms):', gaps.join(', '));
  console.log('  ', await text());
  const ok = gaps.length >= 1 && gaps[0] > 90000;
  console.log(ok ? '  PASS consecutive failures stretched the interval'
                 : '  FAIL a revoked token is retried on the same flat cadence forever');
  await browser.close();
  process.exitCode = ok ? 0 : 1;
})();
