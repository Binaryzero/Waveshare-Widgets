#!/usr/bin/env node
// Scratch probe for the KEV timer decisions, which the data-path runner cannot reach:
// it delivers one ww-init and waits. This wraps setTimeout inside the widget frame and
// records every delay armed, then drives (a) a refreshMinutes change after the first
// poll and (b) a failing feed, and reports the delays that were actually scheduled.
//
//   node kev-timers.js <widget-folder> reschedule|backoff
'use strict';
const fs = require('fs');
const path = require('path');
const REPO = '/home/user/Waveshare-Widgets';
const SHELL = path.join(REPO, 'src/Plinth/Shell');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };

const folder = process.argv[2];
const mode = process.argv[3];

function loadPlaywright() {
  for (const c of ['playwright', '/opt/node22/lib/node_modules/playwright',
    path.join(process.env.HOME || '', 'node_modules/playwright')]) {
    try { return require(c); } catch (e) { /* next */ }
  }
  throw new Error('playwright not found');
}

const FEED_OK = JSON.stringify({ vulnerabilities: [
  { cveID: 'CVE-2026-0001', vendorProject: 'Acme', product: 'Thing', dateAdded: '2026-08-01' },
] });

(async () => {
  const { chromium } = loadPlaywright();
  const shim = fs.readFileSync(path.join(SHELL, 'widget-api.js'), 'utf8') + '\n'
             + fs.readFileSync(path.join(SHELL, 'icue-compat.js'), 'utf8');
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });

  await page.route('https://app.plinth/**', (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\/+/, '');
    const file = path.resolve(SHELL, rel);
    if (file.startsWith(path.resolve(SHELL) + path.sep) && fs.existsSync(file))
      return route.fulfill({ contentType: MIME[path.extname(file)] || 'text/plain', body: fs.readFileSync(file) });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.route('https://widget.test/**', (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(folder, rel);
    if (fs.existsSync(file) && fs.statSync(file).isFile())
      return route.fulfill({ contentType: MIME[path.extname(file)] || 'text/plain', body: fs.readFileSync(file) });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.route('https://shell.test/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}'
      + 'iframe{display:block;border:0;width:100vw;height:100vh}</style>',
  }));
  let feedFails = mode === 'backoff';
  await page.route(/https?:\/\/(?!(?:app\.plinth|widget\.test|shell\.test)(?:[:/?#]|$)).*/, (route) => {
    if (!route.request().url().includes('cisa.gov')) return route.abort();
    if (feedFails) return route.fulfill({ status: 503, body: '', headers: { 'access-control-allow-origin': '*' } });
    return route.fulfill({ status: 200, contentType: 'application/json', body: FEED_OK,
      headers: { 'access-control-allow-origin': '*' } });
  });

  // Record every setTimeout delay armed in the widget frame. The widget is the only
  // script in it besides the shim, and the shim's own timers are tagged by their source.
  await page.addInitScript(() => {
    window.__armed = [];
    const real = window.setTimeout;
    window.setTimeout = function (fn, delay) {
      window.__armed.push(Number(delay) || 0);
      return real.call(window, fn, delay);
    };
  });
  await page.addInitScript(shim);
  await page.addInitScript(() => {
    if (window.top !== window) return;
    let frame = null;
    window.__mount = () => {
      frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      frame.src = 'https://widget.test/index.html#ww-slot=p0s0';
      document.body.appendChild(frame);
    };
    window.__init = (settings) => frame.contentWindow.postMessage(
      { type: 'ww-init', settings, sensors: [], media: null,
        theme: { '--accent': '#e0a33e' }, status: { elevated: false, apiVersion: 1 } },
      'https://widget.test');
    window.addEventListener('message', (ev) => {
      if (!frame || ev.source !== frame.contentWindow || ev.origin !== 'https://widget.test') return;
      const m = ev.data || {};
      const reply = (o) => ev.source.postMessage(o, ev.origin);
      if (m.type === 'ww-ping') reply({ type: 'ww-ping-result', id: m.id, results: [] });
      else if (m.type === 'ww-fetch') reply({ type: 'ww-fetch-result', id: m.id, error: 'no proxy in this probe' });
    });
  });

  await page.goto('https://shell.test/host.html');
  await page.evaluate(() => window.__mount());
  const frameEl = await page.waitForSelector('iframe');
  const frame = await frameEl.contentFrame();
  await frame.waitForLoadState('domcontentloaded');

  const MIN = 60000;
  const armed = () => frame.evaluate(() => window.__armed.slice());
  // Poll timers only: the 6-hour window-boundary timer is armed from render() and is
  // not the polling chain, so counting it would mask the delay under test.
  const CLAMP = 6 * 3600000;
  const pollDelays = (list) => list.filter((d) => d >= MIN && d !== CLAMP);
  const near = (ms, minutes) => Math.abs(ms - minutes * 60000) < 2000;

  if (mode === 'reschedule') {
    await page.evaluate((s) => window.__init(s), { refreshMinutes: 1440 });
    await page.waitForTimeout(1500);
    const before = pollDelays(await armed());
    await page.evaluate((s) => window.__init(s), { refreshMinutes: 15 });
    await page.waitForTimeout(600);
    const after = pollDelays(await armed()).slice(before.length);
    console.log('poll delays armed after first init (min):', before.map((d) => d / 60000));
    console.log('poll delays armed after settings change (min):', after.map((d) => d / 60000));
    const ok = before.length > 0 && near(before[before.length - 1], 1440)
      && after.length > 0 && near(after[after.length - 1], 15);
    const raw = await armed();
    const clampCount = raw.filter((d) => d === CLAMP).length;
    console.log('window-boundary timers armed (6h clamp):', clampCount,
      '| any delay over the 32-bit setTimeout limit:', raw.some((d) => d > 2147483647));
    console.log(ok ? 'PASS the pending poll was re-armed on the new interval'
                   : 'FAIL the pending poll still runs on the old interval');
    process.exitCode = ok ? 0 : 1;
  } else {
    await page.evaluate((s) => window.__init(s), { refreshMinutes: 15 });
    await page.waitForTimeout(1500);
    const first = pollDelays(await armed());
    // A second failure without waiting out the interval: call the widget's Retry, which
    // resets the backoff, then let it fail again to see the stretch reapplied from 1.
    console.log('poll delays armed over a failing feed (min):', first.map((d) => d / 60000));
    const retried = await frame.evaluate(() => {
      const btn = document.querySelector('#state .btn');
      if (!btn) return false;
      btn.click();
      return true;
    });
    await page.waitForTimeout(1200);
    const afterRetry = pollDelays(await armed()).slice(first.length);
    console.log('clicked Retry:', retried, '-> delays armed since (min):', afterRetry.map((d) => d / 60000));
    const ok = first.length > 0 && near(first[first.length - 1], 30)
      && retried && afterRetry.length > 0 && near(afterRetry[afterRetry.length - 1], 30);
    console.log(ok ? 'PASS one failure doubles the interval, and Retry restarts the stretch from 1x'
                   : 'FAIL backoff did not behave as stated');
    process.exitCode = ok ? 0 : 1;
  }
  await browser.close();
})();
