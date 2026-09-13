#!/usr/bin/env node
// A removal made in the settings window's PREVIEW retires the tile, on the same retire
// path the form's own ✕ uses (#226, and the scope cut withdrawn from PR #269).
//
// The preview is a replica shell handed every credential BLANKED, so it cannot author
// an attic entry worth keeping: a def retired there arrives with an empty secret and no
// way back to the value the user typed — reuniting them would need the "sole id-less
// slot of this widget" guess #68 forbids. So the replica names the slot and the settings
// window retires it, against the unscrubbed working copy. The defect being pinned is
// SILENT CREDENTIAL LOSS on one side and a WRONG SPLICE on the other, so every check
// below is about what ends up in the attic and what ends up on the page:
//
//   A1  · the credential in the attic is the one in the working copy, not the blank
//   A1b · the attic holds a deep copy, so later page edits cannot reach the retired bytes
//   A2  · no instanceId is ever seated in both pages and retained (the twin state
//         tools/SecretRoundTrip R6 punishes by blanking the LIVE credential)
//   A3  · a stale generation is refused whole — never half-applied
//   A4  · an armed replica timer is refused (this is the double-tap guard)
//   A5  · an identity mismatch is refused, and a replica-minted id is never adopted (#68)
//   A6  · every bad index is refused, -1 above all: removeSlotAt splices
//         unconditionally, so splice(-1, 1) would DISCARD the last tile on the page
//   A7  · when a mint is needed the LIVE def is stamped first, then copied
//   A8  · the selection cursor follows the removal
//   A9  · falsification — A1 and A2 must FAIL against the pre-fix behaviour
//
// The pair under test is loaded OUT OF settings.js and executed, not transcribed here.
// A transcription would let a regression in the real commit leave every assertion below
// green; see the header of listprims-run.js for the version of this harness that made
// exactly that mistake. If the markers or either name go away this fails at L0.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SHELL = path.join(__dirname, '..', '..', 'src', 'Plinth', 'Shell');

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  if (!ok) failures++;
};

// ---- the sandbox ------------------------------------------------------------------
// Exactly the seven free variables the marker comment promises. Anything the block
// reaches for beyond these throws at call time and the run goes red, which is the
// constraint working as intended rather than a harness bug to paper over.
function loadPair() {
  const src = fs.readFileSync(path.join(SHELL, 'settings.js'), 'utf8');
  const a = src.indexOf('// >>> ww-replica-remove');
  const b = src.indexOf('// <<< ww-replica-remove');
  if (a < 0 || b < 0) return null;
  const ctx = {
    module: {},
    state: { layout: null },
    replicaTimer: null,
    initGen: 7,
    instanceSeq: 0,
    selectedSlot: null,
    renderEditor: () => { ctx.renderEditorCalls++; },
    renderPageList: () => { ctx.renderPageListCalls++; },
    renderEditorCalls: 0,
    renderPageListCalls: 0,
  };
  vm.createContext(ctx);
  try {
    vm.runInContext(src.slice(a, b) + '\nmodule.exports = { onReplicaRemove, removeSlotAt };', ctx);
  } catch (e) {
    console.log(`  FAIL L0 setup: the ww-replica-remove block did not evaluate — ${e.message}`);
    return null;
  }
  const m = ctx.module.exports;
  if (typeof m.onReplicaRemove !== 'function' || typeof m.removeSlotAt !== 'function') return null;
  ctx.onReplicaRemove = m.onReplicaRemove;
  return ctx;
}

// The pre-fix behaviour, for the falsification run: the preview's removal reached the
// settings side only as a whole-layout capture whose attic was dropped on the floor, so
// the net effect on state.layout was a splice and nothing else — the tile's config, and
// its credential, simply gone.
function legacyCtx() {
  const ctx = {
    state: { layout: null }, replicaTimer: null, initGen: 7, instanceSeq: 0,
    selectedSlot: null, renderEditorCalls: 0, renderPageListCalls: 0,
  };
  ctx.onReplicaRemove = (pageIdx, slotIdx) => {
    const page = ctx.state.layout && (ctx.state.layout.pages || [])[pageIdx];
    if (!page || !(page.slots || [])[slotIdx]) return;
    page.slots.splice(slotIdx, 1);
    ctx.renderEditorCalls++;
  };
  return ctx;
}

