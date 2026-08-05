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
//   N14 · a picker:'file' target is CHOSEN from installed apps, not typed (#210)
//   N13 · a property's `help` reaches THIS sheet too, and survives the field having a
//         value — the panel is the screen with no second screen to read docs on (#207)
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const http = require('http');
const path = require('path');

const { textContrast, AA_NORMAL, LARGE_TEXT_PX } = require('./contrast');

const REPO = path.resolve(__dirname, '..', '..');
const SHELL = path.join(REPO, 'src', 'Plinth', 'Shell');
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
    // The only property here carrying `help`, so N13c has a subject that must NOT grow a
    // stub. The text is deliberately unlike every other label in this fixture — N12 finds
    // its rows with hasText filters, and help text is row text too.
    { name: 'token', label: 'Token', type: 'secret', placeholder: 'ghp_…',
      help: 'Fine-grained PAT, read-only on Pull requests and Actions.' },
    { name: 'fresh', label: 'Other token', type: 'secret' },
    { name: 'repo', label: 'Repository', type: 'text', default: 'owner/name' },
    // #210. Shaped like the real ones: EVERY shipped picker:'file' is a field inside a
    // `list` (launcher items.target, deck buttons.target) and there is no top-level one
    // in the catalog. The first version of this fixture invented a top-level property,
    // which is why it passed while the on-device list renderer still had no picker at all
    // — the check was narrower than the claim it was making.
    { name: 'items', label: 'Shortcuts', type: 'list', itemLabel: 'shortcut',
      fields: [
        { key: 'label', label: 'Name', type: 'text', picker: 'emoji-prefix' },
        { key: 'target', label: 'Path or URL', type: 'text', picker: 'file' },
      ], default: [] },
    // Kept beside it so psControl's own branch stays covered: the spec allows a top-level
    // picker even though no stock widget declares one today.
    { name: 'target', label: 'Program', type: 'text', picker: 'file' },
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
    settings: { token: STORED_TOKEN, fresh: '', legacyToken: '', repo: 'binaryzero/waveshare-widgets',
      // Carries a legacy `kind` no field renders — the shape a deck row migrated from
      // the old JSON config still has. classify() consults it for a scheme-less target,
      // so a picked .lnk would be parsed as a hotkey unless the pick retires it.
      items: [{ label: 'Steam', target: '', kind: 'hotkey' }] },
    secretsRestorable: ['legacyToken'],
  }, narrowSlot] }] };

  const saves = [];
  let appListRequests = 0;
  let appFlood = false;
  await page.exposeFunction('__hostRecv', async (json) => {
    const msg = JSON.parse(json);
    if (msg.type === 'ready') {
      page.evaluate((d) => window.__hostPush(d), JSON.stringify({
        type: 'init',
        data: { layout, widgets, sensors: [], media: null, backgroundHost: 'backgrounds.plinth', status: { elevated: false, apiVersion: 1 } },
      })).catch(() => {});
    } else if (msg.type === 'save-layout') {
      saves.push(JSON.parse(JSON.stringify(msg.layout)));
    } else if (msg.type === 'list-apps') {
      appListRequests++;
      page.evaluate((d) => window.__hostPush(d), JSON.stringify({
        type: 'apps-result',
        // 250 entries once N15 asks for them: the render cap is 200, and a cap that says
        // nothing is indistinguishable from "that app is not installed".
        data: appFlood ? { truncated: true, apps: Array.from({ length: 250 }, (_, i) => (
          { name: 'App ' + String(i).padStart(3, '0'), path: 'C:\\Start Menu\\App' + i + '.lnk' })) }
        : { truncated: false, apps: [
          { name: 'Steam', path: 'C:\\ProgramData\\Start Menu\\Steam.lnk' },
          { name: 'Visual Studio Code', path: 'C:\\Users\\u\\Start Menu\\Code.lnk' },
          { name: 'Notepad', path: 'C:\\ProgramData\\Start Menu\\Notepad.lnk' },
        ] },
      })).catch(() => {});
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
  await page.goto(`http://127.0.0.1:${PORT}/src/Plinth/Shell/index.html`);
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

  // ---- N13 · guidance reaches the ON-DEVICE sheet (#207)
  // The settings window has secretfield's E35; this side had nothing, so deleting the
  // sheet's help block failed no check at all. It is also the side that matters more —
  // the panel is where a value gets typed with no second screen to read docs on.
  // By structure, not by text: `hasText` is a case-insensitive substring, so "Token"
  // also matches "Other token" and "Legacy token". The token field is the first one
  // holding a credential control — and the probe checks it landed on the right row
  // before drawing any conclusion from what is inside it.
  const tokenField = page.locator('#psRows .ps-field')
    .filter({ has: page.locator('.ps-secret') }).first();
  const tokenHelp = tokenField.locator('.ps-help');
  check('N13pre the probe is looking at the Token field',
    (await tokenField.locator('label').first().textContent() || '').trim() === 'Token',
    JSON.stringify((await tokenField.locator('label').first().textContent() || '').trim()));
  check('N13 a property with help renders it under the control on the panel',
    await tokenHelp.count() === 1, String(await tokenHelp.count()));
  check('N13a and it says what the manifest said',
    (await tokenHelp.count()) === 1
      && (await tokenHelp.textContent() || '').includes('read-only on Pull requests'),
    (await tokenHelp.count()) === 1 ? JSON.stringify(await tokenHelp.textContent()) : 'no element');

  // The whole difference from a placeholder: a placeholder is gone the moment a value
  // exists, and on this sheet a stored credential means a value ALWAYS exists.
  check('N13b it is still there while the field holds a value',
    (await tokenHelp.count()) === 1 && await tokenHelp.isVisible()
      && (await tokenRow.locator('input').inputValue()) !== '',
    JSON.stringify({ shown: (await tokenHelp.count()) === 1 && await tokenHelp.isVisible(),
      value: (await tokenRow.locator('input').inputValue()) !== '' }));

  // Rendered, not merely present: a 400px-tall strip is where text goes to get clipped,
  // and a paragraph pushed outside the sheet's own box is help nobody can read.
  const helpBox = (await tokenHelp.count()) === 1 ? await tokenHelp.boundingBox() : null;
  const rowsBox = await page.locator('#psRows').boundingBox();
  const ctrlBox = await tokenField.locator('.ps-secret').boundingBox();
  check('N13c it is laid out inside the sheet, not clipped off the side of it',
    !!helpBox && !!rowsBox && helpBox.width > 0 && helpBox.height > 0
      && helpBox.x >= rowsBox.x - 1 && helpBox.x + helpBox.width <= rowsBox.x + rowsBox.width + 1,
    JSON.stringify({ help: helpBox, rows: rowsBox }));
  check('N13c2 and under the control it explains, not above it',
    !!helpBox && !!ctrlBox && helpBox.y >= ctrlBox.y + ctrlBox.height - 1,
    JSON.stringify({ helpY: helpBox && helpBox.y, ctrlBottom: ctrlBox && ctrlBox.y + ctrlBox.height }));

  // Legible, not merely painted. Guidance the standard now REQUIRES on every secret is
  // guidance somebody has to read, and the first shipped colour was `--text-dim` — the
  // dimmest derived token, fainter than the label above it, on a strip read from desk
  // distance. Nothing in this file could see that: every other check here is structural.
  // So the contrast is computed the way a browser composites it — walk the ancestors
  // until the colours stop being transparent, then measure.
  const contrast = await textContrast(tokenHelp);
  check(`N13e and it is legible where it is painted (>= ${AA_NORMAL}:1, normal-size text)`,
    contrast.ratio >= AA_NORMAL && contrast.fontPx < LARGE_TEXT_PX,
    JSON.stringify({ ratio: Math.round(contrast.ratio * 100) / 100,
      exact: contrast.exact, bounds: contrast.bounds, fontPx: contrast.fontPx, color: contrast.color }));

  check('N13d a property without help grows no empty stub',
    await page.locator('#psRows .ps-field').filter({ hasText: 'Repository' })
      .locator('.ps-help').count() === 0);

  // ---- N14 · a path target is CHOSEN on the panel, not typed (#210)
  // This surface had no picker at all: the OS file dialog needs a Win32 owner window, so
  // picker:'file' degraded to free text and the address had to be typed on a touch strip.
  // The LIST field — the shape every shipped picker:'file' actually has.
  // `has:` is resolved RELATIVE to the outer element, so it must be a relative selector —
  // an absolute `#psRows …` one matches nothing inside a .ps-inline and the filter yields
  // zero, which reads exactly like a missing picker.
  const targetField = page.locator('#psRows .ps-item .ps-inline')
    .filter({ has: page.locator('input[aria-label="Path or URL"]') }).first();
  const targetInput = targetField.locator('input[aria-label="Path or URL"]');
  check('N14pre the probe is looking at a list row\'s path field',
    await targetInput.count() === 1, String(await targetInput.count()));
  check('N14a and the TOP-LEVEL form gets one too, which psControl renders separately',
    await page.locator('#psRows .ps-field').filter({ hasText: 'Program' }).first()
      .locator('.ps-pick').count() === 1);
  // Count before clicking. A click on a locator that matches nothing waits out the
  // timeout and THROWS, which aborts the file — so removing the picker would report one
  // FAIL and then silently skip N2 through N12, which have nothing to do with it. This
  // file has been bitten by exactly that once already; ask whether it exists first.
  const havePicker = await targetField.locator('.ps-pick').count() === 1;
  check('N14 the field offers a picker instead of only a text box', havePicker,
    String(await targetField.locator('.ps-pick').count()));

  if (havePicker) {
    await targetField.locator('.ps-pick').click();
    await wait(250);
  }
  const appSheet = page.locator('.ps-apps');
  check('N14b tapping it asks the host and opens the list',
    havePicker && appListRequests === 1 && await appSheet.count() === 1,
    JSON.stringify({ requests: appListRequests, sheets: await appSheet.count() }));
  check('N14c the installed applications are listed',
    await appSheet.locator('.ps-apps-list button').count() === 3,
    String(await appSheet.locator('.ps-apps-list button').count()));

  // A real Start Menu runs to hundreds of entries, so the filter is not a nicety.
  const haveSheet = await appSheet.count() === 1;
  if (haveSheet) {
    await appSheet.locator('.ps-apps-head input').fill('code');
    await wait(120);
  }
  check('N14d the filter narrows by name, case-insensitively',
    haveSheet && await appSheet.locator('.ps-apps-list button').count() === 1
      && (await appSheet.locator('.ps-apps-list button').first().textContent()) === 'Visual Studio Code',
    JSON.stringify(await appSheet.locator('.ps-apps-list button').allTextContents()));

  // 44px rows: a 400px strip is touched, not clicked.
  const rowBox = haveSheet && await appSheet.locator('.ps-apps-list button').count()
    ? await appSheet.locator('.ps-apps-list button').first().boundingBox() : null;
  check('N14e the rows are touch-sized', !!rowBox && rowBox.height >= 44,
    JSON.stringify(rowBox && rowBox.height));

  if (haveSheet && await appSheet.locator('.ps-apps-list button').count()) {
    await appSheet.locator('.ps-apps-list button').first().click();
    await wait(900);
  }
  check('N14f choosing one writes its PATH into the field, not its name',
    await targetInput.inputValue() === 'C:\\Users\\u\\Start Menu\\Code.lnk',
    JSON.stringify(await targetInput.inputValue()));
  const savedRow = () => (savedSetting('items') || [])[0] || {};
  check('N14g and it reaches the saved layout, on the ROW it belongs to',
    savedRow().target === 'C:\\Users\\u\\Start Menu\\Code.lnk' && savedRow().label === 'Steam',
    JSON.stringify(savedRow()));
  check('N14j and it retires the row\'s legacy action kind, which would out-rank the path',
    !('kind' in savedRow()), JSON.stringify(savedRow()));
  check('N14h the sheet closes on a pick',
    await page.locator('.ps-apps').count() === 0);

  // N14i · the sheet must not outlive the editor that opened it. It is appended to
  // <body>, so hiding the property sheet does nothing to it — and left behind it still
  // holds the old input, so a pick writes into a slot whose editor is gone.
  if (havePicker) {
    await targetField.locator('.ps-pick').click();
    await wait(250);
  }
  const beforeClose = await page.locator('.ps-apps').count();
  // Dispatched on the element rather than clicked at its coordinates: the chooser is
  // z-index 60 over the property sheet, so a real click lands on the chooser and the
  // probe measures nothing. This asserts the LIFECYCLE — that closing the editor takes
  // the sheet with it — not that #psClose is hit-testable underneath it.
  await page.evaluate(() => document.getElementById('psClose').click());
  await wait(300);
  check('N14i and it does not outlive the property editor that opened it',
    beforeClose === 1 && await page.locator('.ps-apps').count() === 0,
    JSON.stringify({ opened: beforeClose, after: await page.locator('.ps-apps').count() }));
  // reopen for the checks that follow
  await page.locator('.slot').first().locator('.edit-overlay .gear').click().catch(() => {});
  await wait(250);

  // ---- N15 · the render cap says what it dropped (#210)
  // The list is cut at 200 rows. Cutting it is fine; cutting it silently is not — the
  // rows that are missing look exactly like applications that are not installed, and
  // this is the surface where scrolling to find out costs the most.
  appFlood = true;
  if (havePicker) {
    await targetField.locator('.ps-pick').click();
    await wait(300);
  }
  const flood = page.locator('.ps-apps');
  const floodOpen = await flood.count() === 1;
  check('N15 a list longer than the cap still renders exactly the cap',
    floodOpen && await flood.locator('.ps-apps-list button').count() === 200,
    String(floodOpen ? await flood.locator('.ps-apps-list button').count() : 'no sheet'));
  check('N15b and it SAYS it was cut, with the real total and what to do about it',
    floodOpen && /Showing 200 of 250/.test(await flood.locator('.ps-apps-status').textContent() || '')
      && await flood.locator('.ps-apps-status').isVisible(),
    JSON.stringify(floodOpen ? await flood.locator('.ps-apps-status').textContent() : 'no sheet'));
  if (floodOpen) {
    await flood.locator('.ps-apps-head input').fill('App 24');
    await wait(120);
  }
  check('N15c narrowing under the cap drops the notice rather than leaving it lying',
    floodOpen && await flood.locator('.ps-apps-list button').count() === 10
      && await flood.locator('.ps-apps-status').isVisible() === false,
    JSON.stringify({ rows: floodOpen ? await flood.locator('.ps-apps-list button').count() : null }));
  if (floodOpen) await flood.locator('.ps-pick').click();   // ✕ — leave the sheet closed
  await wait(200);
  appFlood = false;

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

  // A replacement CANCELS the pending removal — the panel's ordinary controls call set()
  // without an intent argument, and latching there deleted the property instead of storing
  // what the user had just typed.
  await legacyRow.locator('input').fill('now-ordinary');
  await wait(900);
  check('N12d typing a replacement after a Clear cancels the removal',
    savedSetting('legacyToken') === 'now-ordinary'
      && !clearedNames(savedSlot()).includes('legacyToken'),
    JSON.stringify({ value: savedSetting('legacyToken'), cleared: clearedNames(savedSlot()) }));

  // ...but an EMPTY value must NOT cancel it. "" is the shape the host already reads as
  // untouched, so it cannot contradict a removal — a control whose empty choice is a real
  // selection would otherwise undo the clear and have Seal restore the envelope. Making
  // the cancel unconditional put the latch back facing the other way.
  await legacyRow.locator('.ps-field-clear').click();
  await wait(900);
  await legacyRow.locator('input').evaluate((el) => {
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await wait(900);
  check('N12e but an empty value does not — it cannot contradict a removal',
    savedSetting('legacyToken') === ''
      && clearedNames(savedSlot()).includes('legacyToken'),
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
