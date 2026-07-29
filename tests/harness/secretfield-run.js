#!/usr/bin/env node
// Issue #15 — the settings-editor half of the `secret` property contract. The C# side
// (tools/SecretRoundTrip) proves the encryption pipeline; these probes prove the UI
// never behaves as if it could read a stored credential:
//   E1 · a secret renders as a MASKED input, never a text field
//   E2 · a stored secret (host sent "" + secretsSet) reads as "saved · encrypted",
//        with no value in the DOM to steal
//   E3 · typing commits the plaintext for this save only, and says it will be encrypted
//   E4 · the reveal toggle shows what YOU typed (and re-masks)
//   E5 · Clear commits an explicit "" — the signal the host needs to drop the stored
//        value (an absent key would mean "keep it")
//   E6 · a secret with no stored value reads "not set" and offers no Clear
//   E7 · the saved layout carries exactly what the user typed, and the widget preview
//        receives it like any other setting
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const http = require('http');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');

function staticServer(rootDir, port) {
  const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
  const srv = http.createServer((req, res) => {
    try {
      const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = path.join(rootDir, path.normalize(p).replace(/^([/\\.])+/, ''));
      if (!file.startsWith(rootDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      res.end(fs.readFileSync(file));
    } catch (e) { res.writeHead(500); res.end(); }
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  if (!ok) failures++;
};

const widgets = [{
  id: 'test.gh', name: 'GitHub Queue', supportedSlots: ['half'],
  properties: [
    { name: 'token', label: 'Personal access token', type: 'secret', placeholder: 'ghp_…' },
    { name: 'fresh', label: 'Other token', type: 'secret' },
    { name: 'repo', label: 'Repository', type: 'text', default: 'owner/name' },
  ],
}];

// Exactly what the host sends after SecretPolicy.Mask: the secret blanked, plus a
// secretsSet list naming the ones that DO have a stored (encrypted) value.
const layout = {
  pages: [{
    name: 'Main',
    slots: [{
      widgetId: 'test.gh', size: 'half', instanceId: 'gh1',
      settings: { token: '', fresh: '', repo: 'binaryzero/waveshare-widgets' },
      secretsSet: ['token'],
    }],
  }],
};

(async () => {
  const shellSrv = await staticServer(REPO, 8951);
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
  page.on('pageerror', (e) => { failures++; console.log('[pageerror]', String(e).slice(0, 300)); });

  const saved = [];
  await page.exposeFunction('__hostRecv', async (json) => {
    const msg = JSON.parse(json);
    const push = (obj) => page.evaluate((d) => window.__hostPush(d), JSON.stringify(obj)).catch(() => {});
    if (msg.type === 'settings-ready') {
      push({ type: 'settings-init', data: {
        layout, widgets, sensors: [], backgroundHost: 'backgrounds.wsw',
        status: { elevated: false, version: 'v0.2.0 (probe)' },
      } });
    } else if (msg.type === 'save-layout') {
      saved.push(JSON.parse(JSON.stringify(msg.layout)));
      push({ type: 'saved', seq: msg.seq });
    }
  });
  await page.addInitScript(() => {
    const listeners = new Set();
    window.chrome = { webview: {
      addEventListener(t, cb) { if (t === 'message') listeners.add(cb); },
      postMessage(m) { window.__hostRecv(JSON.stringify(m)); },
    } };
    window.__hostPush = (json) => { const data = JSON.parse(json); listeners.forEach((cb) => { try { cb({ data }); } catch (e) {} }); };
  });
  await page.goto('http://127.0.0.1:8951/src/WaveshareWidgets/Shell/settings.html');
  await page.waitForTimeout(900);

  // Open the widget inspector for the only slot (chip click, inspector-era UX).
  await page.locator('#slotList .slot-chip .chip-main').first().click();
  await page.waitForTimeout(200);

  const wraps = page.locator('#slotDetail .secret-wrap');
  check('E1 both secret properties render as .secret-wrap rows', await wraps.count() === 2,
    String(await wraps.count()));
  const stored = wraps.nth(0);
  const fresh = wraps.nth(1);

  check('E1b the input is type=password (masked), not text',
    await stored.locator('input').getAttribute('type') === 'password');
  check('E1c autocomplete is off so the browser never stores the credential',
    await stored.locator('input').getAttribute('autocomplete') === 'off');

  // ---- E2 · stored secret: honest "saved" state, nothing readable in the DOM
  check('E2 a stored secret reads as saved+encrypted, not as dots implying readability',
    /saved · encrypted \(hidden\)/.test(await stored.locator('.secret-state').textContent()),
    await stored.locator('.secret-state').textContent());
  check('E2b the field holds NO value to steal (the host never sent one)',
    await stored.locator('input').inputValue() === '');
  check('E2c the placeholder from the manifest is offered as guidance',
    await stored.locator('input').getAttribute('placeholder') === 'ghp_…');

  // ---- E6 · a secret with nothing stored says so, and offers no Clear
  check('E6 an unset secret reads "not set"',
    (await fresh.locator('.secret-state').textContent()).trim() === 'not set');
  check('E6b no Clear button on an unset secret',
    await fresh.locator('button.danger').evaluate((n) => n.hidden) === true);

  // ---- E3 · typing: commits, and promises encryption
  await stored.locator('input').fill('ghp_TYPED_IN_THIS_SESSION');
  await page.waitForTimeout(120);
  check('E3 typing a secret says it will be encrypted on save',
    /will be encrypted on save/.test(await stored.locator('.secret-state').textContent()),
    await stored.locator('.secret-state').textContent());

  // ---- E4 · reveal toggle acts on what the user typed, and re-masks
  await stored.locator('button', { hasText: '👁' }).click();
  check('E4 reveal switches the input to text', await stored.locator('input').getAttribute('type') === 'text');
  await stored.locator('button', { hasText: '👁' }).click();
  check('E4b toggling again re-masks it', await stored.locator('input').getAttribute('type') === 'password');

  // ---- E7 · the save carries exactly the typed value
  await page.locator('#save').click();
  await page.waitForTimeout(400);
  const slot0 = saved.length ? saved[saved.length - 1].pages[0].slots[0] : {};
  check('E7 the saved layout carries the typed secret for the host to encrypt',
    (slot0.settings || {}).token === 'ghp_TYPED_IN_THIS_SESSION', JSON.stringify(slot0.settings));
  check('E7b non-secret settings are unaffected',
    (slot0.settings || {}).repo === 'binaryzero/waveshare-widgets');

  // ---- E5 · Clear commits an explicit empty string (the host's "drop it" signal)
  await stored.locator('button.danger').click();
  await page.waitForTimeout(120);
  // The state must say what the SAVE will do — "saved · encrypted" lingering after a
  // Clear would tell the user their credential is safe while the save deletes it.
  check('E5 Clear empties the field and says the credential will be removed on save',
    await stored.locator('input').inputValue() === '' &&
    (await stored.locator('.secret-state').textContent()).trim() === 'will be removed on save',
    await stored.locator('.secret-state').textContent());
  await page.locator('#save').click();
  await page.waitForTimeout(400);
  const cleared = saved[saved.length - 1].pages[0].slots[0];
  check('E5b the save sends token:"" — an explicit clear, not an absent key',
    Object.prototype.hasOwnProperty.call(cleared.settings, 'token') && cleared.settings.token === '',
    JSON.stringify(cleared.settings));

  await browser.close();
  shellSrv.close();
  console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
