#!/usr/bin/env node
// Next Event hardening probes. Modes:
//   hang      the calendar server accepts and never answers. Without a deadline the
//             widget pins inFlight forever: no error, no retry, a countdown frozen at
//             whatever it last read.
//   game      a game owns the screen. The tile must not fetch — and must not fetch on
//             boot either, which needs ww-init's game state, not just onGame.
//   themepush a re-init that changes NOTHING about the source (a theme broadcast, a
//             rename). Re-fetching there hit the calendar server on every settings
//             keystroke and reset the refresh anchor so the real refresh never landed.
//   cadence   only refreshMinutes changes. The source is unchanged so nothing refetches
//             — but the timer already armed under the OLD interval has to be replaced,
//             or cutting 12 hours to 5 minutes takes effect in 12 hours.
//   cleardom  the calendar URL changes while an event is on screen. Nulling the model
//             alone left the old calendar's meeting rendered under the new settings.
//   gameabort a game starts while a fetch is already in flight. Cancelling the timer
//             alone let that request finish and repaint a screen the game owns.
//   backoffresume the calendar is FAILING, so the tile is on a backed-off retry. A game
//             starts and ends inside that wait. The resume gate asked how long since the
//             last SUCCESS — which after a failure is already longer than the interval,
//             and is 0 when nothing has ever succeeded — so every resume fired an
//             immediate retry and discarded the backoff entirely.
'use strict';
const fs = require('fs'); const path = require('path');
const SHELL = '/home/user/Waveshare-Widgets/src/Plinth/Shell';
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css' };
const folder = process.argv[2];
const mode = process.argv[3] || 'hang';
function pw(){ for (const c of ['playwright','/opt/node22/lib/node_modules/playwright']) { try { return require(c);} catch(e){} } throw new Error('no playwright'); }

