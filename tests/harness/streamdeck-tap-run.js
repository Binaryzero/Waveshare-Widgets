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
//   S3 · the deck iCUE creates is a NETWORK device (model VSD2/WiFi): its profile is on disk,
//        so the same picker and the same keys render, but it has no window on this desktop to
//        capture or to click. Rendering it identically and saying nothing would be the worst
//        outcome — a deck that looks live and whose buttons do nothing — so the widget must
//        say it is read-only, must not run the capture loop, and must refuse the tap.
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

// What the widget actually posted to the host — the only place "did not poll" is visible.
// Absent reads as -1 so a runner that stops reporting fails loudly instead of passing a
// zero-check by silence.
const count = (out, label) => {
  const m = new RegExp('stream-deck ' + label + ': (\\d+)').exec(out);
  return m ? Number(m[1]) : -1;
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

// S3 — the network deck. No --settings, so live mode is on by default: that is what makes
// S3b mean something, since an off switch would suppress the capture poll for the wrong
// reason. Same picker, same keys, plus the banner that says the buttons are not live.
const net = run('streamdeck-sd-network.json', null, ['Gaming', 'Alpha', 'Read-only']);
const netFail = net.out.split('\n').filter((l) => l.includes('FAIL')).map((l) => l.trim()).join(' | ');
check('S3 a network deck renders picker and keys, and says it is read-only', net.ok,
  net.ok ? 'picker + keys + banner'
    : (netFail || net.out.trim().split('\n').slice(-4).join(' | ').slice(0, 300)));

// S3b — with live mode ON, a deck with no window must still make no capture poll. Otherwise
// the widget asks for a screenshot of nothing several times a second for as long as it runs.
check('S3b live mode makes no capture poll for a deck with no window',
  count(net.out, 'captures') === 0, count(net.out, 'captures') + ' capture poll(s)');

// The positive direction, or S3b would pass on a widget that never captures anything.
const live = run('streamdeck-sd.json', null, ['Gaming', 'Alpha']);
check('S3c live mode DOES poll for capture on an ordinary window-backed deck',
  live.ok && count(live.out, 'captures') > 0,
  count(live.out, 'captures') + ' capture poll(s)');

// S3d — text-level, in the style of E3 in icue-emu-run: a tap is not driven by this runner,
// so the guard is asserted where it lives. A click posted for a network deck is
// fire-and-forget — the host logs a warning the user never sees and the key looks pressed.
const widget = fs.readFileSync(path.join(REPO, 'widgets', 'streamdeck', 'index.html'), 'utf8');
check('S3d a key tap is refused for a read-only deck, the same way a vanished deck is',
  /lastProfile\.interactive === false/.test(widget) && /flash\(cell, 'fail-flash'\)/.test(widget));

// S0b — and the fixture really is the network variant, or S3/S3b test nothing.
const netFixture = JSON.parse(fs.readFileSync(path.join(FIX, 'streamdeck-sd-network.json'), 'utf8'));
check('S0b the network fixture is a readable profile that is NOT interactive',
  netFixture.profile && netFixture.profile.available === true
    && netFixture.profile.interactive === false
    && (netFixture.profile.buttons || []).length > 0,
  netFixture.profile ? `model ${netFixture.profile.model}` : 'no profile');

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
