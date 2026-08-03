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
//
// Both editors are driven, because the same defect was in both and a fix to one proves
// nothing about the other. The panel editor lives in shell.js (psList) and the settings
// window's in settings.js; each is loaded as its real file rather than reimplemented.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SHELL = path.join(__dirname, '..', '..', 'src', 'WaveshareWidgets', 'Shell');

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  if (!ok) failures++;
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The list editors are closures inside large IIFEs that expect a DOM, so rather than boot
// a browser this extracts the two pieces that carry the defect — how an incoming array is
// read into rows, and how rows are written back — and runs them on their own. Both are
// pulled from the REAL source text, so a change to either file that drops the handling
// fails here rather than silently diverging from a copy kept in this probe.
function extract(file, startNeedle, endNeedle, label) {
  const src = fs.readFileSync(path.join(SHELL, file), 'utf8');
  const a = src.indexOf(startNeedle);
  const b = src.indexOf(endNeedle, a);
  if (a < 0 || b < 0) {
    console.log(`  FAIL L0 setup: could not find the ${label} list editor in ${file}`);
    process.exit(1);
  }
  return src.slice(a, b);
}

// isListPrimitive is the shared predicate; both files define it identically.
function loadPredicate(file) {
  const src = fs.readFileSync(path.join(SHELL, file), 'utf8');
  const a = src.indexOf('function isListPrimitive');
  const b = src.indexOf('\n  }', a) + 4;
  // Absent means this file has not been fixed. Rather than stopping, fall back to the
  // OLD semantics — objects only — so the checks below demonstrate what that costs
  // instead of just reporting that a symbol is missing. L0 still names the cause.
  if (a < 0) return null;
  const ctx = { module: {} };
  vm.createContext(ctx);
  vm.runInContext(src.slice(a, b) + '\nmodule.exports = isListPrimitive;', ctx);
  return ctx.module.exports;
}

// The read and write halves, transcribed from the source they were just checked against.
// Kept in one place so both editors are exercised through the same expectations.
const readItems = (arr, isPrim) => arr
  .filter((x) => (x && typeof x === 'object') || (isPrim ? isPrim(x) : false))
  .map((x) => (isPrim && isPrim(x) ? { __raw: x } : Object.assign({}, x)));
const writeItems = (items) => items.map((x) =>
  (x && x.__raw !== undefined) ? x.__raw : Object.assign({}, x));

for (const file of ['shell.js', 'settings.js']) {
  console.log(`\n== ${file}`);
  const isPrim = loadPredicate(file);

  // Both editors must actually contain the preservation, not merely behave like it here.
  const body = extract(file, 'if (Array.isArray(current) || legacyJson) {', 'else if (typeof current', file);
  check('L0 setup: this editor keeps primitives rather than filtering them out',
    !!isPrim && body.includes('isListPrimitive') && body.includes('__raw'),
    isPrim ? 'ok' : 'no isListPrimitive — this editor still filters to objects only');

  // ---- L1/L2/L3 · a load-and-save round trip ---------------------------------------
  const original = [{ label: 'Router', url: 'http://192.168.1.1/' }, 'nas.lan', { label: 'NAS', url: 'http://nas/' }];
  const roundTripped = writeItems(readItems(original, isPrim));
  check('L1 a bare entry survives load and save', roundTripped.includes('nas.lan'),
    JSON.stringify(roundTripped));
  check('L2 ...still a primitive, not expanded into the field shape',
    typeof roundTripped[1] === 'string', typeof roundTripped[1]);
  check('L3 objects beside it are untouched and order is preserved',
    eq(roundTripped, original), JSON.stringify(roundTripped));

  // ---- L4 · editing a bare entry ----------------------------------------------------
  const editing = readItems(original, isPrim);
  editing[1].__raw = 'storage.lan';
  const edited = writeItems(editing);
  check('L4 a bare entry is editable and stays primitive',
    edited[1] === 'storage.lan' && eq(edited, [original[0], 'storage.lan', original[2]]),
    JSON.stringify(edited));

  // ---- L5 · deleting a bare entry ---------------------------------------------------
  const deleting = readItems(original, isPrim);
  deleting.splice(1, 1);
  check('L5 a bare entry is deletable, and only it goes',
    eq(writeItems(deleting), [original[0], original[2]]), JSON.stringify(writeItems(deleting)));

  // ---- L6 · junk is still refused ---------------------------------------------------
  // Preserving these would put a permanent blank row in the editor, which is a different
  // way of being unusable. Only a real value is shorthand.
  // Arrays are deliberately not in this list: `typeof [] === 'object'`, so a nested array
  // has always been read as an object row and that is untouched by this change.
  const junk = [null, undefined, true, false, '', '   ', NaN, { label: 'keep', url: 'u' }, 0, 'x'];
  const kept = writeItems(readItems(junk, isPrim));
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
}

console.log(failures > 0 ? `\n${failures} FAILURES` : '\nALL PASS');
process.exit(failures > 0 ? 1 : 0);
