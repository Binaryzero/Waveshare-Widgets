#!/usr/bin/env node
// WoW Panel #182 probes — items 1 through 7. Run against BOTH builds:
//   node wow-probe2.js <folder> <mode>
//
//   oauth401    the token endpoint issues tok1, then tok2. The price endpoint 401s for
//               tok1 and 200s for tok2. Item 1: the cached bearer has to be dropped and
//               re-exchanged ONCE inside the same tick — leaving it meant every backoff
//               retry re-presented a token the server had already rejected, until its
//               advertised expiry.
//   credswap    the token exchange is slow. The client id changes while it is in flight.
//               Item 2: the old exchange must not install its token after onInit cleared
//               it, or every later request authenticates as the PREVIOUS client.
//   retainchar  a good character lookup, then a 500 for the SAME character. Item 3: a
//               transient failure must keep the last-known stats; only 400/404 clears.
//   pausemid    the panel is hidden one second into a tick, between the price and the
//               affixes. Item 4: the remaining sources must not be fetched behind it.
//               Deliberately the DOCUMENT-HIDDEN path, not the game path: onGame already
//               retires, so the game route was covered before this change and proves
//               nothing about it.
//   sparkfirst  two observations already in localStorage, first render after a restart.
//               Item 5: drawSpark() measures #data, so drawing before it was unhidden
//               measured 0x0 and returned — a blank sparkline until a resize or a theme
//               change.
//   twotiles    two tiles on one region, one polling fast and one slow, both having
//               loaded the (empty) store before either saves. Item 6: the slow one must
//               not overwrite the fast one's observation.
//   nethint     everything configured correctly, every source unreachable, first load.
//               Item 7: the card must not prescribe settings changes for an outage.
//   badsecret   the TOKEN endpoint 401s — a wrong client secret, which Blizzard answers
//               with the same status the API uses for a dead token. The 401 retry added
//               for item 1 must not fire here: one sign-in per tick, not two. Falsified
//               against 68e7ac7, where the retry could not tell the two 401s apart.
'use strict';
const fs = require('fs'); const path = require('path');
const SHELL = '/home/user/Waveshare-Widgets/src/Plinth/Shell';
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
const folder = process.argv[2];
const mode = process.argv[3] || 'oauth401';
function pw() { for (const c of ['playwright', '/opt/node22/lib/node_modules/playwright']) { try { return require(c); } catch (e) {} } throw new Error('no playwright'); }

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
const J = (o) => ({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(o) });

let tokenHits = 0;
let priceHits = 0;
const tokensIssued = [];        // in order
const priceAuth = [];           // the Authorization header of every price request
const profileHits = [];
let affixHits = 0;

