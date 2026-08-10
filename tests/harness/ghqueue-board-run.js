#!/usr/bin/env node
// GitHub Queue: the merge board actually shows the queue (issue #22 rework).
//
// The widget's whole reason to exist is rows of real pull requests in worst-first
// order — red CI on top, conflicts next, ready-to-merge after, the quiet tail last.
// The offline harness can only prove the setup card; this runner stubs the three
// GitHub endpoints (pulls list, PR detail, runs by head_sha) and asserts the board:
//
//   G1 · every stubbed PR gets a row (the slot fits them all here)
//   G2 · the verdict column reads worst-first, exactly: failing, conflict, ready,
//        running, draft
//   G3 · the header pill reports the exception count ("1 failing"), err-styled
//   G4 · a row names its PR (repo#number + title) and shows an age
//   G5 · the review-chatter marker appears on the PR that has comments
//   G6 · the footer reports freshness ("updated ...")
'use strict';
const fs = require('fs');
const path = require('path');

function loadPlaywright() {
  const candidates = ['playwright', '/opt/node22/lib/node_modules/playwright',
    path.join(process.env.HOME || '', 'node_modules/playwright')];
  for (const c of candidates) { try { return require(c); } catch (e) { /* next */ } }
  console.error('playwright not found — npm i -g playwright (and provide a chromium via CHROMIUM)');
  process.exit(1);
}
const { chromium } = loadPlaywright();

const REPO = path.resolve(__dirname, '..', '..');
const SHELL = path.join(REPO, 'src', 'Plinth', 'Shell');
const WIDGET = path.join(REPO, 'widgets', 'ghqueue');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  if (!ok) failures++;
};

const ago = (mins) => new Date(Date.now() - mins * 60000).toISOString();

// Five PRs across two repos, one per verdict the board can hand out. The fixture is
// the EXPECTED ORDER too — worst first — while the stub serves them interleaved, so a
// board that merely echoes arrival order fails G2.
const PRS = [
  { repo: 'me/alpha', number: 1, title: 'Fix the flux capacitor', sha: 'a1', created: ago(3 * 1440),
    runs: [{ status: 'completed', conclusion: 'failure' }], mergeable_state: 'clean',
    comments: 3, review_comments: 2, verdict: 'failing' },
  { repo: 'me/beta', number: 7, title: 'Refactor the engine room', sha: 'b7', created: ago(5 * 1440),
    runs: [{ status: 'completed', conclusion: 'success' }], mergeable_state: 'dirty',
    comments: 0, review_comments: 0, verdict: 'conflict' },
  { repo: 'me/alpha', number: 2, title: 'Add the missing docs', sha: 'a2', created: ago(120),
    runs: [{ status: 'completed', conclusion: 'success' }], mergeable_state: 'clean',
    comments: 0, review_comments: 0, verdict: 'ready' },
  { repo: 'me/beta', number: 9, title: 'Rework the intake manifold', sha: 'b9', created: ago(30),
    runs: [{ status: 'in_progress', conclusion: null }], mergeable_state: 'unknown',
    comments: 0, review_comments: 0, verdict: 'running' },
  { repo: 'me/beta', number: 8, title: 'WIP: experimental thing', sha: 'b8', created: ago(60), draft: true,
    runs: [], mergeable_state: 'clean', comments: 0, review_comments: 0, verdict: 'draft' },
];

const listItem = (pr) => ({
  number: pr.number, title: pr.title, draft: !!pr.draft,
  head: { sha: pr.sha }, created_at: pr.created, updated_at: pr.created,
});

