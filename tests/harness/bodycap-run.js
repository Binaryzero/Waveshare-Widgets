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
//
// Runs on plain Node — no Playwright — so it runs in CI beside the C# probes. Node's fetch
// gives real Response streams, a real reader, and a real cancel that tears the connection
// down, which is every primitive the script depends on. What that does NOT cover is
// Chromium/WebView2 specifically; the generated script is syntax-checked separately, and
// the platform is not reachable from here in any case.
'use strict';
const fs = require('fs');
const http = require('http');

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
    const total = Number(url.searchParams.get('bytes') || 0);
    const declare = url.searchParams.get('declare') === '1';
    sent[name] = 0;
    const headers = { 'Content-Type': 'application/octet-stream', 'Access-Control-Allow-Origin': '*' };
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
