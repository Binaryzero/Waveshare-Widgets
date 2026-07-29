#!/usr/bin/env node
// Issue #15 — the ON-PANEL half of the `secret` contract (shell.js psControl + the
// dashboard save path). The panel is a different world from the desktop editor: the
// host hands the dashboard DECRYPTED values, so the field really does hold the
// credential. That makes "the user emptied it" ambiguous unless the shell says which
// it meant, because the host reads "" as "the masked desktop field came back
// untouched" and KEEPS the stored ciphertext.
//   N1 · the field is masked on glass and holds the real (revealed) value
//   N2 · a stored secret offers an explicit Clear; an unset one does not
//   N3 · Clear sends the clear marker, so the credential is actually removed
//   N4 · deleting the characters by hand sends it too (Codex r2, P1: it sent "",
//        so the credential came back on the next reload)
//   N5 · a secret that was never set sends "" — nothing to remove
//   N6 · typing a replacement sends the new plaintext for the host to encrypt
//   N7 · a save the host could not protect is reported on the panel, which
//        otherwise re-renders as if every save succeeded
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const http = require('http');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const SHELL = path.join(REPO, 'src', 'WaveshareWidgets', 'Shell');
const PORT = 8952;

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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const CLEAR = '__ww_secret_cleared__';
const STORED_TOKEN = 'ghp_REAL_DECRYPTED_VALUE';

const widgets = [{
  id: 'test.gh', name: 'GitHub Queue', author: 'WW',
  url: `http://127.0.0.1:${PORT}/widgets/clock/index.html`,
  supportedSlots: ['quarter', 'half'],
  properties: [
    { name: 'token', label: 'Token', type: 'secret', placeholder: 'ghp_…' },
    { name: 'fresh', label: 'Other token', type: 'secret' },
    { name: 'repo', label: 'Repository', type: 'text', default: 'owner/name' },
  ],
}];

