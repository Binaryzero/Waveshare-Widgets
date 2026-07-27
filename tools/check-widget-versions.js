#!/usr/bin/env node
// CI guard for issue #26: any change under widgets/<name>/ in a PR must come with a
// manifest version bump for that widget. Seeding now re-ships changed content
// regardless of versions (content fingerprint), but the human-facing version must
// keep tracking reality — it's what users and logs reason about.
//
// Usage: node tools/check-widget-versions.js <base-ref>   (e.g. origin/main)
'use strict';
const { execSync } = require('child_process');

const base = process.argv[2];
if (!base) {
  console.error('usage: check-widget-versions.js <base-ref>');
  process.exit(2);
}
const sh = (cmd) => execSync(cmd, { encoding: 'utf8' });

const mergeBase = sh(`git merge-base ${base} HEAD`).trim();
const changed = sh(`git diff --name-only ${mergeBase} HEAD -- widgets/`)
  .split('\n').filter(Boolean);
const widgets = [...new Set(changed.map((f) => f.split('/')[1]).filter(Boolean))];

// Existence is checked separately from parsing: a retained manifest that no longer
// PARSES must fail the guard (seeding would ship it and Rescan would silently drop
// the widget for every user), not masquerade as a deletion.
const exists = (rev, p) => {
  try { execSync(`git cat-file -e ${rev}:${p}`, { stdio: 'ignore' }); return true; }
  catch (e) { return false; }
};
const parseVer = (v) => {
  const parts = String(v ?? '').trim().split('.');
  return parts.length && parts.every((p) => /^\d+$/.test(p)) ? parts.map(Number) : null;
};
const cmpVer = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
};

const bad = [];
for (const w of widgets) {
  const p = `widgets/${w}/manifest.json`;
  if (!exists(mergeBase, p)) continue; // widget is new in this PR — any version is fine
  if (!exists('HEAD', p)) continue;    // widget deleted in this PR

  let headManifest;
  try { headManifest = JSON.parse(sh(`git show HEAD:${p}`)); }
  catch (e) { bad.push(`${w} (manifest.json no longer parses — the widget would vanish for users)`); continue; }
  const headVer = parseVer(headManifest.version);
  if (!headVer) { bad.push(`${w} (missing or invalid "version": ${JSON.stringify(headManifest.version ?? null)})`); continue; }

  let baseManifest = null;
  try { baseManifest = JSON.parse(sh(`git show ${mergeBase}:${p}`)); }
  catch (e) { /* pre-existing corruption at base: judge the head on its own */ }
  const baseVer = baseManifest ? parseVer(baseManifest.version) : null;
  // Versions must INCREASE, not merely change — a lowered or re-used version lies
  // to users and logs about what shipped.
  if (baseVer && cmpVer(headVer, baseVer) <= 0)
    bad.push(`${w} (version must increase: ${baseManifest.version} -> ${headManifest.version})`);
}

if (bad.length) {
  console.error('Changed widgets without a manifest version bump:\n  ' + bad.join('\n  '));
  console.error('\nBump "version" in each widget\'s manifest.json so installs and logs track what shipped.');
  process.exit(1);
}
console.log(widgets.length ? `version bumps OK: ${widgets.join(', ')}` : 'no widget changes');
