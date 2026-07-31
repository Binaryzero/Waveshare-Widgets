#!/usr/bin/env node
// Issue #117 — the browser fetch tier ignored the body ceiling the proxy tier advertises.
//
// The fix caps INSIDE the page, streaming, so the bytes past the bound are never received.
// tools/FetchLimits checks the generated script's text; text cannot distinguish "refuse
// before appending the chunk" from "refuse after", and the second is the whole defect —
// by then the memory has been spent. So this runs the real generated script, in a real
// browser, against a real server, and watches what the SERVER saw.
//
//   C1 · a small body comes back intact, base64-encoded
//   C2 · a body exactly at the ceiling still comes back (the cap is not off by one)
//   C3 · an oversized body that DECLARES its length is refused, and never fully transferred
//   C4 · an oversized CHUNKED body is refused and the transfer is cancelled mid-flight,
//        which is the only assertion that catches a budget checked too late
//   C5 · a 204 is a successful empty answer, not a thrown-away retry
//   C6-C9 · the WIDGET half of the same ceiling: the wrapper WW.fetch puts around every
//        response, its per-call lowering, and that it forwards the real Response faithfully
//   C10-C12 · the ways past that wrapper — reading .body directly, formData(), and a clone,
//        the last of which deadlocked on the tee rather than refusing
//
// Runs on plain Node — no Playwright — so it runs in CI beside the C# probes. Node's fetch
// gives real Response streams, a real reader, and a real cancel that tears the connection
// down, which is every primitive the script depends on. What that does NOT cover is
// Chromium/WebView2 specifically; the generated script is syntax-checked separately, and
// the platform is not reachable from here in any case.
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');

const SHIM = path.join(__dirname, '..', '..', 'src', 'WaveshareWidgets', 'Shell', 'widget-api.js');
const MAX = 5 * 1024 * 1024;
const OVERSIZE = MAX * 2;   // enough to be refused, small enough to stay quick when paced
const PORT = 8961;

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  if (!ok) failures++;
};

// What the server saw. A cap that refuses only after reading everything looks identical from
// the client side, so the server is the witness.
//
// Byte COUNTS are not the witness, though — that was two wrong versions of this file. At the
// instant the client reports tooLarge, a paced server has necessarily sent less than the
// total whether it was cancelled or not, so any threshold passes. What distinguishes them is
// the OUTCOME: a cancelled transfer never reaches res.end().
const sent = {};
const outcome = {};   // name -> 'aborted' | 'completed', set once, whichever happens first

function server() {
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const name = url.pathname.slice(1);
    if (name === '') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!DOCTYPE html>ok'); return; }

    // 204 forbids a body, and Fetch answers r.body === null for it. getReader() throws on
    // that, so without a guard a SUCCESSFUL retry lands in the catch and is discarded.
    if (url.searchParams.get('status') === '204') {
      outcome[name] = 'completed';
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
      res.end();
      return;
    }
    // A literal body, for the probes that need one the platform will actually parse —
    // an oversize fill of 'A' proves nothing about formData() if the parser rejects the
    // content-type before the budget was ever the reason.
    if (url.searchParams.has('text')) {
      outcome[name] = 'completed';
      res.writeHead(200, {
        'Content-Type': url.searchParams.get('ct') || 'text/plain',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(url.searchParams.get('text'));
      return;
    }
    const total = Number(url.searchParams.get('bytes') || 0);
    const declare = url.searchParams.get('declare') === '1';
    sent[name] = 0;
    const headers = {
      'Content-Type': url.searchParams.get('ct') || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
    };
    let ended = false;
    const settle = (how) => { if (!outcome[name]) outcome[name] = how; };
    // 'close' fires for BOTH a clean end and a torn-down connection, so the flag is what
    // tells them apart. Without it, a completed transfer would report itself as aborted.
    res.on('close', () => settle(ended ? 'completed' : 'aborted'));
    if (declare) headers['Content-Length'] = String(total);
    res.writeHead(200, headers);

    const chunk = Buffer.alloc(64 * 1024, 0x41);
    let done = false;
    const stop = () => { done = true; };
    req.on('aborted', stop); res.on('close', stop);
    // PACED, deliberately. Writing as fast as backpressure allows hands the whole body to
    // the socket before the browser has read far enough to cancel, so "how much left the
    // server" measures scheduling luck rather than whether the transfer was aborted — the
    // first version of this check failed about one run in three for exactly that reason.
    // A gap between chunks gives the cancellation somewhere to land.
    (function push() {
      if (done || sent[name] >= total) {
        if (!done) { ended = true; res.end(); settle('completed'); }
        return;
      }
      const n = Math.min(chunk.length, total - sent[name]);
      sent[name] += n;
      res.write(chunk.subarray(0, n));
      setTimeout(push, 4);
    })();
  });
  return new Promise((r) => srv.listen(PORT, '127.0.0.1', () => r(srv)));
}