// A page holding one credentialed tile, rebuilt per case so no assertion inherits state.
function seed(ctx, slot) {
  ctx.state.layout = {
    pages: [{ name: 'Main', slots: [slot || {
      widgetId: 'gh', instanceId: 'gh1',
      settings: { token: 'ghp_TYPED', label: 'Repo' },
      secretsSet: ['token'], secretsCleared: ['other'],
    }] }],
  };
  ctx.replicaTimer = null;
  ctx.selectedSlot = null;
  ctx.renderEditorCalls = 0;
  ctx.renderPageListCalls = 0;
  return ctx.state.layout.pages[0];
}

const atticOf = (ctx) => (ctx.state.layout && ctx.state.layout.retained) || [];

// ====================================================================================
console.log('\n== settings.js — the one retire path');
const real = loadPair();
check('L0 setup: settings.js exposes a runnable onReplicaRemove + removeSlotAt',
  !!real, real ? 'loaded and executed from source' : 'no ww-replica-remove block — falling back to pre-fix behaviour');
const ctx = real || legacyCtx();

// ---- A1 · the credential survives the retire ---------------------------------------
{
  const page = seed(ctx);
  ctx.onReplicaRemove(0, 0, 'gh1', ctx.initGen);
  const att = atticOf(ctx);
  check('A1 the tile left the page and landed in the attic',
    page.slots.length === 0 && att.length === 1, `slots=${page.slots.length} attic=${att.length}`);
  const def = att[0] && att[0].def;
  check('A1a ...carrying the WORKING COPY credential, not the replica\'s blank',
    !!def && def.settings && def.settings.token === 'ghp_TYPED',
    def && def.settings ? JSON.stringify(def.settings.token) : 'no def');
  check('A1b ...under the live slot\'s own identity',
    !!def && def.instanceId === 'gh1', def && def.instanceId);
  check('A1c ...with secretsCleared verbatim (the only channel ReadRetainedClearedMarkers reads)',
    !!def && JSON.stringify(def.secretsCleared) === JSON.stringify(['other']),
    def && JSON.stringify(def.secretsCleared));
  check('A1d ...stamped with originPage and a parseable retiredAt',
    !!att[0] && att[0].originPage === 'Main' && !Number.isNaN(Date.parse(att[0].retiredAt)),
    att[0] && `${att[0].originPage} @ ${att[0].retiredAt}`);
  check('A1e the editor and the page strip were both repainted exactly once',
    ctx.renderEditorCalls === 1 && ctx.renderPageListCalls === 1,
    `editor=${ctx.renderEditorCalls} strip=${ctx.renderPageListCalls}`);
}

// ---- A1b · the attic holds a COPY ---------------------------------------------------
{
  const page = seed(ctx);
  const live = page.slots[0];
  ctx.onReplicaRemove(0, 0, 'gh1', ctx.initGen);
  live.settings.token = 'ghp_MUTATED_AFTER';
  const def = (atticOf(ctx)[0] || {}).def;
  check('A1f mutating the source afterwards cannot reach the retired bytes',
    !!def && def.settings.token === 'ghp_TYPED', def && def.settings.token);
}

// ---- A2 · no twin seating -----------------------------------------------------------
{
  const page = seed(ctx);
  page.slots.push({ widgetId: 'gh', instanceId: 'gh2', settings: { token: 'ghp_TWO' } });
  ctx.onReplicaRemove(0, 0, 'gh1', ctx.initGen);
  ctx.onReplicaRemove(0, 0, 'gh2', ctx.initGen);   // gh2 slid down to index 0
  const liveIds = page.slots.map((s) => s.instanceId);
  const atticIds = atticOf(ctx).map((e) => e.def.instanceId);
  const both = atticIds.filter((id) => liveIds.includes(id));
  check('A2 no instanceId is seated in both pages and retained',
    both.length === 0, `live=[${liveIds}] attic=[${atticIds}]`);
  check('A2b both retires landed, each exactly once',
    atticIds.length === 2 && new Set(atticIds).size === 2, `attic=[${atticIds}]`);
}

