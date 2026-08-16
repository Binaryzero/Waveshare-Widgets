#!/usr/bin/env node
// Stream Deck is the widget the #221 tap-surface audit could NOT see (review of #246).
//
// The audit is shared into widget-datapath.js so populated render paths are covered — but
// Stream Deck takes no http path. Its profile, keys and live capture all arrive over the
// host bridge (ww-sd-profile / ww-sd-capture), which the runner did not answer, so
// renderPicker() and the key grid never ran: a Stream Deck data-path run reached the
// "No Virtual Stream Deck found" card and the audit passed VACUOUSLY, with no picker button
// or key to check. widget-datapath.js now answers those messages from a `--sd` fixture.
//
// This drives the populated deck and asserts it actually rendered, so the audit runs against
// real controls:
//   S1 · a multi-profile deck renders the profile PICKER (its buttons are the #picker
//        controls the audit must guard) and the KEY GRID (the .key controls), and the run is
//        green — which includes the #221 audit passing on both.
//   S2 · teeth: the audit is not vacuous — the picker/key surfaces are present in the DOM the
//        audit walked (the run reports them guarded, not "nothing to check").
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const RUNNER = path.join(REPO, 'tools', 'widget-datapath.js');
const FIX = path.join(REPO, 'tests', 'fixtures', 'widgets');

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  if (!ok) failures++;
};

// liveMode off so render() takes the icon-grid path deterministically (the fixture carries no
// capture, so it would fall through to the grid anyway, but this skips the capture poll too).
const run = () => {
  try {
    return { ok: true, out: execFileSync('node', [RUNNER, path.join('widgets', 'streamdeck'),
      '--sd', path.join(FIX, 'streamdeck-sd.json'), '--slot', 'half',
      '--settings', JSON.stringify({ liveMode: 'off' }),
      '--expect', 'Gaming', '--expect', 'Alpha'],
    { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) { return { ok: false, out: (e.stdout || '') + (e.stderr || '') }; }
};

const { ok, out } = run();
const failLines = out.split('\n').filter((l) => l.includes('FAIL')).map((l) => l.trim()).join(' | ');
const tapLine = (out.split('\n').find((l) => l.includes('#221')) || '').trim();

// S1 — the populated deck run is green. --expect Gaming asserts the PICKER rendered with more
// than one profile (renderPicker only builds buttons when profiles.length > 1, and labels
// them by name); --expect Alpha asserts the KEY GRID rendered. The green run includes the
// #221 audit, so it passed on those controls.
check('S1 a multi-profile Stream Deck renders picker + keys and passes the tap audit', ok,
  ok ? tapLine : (failLines || out.trim().split('\n').slice(-4).join(' | ').slice(0, 300)));

// S2 — the audit was NOT vacuous. It ran (the #221 line is present) and reported the surfaces
// guarded rather than there being nothing to check; combined with S1's proof that the picker
// and keys are on screen, the controls the audit walked are the real ones.
check('S2 the #221 audit ran against the populated deck (not vacuously)',
  /every tap surface is guarded against paging \(#221\)/.test(tapLine) && /all guarded/.test(tapLine),
  tapLine || 'no #221 line in runner output');

// The fixture is well-formed JSON with a multi-profile, buttoned deck — a guard against a
// silent edit that drops the picker (profiles.length back to 1) and re-hollows S1/S2.
const fixture = JSON.parse(fs.readFileSync(path.join(FIX, 'streamdeck-sd.json'), 'utf8'));
check('S0 fixture describes a multi-profile deck with keys',
  fixture.profile && fixture.profile.available && (fixture.profile.profiles || []).length > 1
    && (fixture.profile.buttons || []).length > 0,
  `${(fixture.profile && fixture.profile.profiles || []).length} profiles, ${(fixture.profile && fixture.profile.buttons || []).length} keys`);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