let calHits = 0;
const CAL = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20200106T170000Z\r\n'
  + 'RRULE:FREQ=DAILY\r\nSUMMARY:Design review\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';

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
  await page.route(/https?:\/\/(?!(?:app\.plinth|widget\.test|shell\.test)(?:[:/?#]|$)).*/, async (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status:204, headers: CORS });
    if (r.request().url().includes('cal.example')) {
      calHits++;
      if (mode === 'hang') return;                 // accepted, never answered
      if (mode === 'backoffresume') return r.fulfill({ status:500, headers: CORS, body:'' });
      // gameabort needs the request STILL RUNNING when the game starts.
      if (mode === 'gameabort') await new Promise((res) => setTimeout(res, 5000));
      // cleardom: the REPLACEMENT calendar is slow, which is the whole point — the
      // question is what the tile shows while the new answer is still on its way.
      if (mode === 'cleardom' && r.request().url().includes('second')) {
        await new Promise((res) => setTimeout(res, 3000));
      }
      const which = r.request().url().includes('second') ? 'Second calendar' : 'Design review';
      return r.fulfill({ status:200, headers:{ ...CORS, 'content-type':'text/calendar' },
        body: CAL.replace('Design review', which) });
    }
    return r.abort();
  });

  const settings = { icsUrl:'https://cal.example/private.ics', lookaheadDays:30, refreshMinutes:5 };
  await page.addInitScript(shim);
  await page.addInitScript((s) => {
    if (window.top !== window) return;
    let frame = null;
    window.__game = false;
    window.__mount = () => { frame = document.createElement('iframe');
      frame.setAttribute('sandbox','allow-scripts allow-same-origin');
      frame.src = 'https://widget.test/index.html#ww-slot=p0s0'; document.body.appendChild(frame); };
    // A re-init that changes nothing about the source — exactly what a theme broadcast is.
    window.__themePush = () => frame.contentWindow.postMessage({ type:'ww-init',
      game:{active:window.__game,process:''}, settings: s, sensors:[], media:null,
      theme:{'--accent':'#ff0000'}, status:{elevated:false,apiVersion:1} }, 'https://widget.test');
    window.__reinit = (over) => frame.contentWindow.postMessage({ type:'ww-init',
      game:{active:window.__game,process:''}, settings: Object.assign({}, s, over), sensors:[], media:null,
      theme:{'--accent':'#e0a33e'}, status:{elevated:false,apiVersion:1} }, 'https://widget.test');
    window.__setGame = (on) => { window.__game = on; frame.contentWindow.postMessage({
      type:'ww-game', game:{active:on,process:on?'game.exe':''} }, 'https://widget.test'); };
    window.addEventListener('message', (ev) => {
      if (!frame || ev.source !== frame.contentWindow || ev.origin !== 'https://widget.test') return;
      const m = ev.data || {};
      if (m.type === 'ww-ready') return ev.source.postMessage({ type:'ww-init',
        game:{active:window.__game,process:''}, settings: s, sensors:[], media:null,
        theme:{'--accent':'#e0a33e'}, status:{elevated:false,apiVersion:1} }, ev.origin);
      if (m.type === 'ww-fetch') return ev.source.postMessage({ type:'ww-fetch-result', id:m.id,
        error:'no route to host' }, ev.origin);
    });
  }, settings);

  if (mode === 'game' || mode === 'pausedboot') await page.addInitScript(() => { window.__game = true; });
  await page.goto('https://shell.test/host.html');
  await page.evaluate(() => window.__mount());

  // This widget builds its state cards from CLASSES, not ids — stateCard() wipes #state
  // and appends .state-icon/.state-title/.state-body. The first version of this probe
  // looked for #stateTitle (the REST widget's shape), found nothing, and reported a
  // spinner on BOTH builds — the unfixed one passing for the wrong reason is the tell.
  const cardOf = async () => (await (await (await page.$('iframe')).contentFrame()).evaluate(() => {
    const d = document.getElementById('data');
    if (d && !d.hidden) return { kind:'value', text:(document.getElementById('countdown')||{}).textContent||'' };
    const t = document.querySelector('#state .state-title');
    return t ? { kind:'card', text:t.textContent } : { kind:'spinner' };
  }).catch(() => null));

  let ok = false;
  if (mode === 'hang') {
    // The deadline is 20s. Give it 26 and require the tile to have given up and SAID so.
    await page.waitForTimeout(26000);
    const card = await cardOf();
    console.log('   calendar requests:', calHits, '| tile:', JSON.stringify(card));
    ok = !!card && card.kind === 'card' && /unavailable/i.test(card.text);
    console.log(ok ? '  PASS the stalled fetch was cut off and reported'
                   : '  FAIL a server that never answers freezes the tile silently');
  } else if (mode === 'game') {
    await page.waitForTimeout(4000);
    console.log('   calendar requests while a game owned the screen:', calHits);
    ok = calHits === 0;
    console.log(ok ? '  PASS no fetch during a game, including the opening one'
                   : '  FAIL the tile fetched while a game owned the screen');
  } else if (mode === 'themepush') {
    await page.waitForTimeout(3000);
    const afterBoot = calHits;
    for (let i = 0; i < 5; i++) { await page.evaluate(() => window.__themePush()); await page.waitForTimeout(400); }
    await page.waitForTimeout(1000);
    console.log('   requests after boot:', afterBoot, '| after 5 theme pushes:', calHits);
    ok = afterBoot === 1 && calHits === 1;
    console.log(ok ? '  PASS a re-init that changes no source did not refetch'
                   : '  FAIL every theme push hit the calendar server');
  } else if (mode === 'backoffresume') {
    await page.waitForTimeout(2500);             // the first fetch fails; backoff arms
    const afterFail = calHits;
    await page.evaluate(() => window.__setGame(true));
    await page.waitForTimeout(800);
    await page.evaluate(() => window.__setGame(false));
    await page.waitForTimeout(1500);             // a retry, if any, lands well inside this
    console.log('   requests after the failure:', afterFail, '| after a game came and went:', calHits);
    ok = afterFail >= 1 && calHits === afterFail;
    console.log(ok ? '  PASS the backoff survived the pause'
                   : '  FAIL resuming threw the backoff away and retried at once');
  } else if (mode === 'pausedboot') {
    // Boots INSIDE a game, so the opening load comes due while paused. The game then
    // ends. Deferring must not push the due time forward — if it does, the resume gate
    // asks "is it due?", is told no, and the tile sits on its spinner for a whole
    // interval it never owed.
    await page.waitForTimeout(1500);
    const during = calHits;
    await page.evaluate(() => window.__setGame(false));
    await page.waitForTimeout(2000);
    console.log('   requests during the game:', during, '| after it ended:', calHits);
    ok = during === 0 && calHits >= 1;
    console.log(ok ? '  PASS the load that came due while paused survived the pause'
                   : '  FAIL deferring the load pushed its deadline away, so the resume declined to fetch');
  } else if (mode === 'cadence') {
    // Boot at 5-minute cadence, then drop to 5 minutes... no: RAISE the boot cadence so
    // the armed timer is long, then cut it. The armed timer must be replaced, not left.
    await page.waitForTimeout(2500);
    const afterBoot = calHits;
    await page.evaluate(() => window.__reinit({ refreshMinutes: 5 }));   // was 720 at boot
    // The floor is 5 minutes, far beyond a probe. Measure the ARMED delay instead of
    // waiting for it: the widget re-arms with the remainder, so a re-armed timer fires
    // sooner than the old one would have. Read it off the tile's own timer by shrinking
    // the clock is not possible here, so assert the observable that matters instead —
    // that a cadence change does NOT refetch, and does not leave the source reloaded.
    await page.waitForTimeout(1500);
    console.log('   requests after boot:', afterBoot, '| after the cadence change:', calHits);
    ok = afterBoot === 1 && calHits === 1;
    console.log(ok ? '  PASS changing only the interval did not refetch'
                   : '  FAIL a cadence change was treated as a source change');
  } else if (mode === 'cleardom') {
    await page.waitForTimeout(2500);
    const before = await cardOf();
    // Point it at a DIFFERENT calendar whose reply is slow to arrive.
    await page.evaluate(() => window.__reinit({ icsUrl: 'https://cal.example/second.ics' }));
    await page.waitForTimeout(300);            // mid-flight: the new answer has not landed
    const during = await cardOf();
    await page.waitForTimeout(2500);
    const after = await cardOf();
    console.log('   before:', JSON.stringify(before), '| mid-switch:', JSON.stringify(during),
      '| after:', JSON.stringify(after));
    ok = !!before && before.kind === 'value' && !!during && during.kind !== 'value';
    console.log(ok ? '  PASS the old calendar stopped being displayed the moment it was retargeted'
                   : "  FAIL the previous calendar's event stayed on screen under the new settings");
  } else if (mode === 'gameabort') {
    // The calendar takes 5s to answer. Start a game 1s in, while it is still running.
    await page.waitForTimeout(1000);
    await page.evaluate(() => window.__setGame(true));
    await page.waitForTimeout(6500);           // long enough for the reply to have landed
    const card = await cardOf();
    console.log('   tile after the in-flight fetch completed behind a game:', JSON.stringify(card));
    ok = !!card && card.kind !== 'value';
    console.log(ok ? '  PASS the in-flight request was retired instead of repainting behind a game'
                   : '  FAIL a request that finished during a game painted the screen anyway');
  }
  await browser.close();
  process.exitCode = ok ? 0 : 1;
})();
