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

const bad = [];
for (const w of widgets) {
  let baseManifest = null;
  try { baseManifest = JSON.parse(sh(`git show ${mergeBase}:widgets/${w}/manifest.json`)); }
  catch (e) { continue; } // widget is new in this PR — any version is fine
  let headManifest = null;
  try { headManifest = JSON.parse(sh(`git show HEAD:widgets/${w}/manifest.json`)); }
  catch (e) { continue; } // widget deleted in this PR
  if (String(baseManifest.version) === String(headManifest.version))
    bad.push(`${w} (still ${headManifest.version})`);
}

if (bad.length) {
  console.error('Changed widgets without a manifest version bump:\n  ' + bad.join('\n  '));
  console.error('\nBump "version" in each widget\'s manifest.json so installs and logs track what shipped.');
  process.exit(1);
}
console.log(widgets.length ? `version bumps OK: ${widgets.join(', ')}` : 'no widget changes');
