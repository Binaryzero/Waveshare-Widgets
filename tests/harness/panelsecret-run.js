#!/usr/bin/env node
// Issue #15 — the ON-PANEL half of the `secret` contract (shell.js psControl + the
// dashboard save path). The panel is a different world from the desktop editor: the
// host hands the dashboard DECRYPTED values, so the field really does hold the
// credential. That makes "the user emptied it" ambiguous unless the shell says which
// it meant, because the host reads "" as "the masked desktop field came back
// untouched" and KEEPS the stored ciphertext.
//   N1 · the field is masked on glass and holds the real (revealed) value
//   N2 · a stored secret offers an explicit Clear; an unset one does not
//   N3 · Clear names the property cleared, so the credential is actually removed
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

// The string that USED to be the clear sentinel. Kept only so the probes can assert it
// is now ordinary text: intent travels as a name in the slot's secretsCleared projection,
// so no value carries protocol and nothing has to be escaped by any producer.
const EX_SENTINEL = '__ww_secret_cleared__';
const clearedNames = (slot) => (slot && slot.secretsCleared) || [];
const STORED_TOKEN = 'ghp_REAL_DECRYPTED_VALUE';

const widgets = [{
  id: 'test.gh', name: 'GitHub Queue', author: 'WW',
  url: `http://127.0.0.1:${PORT}/widgets/clock/index.html`,
  supportedSlots: ['quarter', 'half'],
  properties: [
    { name: 'token', label: 'Token', type: 'secret', placeholder: 'ghp_…' },
    { name: 'fresh', label: 'Other token', type: 'secret' },
    { name: 'repo', label: 'Repository', type: 'text', default: 'owner/name' },
    // DEMOTED: the manifest calls it text now, but layout.json still holds the envelope,
    // so Reveal blanked it and named it in secretsRestorable on the init payload.
    { name: 'legacyToken', label: 'Legacy token', type: 'text' },
  ],
}, {
  // Declares half+full only, while N11's slot is STORED as quarter — a manifest that
  // narrowed under an existing layout, which is what weather did in #77.
  id: 'test.narrow', name: 'Narrow Only', author: 'WW',
  url: `http://127.0.0.1:${PORT}/widgets/clock/index.html`,
  supportedSlots: ['half', 'full'],
  properties: [],
}];