(async () => {
  const { chromium } = pw();
  const shim = fs.readFileSync(path.join(SHELL, 'widget-api.js'), 'utf8') + '\n'
    + fs.readFileSync(path.join(SHELL, 'icue-compat.js'), 'utf8');
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 400 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));

  await page.route('https://app.plinth/**', (r) => {
    const f = path.resolve(SHELL, decodeURIComponent(new URL(r.request().url()).pathname).replace(/^\/+/, ''));
    return fs.existsSync(f) ? r.fulfill({ contentType: MIME[path.extname(f)] || 'text/plain', body: fs.readFileSync(f) }) : r.fulfill({ status: 404, body: '' });
  });
  await page.route('https://widget.test/**', (r) => {
    const f = path.resolve(folder, decodeURIComponent(new URL(r.request().url()).pathname).replace(/^\/+/, '') || 'index.html');
    return fs.existsSync(f) && fs.statSync(f).isFile() ? r.fulfill({ contentType: MIME[path.extname(f)] || 'text/plain', body: fs.readFileSync(f) }) : r.fulfill({ status: 404, body: '' });
  });
  await page.route('https://shell.test/**', (r) => r.fulfill({ contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#000}iframe{display:block;border:0;width:100vw;height:200px}</style>' }));

  await page.route(/https?:\/\/(?!(?:app\.plinth|widget\.test|shell\.test)(?:[:/?#]|$)).*/, async (r) => {
    const req = r.request();
    const url = req.url();
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
    if (mode === 'nethint') return r.abort();

    if (url.includes('oauth.battle.net/token')) {
      tokenHits++;
      if (mode === 'badsecret') return r.fulfill({ status: 401, headers: CORS, body: '' });
      // The client this exchange is FOR, read off the Basic credential the widget sent.
      const auth = String(req.headers()['authorization'] || '');
      const who = (() => {
        try { return Buffer.from(auth.replace(/^Basic\s+/i, ''), 'base64').toString('utf8').split(':')[0]; }
        catch (e) { return '?'; }
      })();
      const tok = 'tok-' + who + '-' + tokenHits;
      tokensIssued.push(tok);
      return r.fulfill(J({ access_token: tok, token_type: 'bearer', expires_in: 86399 }));
    }

    if (url.includes('/data/wow/token/index')) {
      priceHits++;
      priceAuth.push(String(req.headers()['authorization'] || ''));
      if (mode === 'oauth401' && priceHits === 1) {
        // The server rejects the first token before its advertised expiry.
        return r.fulfill({ status: 401, headers: CORS, body: '' });
      }
      if (mode === 'twotiles') {
        // First requester answered at once, second held — so BOTH tiles have already
        // loaded the (empty) store before either of them saves. That is the ordering the
        // overwrite needs, and mounting them one after the other would not produce it.
        const nth = priceHits;
        if (nth > 1) await new Promise((res) => setTimeout(res, 2500));
        return r.fulfill(J({ price: 2800000000 + nth * 10000000 }));
      }
      return r.fulfill(J({ price: 2841230000 }));
    }

    if (url.includes('mythic-plus/affixes')) {
      affixHits++;
      // pausemid: slow enough that the panel can be hidden while this is outstanding.
      if (mode === 'pausemid') await new Promise((res) => setTimeout(res, 2500));
      return r.fulfill(J({ affix_details: [{ name: 'Fortified' }] }));
    }

    if (url.includes('characters/profile')) {
      profileHits.push(Date.now());
      if (mode === 'retainchar' && profileHits.length > 1) {
        return r.fulfill({ status: 500, headers: CORS, body: '' });
      }
      return r.fulfill(J({ gear: { item_level_equipped: 639 } }));
    }
    return r.abort();
  });

  const settings = { region: 'us', realm: 'argent-dawn', character: 'Thrall',
    clientId: 'cid1', clientSecret: 'sec', refreshMinutes: 30, bgStyle: 'solid' };

  await page.addInitScript(shim);
  if (mode === 'sparkfirst') {
    // Observations recorded by a previous run of this widget, exactly as a restart finds
    // them. Seeded in the WIDGET's origin — one virtual host per widget on the panel.
    await page.addInitScript(() => {
      if (location.origin !== 'https://widget.test') return;
      const now = Date.now();
      try {
        localStorage.setItem('wow.series.v1.us', JSON.stringify({ series: [
          { t: now - 7200000, price: 2700000000 },
          { t: now - 3600000, price: 2900000000 },
          { t: now - 1800000, price: 2750000000 },
        ] }));
      } catch (e) { /* ignore */ }
    });
  }
  await page.addInitScript(({ s, mode, swap }) => {
    if (window.top !== window) return;
    const frames = [];
    window.__settings = s;
    window.__mode = mode;
    window.__swap = Number(swap) || 0;
    window.__mount = (n) => {
      for (let i = 0; i < (n || 1); i++) {
        const f = document.createElement('iframe');
        f.setAttribute('sandbox', 'allow-scripts allow-same-origin');
        f.src = 'https://widget.test/index.html#ww-slot=p0s' + i;
        document.body.appendChild(f);
        frames.push(f);
      }
    };
    window.__reinit = (over) => frames[0].contentWindow.postMessage({ type: 'ww-init',
      game: { active: false, process: '' }, settings: Object.assign({}, window.__settings, over),
      sensors: [], media: null, theme: { '--accent': '#e0a33e' },
      status: { elevated: false, apiVersion: 1 } }, 'https://widget.test');
    window.addEventListener('message', (ev) => {
      const f = frames.find((x) => x.contentWindow === ev.source);
      if (!f || ev.origin !== 'https://widget.test') return;
      const m = ev.data || {};
      if (m.type === 'ww-ready') return ev.source.postMessage({ type: 'ww-init',
        game: { active: false, process: '' }, settings: window.__settings, sensors: [], media: null,
        theme: { '--accent': '#e0a33e' }, status: { elevated: false, apiVersion: 1 } }, ev.origin);
      // A REAL host proxy tier. The token exchange is proxy:'always' — it never uses the
      // browser tier at all — so a probe that stubs the proxy out with an error never
      // gets a bearer, never asks for a price, and reports zero hits on both builds.
      // That is what the first version of this probe did. The shell page's own fetch is
      // intercepted by the same route table the widget frame's is, so this performs the
      // request for real and answers with the host's contract: bodyBase64 plus a
      // Content-Type, and no other response headers.
      if (m.type === 'ww-fetch') {
        const init = { method: m.method || 'GET', headers: m.headers || {} };
        if (m.body != null && init.method !== 'GET' && init.method !== 'HEAD') init.body = m.body;
        fetch(String(m.url || ''), init).then(async (res) => {
          const buf = new Uint8Array(await res.arrayBuffer());
          let bin = '';
          for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
          ev.source.postMessage({ type: 'ww-fetch-result', id: m.id, status: res.status,
            contentType: res.headers.get('content-type') || 'application/json',
            bodyBase64: btoa(bin) }, ev.origin);
          // credswap: the settings change is posted in the SAME turn as the token reply,
          // so it is delivered while the widget is still consuming that reply — the only
          // window in which the finding exists. Changing the settings two seconds ahead
          // of the response (what this probe did first) lets retire()'s abort cancel the
          // exchange outright, and then it passes against the UNFIXED build too, which is
          // a probe proving nothing.
          if (window.__mode === 'credswap' && String(m.url || '').includes('oauth.battle.net')) {
            const fire = () => {
              window.__settings.clientId = 'cid2';
              ev.source.postMessage({ type: 'ww-init', game: { active: false, process: '' },
                settings: window.__settings, sensors: [], media: null,
                theme: { '--accent': '#e0a33e' }, status: { elevated: false, apiVersion: 1 } }, ev.origin);
            };
            // Sweep the delay: the window this finding lives in is between the token
            // reply being CONSUMED and `bearer` being assigned, and where that falls
            // relative to the reply is not something to guess at.
            const d = Number(window.__swap);
            if (d <= 0) fire(); else setTimeout(fire, d);
          }
        }).catch((e) => ev.source.postMessage({ type: 'ww-fetch-result', id: m.id,
          error: 'proxy: ' + String(e && e.message || e) }, ev.origin));
        return;
      }
    });
  }, { s: settings, mode, swap: Number(process.env.SWAP || 0) });

  await page.goto('https://shell.test/host.html');

  const frame = async (i) => (await (await page.$$('iframe'))[i || 0].contentFrame());
  const textOf = async (i) => (await frame(i)).evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());
  const fieldOf = async (id, i) => (await frame(i)).evaluate((x) => (document.getElementById(x) || {}).textContent || '', id);

  let ok = false;
  let note = '';

  if (mode === 'oauth401') {
    await page.evaluate(() => window.__mount(1));
    await page.waitForTimeout(4000);
    const price = await fieldOf('price');
    const t = await textOf();
    note = `token hits=${tokenHits} price hits=${priceHits} issued=${tokensIssued.join(',')} price="${price}"`;
    // Recovered inside ONE tick, with exactly one extra exchange — not a loop.
    ok = price.trim() === '284k' && tokenHits === 2 && priceHits === 2
      && priceAuth[0] !== priceAuth[1] && /LIVE/i.test(t);
  }

  if (mode === 'credswap') {
    await page.evaluate(() => window.__mount(1));
    // The settings change is posted by the ww-fetch responder above, in the same turn as
    // the token reply. Nothing to do here but let both ticks play out.
    await page.waitForTimeout(9000);
    const held = await (await frame(0)).evaluate(() => {
      try { return bearer ? bearer.token : null; } catch (e) { return 'unreadable'; }
    });
    // What the finding is actually about: the CACHED bearer. The retired tick's own price
    // request legitimately carries the old token — cid1 was the configured client when it
    // left — so asserting on priceAuth would fail a correct build. The question is what
    // sits in `bearer` once everything has settled, and which token the NEXT request uses.
    const stale = priceAuth.slice(1).filter((a) => a.includes('tok-cid1'));
    note = `swap=${process.env.SWAP || 0}ms token hits=${tokenHits} issued=${tokensIssued.join(',')} `
      + `priceAuth=${JSON.stringify(priceAuth)} cached bearer=${held}`;
    ok = stale.length === 0 && String(held || '').indexOf('cid1') < 0
      && priceAuth.some((a) => a.includes('tok-cid2'));
  }

  if (mode === 'retainchar') {
    await page.evaluate(() => window.__mount(1));
    await page.waitForTimeout(2500);
    const first = await fieldOf('ilvl');
    // A second tick without waiting out the 20-minute floor. The tick function is a
    // plain global in the widget's script scope; every assertion below is on the DOM.
    await (await frame(0)).evaluate(() => window.tick());
    await page.waitForTimeout(2500);
    const after = await fieldOf('ilvl');
    const t = await textOf();
    note = `profile hits=${profileHits.length} ilvl first="${first}" after="${after}" | ${t.slice(0, 150)}`;
    ok = first.trim() === '639' && after.trim() === '639' && profileHits.length === 2;
  }

  if (mode === 'pausemid') {
    await page.evaluate(() => window.__mount(1));
    await page.waitForTimeout(900);                      // price done, affixes outstanding
    await (await frame(0)).evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(5000);
    note = `price hits=${priceHits} affix hits=${affixHits} profile hits=${profileHits.length}`;
    // The price landed before the hide; the affix request was already out. The CHARACTER
    // request is the one that must never be issued behind a hidden panel.
    ok = priceHits === 1 && affixHits === 1 && profileHits.length === 0;
  }

  if (mode === 'sparkfirst') {
    await page.evaluate(() => window.__mount(1));
    await page.waitForTimeout(3000);
    const drawn = await (await frame(0)).evaluate(() => {
      const c = document.getElementById('spark');
      if (!c || !c.width || !c.height) return { w: c ? c.width : 0, h: c ? c.height : 0, painted: 0 };
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let painted = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 8) painted++;
      return { w: c.width, h: c.height, painted };
    });
    const trend = await fieldOf('trend');
    if (process.env.SHOT) await (await page.$$('iframe'))[0].screenshot({ path: process.env.SHOT });
    note = `canvas ${drawn.w}x${drawn.h} painted=${drawn.painted} trend="${trend}"`;
    ok = drawn.painted > 50;
  }

  if (mode === 'twotiles') {
    await page.evaluate(() => window.__mount(2));
    await page.waitForTimeout(6000);
    const stored = await (await frame(0)).evaluate(() => {
      try { return JSON.parse(localStorage.getItem('wow.series.v1.us') || 'null'); } catch (e) { return null; }
    });
    const n = stored && Array.isArray(stored.series) ? stored.series.length : 0;
    note = `price hits=${priceHits} stored points=${n} ${JSON.stringify((stored || {}).series || [])}`;
    ok = priceHits === 2 && n === 2;
  }

  if (mode === 'badsecret') {
    await page.evaluate(() => window.__mount(1));
    await page.waitForTimeout(4000);
    const t = await textOf();
    note = `token hits=${tokenHits} price hits=${priceHits} | ${t.slice(0, 130)}`;
    // One tick, one sign-in attempt. The price endpoint is never reached at all.
    ok = tokenHits === 1 && priceHits === 0;
  }

  if (mode === 'nethint') {
    await page.evaluate(() => window.__mount(1));
    await page.waitForTimeout(4000);
    const t = await textOf();
    note = t.slice(0, 260);
    // Correct settings, unreachable sources: no settings advice, and it must still say
    // WHAT went wrong.
    ok = !/client ID/i.test(t) && !/realm and character/i.test(t) && /Nothing to show yet/.test(t);
  }

  console.log(`[${mode}] ${folder}`);
  console.log('   ' + note);
  if (pageErrors.length) console.log('   PAGE ERRORS: ' + pageErrors.join(' | '));
  console.log('   ' + (ok ? 'PASS' : 'FAIL'));
  await browser.close();
  process.exit(ok ? 0 : 1);
})();