(async () => {
  const scriptPath = process.argv[2];
  if (!scriptPath || !fs.existsSync(scriptPath)) {
    console.log(`  FAIL C0 setup: generated script not found at ${scriptPath}`);
    console.log('1 FAILURES');
    process.exit(1);
  }
  const template = fs.readFileSync(scriptPath, 'utf8');
  check('C0 setup: the script under test is the one FetchLimits generates',
    template.includes('__WW_URL__') && template.includes(String(MAX)));

  const srv = await server();

  // The script is written against browser globals and assigns its answer to window.
  // Handing it exactly those, and nothing else, keeps this a test of the script rather
  // than of a rewrite of it.
  const run = async (name, bytes, declare, status) => {
    const url = `http://127.0.0.1:${PORT}/${name}?bytes=${bytes}&declare=${declare ? 1 : 0}`
      + (status ? `&status=${status}` : '');
    const win = {};
    const body = template.replace('__WW_URL__', url);
    // eslint-disable-next-line no-new-func
    new Function('window', 'fetch', 'btoa', body)(win, fetch, btoa);
    for (let i = 0; i < 200; i++) {
      if (win.__wwResult) return win.__wwResult;
      await new Promise((r) => setTimeout(r, 50));
    }
    return { timedOut: true };
  };

  const small = await run('small', 1024, true);
  check('C1 a small body comes back intact',
    !small.tooLarge && typeof small.b64 === 'string' && atobLen(small.b64) === 1024,
    JSON.stringify({ tooLarge: small.tooLarge, bytes: small.b64 ? atobLen(small.b64) : null }));

  const exact = await run('exact', MAX, true);
  check('C2 a body of exactly the ceiling still comes back',
    !exact.tooLarge && exact.b64 && atobLen(exact.b64) === MAX,
    JSON.stringify({ tooLarge: exact.tooLarge, bytes: exact.b64 ? atobLen(exact.b64) : null }));

  const declared = await run('declared', OVERSIZE, true);
  check('C3 an oversized body that declares its length is refused', declared.tooLarge === true,
    JSON.stringify({ tooLarge: declared.tooLarge, size: declared.size }));
  check('C3b ...and the server sees the transfer torn down, not completed',
    (await settled('declared')) === 'aborted',
    `${outcome.declared} after ${sent.declared} of ${OVERSIZE} bytes`);

  const chunked = await run('chunked', OVERSIZE, false);
  check('C4 an oversized chunked body is refused', chunked.tooLarge === true,
    JSON.stringify({ tooLarge: chunked.tooLarge, size: chunked.size }));
  // THE assertion, and the reason the byte count would not do: a budget checked after the
  // append also reports tooLarge, just later. Only "the server never got to res.end()"
  // separates a cancelled transfer from one that ran to completion behind the client's back.
  check('C4b ...and the transfer is cancelled, so the server never finishes sending',
    (await settled('chunked')) === 'aborted',
    `${outcome.chunked} after ${sent.chunked} of ${OVERSIZE} bytes`);

  // ---- The WIDGET side of the same ceiling (#106) ----------------------------------
  // WW.fetch wraps every response so a widget cannot materialise more than the ceiling
  // either. The block is lifted out of widget-api.js by marker, so this drives exactly what
  // ships rather than a copy of it — and it runs here because the browser harness cannot:
  // its widget page is https, so an http fixture is blocked as mixed content, leaving the
  // declared-length path the only one reachable there.
  const shimSrc = fs.readFileSync(SHIM, 'utf8');
  // From the END of the marker LINE: the marker has prose after it on the same line, and
  // slicing at the marker itself would leave that prose as bare code.
  const afterMarker = shimSrc.split('>>> BODY-CAP BEGIN')[1] || '';
  const block = afterMarker.slice(afterMarker.indexOf('\n') + 1).split('<<< BODY-CAP END')[0];
  check('C6 setup: the body-cap block was found in widget-api.js', !!block && block.includes('readCapped'));
  // The block ends inside the trailing marker's comment, so the return statement needs its
  // own line or it is swallowed by it.
  const shim = new Function('TextDecoder', 'Blob',
    `${block}\nreturn { readCapped, cappedResponse, resolveCap, MAX_BODY_BYTES };`)(TextDecoder, Blob);
  check('C6 setup: the shim ceiling is the same number the host uses', shim.MAX_BODY_BYTES === MAX,
    `${shim.MAX_BODY_BYTES} vs ${MAX}`);

  const capped = (url, max) => fetch(url).then((r) => shim.cappedResponse(r, max || MAX));

  const ok = await capped(`http://127.0.0.1:${PORT}/wsmall?bytes=2048&declare=1`);
  check('C6 a small body reads through the wrapper', (await ok.text()).length === 2048);
  check('C6b ...and the forwarded properties are the real Response\'s',
    ok.status === 200 && ok.ok === true && typeof ok.headers.get === 'function'
      && ok.headers.get('content-type') === 'application/octet-stream',
    `${ok.status} ${ok.ok} ${ok.headers.get('content-type')}`);

  const bigDeclared = await capped(`http://127.0.0.1:${PORT}/wdeclared?bytes=${OVERSIZE}&declare=1`);
  let refusedDeclared = null;
  try { await bigDeclared.text(); } catch (e) { refusedDeclared = e; }
  check('C7 a declared oversized body is refused by the wrapper',
    refusedDeclared instanceof RangeError && /too large/i.test(refusedDeclared.message),
    String(refusedDeclared));
  check('C7b ...and the server sees it torn down', (await settled('wdeclared')) === 'aborted', outcome.wdeclared);

  // C8 · THE one the browser harness cannot reach. No Content-Length, so the declared
  // shortcut has nothing to look at and only the streaming budget stands in the way.
  const bigChunked = await capped(`http://127.0.0.1:${PORT}/wchunked?bytes=${OVERSIZE}&declare=0`);
  let refusedChunked = null;
  try { await bigChunked.json(); } catch (e) { refusedChunked = e; }
  check('C8 a CHUNKED oversized body is refused by the streaming budget',
    refusedChunked instanceof RangeError && /too large/i.test(refusedChunked.message),
    String(refusedChunked));
  check('C8b ...and that transfer is cancelled too', (await settled('wchunked')) === 'aborted', outcome.wchunked);

  // C9 · the per-call override, LOWER-ONLY. Driven through resolveCap — the value WW.fetch
  // actually passes — rather than by handing cappedResponse a number directly, which would
  // prove the wrapper obeys a budget while saying nothing about which budget it is given.
  const LOW = 256 * 1024;
  check('C9 init.maxBytes lowers the ceiling for that call', shim.resolveCap({ maxBytes: LOW }) === LOW,
    String(shim.resolveCap({ maxBytes: LOW })));
  // The one that has to hold, and the reason the option is not symmetric: the host proxy
  // tier enforces its own ceiling in C#, and which tier serves a call is the remote server's
  // choice (403/429 escalates). A raise would therefore work or not work depending on the
  // target's mood, so it does not work at all.
  check('C9b ...and cannot raise it above the host ceiling',
    shim.resolveCap({ maxBytes: MAX * 2 }) === MAX && shim.resolveCap({ maxBytes: Infinity }) === MAX,
    String(shim.resolveCap({ maxBytes: MAX * 2 })));
  check('C9c ...and anything unusable falls back to the default',
    shim.resolveCap({}) === MAX && shim.resolveCap({ maxBytes: 0 }) === MAX
      && shim.resolveCap({ maxBytes: -1 }) === MAX && shim.resolveCap({ maxBytes: 'big' }) === MAX
      && shim.resolveCap(undefined) === MAX);
  // ...and that the lowered number is not merely returned but ENFORCED: this body is far
  // under the default ceiling, so nothing refuses it except the caller's own request to.
  const lowered = await capped(`http://127.0.0.1:${PORT}/wlowered?bytes=${LOW * 2}&declare=0`,
    shim.resolveCap({ maxBytes: LOW }));
  let refusedLow = null;
  try { await lowered.arrayBuffer(); } catch (e) { refusedLow = e; }
  check('C9d a body over the LOWERED ceiling is refused though the default would allow it',
    refusedLow instanceof RangeError && /too large/i.test(refusedLow.message), String(refusedLow));
  const underLow = await capped(`http://127.0.0.1:${PORT}/wunder?bytes=${LOW / 2}&declare=1`,
    shim.resolveCap({ maxBytes: LOW }));
  check('C9e ...and one under it still reads', (await underLow.arrayBuffer()).byteLength === LOW / 2);

  // C10 · the escape hatch. Every capped reader above is optional — a widget can ignore
  // all of them and pull response.body itself, which is how the budget came to exist in a
  // wrapper that had five overrides and no cap at all on the one path that needs none.
  const streamed = await capped(`http://127.0.0.1:${PORT}/wstream?bytes=${OVERSIZE}&declare=0`);
  let refusedStream = null;
  try {
    const reader = streamed.body.getReader();
    for (;;) { const { done } = await reader.read(); if (done) break; }
  } catch (e) { refusedStream = e; }
  check('C10 a widget reading response.body itself is capped too',
    refusedStream instanceof RangeError && /too large/i.test(refusedStream.message), String(refusedStream));
  check('C10b ...and that transfer is cancelled as well', (await settled('wstream')) === 'aborted', outcome.wstream);
  // ...and the stream is not merely a refusal machine: an ordinary body has to come through
  // it byte for byte, or every widget that streams is broken by the fix.
  const okStream = await capped(`http://127.0.0.1:${PORT}/wokstream?bytes=4096&declare=0`);
  let streamedBytes = 0;
  let streamError = null;
  try {
    for (const reader = okStream.body.getReader(); ;) {
      const { done, value } = await reader.read();
      if (done) break;
      streamedBytes += value.length;
    }
  } catch (e) { streamError = e; }   // caught, or a wrapper that refuses everything takes
                                     // the whole run down instead of reporting one failure
  check('C10c a body under the ceiling streams through intact',
    !streamError && streamedBytes === 4096, streamError ? String(streamError) : String(streamedBytes));

  // C10d · LOOKING at .body must not consume it. Native fetch does not disturb a body when
  // the property is read — `if (res.body)` before res.text() is ordinary widget code — so a
  // wrapper that locks the source on property access breaks readers that would have worked
  // before the ceiling existed. Stranger than the failure the ceiling prevents, and silent.
  const peeked = await capped(`http://127.0.0.1:${PORT}/wpeek?bytes=1024&declare=1`);
  const hasBody = !!peeked.body;
  let peekError = null;
  let peekedText = '';
  try { peekedText = await peeked.text(); } catch (e) { peekError = e; }
  check('C10d reading the .body property does not consume the response',
    hasBody && !peekError && peekedText.length === 1024,
    peekError ? String(peekError) : `body=${hasBody} text=${peekedText.length}`);

  // C11 · formData() does not read a body itself, it PARSES one — and parsing a multipart
  // body the platform already materialised for us is the same unbounded read by another
  // name. It has to go through the budget first.
  // Served as a form the platform WOULD parse, so a failure here means the budget stopped
  // it — not that the parser turned its nose up at the content-type first.
  const FORM_CT = 'application/x-www-form-urlencoded';
  const bigForm = await capped(
    `http://127.0.0.1:${PORT}/wform?bytes=${OVERSIZE}&declare=1&ct=${encodeURIComponent(FORM_CT)}`);
  let refusedForm = null;
  try { await bigForm.formData(); } catch (e) { refusedForm = e; }
  check('C11 formData() is capped rather than parsing whatever arrived',
    refusedForm instanceof RangeError && /too large/i.test(refusedForm.message), String(refusedForm));
  // ...and reading it within the budget first must not have broken the parse itself.
  const okForm = await capped(`http://127.0.0.1:${PORT}/wokform?text=${encodeURIComponent('a=1&b=two')}`
    + `&ct=${encodeURIComponent(FORM_CT)}`);
  const parsed = await okForm.formData();
  check('C11b ...and an ordinary form still parses through the wrapper',
    parsed.get('a') === '1' && parsed.get('b') === 'two', `${parsed.get('a')} ${parsed.get('b')}`);

  // C12 · THE deadlock. A body from clone() is one branch of a tee, and cancelling one
  // branch does not settle until the other is cancelled too — so awaiting the cancel on the
  // refusal path never returns: no RangeError, and the source goes on filling the unread
  // branch's queue, which is the unbounded accumulation the budget exists to stop. The
  // timeout is the assertion; a hang is the bug.
  const original = await capped(`http://127.0.0.1:${PORT}/wclone?bytes=${OVERSIZE}&declare=0`);
  const copy = original.clone();
  const verdict = await Promise.race([
    copy.text().then(() => 'resolved', (e) => (e instanceof RangeError ? 'refused' : 'other: ' + e)),
    new Promise((r) => setTimeout(() => r('hung'), 15000)),
  ]);
  check('C12 refusing a CLONE settles instead of deadlocking on the tee', verdict === 'refused', verdict);

  // C13 · it has to BE a Response, not merely behave like one. Every other platform API
  // brand-checks its arguments against the internal slots, which no amount of faithful
  // forwarding can supply — a Proxy passes every probe above and is still rejected the
  // moment a widget hands it to cache.put(). Checked here through the constructor the
  // browser harness cannot reach; Chromium's Cache API needs a secure context and a real
  // origin, so C13b below asserts the property that makes the brand check pass.
  const real = await capped(`http://127.0.0.1:${PORT}/wreal?bytes=64&declare=1`);
  check('C13 the wrapper IS a Response, so other platform APIs accept it',
    real instanceof Response && Object.getPrototypeOf(real) === Response.prototype,
    `${real instanceof Response} ${Object.getPrototypeOf(real) === Response.prototype}`);
  // ...and the identity a rebuilt Response loses is put back. A constructed Response reports
  // url '' and type 'default'; a widget reading res.url after a redirect would get nothing.
  const src = await fetch(`http://127.0.0.1:${PORT}/wident?bytes=64&declare=1`);
  const ident = shim.cappedResponse(src, MAX);
  check('C13b ...and it still reports the original url, redirected and type',
    ident.url === src.url && ident.redirected === src.redirected && ident.type === src.type,
    JSON.stringify({ url: ident.url, redirected: ident.redirected, type: ident.type }));
  await ident.arrayBuffer();

  // C14 · a native Response.body is a readable BYTE stream. A widget may read into its own
  // buffer with getReader({ mode: 'byob' }), and an ordinary ReadableStream refuses that
  // reader outright — so a wrapper built from one breaks a valid consumer on responses of
  // any size, ceiling or no ceiling.
  //
  // Raced against a timeout, because the failure mode here is a HANG, not a throw: a byte
  // stream that answers a BYOB request with enqueue() instead of writing into the caller's
  // view leaves the read pending forever. Without the race that regression takes the whole
  // suite down with no output at all, which reads as infrastructure trouble rather than as
  // this check failing — it cost most of an hour once already.
  const byob = await capped(`http://127.0.0.1:${PORT}/wbyob?bytes=2048&declare=1`);
  const byobResult = await Promise.race([
    (async () => {
      let n = 0;
      const reader = byob.body.getReader({ mode: 'byob' });
      for (;;) {
        const { done, value } = await reader.read(new Uint8Array(512));
        if (done) break;
        n += value.byteLength;
      }
      return String(n);
    })().catch((e) => 'threw: ' + e),
    new Promise((r) => setTimeout(() => r('HUNG'), 10000)),
  ]);
  check('C14 the wrapped body accepts a BYOB reader, as a native one does',
    byobResult === '2048', byobResult);

  // C5 · a body-forbidden response is an ANSWER, not a failure. The streaming rewrite has
  // to absorb r.body === null the way arrayBuffer() did; if it throws instead, BrowserFetcher
  // discards a retry that actually succeeded and the widget keeps the 403 the proxy got.
  const empty = await run('empty', 0, false, 204);
  check('C5 a 204 comes back as a successful empty body, not an error',
    empty.status === 204 && empty.b64 === '' && !empty.error && !empty.tooLarge,
    JSON.stringify(empty));

  srv.close();
  console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();

function atobLen(b64) { return Buffer.from(b64, 'base64').length; }

// Waits for the server to reach a verdict. The bound is generous on purpose: an UNCANCELLED
// transfer has to be given long enough to finish, or "not finished yet" would read as
// "aborted" and the check would pass for the bug it exists to catch.
async function settled(name) {
  const uncancelledMs = (OVERSIZE / (64 * 1024)) * 4 + 4000;
  const deadline = Date.now() + uncancelledMs;
  while (!outcome[name] && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 25));
  return outcome[name] || 'still-running';
}
