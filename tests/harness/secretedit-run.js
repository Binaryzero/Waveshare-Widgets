#!/usr/bin/env node
// Issue #56 — two editor bugs left over from the secret pipeline.
//   S1 · typing a credential marks the editor dirty. The edit detector compared the
//        preview's copy, which blanks every secret, so a typed token changed nothing
//        there: Save stayed unlit.
//   S2 · after the widget picker swaps a slot's widget, a same-named secret the OLD
//        widget stored this session does not read as saved for the new one. The
//        session record was keyed by instance id alone, and the picker keeps that id.
//   S3 · with a typed credential unsaved, a panel write is not adopted over it (#281):
//        only a clean editor adopts, and the typed token made it look clean.
// Run in the order S1, S3, S2: S2's swap works the same on a held (stale) copy.
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

// Two widgets declaring the SAME secret name: the collision S2 is about.
const widgets = [{
  id: 'test.gh', name: 'GitHub Queue', supportedSlots: ['half'],
  properties: [
    { name: 'token', label: 'Personal access token', type: 'secret', help: 'From GitHub settings.' },
    { name: 'repo', label: 'Repository', type: 'text', default: 'owner/name' },
  ],
}, {
  id: 'test.ha', name: 'Home Assistant', supportedSlots: ['half'],
  properties: [
    { name: 'token', label: 'Long-lived token', type: 'secret', help: 'From your HA profile.' },
  ],
}];

// What the host sends after SecretPolicy.Mask: a stored token, blanked, named in secretsSet.
const layout = {
  pages: [{
    name: 'Main',
    slots: [{
      widgetId: 'test.gh', size: 'half', instanceId: 'gh1',
      settings: { token: '', repo: 'binaryzero/waveshare-widgets' },
      secretsSet: ['token'],
    }],
  }],
};

(async () => {
  const srv = await staticServer(REPO, 8953);
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
  page.on('pageerror', (e) => { failures++; console.log('[pageerror]', String(e).slice(0, 300)); });

  const saved = [];
  const push = (obj) => page.evaluate((d) => window.__hostPush(d), JSON.stringify(obj)).catch(() => {});
  await page.exposeFunction('__hostRecv', async (json) => {
    const msg = JSON.parse(json);
    if (msg.type === 'settings-ready') {
      push({ type: 'settings-init', data: {
        layout, widgets, sensors: [], backgroundHost: 'backgrounds.plinth',
        status: { elevated: false, version: 'v0.2.0 (probe)' },
      } });
    } else if (msg.type === 'save-layout') {
      saved.push(JSON.parse(JSON.stringify(msg.layout)));
      push({ type: 'saved', seq: msg.seq, generation: saved.length });
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
  await page.goto('http://127.0.0.1:8953/src/Plinth/Shell/settings.html');
  await page.waitForTimeout(900);
  await page.locator('#slotList .slot-chip .chip-main').first().click();
  await page.waitForTimeout(200);

  const isDirty = () => page.locator('#save').evaluate((n) => n.classList.contains('dirty'));
  const secret = () => page.locator('#slotDetail .secret-wrap').first();
  const stateText = async () => ((await secret().locator('.secret-state').textContent()) || '').trim();

  check('S1 setup: a freshly loaded editor is clean', !(await isDirty()));
  check('S1 setup: the stored token reads as saved', /saved · encrypted/.test(await stateText()), await stateText());

  // ---- S1 · replacing a saved credential is an edit ---------------------------------
  await secret().locator('input').fill('ghp_REPLACEMENT');
  await page.waitForTimeout(150);
  check('S1 typing a new token over a saved one marks the editor dirty', await isDirty());

  await page.locator('#save').click();
  await page.waitForTimeout(500);
  const last = saved.length ? saved[saved.length - 1].pages[0].slots[0] : {};
  check('S1b ...Save carries the typed token, and the ack leaves the editor clean',
    (last.settings || {}).token === 'ghp_REPLACEMENT' && !(await isDirty()),
    JSON.stringify({ saves: saved.length, token: (last.settings || {}).token, dirty: await isDirty() }));

  // ---- S3 · an unsaved token is unsaved work --------------------------------------
  // Typed into a field whose key is already in the layout ('' from the host's mask, or
  // the token just saved). A key appearing for the first time changed the blanked copy
  // anyway, which hid this bug from any check that started from an empty slot.
  await secret().locator('input').fill('ghp_TYPED_NOT_SAVED');
  await page.waitForTimeout(150);
  const panelLayout = JSON.parse(JSON.stringify(layout));
  panelLayout.pages[0].name = 'Renamed on the panel';
  await push({ type: 'layout-written', layout: panelLayout, generation: 99 });
  await page.waitForTimeout(300);
  // Adopting the panel's layout closes the inspector (its slot objects are new), so a
  // missing row is the failure itself, not a reason to wait.
  const typedStill = await page.locator('#slotDetail .secret-wrap input').count()
    ? await secret().locator('input').inputValue() : '(inspector closed: the panel layout was adopted)';
  check('S3 a panel write does not replace a copy holding an unsaved token',
    typedStill === 'ghp_TYPED_NOT_SAVED' && await isDirty(),
    JSON.stringify({ field: typedStill, dirty: await isDirty() }));
  if (!(await page.locator('#slotDetail select').count())) {
    await page.locator('#slotList .slot-chip .chip-main').first().click();
    await page.waitForTimeout(200);
  }

  // ---- S2 · the session record belongs to the widget, not just the slot -------------
  // The token typed and saved above is recorded for gh1. Swapping the slot to another
  // widget keeps the instance id; the host stores credentials per widget, so the new
  // widget has nothing, whatever its secret is called.
  await page.evaluate(() => {
    const sel = document.querySelector('#slotDetail select');
    sel.value = 'test.ha';
    sel.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(250);
  check('S2 after a swap, the new widget\'s same-named secret reads "not set"',
    (await stateText()) === 'not set', await stateText());
  check('S2b and it offers no Clear for a credential it never had',
    await secret().locator('button.danger').evaluate((n) => n.hidden) === true);

  await browser.close();
  srv.close();
  console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
