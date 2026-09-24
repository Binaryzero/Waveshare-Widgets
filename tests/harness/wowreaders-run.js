#!/usr/bin/env node
// WoW Panel: what the card CHOOSES to show (#258), pinned in CI on plain Node.
//
// The owner's #258 card spent a 1280px tile on three short lists: fixed three-row caps cut
// the data a character has, and with no reputation movement seen yet the fallback ranked
// factions by closeness to their next tier — so the card led with Gilneas and Tushui
// Pandaren, a decade old and a sliver short of Friendly→Honored, over every faction of the
// current expansion. This runs the widget's own readers, extracted from
// widgets/wow/index.html between markers — not transcribed — against the payload shapes
// Blizzard's profile API returns:
//
//   R1 · with no movement seen, the NEWEST factions lead (faction ids rise with each
//        release) — not the old ones closest to their next tier
//   R2 · a faction seen MOVING outranks every unmoved one, whatever its age
//   R3 · a capped faction that never moved is left off; one that just capped stays on
//   R4 · the lists are no longer cut to three: every profession, primaries then
//        secondaries; reputations and near-done achievements past three
//   R5 · the latest achievements: several, newest first
//   R6 · the profile's race, realm, item level and achievement points reach the card;
//        a zero item level (an unequipped character) reads as absent, not as "0"
//   F1 · falsification — the pre-#258 readers fail R1 and R4
//
// The layout half (nothing clipped, no canyons, lists fill their room, at every size) is
// tests/harness/wow-card-run.js on the maintainer's machine.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'widgets', 'wow', 'index.html'), 'utf8');

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  if (!ok) failures++;
};

// Refreshes are 20+ minutes apart on the panel; here they are microseconds apart, so the
// readers get a clock that the checks advance between looks — otherwise two movements
// share one timestamp and their order is decided by the tie-break, not by recency.
let clock = 1790000000000;
function load(block) {
  const store = new Map();
  const ctx = {
    module: {},
    Date: class extends Date { static now() { return clock; } },
    cfg: { region: 'us', realm: 'Argent Dawn', character: 'Pixel', clientId: '', clientSecret: '' },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
  };
  vm.createContext(ctx);
  vm.runInContext(block + '\nmodule.exports = { readWho, readProfs, readReps, readAchievements };', ctx);
  return ctx.module.exports;
}

function extract() {
  const a = SRC.indexOf('// >>> wow-readers');
  const b = SRC.indexOf('// <<< wow-readers');
  if (a < 0 || b < 0 || b < a) return null;
  return SRC.slice(a, b);
}

// ---- Payloads, in the profile API's shapes ------------------------------------------------
const reps = (list) => ({ reputations: list.map(([name, id, standing]) => ({ faction: { name, id }, standing })) });
const OLD_AND_NEW = reps([
  ['Gilneas', 1134, { value: 2950, max: 3000, name: 'Friendly' }],
  ['Tushui Pandaren', 1353, { value: 2900, max: 3000, name: 'Friendly' }],
  ['Council of Dornogal', 2590, { value: 500, max: 2500, renown_level: 9 }],
  ['The Assembly of the Deeps', 2594, { value: 300, max: 2500, renown_level: 12 }],
  ['Hallowfall Arathi', 2570, { value: 1200, max: 2500, renown_level: 7 }],
  ['The Severed Threads', 2600, { value: 100, max: 2500, renown_level: 5 }],
  ['Stormwind', 72, { value: 999, max: 999, name: 'Exalted' }],
]);
const leaves = (done, todo) => ({ child_criteria: [
  ...Array.from({ length: done }, (_, i) => ({ id: i + 1, is_completed: true })),
  ...Array.from({ length: todo }, (_, i) => ({ id: 100 + i, is_completed: false })),
] });
const ACH = { achievements: [
  { achievement: { name: 'Old' }, completed_timestamp: 1000 },
  { achievement: { name: 'Newest' }, completed_timestamp: 5000 },
  { achievement: { name: 'Middle' }, completed_timestamp: 3000 },
  { achievement: { name: 'Second' }, completed_timestamp: 4000 },
  { achievement: { name: 'A' }, criteria: leaves(59, 1) },
  { achievement: { name: 'B' }, criteria: leaves(31, 1) },
  { achievement: { name: 'C' }, criteria: leaves(26, 1) },
  { achievement: { name: 'D' }, criteria: leaves(18, 2) },
  { achievement: { name: 'E' }, criteria: leaves(17, 3) },
] };
const PROFS = {
  primaries: [
    { profession: { name: 'Engineering' }, tiers: [{ tier: { id: 9 }, skill_points: 48, max_skill_points: 105 }] },
    { profession: { name: 'Tailoring' }, tiers: [{ tier: { id: 9 }, skill_points: 37, max_skill_points: 100 }] },
  ],
  secondaries: [
    { profession: { name: 'Cooking' }, tiers: [{ tier: { id: 9 }, skill_points: 52, max_skill_points: 100 }] },
    { profession: { name: 'Fishing' }, tiers: [{ tier: { id: 9 }, skill_points: 20, max_skill_points: 100 }] },
    { profession: { name: 'Archaeology' }, tiers: [{ tier: { id: 1 }, skill_points: 150, max_skill_points: 950 }] },
  ],
};
const PROFILE = { name: 'Ami', level: 82, active_spec: { name: 'Fire' }, character_class: { name: 'Mage' },
  guild: { name: 'The Highguard' }, race: { name: 'Gnome' }, realm: { name: 'Argent Dawn' },
  equipped_item_level: 671, achievement_points: 31420 };

