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
//   S3 · a readable profile is not a pressable deck. The profile is read from DISK, so the
//        keys render just as well when the user has closed their Virtual Stream Deck — and
//        the press needs the window. The capture reply used to be what noticed this, which
//        left live mode OFF with no signal at all: keys stayed live-looking and every tap
//        vanished. The profile poll carries it now, so both modes refuse the tap.
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
const run = (fixture, settings, expects) => {
  try {
    const args = [RUNNER, path.join('widgets', 'streamdeck'),
      '--sd', path.join(FIX, fixture), '--slot', 'half'];
    if (settings) args.push('--settings', JSON.stringify(settings));
    return { ok: true, out: execFileSync('node',
      [...args, ...expects.flatMap((e) => ['--expect', e])],
    { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) { return { ok: false, out: (e.stdout || '') + (e.stderr || '') }; }
};

const { ok, out } = run('streamdeck-sd.json', { liveMode: 'off' }, ['Gaming', 'Alpha']);
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

// S3 — the same deck with its window shut, live mode OFF: the mode that had no signal at
// all before, so the keys rendered and the taps went nowhere. They must still render —
// the faces are real — and the tap must be refused.
const shut = run('streamdeck-sd-nowindow.json', { liveMode: 'off' }, ['Gaming', 'Alpha']);
const shutFail = shut.out.split('\n').filter((l) => l.includes('FAIL')).map((l) => l.trim()).join(' | ');
check('S3 a deck with its window shut still renders its picker and keys', shut.ok,
  shut.ok ? 'picker + keys'
    : (shutFail || shut.out.trim().split('\n').slice(-4).join(' | ').slice(0, 300)));

// S3b — text-level: this runner does not tap, so the guard is asserted where it lives.
// A click posted here is fire-and-forget — the host logs a warning nobody sees and the
// key looks pressed.
const widget = fs.readFileSync(path.join(REPO, 'widgets', 'streamdeck', 'index.html'), 'utf8');
check('S3b a tap is refused when no deck window is open, in either live mode',
  /lastProfile\.windowAvailable === false/.test(widget)
    && /flash\(cell, 'fail-flash'\)/.test(widget));

// S3c — and the fixture really does describe a shut window, or S3/S3b test nothing.
const shutFixture = JSON.parse(fs.readFileSync(path.join(FIX, 'streamdeck-sd-nowindow.json'), 'utf8'));
check('S3c the fixture is a readable profile whose window is NOT open',
  shutFixture.profile && shutFixture.profile.available === true
    && shutFixture.profile.windowAvailable === false
    && (shutFixture.profile.buttons || []).length > 0,
  shutFixture.profile ? `${(shutFixture.profile.buttons || []).length} keys` : 'no profile');

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
