#!/usr/bin/env node
// The header pill reports EXCEPTIONS, not health (issue #205).
//
// Every stock tile carried a permanent badge in its top-right corner reading LIVE, ALL UP,
// CLEAR, QUIET, LOADED or SCHEDULED — a word that was true from the moment the widget
// worked until the moment it stopped, on every tile at once. The field report is the whole
// argument: "I don't need something telling me it's a live 7-day forecast when it's really
// just a 7-day forecast." A badge that is always present is not a status, it is furniture,
// and it teaches the reader to skip the one corner a widget has to speak from.
//
// The rule now: hidden while healthy, shown only for something the reader would act on.
// So the check has to run BOTH ways, or it is satisfied by simply deleting the pill:
//
//   P1/P3 · a healthy render does NOT put the nominal word on screen
//   P2/P4 · a degraded one still does
//
// --reject matches document.innerText, which omits hidden elements, and widget-base
// uppercases pill text — so the nominal word appearing at all means the pill is showing.
//
// endpoints and ollama carry it because their stock fixtures reach a genuinely healthy
// render and a genuinely degraded one without needing credentials. The other six widgets
// changed by this rule (forecast7, ghqueue, homeassistant, kev, nextevent, wow) are covered
// for RENDERING by the 162-run stock sweep, but their nominal state is not asserted here —
// each needs configured settings plus a fixture shaped to produce it, and an unfalsifiable
// check would be worse than an absent one. Stated rather than glossed.
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const RUNNER = path.join(REPO, 'tools', 'widget-datapath.js');
const FIX = path.join(REPO, 'tests', 'fixtures', 'widgets');

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  if (!ok) failures++;
};

// One target up and one refusing: enough for "1 down" without depending on timing.
const DOWN_TARGETS = JSON.stringify({
  targets: [{ label: 'Router', url: 'http://192.168.1.1/' },
    { label: 'Old box', url: 'http://old.lan/' }],
});

const CASES = [
  { id: 'P1', widget: 'endpoints', stubs: 'endpoints.json',
    args: ['--expect', 'Router', '--reject', 'ALL UP'],
    what: 'every endpoint up leaves the corner empty' },
  { id: 'P2', widget: 'endpoints', stubs: 'endpoints.json',
    args: ['--settings', DOWN_TARGETS, '--expect', 'DOWN'],
    what: '...and an endpoint that is down still says so' },
  { id: 'P3', widget: 'ollama', stubs: 'ollama.json',
    args: ['--expect', 'llama3.1:8b', '--reject', 'LOADED'],
    what: 'models loaded and listed leaves the corner empty' },
  { id: 'P4', widget: 'ollama', stubs: 'ollama-idle.json',
    args: ['--expect', 'IDLE'],
    what: '...and a host with no models loaded still says so' },
];

for (const c of CASES) {
  let out = '';
  let ok = true;
  try {
    out = execFileSync('node', [RUNNER, path.join('widgets', c.widget),
      '--stubs', path.join(FIX, c.stubs), '--slot', 'half', ...c.args],
    { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    ok = false;
    out = (e.stdout || '') + (e.stderr || '');
  }
  // The runner's own FAIL lines are the detail worth surfacing; its PASS lines are noise.
  const bad = out.split('\n').filter((l) => l.includes('FAIL')).join(' | ').slice(0, 200);
  check(`${c.id} ${c.widget}: ${c.what}`, ok, bad || 'runner all green');
}

console.log(failures > 0 ? `\n${failures} FAILURES` : '\nALL PASS');
process.exit(failures > 0 ? 1 : 0);
