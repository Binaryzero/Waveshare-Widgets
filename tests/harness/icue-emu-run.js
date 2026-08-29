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
//        qrc-left:none   — every Qt-resource (`qrc:`) @font-face was defused. Chromium
//                          cannot load that scheme and logs a "Fallback font will be
//                          used" intervention per waiting element — hundreds of lines
//                          from one widget. The probe plants three, in the three places
//                          a sweep can miss: top level, inside an @media group (not
//                          itself a FONT_FACE_RULE, so a type test on the outermost
//                          rule never sees it), and in a <style> appended 1.4 s after
//                          load, past every scheduled sweep. The marker names the
//                          survivors, so a regression says WHICH placement broke.
//   E2 · teeth for the Stream Deck path: the --sd fixture was actually served (the
//        runner's own "profile was served" check is part of the green run).
//   E3 · wiring, text-level (the pattern tools/StreamDeckPaths uses for what a Node
//        harness cannot execute): the click phase field crosses every hop — the shim
//        sends phase down/up, shell.js forwards it validated, DashboardWindow passes
//        it through, and StreamDeckBridge holds/releases with a safety release.
//   E5 · the two deck kinds are not the same deck. iCUE's Streamdeck plugin is a NETWORK
//        client of a VSD2/WiFi device: its profile is on disk (so grid, titles and static
//        faces mirror) but its live faces and key presses travel over Elgato's paired
//        network protocol, and there is no window here to capture or click. So the same
//        probe, against a fixture marked interactive:false, must still announce the deck
//        and paint its faces while making ZERO capture polls and ZERO clicks — the
//        fixture carries a capture frame precisely so that a shim which polls anyway
//        would slice it and look right. The window-deck run above asserts the opposite
//        direction, or a shim that simply refused everything would pass both.
//   E4 · the helper bundle is DEFINED, not fetched, and is injected everywhere the
//        other two shims are. Serving those files over their clamped URLs was tried
//        first and failed in the field — the classes were still undefined on a build
//        carrying the hook, and a filter miss and a missing file present as the same
//        silent 404. The probe widget's <script src="../common/…"> tags 404 here on
//        purpose: that IS the device condition, and the markers above passing proves
//        the globals alone carry it.
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
  'live-tiles', 'qrc-left:none'];

// icue-sd.json, not streamdeck-sd.json: same deck plus a capture frame, so the
// slice-into-per-key-faces path runs (the capture poll fires at 500ms — the --wait
// below leaves it room).
const run = (fixture, markers, wait) => {
  try {
    return { ok: true, out: execFileSync('node', [RUNNER,
      path.join('tests', 'fixtures', 'widgets', 'icue-emu'),
      '--sd', path.join(FIX, fixture), '--slot', 'half', '--wait', String(wait || 2500),
      ...markers.flatMap((m) => ['--expect', m])],
    { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) { return { ok: false, out: (e.stdout || '') + (e.stderr || '') }; }
};

// `stream-deck clicks: N` / `stream-deck captures: N` from the runner — what the widget
// actually posted to the host, which is the only place the two deck kinds differ
// observably. Absent counts read as -1 so a runner that stopped reporting fails loudly
// rather than satisfying a zero-check by silence.
const count = (out, label) => {
  const m = new RegExp('stream-deck ' + label + ': (\\d+)').exec(out);
  return m ? Number(m[1]) : -1;
};

const { ok, out } = run('icue-sd.json', MARKERS, 3500);
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

// E4 — the bundle defines every helper the stock widgets construct, and every surface
// that injects the other two shims injects it too. A helper added to one and not the
// other is the failure this replaced: silent, and only visible on a real device.
const bundle = fs.readFileSync(path.join(REPO, 'src', 'Plinth', 'Shell', 'icue-common.js'), 'utf8');
const HELPERS = ['IcueWidgetApiWrapper', 'SimpleSensorApiWrapper', 'SimpleMediaApiWrapper',
  'SimpleFpsApiWrapper', 'SimpleNotificationsApiWrapper', 'hexToRGB', 'DateFormatter',
  'TickerTracker', 'MediaViewer'];
const undefined_ = HELPERS.filter((h) => !bundle.includes('window.' + h + ' ='));
check('E4 the bundle defines every helper, as a window property (vendored copies shadow)',
  undefined_.length === 0, undefined_.length ? 'missing: ' + undefined_.join(', ') : `${HELPERS.length} helpers`);

const injectors = ['src/Plinth/App/DashboardWindow.cs', 'src/Plinth/App/SettingsWindow.cs',
  'tools/widget-harness.js', 'tools/widget-datapath.js'];
const notInjecting = injectors.filter((f) =>
  !fs.readFileSync(path.join(REPO, f), 'utf8').includes('icue-common.js'));
check('E4b every surface that injects the shims injects the bundle',
  notInjecting.length === 0, notInjecting.join(', ') || injectors.length + ' surfaces');

// The positive direction, from the window-deck run above. Without it, a shim that
// refused to click and refused to capture unconditionally would satisfy E5 completely.
check('E4c a window-backed deck is captured and clicked',
  count(out, 'clicks') > 0 && count(out, 'captures') > 0,
  `${count(out, 'clicks')} click(s), ${count(out, 'captures')} capture poll(s)`);

// E5 — the same probe against the deck iCUE creates.
const NET_MARKERS = ['device-created', 'icons:3'];
const net = run('icue-sd-network.json', NET_MARKERS);
const netFailLines = net.out.split('\n').filter((l) => l.includes('FAIL')).map((l) => l.trim()).join(' | ');

check('E5 a network deck still announces itself and paints its faces from the profile',
  net.ok, net.ok ? NET_MARKERS.join(', ')
    : (netFailLines || net.out.trim().split('\n').slice(-4).join(' | ').slice(0, 300)));

// The two teeth. A press posted here reaches a host that finds no window, logs a warning
// the widget never sees, and leaves a grid of keys that look live and do nothing.
check('E5b no key press is posted for a deck with no window to click',
  count(net.out, 'clicks') === 0, count(net.out, 'clicks') + ' click(s)');
// And the capture poll runs twice a second, forever, for a frame that cannot exist.
check('E5c no capture poll is made for a deck with no window to capture',
  count(net.out, 'captures') === 0, count(net.out, 'captures') + ' capture poll(s)');

// E5e — the kind crosses every hop, text-level, in the style of E3. The behaviour above
// is driven through a FIXTURE, so it proves the shim honours the flag; it cannot prove the
// host ever sets it, and a host that never does would leave the shim permanently in the
// interactive default.
check('E5d the deck kind crosses every hop (bridge → host → shim)',
  /IsLocalWindowModel\(model\)/.test(bridge)          // the bridge decides it from the model
    && /\["interactive"\] = profile\.Interactive/.test(dash)   // the host ships it
    && /profile\.interactive !== false/.test(shim)      // the shim adopts it, defaulting safe
    && /sdState\.interactive\) sdState\.captureTimer/.test(shim)  // …and gates the capture poll
    && /if \(!sdState\.interactive\)/.test(shim));      // …and the presses

// A host older than this field only ever mirrored window decks, so absent must read as
// interactive. Reading it as read-only would drop the presses that host CAN deliver.
check('E5e a profile with no kind field is treated as clickable, not as read-only',
  /profile\.interactive !== false/.test(shim) && !/profile\.interactive === true/.test(shim));

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
