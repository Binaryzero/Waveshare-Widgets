#!/usr/bin/env node
// The backoff must never schedule a poll SOONER than the configured interval. At the
// 120-minute setting the widget offers, a flat MAX_WAIT ceiling of one hour turned the
// first failure into a 60-minute delay — half the configured interval, i.e. double the
// traffic at the exact moment nothing is answering.
//
// This is arithmetic over a two-hour period, which no wall-clock probe can watch, so the
// widget's own pollDelay() is lifted out of the file and driven directly. Lifting rather
// than reimplementing is the point: a reimplementation would only ever test itself.
'use strict';
const fs = require('fs');
const file = process.argv[2];
const src = fs.readFileSync(file, 'utf8');

const consts = {};
for (const name of ['MAX_WAIT']) {
  const m = src.match(new RegExp('const\\s+' + name + '\\s*=\\s*([0-9]+)'));
  if (!m) { console.log('  could not find ' + name); process.exit(2); }
  consts[name] = Number(m[1]);
}
const body = src.match(/function pollDelay\(\)\s*\{([\s\S]*?)\n  \}/);
if (!body) { console.log('  could not lift pollDelay()'); process.exit(2); }

const cfg = { refreshMs: 0 };
let fails = 0;
const MAX_WAIT = consts.MAX_WAIT;
const pollDelay = new Function('cfg', 'fails', 'MAX_WAIT', body[1] + '\n');

let bad = 0;
console.log('   MAX_WAIT =', MAX_WAIT / 60000, 'min');
for (const minutes of [1, 5, 30, 60, 90, 120]) {
  cfg.refreshMs = minutes * 60000;
  const row = [];
  for (fails = 0; fails <= 3; fails++) {
    const d = pollDelay(cfg, fails, MAX_WAIT) / 60000;
    row.push(d);
    // The invariant: a failure can only ever make the next poll LATER.
    if (d < minutes) bad++;
  }
  console.log('   refresh ' + String(minutes).padStart(3) + ' min -> delays by consecutive failure: ' + row.join(', '));
}
console.log(bad === 0
  ? '  PASS no failure count ever schedules sooner than the configured interval'
  : '  FAIL ' + bad + ' case(s) poll HARDER after a failure than when healthy');
process.exitCode = bad === 0 ? 0 : 1;