(async () => {
  const srv = await staticServer(REPO, PORT);
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 400 } });
  page.on('pageerror', (e) => { failures++; console.log('[pageerror]', String(e).slice(0, 300)); });

  // The dashboard is handed DECRYPTED secrets — that is the whole reason the panel
  // field can be prefilled and the reason emptying it has to be disambiguated.
  const layout = { pages: [{ name: 'P', slots: [{
    widgetId: 'test.gh', size: 'half', instanceId: 'gh1',
    settings: { token: STORED_TOKEN, fresh: '', repo: 'binaryzero/waveshare-widgets' },
  }] }] };

  const saves = [];
  await page.exposeFunction('__hostRecv', async (json) => {
    const msg = JSON.parse(json);
    if (msg.type === 'ready') {
      page.evaluate((d) => window.__hostPush(d), JSON.stringify({
        type: 'init',
        data: { layout, widgets, sensors: [], media: null, backgroundHost: 'backgrounds.wsw', status: { elevated: false, apiVersion: 1 } },
      })).catch(() => {});
    } else if (msg.type === 'save-layout') {
      saves.push(JSON.parse(JSON.stringify(msg.layout)));
    }
  });
  await page.addInitScript(() => {
    if (window.top !== window) return;
    const listeners = new Set();
    window.chrome = { webview: {
      addEventListener(t, cb) { if (t === 'message') listeners.add(cb); },
      postMessage(m) { window.__hostRecv(JSON.stringify(m)); },
    } };
    window.__hostPush = (json) => { const data = JSON.parse(json); listeners.forEach((cb) => { try { cb({ data }); } catch (e) {} }); };
  });
  await page.addInitScript(fs.readFileSync(path.join(SHELL, 'widget-api.js'), 'utf8'));
  await page.goto(`http://127.0.0.1:${PORT}/src/WaveshareWidgets/Shell/index.html`);
  await wait(1200);

  const lastSave = () => (saves.length ? saves[saves.length - 1] : null);
  const savedSetting = (name) => {
    const s = lastSave();
    return s ? s.pages[0].slots[0].settings[name] : undefined;
  };

  await page.locator('#editBtn').click();
  await wait(250);
  await page.locator('.slot').first().locator('.edit-overlay .gear').click();
  await wait(200);

  const rows = page.locator('#psRows .ps-secret');
  check('N1 both secrets render as on-panel credential rows', await rows.count() === 2,
    String(await rows.count()));
  const tokenRow = rows.nth(0);
  const freshRow = rows.nth(1);

  check('N1b the field is masked — a desk-height strip is readable across a room',
    await tokenRow.locator('input').getAttribute('type') === 'password');
  check('N1c it holds the REAL credential (the host decrypts for the dashboard)',
    await tokenRow.locator('input').inputValue() === STORED_TOKEN);

  // ---- N2 · Clear is offered only where there is something to remove
  check('N2 a stored secret offers an explicit Clear',
    await tokenRow.locator('.ps-clear').evaluate((n) => n.hidden) === false);
  check('N2b a secret with nothing stored offers none',
    await freshRow.locator('.ps-clear').evaluate((n) => n.hidden) === true);

  // ---- N4 · deleting the characters by hand must reach the host as a REMOVAL
  await tokenRow.locator('input').fill('');
  await wait(900); // apply + persist debounces
  check('N4 emptying the field by hand sends the clear marker, not a bare ""',
    savedSetting('token') === CLEAR, JSON.stringify(savedSetting('token')));

  // ---- N6 · typing a replacement sends the plaintext for the host to encrypt
  await tokenRow.locator('input').fill('ghp_TYPED_ON_GLASS');
  await wait(900);
  check('N6 typing a replacement sends the new value',
    savedSetting('token') === 'ghp_TYPED_ON_GLASS', JSON.stringify(savedSetting('token')));

  // ---- N3 · the Clear button does the same thing in one deliberate tap
  await tokenRow.locator('.ps-clear').click();
  await wait(900);
  check('N3 Clear empties the field', await tokenRow.locator('input').inputValue() === '');
  check('N3b and the save carries the clear marker',
    savedSetting('token') === CLEAR, JSON.stringify(savedSetting('token')));

  // ---- N5 · a secret nobody touched is never turned into a removal
  check('N5 an untouched unset secret still saves as "" — there is nothing to delete',
    savedSetting('fresh') === '', JSON.stringify(savedSetting('fresh')));
  check('N5b the marker is never shown back to the user as a value',
    await tokenRow.locator('input').inputValue() === '' && await freshRow.locator('input').inputValue() === '');
  check('N5c non-secret settings ride along untouched',
    savedSetting('repo') === 'binaryzero/waveshare-widgets');

  // ---- N8 · a credential typed during THIS sheet session is still removable
  // The field started empty, so a snapshot taken at render time says "nothing stored".
  // But edits persist on a debounce, so by the time the user deletes what they typed a
  // credential DOES exist — and sending "" would have the host restore the value it
  // just saved, leaving an empty-looking field over a live token (Codex r3, P1).
  await freshRow.locator('input').fill('ghp_TYPED_INTO_AN_EMPTY_FIELD');
  await wait(900);   // persisted: a credential now exists for this field
  check('N8b Clear appears as soon as a credential exists',
    await freshRow.locator('.ps-clear').evaluate((n) => n.hidden) === false);
  await freshRow.locator('input').fill('');
  await wait(900);
  check('N8c deleting it sends the clear marker, not the "keep it" empty string',
    savedSetting('fresh') === CLEAR, JSON.stringify(savedSetting('fresh')));

  // ---- N7 · a save the host could not protect has to surface on the panel
  await page.evaluate(() => window.__hostPush(JSON.stringify({
    type: 'secrets-failed', data: ['test.gh.token'],
  })));
  await wait(150);
  const notice = page.locator('#panelNotice');
  check('N7 an unprotectable credential is reported on glass, not swallowed',
    await notice.count() === 1 && await notice.isVisible() &&
    /Could not save the credential/i.test(await notice.textContent() || ''),
    await notice.textContent().catch(() => '(absent)'));

  await browser.close();
  srv.close();
  console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