// Runs the R checks against one set of readers and returns which failed, so F1 can ask
// the pre-#258 readers to fail the right ones.
function runReaders(r, label, quiet) {
  const failed = new Set();
  const say = (tag, name, ok, detail) => {
    if (!ok) failed.add(tag);
    if (!quiet) check(`${tag} ${name}`, ok, detail);
  };
  if (!quiet) console.log(`\n== ${label}`);
  const names = (list) => list.map((x) => x.name);

  // R1
  const first = names(r.readReps(OLD_AND_NEW, 'k1'));
  const newest = ['The Severed Threads', 'The Assembly of the Deeps', 'Council of Dornogal', 'Hallowfall Arathi'];
  say('R1', 'no movement yet: the newest factions lead, not the old near-tier ones',
    newest.every((n, i) => first[i] === n) && first.indexOf('Gilneas') > 3, JSON.stringify(first));

  // R2 — Tushui moves between two looks; it now outranks every unmoved faction.
  const moved = JSON.parse(JSON.stringify(OLD_AND_NEW));
  moved.reputations[1].standing.value = 2990;
  clock += 1800000;
  const second = names(r.readReps(moved, 'k1'));
  say('R2', 'a faction seen moving outranks every unmoved one', second[0] === 'Tushui Pandaren', JSON.stringify(second));

  // R3 — Stormwind is capped and never moved; a faction that CAPS while watched stays.
  const capped = JSON.parse(JSON.stringify(moved));
  capped.reputations[0].standing.value = 3000;   // Gilneas reaches its tier's max
  clock += 1800000;
  const third = names(r.readReps(capped, 'k1'));
  say('R3', 'an unmoved capped faction is left off; one that just capped stays',
    !third.includes('Stormwind') && third[0] === 'Gilneas', JSON.stringify(third));

  // R4
  const profs = names(r.readProfs(PROFS));
  const achs = r.readAchievements(ACH);
  say('R4', 'lists are not cut to three: every profession; reps and near-done past three',
    JSON.stringify(profs) === JSON.stringify(['Engineering', 'Tailoring', 'Cooking', 'Fishing', 'Archaeology'])
      && first.length >= 6 && achs.almost.length === 5,
    `profs ${profs.length}, reps ${first.length}, almost ${achs.almost.length}`);

  // R5
  const latest = Array.isArray(achs.latest) ? names(achs.latest) : [achs.latest && achs.latest.name];
  say('R5', 'the latest achievements: several, newest first',
    JSON.stringify(latest) === JSON.stringify(['Newest', 'Second', 'Middle']), JSON.stringify(latest));

  // R6
  const who = r.readWho(PROFILE);
  const bare = r.readWho(Object.assign({}, PROFILE, { equipped_item_level: 0, achievement_points: undefined }));
  say('R6', 'race, realm, item level and achievement points reach the card; a zero item level is absent',
    who.from === 'Gnome · Argent Dawn' && who.ilvl === 671 && who.points === 31420
      && bare.ilvl === null && bare.points === null,
    JSON.stringify({ from: who.from, ilvl: who.ilvl, points: who.points, bare: [bare.ilvl, bare.points] }));
  return failed;
}

const block = extract();
if (!block) {
  check('L0 the wow-readers block is marked in widgets/wow/index.html', false, 'markers not found');
} else {
  let readers = null;
  try { readers = load(block); } catch (e) { check('L0 the wow-readers block evaluates', false, e.message); }
  if (readers) runReaders(readers, 'widgets/wow/index.html (shipped)');

  // F1 — the same block with the pre-#258 choices put back: the closeness-to-done fallback
  // and the three-row caps. It must fail R1 and R4, or those checks are not testing them.
  console.log('\n== F1 falsification: the pre-#258 readers');
  const legacy = block
    .replace('(b.t - a.t) || (b.id - a.id) || (frac(b) - frac(a))', '(b.t - a.t) || (frac(b) - frac(a))')
    .replace('return out.slice(0, 8);', 'return out.slice(0, 3);')
    .replace(/\.slice\(0, 8\);\n  \}/, '.slice(0, 3);\n  }')
    .replace('almost: almost.slice(0, 10)', 'almost: almost.slice(0, 3)');
  const edits = ['(b.t - a.t) || (frac(b) - frac(a))', 'return out.slice(0, 3);', 'almost: almost.slice(0, 3)']
    .filter((t) => legacy.includes(t)).length;
  let failed = null;
  try { failed = runReaders(load(legacy), 'legacy', true); } catch (e) { failed = null; }
  check('F1 the pre-#258 readers fail R1 and R4', edits === 3 && failed && failed.has('R1') && failed.has('R4'),
    failed ? `edits applied ${edits}/3; failed: ${[...failed].join(', ') || 'none'}` : 'legacy block did not run');
}

console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
process.exit(failures ? 1 : 0);