// ---- A3/A4 · staleness is refused WHOLE ---------------------------------------------
for (const [label, arm] of [['A3 a stale generation', (c) => { c.__gen = c.initGen - 1; }],
                            ['A4 an armed replica timer', (c) => { c.replicaTimer = 1; }]]) {
  const page = seed(ctx);
  ctx.__gen = ctx.initGen;
  arm(ctx);
  const before = JSON.stringify(ctx.state.layout);
  ctx.onReplicaRemove(0, 0, 'gh1', ctx.__gen);
  check(`${label} is refused, and refused whole`,
    JSON.stringify(ctx.state.layout) === before && ctx.renderEditorCalls === 0,
    `mutated=${JSON.stringify(ctx.state.layout) !== before} repaints=${ctx.renderEditorCalls}`);
}

// ---- A5 · identity (#68) -------------------------------------------------------------
{
  const page = seed(ctx);
  const before = JSON.stringify(ctx.state.layout);
  ctx.onReplicaRemove(0, 0, 'gh-WRONG', ctx.initGen);
  check('A5 an identity mismatch is refused',
    JSON.stringify(ctx.state.layout) === before, 'layout unchanged');
}
{
  // The case the withdrawn union died on: our slot is id-less and the replica names an
  // id it minted itself. There must be no branch that adopts it — that inference is
  // byte-indistinguishable from "deleted the credentialed tile, added a fresh one".
  const page = seed(ctx, { widgetId: 'gh', settings: { token: 'ghp_LEGACY' } });
  const before = JSON.stringify(ctx.state.layout);
  ctx.onReplicaRemove(0, 0, 'i-replica-minted-1', ctx.initGen);
  check('A5b a replica-minted id is never adopted onto an id-less slot (#68)',
    JSON.stringify(ctx.state.layout) === before, 'layout unchanged');
}

// ---- A6 · index validation, the splice door ------------------------------------------
{
  const bad = [[0, -1, 'index -1 — would splice the LAST tile'], [0, 1, 'index === length'],
               [0, 1.5, 'a fractional index'], [0, '0', 'a string index'],
               [0, null, 'a null index'], [0, undefined, 'an absent index'],
               [9, 0, 'a page index out of range'], [-1, 0, 'a negative page index']];
  let clean = true; const notes = [];
  for (const [pi, si, what] of bad) {
    const page = seed(ctx);
    const before = JSON.stringify(ctx.state.layout);
    let threw = false;
    try { ctx.onReplicaRemove(pi, si, 'gh1', ctx.initGen); } catch (e) { threw = true; }
    if (threw || JSON.stringify(ctx.state.layout) !== before) { clean = false; notes.push(what + (threw ? ' THREW' : ' MUTATED')); }
  }
  check('A6 every bad index is refused — no throw, no mutation, no retire',
    clean, clean ? `${bad.length} shapes refused` : notes.join('; '));
}

// ---- A7 · mint-then-copy ordering ------------------------------------------------------
{
  // Belt only: #289 made LayoutStore.Load stamp every id-less slot and persist it, so a
  // layout this process has read has none left. Pinned anyway — the ordering is what
  // makes the attic addressable at all.
  const page = seed(ctx, { widgetId: 'gh', settings: { token: 'ghp_NOID' } });
  ctx.onReplicaRemove(0, 0, null, ctx.initGen);
  const def = (atticOf(ctx)[0] || {}).def;
  check('A7 an id-less slot is stamped on the LIVE def first, then copied',
    !!def && !!def.instanceId && /^i[0-9a-z]+-\d+$/.test(def.instanceId), def && def.instanceId);
  check('A7b ...and the credential still rode across',
    !!def && def.settings.token === 'ghp_NOID', def && def.settings.token);
}

