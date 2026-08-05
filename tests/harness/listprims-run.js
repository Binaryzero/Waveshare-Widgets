#!/usr/bin/env node
// List settings whose entries may be bare values (issue #167).
//
// Several widgets accept a primitive as shorthand in a list — endpoints takes "nas.lan"
// and expands it to a label and a URL itself. Both settings editors filtered the array
// down to objects before rendering, so a bare entry got no row: it could not be seen,
// edited or deleted, and because each editor writes back only the rows it rendered,
// opening the panel and saving silently deleted every one of them.
//
// Silent DELETION is the defect, so every check here is about what comes back out:
//
//   L1 · a bare entry survives a load and a save unchanged
//   L2 · ...as a primitive, not rewritten into the field shape a widget never asked for
//   L3 · object entries beside it are untouched, and ORDER is preserved
//   L4 · a bare entry can be edited, and edits round-trip as primitives
//   L5 · a bare entry can be deleted, and deleting it removes only that one
//   L6 · junk (null, booleans, blank strings) is still dropped — preserving it would
//        put an uneditable blank row in front of the user forever
//   L7 · an object row whose own field is literally named "__raw" is NOT mistaken for a
//        bare value. Nothing reserves field keys, so a widget may legally declare one;
//        a string marker made that row render as a single input and write back as the
//        bare value, dropping its other fields — this bug, caused by its own fix.
//
// Both editors are driven, because the same defect was in both and a fix to one proves
// nothing about the other. The panel editor lives in shell.js (psList) and the settings
// window's in settings.js; each is loaded as its real file rather than reimplemented.
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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The mapping under test is loaded OUT OF THE SOURCE FILE and executed — not
// transcribed here. An earlier version of this harness kept its own copy of the read and
// write halves and checked the file only for two substrings, so a regression in either
// editor's real commit would have left every behavioural assertion below green. The
// editors now carry the pair as named functions between marker comments for exactly this
// reason, and if those markers or names go away this fails at L0 rather than quietly
// testing nothing.
function loadMapping(file) {
  const src = fs.readFileSync(path.join(SHELL, file), 'utf8');
  const a = src.indexOf('// >>> ww-list-mapping');
  const b = src.indexOf('// <<< ww-list-mapping');
  if (a < 0 || b < 0) return null;
  const ctx = { module: {} };
  vm.createContext(ctx);
  try {
    vm.runInContext(
      src.slice(a, b) +
      '\nmodule.exports = { isListPrimitive, listRowsFrom, listValueFrom, LIST_RAW };',
      ctx);
  } catch (e) {
    console.log(`  FAIL L0 setup: the ${file} mapping block did not evaluate — ${e.message}`);
    return null;
  }
  const m = ctx.module.exports;
  if (typeof m.listRowsFrom !== 'function' || typeof m.listValueFrom !== 'function'
      || typeof m.isListPrimitive !== 'function' || !m.LIST_RAW) return null;
  return m;
}

// The pre-fix behaviour, for the falsification run: objects only, primitives discarded.
const LEGACY = {
  listRowsFrom: (arr) => (arr || []).filter((x) => x && typeof x === 'object').map((x) => Object.assign({}, x)),
  listValueFrom: (items) => (items || []).map((x) => Object.assign({}, x)),
  LIST_RAW: Symbol('legacy'),
};

