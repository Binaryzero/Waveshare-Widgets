#!/usr/bin/env node
// A swipe that starts inside a widget pages the dashboard (issue #257) — and a drift on the
// way to a tap still does not (issue #206).
//
// The two issues pull opposite ways and touch-action cannot serve both. #206's fix told the
// browser a widget's scrolling list and its controls never pan sideways, so a finger drifting
// a few pixels during a tap stopped changing page. But a list that fills its tile
// (notifications, jellyfin) then refused every horizontal stroke, deliberate or not, and the
// tile became a dead zone for paging. widget-api.js now recognises a real swipe by DISTANCE
// and hands it to the shell. This pins the decision, in CI, on plain Node:
//
//   R1 · a drift is not a swipe — at a FIXED 30px, not relative to the constant, so a retune
//        of SWIPE_MIN_PX cannot quietly reopen #206
//   R2 · the threshold is a boundary: one pixel under it is not a swipe, at it is
//   R3 · finger left = next page (+1), finger right = previous (-1), matching the edge strips
//   R4 · a diagonal is not a swipe — the stroke has to be clearly sideways
//   R5 · a slow press-and-slide is not a swipe, and a nonsense duration is refused
//   R6 · a native slider and anything marked data-ww-no-swipe keep their own sideways drag;
//        an ordinary button does not
//   W1-W5 · widget-api.js: only widget documents listen, the mouse is excluded, a cancelled
//        pointer (the browser took the pan) never reaches a verdict, a gesture the widget
//        claimed is left alone, and a verdict posts ww-swipe
//   W6 · the tap-surface audit (#221) exempts the detector's two listeners by a tag — and ONLY
//        those two: set in one place, wrapped around exactly pointerdown and pointerup, never
//        carried by a widget (which could otherwise use it to slip a real tap past the audit)
//   H1-H4 · shell.js: the swipe is answered only past the bridge's identity-and-origin check,
//        never in edit mode, only from a widget on the page being shown, and pages by one
//   F1 · falsification — the pre-#257 behaviour fails R-checks it must fail
//
// The browser half — real touch events in real Chromium, the notifications list, the eye —
// is tests/harness/touchpan-run.js (S1-S5, and T3/T9 rebased to the drift they guard).
//
// The rule is loaded OUT OF widget-api.js between markers and executed, not transcribed.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SHELL = path.join(__dirname, '..', '..', 'src', 'Plinth', 'Shell');
const API = fs.readFileSync(path.join(SHELL, 'widget-api.js'), 'utf8');
const SH = fs.readFileSync(path.join(SHELL, 'shell.js'), 'utf8');

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  if (!ok) failures++;
};

function loadRule() {
  const a = API.indexOf('// >>> ww-swipe-rule');
  const b = API.indexOf('// <<< ww-swipe-rule');
  if (a < 0 || b < 0) return null;
  const ctx = { module: {} };
  vm.createContext(ctx);
  try {
    vm.runInContext(API.slice(a, b)
      + '\nmodule.exports = { swipeDirection, ownsHorizontalDrag, SWIPE_MIN_PX, SWIPE_MAX_MS };', ctx);
  } catch (e) {
    console.log(`  FAIL L0 setup: the ww-swipe-rule block did not evaluate — ${e.message}`);
    return null;
  }
  const m = ctx.module.exports;
  if (typeof m.swipeDirection !== 'function' || typeof m.ownsHorizontalDrag !== 'function') return null;
  return m;
}

// Before #257 nothing inside a widget recognised a swipe at all.
const LEGACY = { swipeDirection: () => 0, ownsHorizontalDrag: () => false, SWIPE_MIN_PX: NaN, SWIPE_MAX_MS: NaN };

// Just enough of an Element for the ancestor walk.
function el(tag, { type, attrs = [], parent = null } = {}) {
  return { nodeType: 1, tagName: tag, type, parentElement: parent, hasAttribute: (n) => attrs.includes(n) };
}

function runRule(r, label) {
  console.log(`\n== ${label}`);
  const { swipeDirection: dir, ownsHorizontalDrag: owns } = r;

  // ---- R1 · #206: a drift is never a swipe -----------------------------------------------
  const drifts = [[5, 1, 120], [-5, 0, 120], [30, 0, 150], [-30, 2, 150]];
  check('R1 a drift (5px, 30px — fixed, not relative to the constant) is not a swipe',
    drifts.every(([dx, dy, dt]) => dir(dx, dy, dt) === 0),
    drifts.map(([dx, dy, dt]) => `${dx}px->${dir(dx, dy, dt)}`).join(' '));

  // ---- R2 · the threshold is a boundary ------------------------------------------------------
  const T = r.SWIPE_MIN_PX;
  check('R2 one pixel under the threshold is not a swipe; at it, it is',
    dir(-(T - 1), 0, 200) === 0 && dir(-T, 0, 200) === 1, `threshold ${T}px`);

  // ---- R3 · direction --------------------------------------------------------------------
  check('R3 finger left asks for the next page, finger right for the previous',
    dir(-160, 0, 250) === 1 && dir(160, 0, 250) === -1,
    `left ${dir(-160, 0, 250)}, right ${dir(160, 0, 250)}`);

  // ---- R4 · clearly sideways -----------------------------------------------------------------
  check('R4 a diagonal is not a swipe (160 across, 100 down)', dir(-160, 100, 250) === 0,
    String(dir(-160, 100, 250)));
  check('R4b ...but a stroke at exactly twice as wide as tall is', dir(-160, 80, 250) === 1,
    String(dir(-160, 80, 250)));

  // ---- R5 · duration -------------------------------------------------------------------------
  const M = r.SWIPE_MAX_MS;
  check('R5 a slow press-and-slide is not a swipe', dir(-160, 0, M + 1) === 0 && dir(-160, 0, M) === 1,
    `max ${M}ms`);
  check('R5b a nonsense duration or distance is refused, not thrown on',
    [[-160, 0, -1], [-160, 0, NaN], [NaN, 0, 200], [-160, NaN, 200]].every(([a, b, c]) => dir(a, b, c) === 0));

  // ---- R6 · controls that own a sideways drag ------------------------------------------------
  const body = el('BODY');
  const slider = el('INPUT', { type: 'range', parent: body });
  const marked = el('DIV', { attrs: ['data-ww-no-swipe'], parent: body });
  const insideMarked = el('SPAN', { parent: marked });
  const button = el('BUTTON', { parent: body });
  const text = el('INPUT', { type: 'text', parent: body });
  check('R6 a native slider keeps its drag', owns(slider) === true);
  check('R6b anything inside a data-ww-no-swipe element keeps its drag', owns(insideMarked) === true);
  check('R6c an ordinary button or text field does not — a stroke from it still pages',
    owns(button) === false && owns(text) === false);
  check('R6d a missing target is not an error', owns(null) === false);
}