// ---- A8 · the selection cursor ----------------------------------------------------------
{
  seed(ctx).slots.push({ widgetId: 'gh', instanceId: 'gh2' });
  ctx.selectedSlot = 1;
  ctx.onReplicaRemove(0, 0, 'gh1', ctx.initGen);
  check('A8 removing above the selection walks the cursor down', ctx.selectedSlot === 0, String(ctx.selectedSlot));
  seed(ctx);
  ctx.selectedSlot = 0;
  ctx.onReplicaRemove(0, 0, 'gh1', ctx.initGen);
  check('A8b removing the selection itself clears it', ctx.selectedSlot === null, String(ctx.selectedSlot));
}

// ---- L0b · shell.js source guards --------------------------------------------------------
// The replica half has no seam worth extracting — it is DOM and postMessage — but its two
// load-bearing properties are checkable as facts about the source rather than comments
// hoping to be obeyed.
{
  const sh = fs.readFileSync(path.join(SHELL, 'shell.js'), 'utf8');
  const rm = sh.indexOf('function removeSlot(record) {');
  const head = rm < 0 ? '' : sh.slice(rm, rm + 900);
  const gated = rm >= 0 && /^\s*if \(PREVIEW\) return;/m.test(head);
  check('L0b removeSlot is panel-only by construction (if (PREVIEW) return;)',
    gated, rm < 0 ? 'removeSlot not found' : gated ? 'gate present before any mutation'
      : 'NO PREVIEW gate — the replica can author a phantom attic');

  const rq = sh.indexOf('function requestRemoveSlot(record) {');
  const end = rq < 0 ? -1 : sh.indexOf('\n  function ', rq + 1);
  const body = rq < 0 ? '' : sh.slice(rq, end < 0 ? rq + 2000 : end);
  const forked = rq >= 0 && /if \(PREVIEW\) requestRemoveSlot\(record\); else removeSlot\(record\);/.test(sh);
  check('L0c the preview ✕ hands off to requestRemoveSlot', forked,
    rq < 0 ? 'requestRemoveSlot not found' : forked ? 'fork present at the ✕'
      : 'the ✕ still calls removeSlot directly');
  // The object the withdrawn union died on. A comment saying "we never mint here" is
  // worth less than a check that no minting expression exists in the function at all.
  const mints = /instanceSeq/.test(body) || /Date\.now\(\)\.toString\(36\)/.test(body);
  check('L0d requestRemoveSlot never mints an identity (#68)', rq >= 0 && !mints,
    rq < 0 ? 'n/a' : mints ? 'MINTS an id — the object the withdrawn union died on'
      : 'no instanceSeq, no id generator');
  const names = rq >= 0 && /instanceId: record\.def\.instanceId \|\| null/.test(body);
  check('L0e ...and names the slot with the id it was given, or null', names,
    names ? 'names, does not invent' : 'does not pass through the live id verbatim');
}

// ---- A9 · falsification ---------------------------------------------------------------
// Every assertion above must be able to FAIL. Run the two that matter most against the
// pre-fix behaviour and assert they do, so a green file cannot mean an inert one.
{
  const leg = legacyCtx();
  const page = seed(leg);
  leg.onReplicaRemove(0, 0, 'gh1', leg.initGen);
  const att = atticOf(leg);
  check('A9 the pre-fix behaviour DOES lose the tile (A1 would fail against it)',
    page.slots.length === 0 && att.length === 0,
    `slots=${page.slots.length} attic=${att.length} — spliced, nothing retired`);
  check('A9b ...so the credential is gone with no attic entry to restore it from',
    att.length === 0, 'no retained entry exists');
}

console.log(failures > 0 ? `\n${failures} FAILURES` : '\nALL PASS');
process.exit(failures > 0 ? 1 : 0);