for (const file of ['shell.js', 'settings.js']) {
  console.log(`\n== ${file}`);
  const real = loadMapping(file);
  check('L0 setup: this editor exposes a runnable list mapping that keeps primitives',
    !!real, real ? 'loaded and executed from source' : 'no ww-list-mapping block — falling back to pre-fix behaviour');
  // The marker's TYPE is load-bearing, not a style choice. Deliberately checked here
  // rather than in the loader, so that a string marker still loads and L7 below gets to
  // demonstrate what it costs instead of being skipped.
  check('L0b the row marker is a symbol, so no manifest field can collide with it',
    !real || typeof real.LIST_RAW === 'symbol', real ? typeof real.LIST_RAW : 'n/a');
  // Fall back rather than bail, so the checks below SHOW what the old behaviour costs.
  const { listRowsFrom, listValueFrom, LIST_RAW } = real || LEGACY;
  const readItems = listRowsFrom;
  const writeItems = listValueFrom;

  // ---- L1/L2/L3 · a load-and-save round trip ---------------------------------------
  const original = [{ label: 'Router', url: 'http://192.168.1.1/' }, 'nas.lan', { label: 'NAS', url: 'http://nas/' }];
  const roundTripped = writeItems(readItems(original));
  check('L1 a bare entry survives load and save', roundTripped.includes('nas.lan'),
    JSON.stringify(roundTripped));
  check('L2 ...still a primitive, not expanded into the field shape',
    typeof roundTripped[1] === 'string', typeof roundTripped[1]);
  check('L3 objects beside it are untouched and order is preserved',
    eq(roundTripped, original), JSON.stringify(roundTripped));

  // ---- L4 · editing a bare entry ----------------------------------------------------
  const editing = readItems(original);
  editing[1][LIST_RAW] = 'storage.lan';
  const edited = writeItems(editing);
  check('L4 a bare entry is editable and stays primitive',
    edited[1] === 'storage.lan' && eq(edited, [original[0], 'storage.lan', original[2]]),
    JSON.stringify(edited));

  // ---- L5 · deleting a bare entry ---------------------------------------------------
  const deleting = readItems(original);
  deleting.splice(1, 1);
  check('L5 a bare entry is deletable, and only it goes',
    eq(writeItems(deleting), [original[0], original[2]]), JSON.stringify(writeItems(deleting)));

  // ---- L6 · junk is still refused ---------------------------------------------------
  // Preserving these would put a permanent blank row in the editor, which is a different
  // way of being unusable. Only a real value is shorthand.
  // Arrays are deliberately not in this list: `typeof [] === 'object'`, so a nested array
  // has always been read as an object row and that is untouched by this change.
  const junk = [null, undefined, true, false, '', '   ', NaN, { label: 'keep', url: 'u' }, 0, 'x'];
  const kept = writeItems(readItems(junk));
  check('L6 null/undefined/boolean/blank/NaN are still dropped',
    kept.length === 3 && !kept.some((v) => v === null || v === undefined || v === true || v === false
      || (typeof v === 'string' && v.trim() === '') || (typeof v === 'number' && !Number.isFinite(v))),
    JSON.stringify(kept));
  // A number that nobody edited must come back a NUMBER. Stringifying at read time made
  // 0 return as "0" — a silent type rewrite, which is the thing this change exists to
  // stop, committed by the fix for it.
  check('L6b a zero survives as a number, and a real string as a string',
    kept.some((v) => v === 0 && typeof v === 'number') && kept.includes('x'),
    JSON.stringify(kept.map((v) => typeof v + ':' + JSON.stringify(v))));
  // ---- L7 · a field genuinely named __raw --------------------------------------------
  // The validator reserves no field keys (tools/validate-widget.js only requires that
  // `fields` exists and each entry has a key), so this manifest is legal today.
  const collide = [{ __raw: 'x', label: 'y', url: 'z' }, 'nas.lan'];
  const out = writeItems(readItems(collide));
  check('L7 an object row with a "__raw" field keeps all of its fields',
    out[0] && typeof out[0] === 'object' && out[0].__raw === 'x'
      && out[0].label === 'y' && out[0].url === 'z',
    JSON.stringify(out[0]));
  check('L7b ...and is still an object, not collapsed to its __raw value',
    typeof out[0] === 'object' && out[1] === 'nas.lan', JSON.stringify(out));
}

console.log(failures > 0 ? `\n${failures} FAILURES` : '\nALL PASS');
process.exit(failures > 0 ? 1 : 0);