(async () => {
  const srv = await staticServer(REPO, PORT);
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 400 } });
  page.on('pageerror', (e) => { failures++; console.log('[pageerror]', String(e).slice(0, 300)); });

  // The dashboard is handed DECRYPTED secrets — that is the whole reason the panel
  // field can be prefilled and the reason emptying it has to be disambiguated.
  // A second tile whose STORED size its widget no longer allows — the state weather
  // entered when it dropped `quarter` (#77). Its widget is declared in `widgets` below.
  const narrowSlot = {
    widgetId: 'test.narrow', size: 'quarter', instanceId: 'nar1', settings: {},
  };
  const layout = { pages: [{ name: 'P', slots: [{
    // Deliberately ID-LESS: a layout written before instance ids existed. It is the case
    // #68 and #70 are both about, and it is what lets N10 tell whether the shell really
    // mints before saving — with an id already present, that check passes either way.
    // A QUARTER, so the page keeps room for the narrow tile to reach either half or
    // three-quarter. With both reachable, N11 is decided by cycle ORDER; if only one
    // fitted, the probe would pass whichever order the cycler used.
    widgetId: 'test.gh', size: 'quarter',
    settings: { token: STORED_TOKEN, fresh: '', legacyToken: '', repo: 'binaryzero/waveshare-widgets' },
    secretsRestorable: ['legacyToken'],
  }, narrowSlot] }] };

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
  const savedSlot = () => {
    const s = lastSave();
    return s ? s.pages[0].slots[0] : null;
  };
  const savedSetting = (name) => {
    const slot = savedSlot();
    return slot ? slot.settings[name] : undefined;
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
  check('N4 emptying the field by hand names it cleared, not a bare "" that means two things',
    savedSetting('token') === '' && clearedNames(savedSlot()).includes('token'),
    JSON.stringify({ value: savedSetting('token'), cleared: clearedNames(savedSlot()) }));

  // ---- N6 · typing a replacement sends the plaintext for the host to encrypt
  await tokenRow.locator('input').fill('ghp_TYPED_ON_GLASS');
  await wait(900);
  check('N6 typing a replacement sends the new value',
    savedSetting('token') === 'ghp_TYPED_ON_GLASS', JSON.stringify(savedSetting('token')));

  // ---- N3 · the Clear button does the same thing in one deliberate tap
  await tokenRow.locator('.ps-clear').click();
  await wait(900);
  check('N3 Clear empties the field', await tokenRow.locator('input').inputValue() === '');
  check('N3b and the save carries the cleared name beside the layout',
    savedSetting('token') === '' && clearedNames(savedSlot()).includes('token'),
    JSON.stringify({ value: savedSetting('token'), cleared: clearedNames(savedSlot()) }));

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
  check('N8c deleting it NAMES the property cleared, so the empty value cannot be read '
    + 'as "keep it"',
    savedSetting('fresh') === '' && clearedNames(savedSlot()).includes('fresh'),
    JSON.stringify({ value: savedSetting('fresh'), cleared: clearedNames(savedSlot()) }));

  // ---- N9 · nothing sentinel-shaped can reach the live widget, because none exists
  // The 400 ms apply path reloads the iframe with ww-settings from the same record the
  // save payload comes from. This used to need an unwrap step in mergedSettings, because
  // a widget handed the sentinel would read a non-empty string as a live credential and
  // keep retrying (Codex r4, P2). The value is simply empty now.
  await tokenRow.locator('input').fill('ghp_ABOUT_TO_BE_CLEARED');
  await wait(900);
  await tokenRow.locator('.ps-clear').click();
  await wait(900);
  const frameHash = await page.locator('.slot iframe').first().getAttribute('src');
  const applied = decodeURIComponent((frameHash || '').split('ww-settings=')[1] || '');
  check('N9 the reloaded widget receives an empty secret, with no sentinel anywhere',
    applied.length > 0 && !applied.includes('__ww_secret') && /"token":""/.test(applied),
    applied.slice(0, 160));

  // ---- N9b · the string that used to be protocol is now an ordinary credential --------
  // The panel had to escape it before; a value can only mean itself now.
  await tokenRow.locator('input').fill(EX_SENTINEL);
  await wait(900);
  check('N9b a credential equal to the old sentinel is sent verbatim, and is not a clear',
    savedSetting('token') === EX_SENTINEL && !clearedNames(savedSlot()).includes('token'),
    JSON.stringify({ value: savedSetting('token'), cleared: clearedNames(savedSlot()) }));

  // ---- N12 · #153: the panel can finally DELETE a demoted credential ------------------
  // Reveal blanks the envelope, so the field arrives empty and looks identical to one that
  // was always empty. Before the reveal-side marker the panel had no way to tell them
  // apart, rendered no Clear, and an emptied field was read by Seal as untouched — the
  // stored envelope came straight back. The name is what makes the intent sayable.
  const legacyRow = page.locator('.ps-field').filter({ hasText: 'Legacy token' });
  check('N12 a demoted property gets a Clear on the panel',
    await legacyRow.locator('.ps-field-clear').count() === 1,
    String(await legacyRow.locator('.ps-field-clear').count()));
  check('N12b while an ordinary property does not',
    await page.locator('.ps-field').filter({ hasText: 'Repository' })
      .locator('.ps-field-clear').count() === 0);
  await legacyRow.locator('.ps-field-clear').click();
  await wait(900);
  check('N12c and using it names the address, so the host removes rather than restores',
    savedSetting('legacyToken') === '' && clearedNames(savedSlot()).includes('legacyToken'),
    JSON.stringify({ value: savedSetting('legacyToken'), cleared: clearedNames(savedSlot()) }));

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

  // N7b · the notice must not eat the taps it is telling the user to make. It rides at
  // z-index 90 for six seconds, bottom-centre — right where a tile's size and band chips
  // are — over an edit overlay at z-index 3. It carries no controls, so it is inert;
  // without that, the one banner that says "move or remove a widget first" is also the
  // thing blocking you from doing it.
  const hitTest = await page.evaluate(() => {
    const el = document.getElementById('panelNotice');
    if (!el) return { ok: false, why: 'no notice' };
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      ok: at !== el && !el.contains(at),
      why: at ? (at.id || at.className || at.tagName) : 'nothing',
      visible: r.width > 0 && r.height > 0,
    };
  });
  check('N7b the notice is visible but not hit-testable, so it cannot swallow the next tap',
    hitTest.ok && hitTest.visible, `point resolves to: ${hitTest.why}`);

  // ---- N10 · identity flows back from the host, and why it is dormant (#70) ----------
  // SettingsWindow has handed minted instance ids back to its client since #15;
  // DashboardWindow dropped them, so host and shell could disagree about which slot is
  // which. The handler now exists on both sides — but the reason it has never bitten is
  // an INVARIANT nothing stated: persistLayout mints an id for every id-less def before
  // posting, so the host's Stamp has nothing left to mint on this path.
  //
  // That invariant is what these two checks pin. If a future change stops the shell
  // minting first, N10 fails here rather than in the field, and the adoption path N10b
  // covers stops being dormant at exactly that moment.
  const everySavedSlotHasId = saves.length > 0 && saves.every((s) =>
    (s.pages || []).every((p) => (p.slots || []).every((slot) => !!slot.instanceId)));
  check('N10 the shell mints before saving, so the host never has to (why #70 is dormant)',
    everySavedSlotHasId, `${saves.length} saves inspected`);

  // An ack for a slot that already has an identity must not re-brand it. While N10 holds
  // that is every slot, so this is the reachable half of the handler; the widgetId guard
  // itself cannot be exercised from here, and a probe claiming to test it would pass with
  // the guard deleted.
  //
  // The id is compared ACROSS the ack, and a real mutation is forced afterwards so the
  // comparison sees a save taken after it. Asserting against `saves` alone proved nothing:
  // selecting a slot does not call persistLayout, so the newest snapshot still predated
  // the message and the check passed however the handler behaved.
  const idBefore = (lastSave() || {}).pages?.[0]?.slots?.[0]?.instanceId;
  await page.evaluate(() => window.__hostPush(JSON.stringify({
    type: 'minted-ids',
    data: [{ page: 0, slot: 0, widgetId: 'test.gh', instanceId: 's-from-host' },
           { page: 0, slot: 0, widgetId: 'other.widget', instanceId: 's-wrong-widget' },
           { page: 9, slot: 9, widgetId: 'test.gh', instanceId: 's-out-of-range' }],
  })));
  await wait(250);
  const savesBeforeMutation = saves.length;
  await rows.nth(0).locator('input').fill('forces-a-save-after-the-ack');
  await wait(900);
  const idAfter = (lastSave() || {}).pages?.[0]?.slots?.[0]?.instanceId;
  check('N10b the mutation really persisted, so the comparison sees a post-ack save',
    saves.length > savesBeforeMutation, `${savesBeforeMutation} -> ${saves.length}`);
  check('N10c an ack for an already-identified slot leaves its identity alone',
    !!idBefore && idAfter === idBefore, `${idBefore} -> ${idAfter}`);
  check('N10d and none of the injected ids reached the layout',
    !JSON.stringify(lastSave()).includes('s-from-host') &&
    !JSON.stringify(lastSave()).includes('s-wrong-widget') &&
    !JSON.stringify(lastSave()).includes('s-out-of-range'));

  // ---- N11 · cycling from a size the widget no longer allows (#77) -------------------
  // `test.narrow` allows [half, full] — so allowedWidths gives [half, three-quarter,
  // full] — while its slot is STORED as quarter. indexOf returns -1 for that, and
  // clamping it to 0 made the first candidate whatever sat at index 0: three-quarter,
  // vaulting past the adjacent half. Every size stayed reachable by cycling, so this is
  // an ordering defect rather than the unreachability it first looked like.
  //
  // The page is a quarter plus this quarter, so BOTH half and three-quarter fit. That
  // is what makes the probe discriminate: if only one fitted, either order would land
  // on it and the check would pass regardless.
  const narrowTile = page.locator('.slot').nth(1);
  const beforeSizes = (lastSave() || {}).pages?.[0]?.slots?.map((s) => s.size);
  await narrowTile.locator('.edit-overlay .size').click();
  await wait(900);
  const afterSizes = (lastSave() || {}).pages?.[0]?.slots?.map((s) => s.size);
  check('N11 the tap changed the stored size, so there is something to judge',
    JSON.stringify(beforeSizes) !== JSON.stringify(afterSizes) || beforeSizes === undefined,
    `${JSON.stringify(beforeSizes)} -> ${JSON.stringify(afterSizes)}`);
  check('N11b an unsupported stored size cycles to the NEXT size up, not past it',
    afterSizes && afterSizes[1] === 'half', JSON.stringify(afterSizes));

  await browser.close();
  srv.close();
  console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