const real = loadRule();
check('L0 setup: widget-api.js exposes a runnable swipe rule', !!real,
  real ? 'loaded and executed from source' : 'no ww-swipe-rule block — falling back to pre-fix behaviour');
runRule(real || LEGACY, 'widget-api.js — the swipe rule');

// ---- W · the detector's wiring in widget-api.js --------------------------------------------
console.log('\n== widget-api.js — the detector');
const detStart = API.indexOf('// <<< ww-swipe-rule');
const detEnd = API.indexOf('window.WW = WW;', detStart);
const det = detStart < 0 || detEnd < 0 ? '' : API.slice(detStart, detEnd);
check('W1 only widget documents listen — the #ww-slot= marker, and a parent to talk to',
  /if \(window\.parent !== window && \/ww-slot=\/\.test\(location\.hash\)\)/.test(det));
check('W2 a mouse drag is not a swipe', /ev\.pointerType === 'mouse'/.test(det));
check('W3 a cancelled pointer — the browser took the pan — never reaches a verdict',
  /addEventListener\('pointercancel'[\s\S]{0,160}stroke = null/.test(det));
check('W4 a gesture the widget prevented is left to the widget',
  /ev\.defaultPrevented\) stroke\.claimed = true/.test(det) && /if \(s\.claimed\) return;/.test(det));
check('W5 a verdict posts ww-swipe with the direction', /type: 'ww-swipe', dir/.test(det));

// ---- W6 · the audit exemption stays exactly as wide as the detector --------------------------
const AUDIT = fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'tap-audit.js'), 'utf8');
const WIDGETS = path.join(__dirname, '..', '..', 'widgets');
const widgetHits = fs.readdirSync(WIDGETS)
  .map((d) => path.join(WIDGETS, d, 'index.html'))
  .filter((f) => fs.existsSync(f) && /__wwStrokeObserver|strokeObserver/.test(fs.readFileSync(f, 'utf8')))
  .map((f) => path.basename(path.dirname(f)));
const wrapped = [...det.matchAll(/addEventListener\('(\w+)', strokeObserver\(/g)].map((m) => m[1]);
check('W6 the audit honours the stroke-observer tag',
  /TAP\[type\] && !\(listener && listener\.__wwStrokeObserver\)/.test(AUDIT));
check('W6b ...which is set in exactly one place in widget-api.js',
  (API.match(/__wwStrokeObserver = true/g) || []).length === 1);
check('W6c ...and wraps exactly the detector\'s pointerdown and pointerup, nothing else',
  wrapped.length === 2 && wrapped.includes('pointerdown') && wrapped.includes('pointerup')
    && (API.match(/strokeObserver\(\(/g) || []).length === 2,
  `wrapped [${wrapped}]`);
check('W6d ...and no widget carries it', widgetHits.length === 0, widgetHits.join(', ') || 'none');

// ---- H · the shell's answer ---------------------------------------------------------------
console.log('\n== shell.js — the answer');
const originGate = SH.indexOf('if (!sender.origin || ev.origin !== sender.origin) return;');
const branch = SH.indexOf("msg.type === 'ww-swipe'");
const branchBody = branch < 0 ? '' : SH.slice(branch, SH.indexOf('} else if', branch + 10));
check('H1 the swipe is answered only past the bridge\'s identity-and-origin check',
  originGate > 0 && branch > originGate, `origin gate @${originGate}, ww-swipe @${branch}`);
check('H2 only a direction of exactly +1 or -1 is accepted',
  /msg\.dir === 1 \|\| msg\.dir === -1/.test(branchBody));
check('H3 never in edit mode, and only from a widget on the page being shown',
  /if \(editing \|\| sender\.page !== layoutData\.pages\[editIndex\(\)\]\) return;/.test(branchBody));
check('H4 it pages by one from where the dashboard is headed',
  /goToPage\(editIndex\(\) \+ msg\.dir\)/.test(branchBody));

// ---- F1 · falsification --------------------------------------------------------------------
// Run the checks that define #257 against the pre-fix behaviour and require them to fail, so a
// green file cannot mean one that tests nothing.
console.log('\n== falsification — the pre-#257 behaviour');
const before = failures;
const quiet = console.log;
console.log = () => {};
runRule(LEGACY, 'legacy');
console.log = quiet;
const legacyFailed = failures - before;
failures = before;
check('F1 the pre-fix behaviour fails the swipe checks (a real stroke never paged)',
  legacyFailed >= 2, `${legacyFailed} checks fail against it`);

console.log(failures > 0 ? `\n${failures} FAILURES` : '\nALL PASS');
process.exit(failures > 0 ? 1 : 0);