const SHELL_PAGE = '<!doctype html><meta charset="utf-8"><title>ww shell</title>'
  + '<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#000}'
  + 'iframe{display:block;border:0;width:100vw;height:100vh}</style>';

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  page.on('pageerror', (e) => { failures++; console.log('[pageerror]', String(e).slice(0, 300)); });

  const serve = (route, dir, rel) => {
    const root = path.resolve(dir);
    const file = path.resolve(root, rel);
    if ((file === root || file.startsWith(root + path.sep)) && fs.existsSync(file) && fs.statSync(file).isFile())
      return route.fulfill({ contentType: MIME[path.extname(file)] || 'text/plain', body: fs.readFileSync(file) });
    return route.fulfill({ status: 404, body: '' });
  };
  await page.route('https://app.plinth/**', (r) =>
    serve(r, SHELL, decodeURIComponent(new URL(r.request().url()).pathname).replace(/^\/+/, '')));
  await page.route('https://widget.test/**', (r) =>
    serve(r, WIDGET, decodeURIComponent(new URL(r.request().url()).pathname).replace(/^\/+/, '') || 'index.html'));
  await page.route('https://shell.test/**', (r) =>
    r.fulfill({ contentType: 'text/html', body: SHELL_PAGE }));

  // The stubbed GitHub API. Cross-origin from widget.test, so the CORS headers are part
  // of the stub's honesty: without them the browser blocks the direct tier and the shim
  // escalates to the host proxy, which this runner refuses — a pass must come from the
  // same tier the panel actually uses first.
  const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, accept, x-github-api-version, if-none-match',
    'access-control-allow-methods': 'GET, OPTIONS',
  };
  const json = (r, body) => r.fulfill({ status: 200, contentType: 'application/json',
    headers: CORS, body: JSON.stringify(body) });
  await page.route('https://api.github.com/**', (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS, body: '' });
    const u = new URL(r.request().url());
    const seg = u.pathname.split('/').filter(Boolean);   // repos/{o}/{r}/...
    const repo = seg[1] + '/' + seg[2];
    if (seg[3] === 'pulls' && !seg[4])
      return json(r, PRS.filter((p) => p.repo === repo).map(listItem));
    if (seg[3] === 'pulls' && seg[4]) {
      const pr = PRS.find((p) => p.repo === repo && String(p.number) === seg[4]);
      if (!pr) return r.fulfill({ status: 404, headers: CORS, body: '{}' });
      return json(r, { number: pr.number, mergeable_state: pr.mergeable_state,
        comments: pr.comments, review_comments: pr.review_comments });
    }
    if (seg[3] === 'actions' && seg[4] === 'runs') {
      const pr = PRS.find((p) => p.repo === repo && p.sha === u.searchParams.get('head_sha'));
      return json(r, { workflow_runs: pr ? pr.runs : [] });
    }
    return r.fulfill({ status: 404, headers: CORS, body: '{}' });
  });
  await page.route(/https?:\/\/(?!(?:app\.plinth|widget\.test|shell\.test|api\.github\.com)(?:[/?#]|$)).*/,
    (r) => r.abort());

  const shim = fs.readFileSync(path.join(SHELL, 'widget-api.js'), 'utf8') + '\n'
             + fs.readFileSync(path.join(SHELL, 'icue-compat.js'), 'utf8');
  await page.addInitScript(shim);
  await page.addInitScript(({ widgetUrl, widgetOrigin, initMessage }) => {
    if (window.top !== window) return;
    let frame = null;
    window.__wwMount = () => {
      frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      frame.src = widgetUrl + '#ww-slot=p0s0';
      (document.body || document.documentElement).appendChild(frame);
    };
    window.__wwPush = (msg) => { if (frame && frame.contentWindow) frame.contentWindow.postMessage(msg, widgetOrigin); };
    window.addEventListener('message', (ev) => {
      if (!frame || ev.source !== frame.contentWindow || ev.origin !== widgetOrigin) return;
      const m = ev.data || {};
      if (m.type === 'ww-ready') return window.__wwPush(initMessage);
      // The board must be fed by the direct tier the stub serves; an escalation to the
      // host proxy would answer the same way the host does, and is refused so the run
      // cannot pass on a tier this runner does not control.
      if (m.type === 'ww-fetch') window.__wwPush({ type: 'ww-fetch-result', id: m.id, error: 'offline probe' });
    });
  }, {
    widgetUrl: 'https://widget.test/index.html',
    widgetOrigin: 'https://widget.test',
    initMessage: { type: 'ww-init',
      settings: { repos: [{ repo: 'me/alpha' }, { repo: 'me/beta' }], apiToken: 'stub-token', refreshMinutes: 5 },
      sensors: [], media: null, theme: {},
      status: { elevated: false, apiVersion: 1 } },
  });

  await page.goto('https://shell.test/host.html');
  await page.evaluate(() => window.__wwMount());
  const frameEl = await page.waitForSelector('iframe', { timeout: 10000 });
  const frame = await frameEl.contentFrame();
  if (!frame) { console.log('  FAIL G0 widget frame never attached'); await browser.close(); process.exit(1); }
  await frame.waitForSelector('#board .pr', { timeout: 10000 }).catch(() => {});
  // One settle pass: the sweep renders once after the lists and refines rows as the
  // per-PR calls land; the assertions want the finished board.
  await page.waitForTimeout(1500);

  const board = await frame.evaluate(() => ({
    rows: [...document.querySelectorAll('#board .pr')].map((row) => ({
      verdict: row.querySelector('.ci').textContent,
      verdictCls: row.querySelector('.ci').className,
      name: row.querySelector('.name').textContent,
      msgs: row.querySelector('.msgs').textContent,
      age: row.querySelector('.age').textContent,
    })),
    pill: { text: document.getElementById('pill').textContent,
            cls: document.getElementById('pill').className,
            hidden: document.getElementById('pill').hidden },
    meta: document.getElementById('meta').textContent,
  }));

  check('G1 every stubbed PR gets a row', board.rows.length === PRS.length,
    `${board.rows.length} of ${PRS.length}`);
  const wantOrder = PRS.map((p) => p.verdict).sort((a, b) => {
    const rank = { failing: 0, conflict: 1, ready: 2, running: 3, draft: 4 };
    return rank[a] - rank[b];
  });
  check('G2 the board reads worst-first', JSON.stringify(board.rows.map((r) => r.verdict)) === JSON.stringify(wantOrder),
    board.rows.map((r) => r.verdict).join(' > '));
  check('G3 the header pill reports the exception', board.pill.text === '1 failing' && /\berr\b/.test(board.pill.cls),
    `"${board.pill.text}" [${board.pill.cls}]`);
  const top = board.rows[0] || { name: '', age: '' };
  check('G4 a row names its PR and shows an age',
    top.name.includes('alpha#1') && top.name.includes('Fix the flux capacitor') && /\d+[mhd]/.test(top.age),
    `"${top.name}" age="${top.age}"`);
  check('G5 review chatter shows where it exists', top.msgs === '💬5', `"${top.msgs}"`);
  check('G6 the footer reports freshness', /updated .+ago/.test(board.meta), `"${board.meta}"`);

  const shot = path.join(__dirname, 'ghqueue-board.png');
  await page.screenshot({ path: shot });
  console.log(`  shot ${shot}`);

  await browser.close();
  process.exit(failures ? 1 : 0);
})();
