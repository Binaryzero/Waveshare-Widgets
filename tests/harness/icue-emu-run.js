#!/usr/bin/env node
// The iCUE compatibility surface, driven end-to-end through the real shims (PR: iCUE
// stock-widget compatibility). Every check here is a failure mode the Corsair stock
// widget dump exposed — each one blanked or froze a real widget:
//
//   E1 · the probe widget runs and every marker renders. Each marker is one repair:
//        module-alive    — `icueEvents = {…}` in a <script type=module> (strict mode)
//                          needs the predeclared global; without it the module dies on
//                          its first statement (Calendar, Sensor, SensorList).
//        mediaviewer-ok  — the shared-common escape (../common/…) serves the
//                          Plinth-authored MediaViewer instead of 404ing into a
//                          top-level ReferenceError (every stock widget).
//        hex:255, 0, 57  — ColorTools serves and returns the "r, g, b" triple the
//                          widgets interpolate into rgb()/rgba().
//        tr-then:…       — tr() is thenable (stock code calls tr('AM').then(...)) AND
//                          the i18next-nested translation.json shape resolves.
//        notif:0         — the Notificationsprovider emulation answers the wrapper's
//                          requestId/asyncResponse round trip.
//        device-created  — the Streamdeck plugin emulation announces the deck from
//                          the ww-sd-profile bridge.
//        icons:3         — per-key buttonIconUpdated pushes arrive (title tiles
//                          generated for image-less profile keys).
//        click-sent      — sendKeyPress(down)+sendKeyPress(up) completed against the
//                          mirrored grid.
//        live-tiles      — the fixture's capture frame was sliced into per-key PNG
//                          faces (the dynamic-key-face path replacing profile icons).
//   E2 · teeth for the Stream Deck path: the --sd fixture was actually served (the
//        runner's own "profile was served" check is part of the green run).
//   E3 · wiring, text-level (the pattern tools/StreamDeckPaths uses for what a Node
//        harness cannot execute): the click phase field crosses every hop — the shim
//        sends phase down/up, shell.js forwards it validated, DashboardWindow passes
//        it through, and StreamDeckBridge holds/releases with a safety release.
//   E4 · the compat whitelist and the shipped files agree: every path
//        IcueCommonAssets.cs offers exists under Shell/icue-common (a rename in one
//        place must not silently 404 on the device).
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

const MARKERS = ['module-alive', 'mediaviewer-ok', 'hex:255, 0, 57',
  'tr-then:Compat says hello', 'notif:0', 'device-created', 'icons:3', 'click-sent',
  'live-tiles'];

// icue-sd.json, not streamdeck-sd.json: same deck plus a capture frame, so the
// slice-into-per-key-faces path runs (the capture poll fires at 500ms — the --wait
// below leaves it room).
const run = () => {
  try {
    return { ok: true, out: execFileSync('node', [RUNNER,
      path.join('tests', 'fixtures', 'widgets', 'icue-emu'),
      '--sd', path.join(FIX, 'icue-sd.json'), '--slot', 'half', '--wait', '2500',
      ...MARKERS.flatMap((m) => ['--expect', m])],
    { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) { return { ok: false, out: (e.stdout || '') + (e.stderr || '') }; }
};

const { ok, out } = run();
const failLines = out.split('\n').filter((l) => l.includes('FAIL')).map((l) => l.trim()).join(' | ');

// E1 — the probe ran green, which includes every marker's --expect and the runner's
// own no-page-errors check (a strict-mode ReferenceError would fail both).
check('E1 iCUE probe widget renders every compatibility marker', ok,
  ok ? `${MARKERS.length} markers` : (failLines || out.trim().split('\n').slice(-4).join(' | ').slice(0, 300)));

// E2 — the deck data actually flowed (part of the same green run, called out so a
// future change to the runner's served-check cannot hollow E1 silently).
check('E2 the --sd fixture profile was served to the probe',
  ok && /Stream Deck profile was actually served|stubbed endpoint or Stream Deck profile/.test(out),
  (out.split('\n').find((l) => l.includes('served')) || '').trim());

// E3 — phase plumbing exists at every hop. Text-level: the C# half cannot execute here.
const shim = fs.readFileSync(path.join(REPO, 'src', 'Plinth', 'Shell', 'icue-compat.js'), 'utf8');
const shell = fs.readFileSync(path.join(REPO, 'src', 'Plinth', 'Shell', 'shell.js'), 'utf8');
const dash = fs.readFileSync(path.join(REPO, 'src', 'Plinth', 'App', 'DashboardWindow.cs'), 'utf8');
const bridge = fs.readFileSync(path.join(REPO, 'src', 'Plinth', 'App', 'StreamDeckBridge.cs'), 'utf8');
check('E3 click phase crosses every hop (shim → shell → host → bridge)',
  /phase: pressed \? 'down' : 'up'/.test(shim)
    && /msg\.phase === 'down' \|\| msg\.phase === 'up'/.test(shell)
    && /is "down" or "up"/.test(dash)
    && /ReleasePendingPress/.test(bridge) && /_pressSafety/.test(bridge));

// E4 — whitelist ↔ files agreement. The Provided list is parsed out of the C# source
// so a path added there without a file (or renamed on one side only) fails here.
const assets = fs.readFileSync(path.join(REPO, 'src', 'Plinth', 'App', 'IcueCommonAssets.cs'), 'utf8');
const provided = [...assets.matchAll(/"((?:plugins|tools)\/[^"]+)"/g)].map((m) => m[1]);
const missing = provided.filter((p) =>
  !fs.existsSync(path.join(REPO, 'src', 'Plinth', 'Shell', 'icue-common', ...p.split('/'))));
check('E4 every whitelisted compat asset ships in Shell/icue-common',
  provided.length >= 11 && missing.length === 0,
  missing.length ? 'missing: ' + missing.join(', ') : `${provided.length} assets`);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
