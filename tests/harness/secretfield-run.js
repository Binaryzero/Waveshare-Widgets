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
}, {
  // A DIFFERENT widget that happens to declare the same secret name — the collision
  // that makes stale `secretsSet` visible after a swap (E10).
  id: 'test.ha', name: 'Home Assistant', supportedSlots: ['half'],
  properties: [
    { name: 'token', label: 'Long-lived token', type: 'secret' },
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
  // An empty string is what an UNTOUCHED masked field sends, and the host keeps the
  // stored credential for that — so a clear has to say something different or the
  // credential silently survives the delete (Codex r1, P1).
  check('E5b the save sends the distinct clear marker, never a bare empty string',
    cleared.settings.token === '__ww_secret_cleared__', JSON.stringify(cleared.settings));
  check('E5c an untouched secret still sends "" (the keep-what-you-have signal)',
    cleared.settings.fresh === '', JSON.stringify(cleared.settings));

  // ---- E8 · the marker is host protocol, never shown back to the user as a value
  const shownAfterClear = await stored.locator('input').inputValue();
  check('E8 the clear marker never appears in the field the user reads',
    shownAfterClear === '', shownAfterClear);

  // ---- E9 · a save the host could not fully honour must NOT read as "Saved"
  // The host encrypts; when Windows protection is unavailable it refuses to write the
  // credential in the clear. Saying "Saved — dashboard updated" then would tell the user
  // a token is active when it is not (Codex r2, P2).
  await page.evaluate(() => window.__hostPush(JSON.stringify({
    type: 'saved', seq: 999999, secretsFailed: ['test.gh.token'],
  })));
  await page.waitForTimeout(150);
  const warned = await page.locator('#toast').textContent();
  const warnClass = await page.locator('#toast').getAttribute('class');
  check('E9 a save with an unprotectable secret warns instead of claiming success',
    /could NOT be encrypted/i.test(warned || '') && !/^Saved/.test((warned || '').trim()), warned);
  check('E9b it is styled as an error, not as a normal confirmation',
    /error/.test(warnClass || ''), warnClass);
  await page.evaluate(() => window.__hostPush(JSON.stringify({ type: 'saved', seq: 999998 })));
  await page.waitForTimeout(150);
  check('E9c a clean save still reads as a plain success',
    /Saved — dashboard updated/.test(await page.locator('#toast').textContent() || ''));

  // ---- E11 · a credential saved during THIS session is still removable
  // secretsSet is the state at init; the host does not refresh it and this control is
  // not rebuilt, so after typing + saving, emptying the field would send "" and the host
  // would restore what it had just stored (Codex r4, P1).
  await fresh.locator('input').fill('ghp_TYPED_NOW');
  await page.waitForTimeout(120);
  await page.locator('#save').click();
  await page.waitForTimeout(400);
  await fresh.locator('input').fill('');
  await page.waitForTimeout(120);
  check('E11 emptying a secret typed this session says it will be removed',
    (await fresh.locator('.secret-state').textContent()).trim() === 'will be removed on save',
    await fresh.locator('.secret-state').textContent());
  await page.locator('#save').click();
  await page.waitForTimeout(400);
  check('E11b and the save sends the clear marker, not the keep-it empty string',
    saved[saved.length - 1].pages[0].slots[0].settings.fresh === '__ww_secret_cleared__',
    JSON.stringify(saved[saved.length - 1].pages[0].slots[0].settings));

  // ---- E12 · a credential that IS the clear marker stays storeable (escaped)
  await fresh.locator('input').fill('__ww_secret_cleared__');
  await page.waitForTimeout(120);
  await page.locator('#save').click();
  await page.waitForTimeout(400);
  check('E12 a typed value in the reserved namespace travels escaped, not as a clear',
    saved[saved.length - 1].pages[0].slots[0].settings.fresh === '__ww_secret_lit___ww_secret_cleared__',
    JSON.stringify(saved[saved.length - 1].pages[0].slots[0].settings.fresh));

  // ---- E13 · a TYPED credential must not reach the preview replica
  // The replica hosts real widget iframes. Sending state.layout verbatim hands a widget
  // the credential before the user has chosen Save — in the one surface the spec says
  // always shows an empty secret (Codex r5, P1).
  await fresh.locator('input').fill('ghp_NOT_SAVED_YET');
  await page.waitForTimeout(150);
  const replicaSees = await page.evaluate(() => {
    const seen = [];
    // Re-run the projection the replica is initialised with and read the secret back.
    for (const pg of (window.__wwReplicaLayout ? window.__wwReplicaLayout().pages : [])) {
      for (const sl of pg.slots || []) seen.push(sl.settings || {});
    }
    return seen;
  }).catch(() => null);
  if (replicaSees) {
    check('E13 the preview projection carries no typed credential',
      replicaSees.every((st) => !Object.values(st).some((v) => String(v).includes('ghp_NOT_SAVED_YET'))),
      JSON.stringify(replicaSees));
  }
  // Belt: whatever the replica frame was actually handed must not contain it either.
  const leaked = await page.evaluate(() => JSON.stringify(window.__wwLastReplicaInit || null));
  check('E13b nothing posted to the replica contains the plaintext',
    !String(leaked).includes('ghp_NOT_SAVED_YET'), String(leaked).slice(0, 200));
  await fresh.locator('input').fill('');
  await page.waitForTimeout(150);

  // ---- E10 · swapping the widget must not inherit the old one's "saved" marker
  // secretsSet describes the OUTGOING widget. The host scopes carry-over by widget id,
  // so the new widget correctly inherits nothing — but a stale marker would tell the
  // user a credential is stored for a widget that has never had one (Codex r3, P2).
  await page.evaluate(() => {
    const sel = document.querySelector('#slotDetail select');
    sel.value = 'test.ha';
    sel.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(250);
  const swapped = page.locator('#slotDetail .secret-wrap').first();
  check('E10 after a widget swap, a same-named secret does not read as saved',
    (await swapped.locator('.secret-state').textContent()).trim() === 'not set',
    await swapped.locator('.secret-state').textContent());
  check('E10b and it offers no Clear for a credential it never had',
    await swapped.locator('button.danger').evaluate((n) => n.hidden) === true);

  // ---- E14 · a full settings-init RESETS the secret-name union
  // The union exists so a hot-reload that drops a secret property cannot un-blank a
  // credential the layout still holds. But a full init is the one moment it must be
  // dropped: the host has remasked the layout against the CURRENT manifests, so no
  // unsaved plaintext from the old catalog survives for the old names to protect —
  // and a property retyped `secret` → `text` (a feed URL that stopped being private)
  // would otherwise stay blanked in the preview for the life of the window, with no
  // edit that could clear it (Codex #61 r5, P2).
  await page.evaluate((payload) => window.__hostPush(payload), JSON.stringify({
    type: 'settings-init',
    data: {
      widgets: [{
        id: 'test.gh', name: 'GitHub Queue', supportedSlots: ['half'],
        properties: [
          { name: 'token', label: 'Personal access token', type: 'secret' },
          // Was `secret` in the first init; now an ordinary setting.
          { name: 'fresh', label: 'Public feed', type: 'text' },
        ],
      }],
      layout: { pages: [{ name: 'Main', slots: [{
        widgetId: 'test.gh', size: 'half', instanceId: 'gh1',
        settings: { token: '', fresh: 'now-a-public-value' },
      }] }] },
      sensors: [], backgroundHost: 'backgrounds.wsw',
      status: { elevated: false, version: 'v0.2.0 (probe)' },
    },
  }));
  await page.waitForTimeout(400);
  const afterReinit = await page.evaluate(() =>
    (window.__wwReplicaLayout ? window.__wwReplicaLayout().pages[0].slots[0].settings : null));
  check('E14 a property retyped to ordinary text reaches the preview after a re-init',
    afterReinit && afterReinit.fresh === 'now-a-public-value', JSON.stringify(afterReinit));
  // The reset must not cost the protection it replaced: a name the NEW catalog still
  // calls secret is blanked exactly as before.
  await page.locator('#slotList .slot-chip .chip-main').first().click();
  await page.waitForTimeout(200);
  await page.locator('#slotDetail .secret-wrap input').first().fill('ghp_AFTER_REINIT');
  await page.waitForTimeout(150);
  const afterTyped = await page.evaluate(() =>
    JSON.stringify(window.__wwReplicaLayout ? window.__wwReplicaLayout() : null));
  check('E14b and a still-secret property is still kept out of the preview',
    !afterTyped.includes('ghp_AFTER_REINIT'), afterTyped.slice(0, 200));

  // ---- E15 · the dock is DOCKED, not floating (#79) ----------------------------------
  // The complaint that opened #79 was a config card sitting on top of the layout it
  // configures. "Docked" is not a look — it is the measurable claim that the canvas and
  // the panel never occupy the same pixels, and that the canvas keeps its full height.
  const dock = await page.evaluate(() => {
    const r = (id) => { const e = document.getElementById(id); return e ? e.getBoundingClientRect() : null; };
    const stage = r('previewStage'), d = r('dock'), pal = r('dockPalette'), panel = r('contextPanel');
    const vis = (id) => { const e = document.getElementById(id); if (!e) return false;
      const s = getComputedStyle(e); return s.display !== 'none' && s.visibility !== 'hidden'; };
    return {
      // Measured against the PANEL, not the dock container. Floating the panel takes
      // it out of flow, so the dock shrinks to the palette and a dock-vs-canvas check
      // still reads zero overlap while the card sits squarely on the layout — which is
      // precisely the bug #79 exists to fix, passing its own probe.
      overlap: stage && panel ? Math.round(Math.max(0, stage.bottom - panel.top)) : -1,
      panelInFlow: panel ? getComputedStyle(document.getElementById('contextPanel')).position === 'static' : false,
      stageH: stage ? Math.round(stage.height) : 0,
      dockBottom: d ? Math.round(d.bottom) : 0,
      win: window.innerHeight,
      paletteVisible: vis('dockPalette') && !!pal && pal.width > 0,
      paletteItems: document.querySelectorAll('#widgetGallery .gallery-item').length,
      panelBesidePalette: !!(pal && panel) && panel.left >= pal.right - 1,
      openerGone: getComputedStyle(document.getElementById('addSlot')).display === 'none',
      panesShown: [...document.querySelectorAll('#contextBody .pane')]
        .filter((p) => getComputedStyle(p).display !== 'none').length,
    };
  });
  check('E15 the panel never overlaps the canvas it is configuring',
    dock.overlap === 0, `overlap ${dock.overlap}px`);
  check('E15a and it is in normal flow, so the canvas can claim the space it leaves',
    dock.panelInFlow);
  check('E15b the canvas keeps a usable height rather than being squeezed out',
    dock.stageH >= 150, `${dock.stageH}px`);
  check('E15c the dock fits the window instead of pushing content off-screen',
    dock.dockBottom <= dock.win + 1, `${dock.dockBottom} vs ${dock.win}`);
  // The palette is the one thing the iCUE reference never hides.
  check('E15d the widget palette is permanently visible, not behind a button',
    dock.paletteVisible && dock.paletteItems > 0, `${dock.paletteItems} items`);
  check('E15e and its opener is gone, so there is no button that reveals what is already shown',
    dock.openerGone);
  check('E15f the panel sits BESIDE the palette — columns, not a stack',
    dock.panelBesidePalette);
  // A pane that stays visible because a display rule outranked [hidden] puts the page's
  // controls under the selected widget's. Exactly one pane may be showing.
  check('E15g exactly one pane is visible at a time',
    dock.panesShown === 1, `${dock.panesShown} panes`);

  // ---- E16 · the supported 780×480 minimum ------------------------------------------
  // Both regions are flex:none inside an overflow:hidden body, so nothing can scroll
  // the window: anything past the bottom edge is simply unreachable. At the smallest
  // supported size the toolbar plus the dock can leave less room than the canvas's
  // preferred floor, and an unconditional floor spends room the dock needs. A cramped
  // canvas is recoverable by resizing; controls clipped off a document that cannot
  // scroll are not.
  await page.setViewportSize({ width: 780, height: 480 });
  await page.waitForTimeout(500);
  const tiny = await page.evaluate(() => {
    const r = (id) => { const e = document.getElementById(id); return e ? e.getBoundingClientRect() : null; };
    const stage = r('previewStage'), d = r('dock'), panel = r('contextPanel');
    return {
      dockBottom: d ? Math.round(d.bottom) : 0,
      win: window.innerHeight,
      stageH: stage ? Math.round(stage.height) : 0,
      overlap: stage && panel ? Math.round(Math.max(0, stage.bottom - panel.top)) : -1,
    };
  });
  check('E16 at 780×480 the dock still fits inside the window',
    tiny.dockBottom <= tiny.win + 1, `dock bottom ${tiny.dockBottom} vs window ${tiny.win}`);
  check('E16b the canvas gives up height rather than pushing the dock off-screen',
    tiny.stageH > 0 && tiny.stageH <= 160, `${tiny.stageH}px`);
  check('E16c and the panel still does not cover the canvas at that size',
    tiny.overlap === 0, `overlap ${tiny.overlap}px`);

  await browser.close();
  shellSrv.close();
  console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
