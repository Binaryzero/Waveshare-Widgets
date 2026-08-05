#!/usr/bin/env node
// Headers arrive, then the body stalls mid-stream. This is NOT the same as a request that
// never answers: WW.fetch RESOLVES on headers, so anything that clears the deadline at
// that point leaves res.json() pending forever — the panel dies one step further along
// than the plain hang, and the earlier fix does not cover it.
//
// Playwright's route.fulfill cannot half-send a body (holding the route open just means
// the fetch never resolves at all, which is the case already covered), so this runs a
// REAL server that writes a 200, flushes part of the JSON, and then keeps the socket open
// forever. The widget's requests to it are passed through rather than intercepted.
'use strict';
const fs = require('fs'); const path = require('path'); const https = require('https');
const SHELL = '/home/user/Waveshare-Widgets/src/WaveshareWidgets/Shell';
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css' };
const folder = process.argv[2];
function pw(){ for (const c of ['playwright','/opt/node22/lib/node_modules/playwright']) { try { return require(c);} catch(e){} } throw new Error('no playwright'); }
const open = [];
(async () => {
  // HTTPS, because the widget page is https and an http://127.0.0.1 fetch from it is
  // blocked as mixed content before it ever leaves the browser — the first version of this
  // probe never reached the server at all (sockets held open: 0) and "passed" on the
  // escalated proxy path instead, which cannot stall a body because it delivers one whole
  // base64 blob. Self-signed, with the context told to accept it.
  const server = https.createServer({
    key: fs.readFileSync(path.join(__dirname, 'ha-key.pem')),
    cert: fs.readFileSync(path.join(__dirname, 'ha-cert.pem')),
  }, (req, res) => {
    console.log('   server saw:', req.method, req.url);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin':'*', 'access-control-allow-headers':'*',
        'access-control-allow-methods':'GET,POST,OPTIONS', 'access-control-max-age':'600' });
      return res.end();
    }
    res.writeHead(200, { 'content-type':'application/json', 'access-control-allow-origin':'*',
      'access-control-allow-headers':'*', 'transfer-encoding':'chunked' });
    // Enough of the array to be unmistakably a real response in progress, then silence.
    res.write('[{"entity_id":"light.kitchen","state":"on","attributes":{');
    open.push(res);        // never ended, never destroyed
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  console.log('   stalling server on 127.0.0.1:' + port);

  const { chromium } = pw();
  const shim = fs.readFileSync(path.join(SHELL,'widget-api.js'),'utf8')+'\n'+fs.readFileSync(path.join(SHELL,'icue-compat.js'),'utf8');
  const launch = { args: ['--ignore-certificate-errors'] };
  if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
  const browser = await chromium.launch(launch);
  const context = await browser.newContext({ viewport:{width:640,height:400}, ignoreHTTPSErrors: true });
  const page = await context.newPage();
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
  // Everything else that is NOT the stalling server is refused; the server itself is
  // passed straight through to the real socket, which is the whole point.
  await page.route(/https?:\/\/(?!(?:app\.wsw|widget\.test|shell\.test)(?:[:/?#]|$)).*/, (r) => {
    if (r.request().url().includes('127.0.0.1:' + port)) return r.continue();
    return r.abort();
  });
  await page.addInitScript(shim);
  await page.addInitScript((p) => {
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
        settings:{ refreshSeconds: 30, baseUrl: 'https://127.0.0.1:' + p,
          accessToken: 'llat_probe', entities: [ { entity:'light.kitchen' } ] },
        sensors:[], media:null,
        theme:{'--accent':'#e0a33e'}, status:{elevated:false,apiVersion:1} }, ev.origin);
      if (m.type === 'ww-fetch') return ev.source.postMessage({ type:'ww-fetch-result', id:m.id,
        error:'no route to host' }, ev.origin);
    });
  }, port);
  await page.goto('https://shell.test/host.html');
  await page.evaluate(() => window.__mount());
  const el = await page.waitForSelector('iframe');
  const frame = await el.contentFrame();
  await frame.waitForLoadState('domcontentloaded');
  const text = () => frame.evaluate(() => document.body.innerText.replace(/\s+/g,' ').trim());
  await page.waitForTimeout(4000);
  console.log('   at t+4s  :', await text(), '| sockets held open:', open.length);
  await page.waitForTimeout(22000);              // POLL_DEADLINE is 20s
  const after = await text();
  console.log('   at t+26s :', after);
  const stuck = !/did not answer|unavailable|Error/i.test(after);
  console.log(stuck ? '  FAIL headers landed, the body never did, and nothing cut it off'
                    : '  PASS the deadline stayed armed through the body read');
  await browser.close();
  for (const r of open) { try { r.destroy(); } catch (e) {} }
  server.close();
  process.exitCode = stuck ? 1 : 0;
})();
