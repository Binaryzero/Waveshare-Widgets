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
    // A DEMOTED property (#66): the manifest calls it `text` now, but layout.json still
    // holds the envelope from when it was `secret`. The host blanks it and names it in
    // secretsRestorable.
    { name: 'legacyToken', label: 'Legacy token', type: 'text' },
    // A demoted property of a NON-text type: the host blanks and lists it exactly the
    // same way, and the Clear affordance has to reach it too.
    { name: 'legacyTint', label: 'Legacy tint', type: 'color', default: '#00d4ff' },
    // A demoted property whose control has a legitimately EMPTY choice: an sd-profiles
    // select where "" means "first available". Choosing it must NOT cancel a pending
    // removal — "" is the one value that cannot contradict a clear, because it is the
    // shape the host already reads as untouched.
    { name: 'legacyProfile', label: 'Legacy profile', type: 'select', optionsSource: 'sd-profiles' },
  ],
}, {
  // A DIFFERENT widget that happens to declare the same secret name — the collision
  // that makes stale `secretsSet` visible after a swap (E10).
  id: 'test.ha', name: 'Home Assistant', supportedSlots: ['half'],
  properties: [
    { name: 'token', label: 'Long-lived token', type: 'secret' },
  ],
}, {
  // A widget that declares NO secret at all, but still holds a demoted envelope. This is
  // the shape mergeReplicaCapture's secret-name gate was blind to: a demotion is exactly
  // the case where the manifest has stopped calling anything secret, so gating the
  // projection merge on that list dropped it for the only widgets that needed it.
  id: 'test.demoted', name: 'All Demoted', supportedSlots: ['half'],
  properties: [
    { name: 'legacyOnly', label: 'Legacy only', type: 'text' },
  ],
}];

// Exactly what the host sends after SecretPolicy.Mask: the secret blanked, plus a
// secretsSet list naming the ones that DO have a stored (encrypted) value.
const layout = {
  pages: [{
    name: 'Main',
    slots: [{
      widgetId: 'test.gh', size: 'half', instanceId: 'gh1',
      settings: {
        token: '', fresh: '', legacyToken: '', legacyTint: '', legacyProfile: '',
        repo: 'binaryzero/waveshare-widgets',
      },
      secretsSet: ['token'],
      secretsRestorable: ['legacyToken', 'legacyTint', 'legacyProfile'],
    }, {
      // Declares no secret, holds a demoted envelope — see the manifest note above.
      widgetId: 'test.demoted', size: 'half', instanceId: 'dm1',
      settings: { legacyOnly: '' },
      secretsRestorable: ['legacyOnly'],
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
  check('E5b the save NAMES the cleared property, so a bare empty string cannot mean two things',
    cleared.settings.token === '' && (cleared.secretsCleared || []).includes('token'),
    JSON.stringify({ settings: cleared.settings, cleared: cleared.secretsCleared }));
  check('E5c an untouched secret still sends "" (the keep-what-you-have signal)',
    cleared.settings.fresh === '', JSON.stringify(cleared.settings));

  // ---- E8 · the marker is host protocol, never shown back to the user as a value
  const shownAfterClear = await stored.locator('input').inputValue();
  check('E8 no protocol word can appear in the field the user reads — none exists',
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
  check('E11b and the save names it cleared, rather than relying on the keep-it empty string',
    saved[saved.length - 1].pages[0].slots[0].settings.fresh === ''
      && (saved[saved.length - 1].pages[0].slots[0].secretsCleared || []).includes('fresh'),
    JSON.stringify(saved[saved.length - 1].pages[0].slots[0].settings));

  // ---- E12 · a credential that IS the old sentinel stays storeable (no escaping)
  await fresh.locator('input').fill('__ww_secret_cleared__');
  await page.waitForTimeout(120);
  await page.locator('#save').click();
  await page.waitForTimeout(400);
  // Nothing escapes anything now: intent travels as a NAME beside the layout, so the
  // string that used to be the sentinel is a credential like any other.
  check('E12 a credential equal to the old sentinel travels verbatim, and is not a clear',
    saved[saved.length - 1].pages[0].slots[0].settings.fresh === '__ww_secret_cleared__'
      && !((saved[saved.length - 1].pages[0].slots[0].secretsCleared) || []).includes('fresh'),
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

  // ---- E20/E21 · the palette is a GRID, and appearance is its own panel -------------
  // Field feedback on the first cut of the dock: the widget shelf was "a massive scroll
  // list", and configuring a widget and restyling it were "the same window". Both are
  // measurable, so both are pinned rather than left to the next screenshot.
  const shape = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll('#widgetGallery .gallery-item')]
      .map((t) => t.getBoundingClientRect());
    const style = document.getElementById('stylePanel');
    const ctx = document.getElementById('contextPanel');
    const sr = style && !style.hidden ? style.getBoundingClientRect() : null;
    const cr = ctx ? ctx.getBoundingClientRect() : null;
    return {
      tiles: tiles.length,
      // The resolved track list is the direct statement of "grid, not list", and it
      // does not depend on how many widgets the fixture's catalog happens to hold —
      // by this point in the run it is down to one, so a same-row check would be
      // measuring a constant.
      tracks: getComputedStyle(document.getElementById('widgetGallery'))
        .gridTemplateColumns.trim().split(/\s+/).length,
      tileWidth: tiles.length ? Math.round(tiles[0].width) : 0,
      styleShown: !!sr,
      // Separate panels, not one box: distinct elements, and no shared pixels.
      styleIsOwnPanel: !!style && !!ctx && !ctx.contains(style),
      overlap: sr && cr ? Math.round(Math.max(0, Math.min(sr.right, cr.right) - Math.max(sr.left, cr.left))) : -1,
      // The tabs that used to hide one half behind the other are gone.
      subTabs: document.querySelectorAll('.slot-tabs .slot-tab').length,
    };
  });
  check('E20 the widget shelf lays out as a grid, not a single-file list',
    shape.tracks >= 3 && shape.tileWidth > 0 && shape.tileWidth < 140,
    `${shape.tracks} columns, tile ${shape.tileWidth}px`);
  check('E21 appearance is its OWN panel beside the settings, not a tab inside them',
    shape.styleShown && shape.styleIsOwnPanel && shape.overlap === 0 && shape.subTabs === 0,
    JSON.stringify(shape));

  // E22 · closing the inspector closes its Appearance column too. closePanel only drops
  // the card's `open` class — the selection and the tab survive it — so a visibility
  // rule reading those alone leaves a 300px column of controls for a card the user just
  // dismissed.
  await page.locator('#panelClose').click();
  await page.waitForTimeout(250);
  const afterClose = await page.evaluate(() => {
    const s = document.getElementById('stylePanel');
    return { styleHidden: !!s && s.hidden, cardOpen: document.getElementById('contextPanel').classList.contains('open') };
  });
  check('E22 closing the inspector also closes the Appearance column',
    afterClose.styleHidden && !afterClose.cardOpen, JSON.stringify(afterClose));
  // Reselecting takes TWO clicks: closePanel leaves the slot selected, so the first
  // click on its chip toggles the selection off. The later probes expect an open
  // inspector, so this restores the state as well as proving the column comes back.
  await page.locator('#slotList .slot-chip .chip-main').first().click();
  await page.waitForTimeout(200);
  await page.locator('#slotList .slot-chip .chip-main').first().click();
  await page.waitForTimeout(300);
  check('E22b and reselecting the widget brings the column back',
    await page.evaluate(() => !document.getElementById('stylePanel').hidden
      && document.getElementById('contextPanel').classList.contains('open')));

  // E23 · at the supported 780px minimum, two fixed side columns (288 + 300) would
  // leave 192px for the widget's own settings — narrower than a single property track.
  // The panels beside the inspector must yield to it, not the other way round.
  await page.setViewportSize({ width: 780, height: 700 });
  await page.waitForTimeout(500);
  const narrow = await page.evaluate(() => {
    const r = (id) => { const e = document.getElementById(id); return e && !e.hidden ? e.getBoundingClientRect() : null; };
    const ctx = r('contextPanel'), pal = r('dockPalette'), sty = r('stylePanel');
    return {
      ctx: ctx ? Math.round(ctx.width) : 0,
      pal: pal ? Math.round(pal.width) : 0,
      sty: sty ? Math.round(sty.width) : 0,
      // Nothing may hang off the right edge of a document that cannot scroll sideways.
      rightmost: Math.round(Math.max(ctx ? ctx.right : 0, sty ? sty.right : 0)),
      win: window.innerWidth,
    };
  });
  check('E23 at 780px the widget settings keep a usable column',
    narrow.ctx >= 320, `settings ${narrow.ctx}px (palette ${narrow.pal}, appearance ${narrow.sty})`);
  check('E23b and the dock still fits the window width',
    narrow.rightmost <= narrow.win + 1, `${narrow.rightmost} vs ${narrow.win}`);
  // E23c measures what was actually BROKEN. E23 checks the column, and the column
  // reaching its floor says nothing about whether its CONTENTS are usable: at 320px
  // the widget picker rendered as a bare chevron, the size select as the single letter
  // "H", and the deck's button fields as two characters each. That passed E23. It took
  // a screenshot to see it, so the assertion moved to the controls themselves.
  const controls = await page.evaluate(() => {
    const w = document.querySelector('#slotDetail .slot-row select.widget');
    const z = document.querySelector('#slotDetail .slot-row select.size');
    return {
      widget: w ? Math.round(w.getBoundingClientRect().width) : 0,
      size: z ? Math.round(z.getBoundingClientRect().width) : 0,
    };
  });
  check('E23c and the widget/size controls stay readable rather than collapsing',
    controls.widget >= 180 && controls.size >= 150,
    `widget ${controls.widget}px, size ${controls.size}px`);
  // E23d · the WRAPPED row must be reachable, which is a VERTICAL question. Below
  // 1040px Appearance wraps to its own flex line, and a flex line takes its cross size
  // from its content: the first row grew to fit a populated inspector and pushed the
  // second row past the bottom of a document that cannot scroll. At 780x480 that put
  // the panel's top at 987px in a 480px window — not clipped, gone. E23/E23b measure
  // horizontal bounds and the dock box, and both passed throughout.
  await page.setViewportSize({ width: 780, height: 480 });
  await page.waitForTimeout(600);
  const wrapped = await page.evaluate(() => {
    const body = document.getElementById('dockBody');
    if (body) body.scrollTop = body.scrollHeight;   // scroll to the end before judging
    const sty = document.getElementById('stylePanel');
    const r = sty && !sty.hidden ? sty.getBoundingClientRect() : null;
    return {
      shown: !!r,
      top: r ? Math.round(r.top) : null,
      bottom: r ? Math.round(r.bottom) : null,
      win: window.innerHeight,
    };
  });
  check('E23d at 780×480 the wrapped Appearance row is reachable, not below the window',
    wrapped.shown && wrapped.top >= 0 && wrapped.bottom <= wrapped.win + 1,
    JSON.stringify(wrapped));

  await page.setViewportSize({ width: 1100, height: 820 });
  await page.waitForTimeout(400);

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

  // ---- E17 · the DOCK's height is an input to the fit, so it has to be watched ------
  // The dock changes height with no window, toolbar or stage change at all: the palette
  // fills on settings-init, and switching widgets swaps inspector content of a different
  // height. Both regions are flex:none inside an overflow:hidden body, so a stale dock
  // height in the calculation leaves the dock's lower controls clipped until some
  // unrelated resize happens to refit. Driven here by moving the dock body's own cap —
  // #dockPalette is overflow:auto, so adding content to it scrolls the column instead of
  // resizing the dock and would prove nothing.
  // Wide and short ON PURPOSE. The stage takes the smaller of the width fit and the
  // height fit, and at the harness's default 1100×820 the WIDTH is what binds — the
  // dock could change freely and the stage would not move, so the probe would be
  // measuring a constant. 1400px of width takes the width term out of the running.
  await page.setViewportSize({ width: 1400, height: 700 });
  await page.waitForTimeout(500);
  const grew0 = await page.evaluate(() => ({
    dockH: Math.round(document.getElementById('dock').getBoundingClientRect().height),
    stageH: Math.round(document.getElementById('previewStage').getBoundingClientRect().height),
  }));
  await page.evaluate(() => {
    const s = document.createElement('style');
    s.id = 'wwProbeDockCap';
    s.textContent = '#dockBody { max-height: 170px !important; }';
    document.head.appendChild(s);
  });
  await page.waitForTimeout(500);
  const grew1 = await page.evaluate(() => ({
    dockH: Math.round(document.getElementById('dock').getBoundingClientRect().height),
    stageH: Math.round(document.getElementById('previewStage').getBoundingClientRect().height),
  }));
  // Guard FIRST: if the setup did not actually move the dock there is no stimulus, and
  // the height comparison below would pass on a stage that simply never had to change.
  const dockDelta = grew0.dockH - grew1.dockH;
  check('E17 the probe actually changed the dock height (stimulus guard)',
    dockDelta > 40, `dock ${grew0.dockH} → ${grew1.dockH}`);
  check('E17b the canvas refits when the DOCK changes, with no window resize',
    grew1.stageH - grew0.stageH > 20,
    `stage ${grew0.stageH} → ${grew1.stageH} for a ${dockDelta}px dock change`);
  await page.evaluate(() => document.getElementById('wwProbeDockCap').remove());
  await page.waitForTimeout(400);

  // ---- E18 · the palette follows the page the "+" tap came from --------------------
  // The shelf's buttons close over the page they were rendered for. An add-widget
  // message can name a different page — tapping the old page's "+" during the preview's
  // page transition moves selectedPage — and a shelf still bound to the previous page
  // adds the widget THERE, then opens details for an unrelated slot on the new page.
  const counts = () => saved.length
    ? saved[saved.length - 1].pages.map((p) => (p.slots || []).length) : null;
  await page.locator('#addPage').click();
  await page.waitForTimeout(250);
  await page.locator('#pageList li').first().click();          // back to page 0
  await page.waitForTimeout(250);
  await page.locator('#save').click();                         // baseline, AFTER the setup
  await page.waitForTimeout(350);
  const before18 = counts();
  const gen = await page.evaluate(() => {
    // The init message is {type:'init', data:{gen, layout, …}} — the generation the
    // replica must echo back lives on data, and a message tagged with anything else is
    // dropped by the staleness guard before it can reach openGallery.
    try { return ((JSON.parse(window.__wwLastReplicaInit || '{}').data || {}).gen | 0); } catch (e) { return -1; }
  });
  const replica = page.frames().find((f) => /index\.html/.test(f.url()));
  const selected0 = await page.evaluate(() =>
    [...document.querySelectorAll('#pageList li')].findIndex((li) => li.classList.contains('active')));
  check('E18 setup: two pages, page 0 selected, and a live replica to speak for the "+" tap',
    !!before18 && before18.length === 2 && selected0 === 0 && !!replica && gen > 0,
    `pages ${JSON.stringify(before18)} selected ${selected0} gen ${gen} frame ${!!replica}`);
  if (replica && before18) {
    await replica.evaluate((g) => parent.postMessage(
      { type: 'ww-shell', message: { type: 'add-widget', index: 1, gen: g } }, '*'), gen);
    await page.waitForTimeout(400);
    await page.locator('#widgetGallery .gallery-item:not(:disabled)').first().click();
    await page.waitForTimeout(300);
    await page.locator('#save').click();
    await page.waitForTimeout(350);
    const after18 = counts();
    check('E18b the widget lands on the page the message named, not the one the shelf was built for',
      !!after18 && after18[1] === before18[1] + 1 && after18[0] === before18[0],
      `${JSON.stringify(before18)} → ${JSON.stringify(after18)}`);

    // ---- E24 · the shelf answers for the hole that was TAPPED ---------------------
    // The panel's add zones are per-hole (#84) and carry the region in the message.
    // The shelf's enabled state has to come from the same region the add does: sizing
    // the buttons against the page while the click sizes against the region leaves
    // half-width widgets enabled over a one-column hole, where clicking does nothing
    // at all — a control that is offered and inert. Both fixture widgets are half-only,
    // so a 1x1 target can take neither.
    // The generation moved when the add above re-initialised the replica, and a
    // message tagged with the old one is dropped by the staleness guard before it can
    // reach any of this. Re-read it rather than reusing the captured value.
    const gen2 = await page.evaluate(() => {
      try { return ((JSON.parse(window.__wwLastReplicaInit || '{}').data || {}).gen | 0); } catch (e) { return -1; }
    });
    const here = await page.evaluate(() =>
      [...document.querySelectorAll('#pageList li')].findIndex((li) => li.classList.contains('active')));
    await replica.evaluate((a) => parent.postMessage({ type: 'ww-shell', message: {
      type: 'add-widget', index: a.i, target: { col: 3, row: 1, w: 1, h: 1 }, gen: a.g } }, '*'),
      { i: here, g: gen2 });
    await page.waitForTimeout(450);
    const shelf = await page.evaluate(() => ({
      items: [...document.querySelectorAll('#widgetGallery .gallery-item')].length,
      enabled: [...document.querySelectorAll('#widgetGallery .gallery-item')].filter((b) => !b.disabled).length,
      why: [...document.querySelectorAll('#widgetGallery .g-why')].map((e) => e.textContent),
    }));
    check('E24 a half-only widget is not offered against a one-column hole',
      shelf.items > 0 && shelf.enabled === 0 && shelf.why.every((w) => /too big/i.test(w)),
      JSON.stringify(shelf));

    // E24b · offered implies completable. The reason text above proves the shelf is
    // reading the region, but not that what it OFFERS can finish: the reported harm was
    // an entry left enabled that does nothing when clicked. With a target the widget
    // does fit, the click must actually add — the only check that rules that out.
    const fitTarget = await page.evaluate(() => {
      try { return ((JSON.parse(window.__wwLastReplicaInit || '{}').data || {}).gen | 0); } catch (e) { return -1; }
    });
    // The region is COMPUTED from the live layout rather than assumed. A hardcoded
    // rectangle silently became occupied as earlier probes added widgets, the target
    // was correctly rejected as stale, and the probe then measured a page-wide shelf —
    // failing for a reason that had nothing to do with what it claims to test.
    const freeSpot = await page.evaluate((idx) => {
      const l = window.__wwReplicaLayout ? window.__wwReplicaLayout() : null;
      const pg = l && l.pages[idx];
      if (!pg) return null;
      const W = { quarter: 1, half: 2, 'three-quarter': 3, full: 4 };
      const occ = [[0, 0, 0, 0], [0, 0, 0, 0]];
      for (const sl of pg.slots || []) {
        let t = String(sl.size || 'quarter'), band = 'full';
        if (t.endsWith('-upper')) { band = 'upper'; t = t.slice(0, -6); }
        else if (t.endsWith('-lower')) { band = 'lower'; t = t.slice(0, -6); }
        const w = W[t] || 1;
        const rows = band === 'full' ? [0, 1] : band === 'upper' ? [0] : [1];
        for (let c = 0; c + w <= 4; c++) {
          if (rows.every((r) => { for (let i = 0; i < w; i++) if (occ[r][c + i]) return false; return true; })) {
            rows.forEach((r) => { for (let i = 0; i < w; i++) occ[r][c + i] = 1; });
            break;
          }
        }
      }
      for (let c = 0; c + 2 <= 4; c++)
        if (!occ[0][c] && !occ[0][c + 1] && !occ[1][c] && !occ[1][c + 1])
          return { col: c, row: 0, w: 2, h: 2 };
      return null;
    }, 0);
    check('E24b setup: page 1 has a free two-column region to aim at',
      !!freeSpot, JSON.stringify(freeSpot));
    await replica.evaluate((a) => parent.postMessage({ type: 'ww-shell', message: {
      type: 'add-widget', index: 0, target: a.t, gen: a.g } }, '*'),
      { t: freeSpot, g: fitTarget });
    await page.waitForTimeout(450);
    const offered = await page.evaluate(() => ({
      enabled: [...document.querySelectorAll('#widgetGallery .gallery-item')].filter((b) => !b.disabled).length,
      why: [...document.querySelectorAll('#widgetGallery .g-why')].map((e) => e.textContent),
    }));
    await page.locator('#save').click();
    await page.waitForTimeout(350);
    const preClick = counts();
    if (offered.enabled > 0) {
      await page.locator('#widgetGallery .gallery-item:not(:disabled)').first().click();
      await page.waitForTimeout(300);
      await page.locator('#save').click();
      await page.waitForTimeout(350);
    }
    const postClick = counts();
    check('E24b an entry the shelf offers against a target actually completes the add',
      offered.enabled > 0 && !!preClick && !!postClick
        && postClick.reduce((a, b) => a + b, 0) === preClick.reduce((a, b) => a + b, 0) + 1,
      `${JSON.stringify(offered)}, ${JSON.stringify(preClick)} → ${JSON.stringify(postClick)}`);

    // ---- E25 · the target belongs to the page it was tapped on --------------------
    // page-changed follows the replica (edge drop, capsule arrows) without touching
    // the target, so coordinates alone would anchor a later pick into a cell chosen on
    // a different page. Navigate after the tap, then add: the target must not apply.
    // A LIVE target first. E24b's add both consumed the previous target and re-inited
    // the replica, so a message tagged with the old generation is rejected outright —
    // the first version of this probe navigated with no target set and then asserted an
    // ordinary page-wide shelf, which passes whether or not the binding exists.
    const gen3 = await page.evaluate(() => {
      try { return ((JSON.parse(window.__wwLastReplicaInit || '{}').data || {}).gen | 0); } catch (e) { return -1; }
    });
    // Page 1 explicitly: E24b's add filled page 0, and a target on an occupied cell is
    // correctly revalidated away — which would leave this probe asserting nothing
    // again. Page 1 holds a three-quarter, so its last column is free.
    await replica.evaluate((a) => parent.postMessage({ type: 'ww-shell', message: {
      type: 'add-widget', index: 1, target: { col: 3, row: 1, w: 1, h: 1 }, gen: a.g } }, '*'),
      { g: gen3 });
    await page.waitForTimeout(400);
    const armed = await page.evaluate(() =>
      [...document.querySelectorAll('#widgetGallery .g-why')].map((e) => e.textContent));
    check('E25 setup: a live 1x1 target is in force before the navigation',
      armed.length > 0 && armed.every((w) => /too big/i.test(w)), JSON.stringify(armed));

    const other = 0;   // navigate away from the page the target belongs to
    await replica.evaluate((a) => parent.postMessage({ type: 'ww-shell', message: {
      type: 'page-changed', index: a.other, gen: a.g } }, '*'), { other, g: gen3 });
    await page.waitForTimeout(400);
    const shelf2 = await page.evaluate(() => ({
      selected: [...document.querySelectorAll('#pageList li')].findIndex((li) => li.classList.contains('active')),
      enabled: [...document.querySelectorAll('#widgetGallery .gallery-item')].filter((b) => !b.disabled).length,
      why: [...document.querySelectorAll('#widgetGallery .g-why')].map((e) => e.textContent),
    }));
    check('E25b the navigation actually happened, so the next assertion means something',
      shelf2.selected === other, `selected ${shelf2.selected}, wanted ${other}`);
    // The discriminator is the REASON, not the count. Page 0 is full by now, so the
    // shelf offers nothing either way; what separates a bound target from an unbound
    // one is whether it answers "too big" (judging the old page's 1x1 rectangle) or
    // "no room" (judging the page it is actually on).
    check('E25c and the old page\'s target does not follow it',
      shelf2.why.length > 0 && !shelf2.why.some((w) => /too big/i.test(w)),
      JSON.stringify(shelf2));

    // ---- E26 · the target belongs to a PAGE, isolated from the revalidation -------
    // E25 above proves a target does not follow a navigation, but it cannot say WHICH
    // rule stopped it: its rectangle is on another page AND occupied on the one it
    // lands on, so deleting either the page binding or the revalidation leaves it
    // passing. This probe removes the second reason. It navigates to a page that is
    // EMPTY, where the stale rectangle revalidates perfectly clean — the only fact
    // left that can reject it is the page it was tapped on. Reason strings again:
    // "too big" means the old page's 1x1 rectangle is still being judged; an entry
    // offered with no reason at all means the shelf is sizing against the page it is
    // actually on.
    await page.locator('#addPage').click();
    await page.waitForTimeout(600);   // past refreshReplica's 350ms debounce, so the
                                      // generation below is the one the tap must echo
    // Both the source page and the rectangle are DERIVED. Page 0 is full by now and
    // page 1 holds a three-quarter, so a hardcoded pair is a rectangle that is already
    // occupied at tap time: correctly revalidated away before the navigation, leaving
    // the probe measuring a shelf nobody ever armed.
    const spot = await page.evaluate(() => {
      const l = window.__wwReplicaLayout ? window.__wwReplicaLayout() : null;
      if (!l) return null;
      const W = { quarter: 1, half: 2, 'three-quarter': 3, full: 4 };
      // Both of occupancyOf's passes: `col` anchors claim their cells first, then
      // everything else first-fits in order. A single-pass mirror disagrees with the
      // real placement exactly where E24b's anchored add landed.
      const occOf = (slots) => {
        const occ = [[0, 0, 0, 0], [0, 0, 0, 0]];
        const geo = (s) => {
          let t = String(s.size || 'quarter'), band = 'full';
          if (t.endsWith('-upper')) { band = 'upper'; t = t.slice(0, -6); }
          else if (t.endsWith('-lower')) { band = 'lower'; t = t.slice(0, -6); }
          return { w: W[t] || 1, rows: band === 'full' ? [0, 1] : band === 'upper' ? [0] : [1] };
        };
        const free = (rows, c, w) => c >= 0 && c + w <= 4
          && rows.every((r) => { for (let i = 0; i < w; i++) if (occ[r][c + i]) return false; return true; });
        const take = (rows, c, w) => rows.forEach((r) => { for (let i = 0; i < w; i++) occ[r][c + i] = 1; });
        const placed = slots.map(() => false);
        slots.forEach((s, i) => {
          const a = (s.col >= 1 && s.col <= 4) ? s.col - 1 : null;
          if (a === null) return;
          const g = geo(s);
          if (free(g.rows, a, g.w)) { take(g.rows, a, g.w); placed[i] = true; }
        });
        slots.forEach((s, i) => {
          if (placed[i]) return;
          const g = geo(s);
          for (let c = 0; c + g.w <= 4; c++) if (free(g.rows, c, g.w)) { take(g.rows, c, g.w); break; }
        });
        return occ;
      };
      const to = l.pages.length - 1;                      // the page #addPage just made
      const dest = occOf(l.pages[to].slots || []);
      for (let from = 0; from < to; from++) {
        const src = occOf(l.pages[from].slots || []);
        for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++)
          if (!src[r][c] && !dest[r][c])
            return { from, to, target: { col: c, row: r, w: 1, h: 1 },
              toSlots: (l.pages[to].slots || []).length };
      }
      return null;
    });
    // One column wide is load-bearing: the catalog offers half and three-quarter, so a
    // 1x1 hole takes nothing and the region verdict is visible as "too big". A 2-wide
    // rectangle sizes to 'half' in both worlds and the probe would measure nothing.
    check('E26 setup: a 1x1 hole free on the tapped page AND on a still-empty destination',
      !!spot && spot.from !== spot.to && spot.toSlots === 0
        && spot.target.w === 1 && spot.target.h === 1,
      JSON.stringify(spot));
    if (spot) {
      const gen4 = await page.evaluate(() => {
        try { return ((JSON.parse(window.__wwLastReplicaInit || '{}').data || {}).gen | 0); } catch (e) { return -1; }
      });
      await replica.evaluate((a) => parent.postMessage({ type: 'ww-shell', message: {
        type: 'add-widget', index: a.i, target: a.t, gen: a.g } }, '*'),
        { i: spot.from, t: spot.target, g: gen4 });
      await page.waitForTimeout(400);
      const armedA = await page.evaluate(() => ({
        selected: [...document.querySelectorAll('#pageList li')].findIndex((li) => li.classList.contains('active')),
        items: [...document.querySelectorAll('#widgetGallery .gallery-item')].length,
        enabled: [...document.querySelectorAll('#widgetGallery .gallery-item')].filter((b) => !b.disabled).length,
        why: [...document.querySelectorAll('#widgetGallery .g-why')].map((e) => e.textContent),
      }));
      // Stimulus guard, and load-bearing rather than decorative: a tap dropped by the
      // staleness gate leaves no target at all, and E26c would then pass with the
      // binding deleted, for a reason that has nothing to do with the binding.
      check('E26a setup: the target is live on the page it was tapped on, and nothing fits it',
        armedA.selected === spot.from && armedA.items > 0 && armedA.enabled === 0
          && armedA.why.length > 0 && armedA.why.every((w) => /too big/i.test(w)),
        JSON.stringify(armedA));

      const gen5 = await page.evaluate(() => {
        try { return ((JSON.parse(window.__wwLastReplicaInit || '{}').data || {}).gen | 0); } catch (e) { return -1; }
      });
      // page-changed, NOT a page chip: the chip's own handler drops the target outright,
      // so a chip click would make E26c pass with the binding deleted. This is also the
      // real path the binding exists for — edge drop, capsule arrows.
      await replica.evaluate((a) => parent.postMessage({ type: 'ww-shell', message: {
        type: 'page-changed', index: a.to, gen: a.g } }, '*'), { to: spot.to, g: gen5 });
      await page.waitForTimeout(400);
      const landed = await page.evaluate((to) => ({
        selected: [...document.querySelectorAll('#pageList li')].findIndex((li) => li.classList.contains('active')),
        items: [...document.querySelectorAll('#widgetGallery .gallery-item')].length,
        enabled: [...document.querySelectorAll('#widgetGallery .gallery-item')].filter((b) => !b.disabled).length,
        why: [...document.querySelectorAll('#widgetGallery .g-why')].map((e) => e.textContent),
        destSlots: ((window.__wwReplicaLayout().pages[to] || {}).slots || []).length,
      }), spot.to);
      check('E26b the navigation happened and the destination really is empty',
        landed.selected === spot.to && landed.destSlots === 0, JSON.stringify(landed));
      // The destination has room for everything, so a shelf judging the PAGE offers the
      // widget with no reason at all, while a shelf still judging the old page's 1x1
      // rectangle says "too big". The revalidation cannot be what separates them: every
      // cell that rectangle names is free here, which E26b just asserted.
      check('E26c a target tapped on another page does not survive the navigation',
        landed.items > 0 && landed.enabled === landed.items
          && !landed.why.some((w) => /too big/i.test(w)),
        JSON.stringify(landed));
    }

    // ---- E27 · the target is REVALIDATED, isolated from the page binding ----------
    // The other half of E25's ambiguity. Everything here happens on ONE page, so the
    // binding never has anything to reject and cannot be what answers: between the tap
    // and the pick a slot is resized over the very cells the tap named, and the shelf
    // must stop answering for a rectangle that no longer exists. "no room" means the
    // page was judged (the target was dropped); "too big" means the dead rectangle is
    // still being judged.
    // E26 left its target armed — guard A rejects without clearing — and on a fresh
    // empty page that rectangle revalidates clean, which would disable the whole shelf
    // and hang the builder clicks below. A page chip is the one control that drops a
    // target outright. Click the chip's NAME, not the chip: the active chip carries the
    // reorder arrows, and chipMove stops propagation before the chip's own handler runs.
    await page.locator('#pageList li').first().locator('span').first().click();
    await page.waitForTimeout(250);
    await page.locator('#addPage').click();
    await page.waitForTimeout(300);
    const fixPage = await page.evaluate(() =>
      [...document.querySelectorAll('#pageList li')].findIndex((li) => li.classList.contains('active')));
    // One 4x2 placement mirror, used both to derive the target and to prove the
    // stimulus. `grow` re-runs the same placement with one slot resized, so the target
    // can be chosen as "free now, taken after the resize" rather than hardcoded.
    await page.evaluate(() => {
      window.__wwProbeOcc = (idx, grow) => {
        const W = { quarter: 1, half: 2, 'three-quarter': 3, full: 4 };
        const pg = (window.__wwReplicaLayout().pages || [])[idx];
        const slots = ((pg && pg.slots) || []).map((s, i) =>
          (grow && i === grow.i) ? { size: grow.size, col: s.col } : { size: s.size, col: s.col });
        const occ = [[0, 0, 0, 0], [0, 0, 0, 0]];
        const geo = (s) => {
          let t = String(s.size || 'quarter'), band = 'full';
          if (t.endsWith('-upper')) { band = 'upper'; t = t.slice(0, -6); }
          else if (t.endsWith('-lower')) { band = 'lower'; t = t.slice(0, -6); }
          return { w: W[t] || 1, rows: band === 'full' ? [0, 1] : band === 'upper' ? [0] : [1] };
        };
        const free = (rows, c, w) => c >= 0 && c + w <= 4
          && rows.every((r) => { for (let i = 0; i < w; i++) if (occ[r][c + i]) return false; return true; });
        const take = (rows, c, w) => rows.forEach((r) => { for (let i = 0; i < w; i++) occ[r][c + i] = 1; });
        const placed = slots.map(() => false);
        slots.forEach((s, i) => {
          const a = (s.col >= 1 && s.col <= 4) ? s.col - 1 : null;
          if (a === null) return;
          const g = geo(s);
          if (free(g.rows, a, g.w)) { take(g.rows, a, g.w); placed[i] = true; }
        });
        slots.forEach((s, i) => {
          if (placed[i]) return;
          const g = geo(s);
          for (let c = 0; c + g.w <= 4; c++) if (free(g.rows, c, g.w)) { take(g.rows, c, g.w); break; }
        });
        return occ;
      };
    });
    // Two slots, packed so that exactly one 2-wide band stays free and one resize can
    // consume it. The sizes are set explicitly rather than assumed: the first add takes
    // THREE-QUARTER, not half — offeredWidths adds three-quarter for anything declaring
    // half, and defaultSizeFor picks widest-first.
    const setSize = (v) => page.evaluate((val) => {
      const s = document.querySelector('#slotDetail .slot-row select.size');
      if (!s) return false;
      s.value = val;
      s.dispatchEvent(new Event('change'));
      return true;
    }, v);
    await page.locator('#widgetGallery .gallery-item:not(:disabled)').first().click();
    await page.waitForTimeout(250);
    const s1 = await setSize('half');                    // cols 0-1, both rows
    await page.locator('#widgetGallery .gallery-item:not(:disabled)').first().click();
    await page.waitForTimeout(250);
    const s2 = await setSize('half-upper');              // cols 2-3, top row only
    await page.waitForTimeout(500);                      // past the 350ms debounce again
    const plan = await page.evaluate((idx) => {
      const pg = window.__wwReplicaLayout().pages[idx];
      const last = (pg.slots || []).length - 1;
      const before = window.__wwProbeOcc(idx);
      const after = window.__wwProbeOcc(idx, { i: last, size: 'half' });
      let cell = null;
      for (let r = 0; r < 2 && !cell; r++) for (let c = 0; c < 4 && !cell; c++)
        if (!before[r][c] && after[r][c]) cell = { col: c, row: r, w: 1, h: 1 };
      // No 2-wide run left afterwards, in either band: "no room" is then the CORRECT
      // page-wide answer, and the reason strings genuinely differ between the two worlds.
      const roomAfter = [0, 1].some((r) => {
        for (let c = 0; c + 2 <= 4; c++) if (!after[r][c] && !after[r][c + 1]) return true;
        return false;
      });
      return { cell, roomAfter, before, after, sizes: (pg.slots || []).map((s) => s.size), last };
    }, fixPage);
    check('E27 setup: a free 1x1 cell that the planned resize will fill, on an otherwise packed page',
      s1 && s2 && !!plan.cell && !plan.roomAfter && plan.sizes.length === 2,
      JSON.stringify(plan));
    if (plan.cell) {
      const gen6 = await page.evaluate(() => {
        try { return ((JSON.parse(window.__wwLastReplicaInit || '{}').data || {}).gen | 0); } catch (e) { return -1; }
      });
      // The tap names the page we are already on, so the handler's page-follow branch
      // never runs, the inspector keeps its selection, and pendingAddTarget.page is the
      // very object every later render passes to activeAddTarget.
      await replica.evaluate((a) => parent.postMessage({ type: 'ww-shell', message: {
        type: 'add-widget', index: a.i, target: a.t, gen: a.g } }, '*'),
        { i: fixPage, t: plan.cell, g: gen6 });
      await page.waitForTimeout(400);
      // Read the armed shelf, take the cells, and read the shelf again in ONE
      // synchronous turn. The size select's onchange sets the size and re-renders
      // inline, so nothing — no debounced re-init, no replica capture rebuilding the
      // page objects — can slip between the two reads and reject the target for the
      // other reason.
      const iso = await page.evaluate((a) => {
        const why = () => [...document.querySelectorAll('#widgetGallery .g-why')].map((e) => e.textContent);
        const enabled = () => [...document.querySelectorAll('#widgetGallery .gallery-item')].filter((b) => !b.disabled).length;
        const sel = () => [...document.querySelectorAll('#pageList li')].findIndex((li) => li.classList.contains('active'));
        const before = { why: why(), enabled: enabled(), page: sel() };
        const size = document.querySelector('#slotDetail .slot-row select.size');
        const had = size ? size.value : null;
        if (size) { size.value = 'half'; size.dispatchEvent(new Event('change')); }
        const occ = window.__wwProbeOcc(a.i);
        return { before, had, after: { why: why(), enabled: enabled(), page: sel() },
          cellNowTaken: !!occ[a.t.row][a.t.col], occ };
      }, { i: fixPage, t: plan.cell });
      // Stimulus guard, load-bearing for the same reason E26a is: page-wide sizing at
      // this moment returns 'half-lower' (row 1 still has a 2-wide run), so an unarmed
      // target shows an ENABLED entry with no reason at all — this cannot pass by
      // accident, and if it fails the run below is void rather than informative.
      check('E27a setup: the target is live and REGION-judged before the cells fill',
        iso.before.why.length > 0 && iso.before.why.every((w) => /too big/i.test(w))
          && iso.before.enabled === 0 && iso.before.page === fixPage && iso.had === 'half-upper',
        JSON.stringify(iso.before) + ' size=' + iso.had);
      check('E27b the resize actually took the tapped cell (stimulus guard)',
        iso.cellNowTaken, JSON.stringify({ target: plan.cell, occ: iso.occ }));
      // Nothing about the page changed except the cells. Same page index, same page
      // object, same render — so "too big" here can only mean a rectangle that no
      // longer exists is still being answered for.
      check('E27c the target does not survive the cells it named being taken',
        iso.after.why.length > 0 && iso.after.why.every((w) => /no room/i.test(w))
          && !iso.after.why.some((w) => /too big/i.test(w)) && iso.after.page === fixPage,
        JSON.stringify(iso.after));
    }
  }

  // ---- E19 · the dock's caps must be bounded by the viewport, not by each other ----
  // The toolbar's 38vh and the dock body's 46vh are independent allowances. Enough page
  // chips to wrap the toolbar to its cap, plus a dock body with a populated inspector,
  // is 84vh of fixed-height region before the header and preview bar are counted — at
  // 480px that overflows the window on its own, and E16's floor fix cannot recover it:
  // shrinking the canvas to zero still leaves the dock too tall. Nothing scrolls the
  // document, so those controls are simply unreachable.
  for (let i = 0; i < 28; i++) await page.locator('#addPage').click();
  await page.locator('#pageList li').first().click();          // a page that HAS a slot
  await page.waitForTimeout(250);
  await page.locator('#slotList .slot-chip .chip-main').first().click();  // fill the inspector
  await page.setViewportSize({ width: 780, height: 480 });
  await page.waitForTimeout(700);
  const packed = await page.evaluate(() => {
    const g = (id) => document.getElementById(id);
    const d = g('dock');
    // What the dock WANTS, measured with the cap lifted. Without this the assertion
    // below could pass on a dock that was never too tall in the first place — the
    // hollow-probe failure mode this suite has hit six times.
    const prev = d.style.maxHeight;
    d.style.maxHeight = 'none';
    const natural = Math.round(d.getBoundingClientRect().height);
    d.style.maxHeight = prev;
    return {
      natural,
      dockBottom: Math.round(d.getBoundingClientRect().bottom),
      stageTop: Math.round(g('previewStage').getBoundingClientRect().top),
      win: window.innerHeight,
      // Clipping is the actual harm, so every column has to be able to reach the
      // overflow the cap hides rather than losing it past the window's edge.
      scrollable: ['toolbar', 'dockPalette', 'contextBody'].every((id) => {
        const e = g(id); if (!e) return false;
        const o = getComputedStyle(e).overflowY;
        return o === 'auto' || o === 'scroll';
      }),
    };
  });
  check('E19 the dock genuinely wants more than the window has (stimulus guard)',
    packed.natural + packed.stageTop > packed.win,
    `dock wants ${packed.natural}px under ${packed.stageTop}px of chrome, window ${packed.win}px`);
  check('E19b it still stays inside the window when both of its caps are saturated',
    packed.dockBottom <= packed.win + 1, `dock bottom ${packed.dockBottom} vs window ${packed.win}`);
  check('E19c and every column can scroll to what the cap hid',
    packed.scrollable);

  // ---- E28 · #66/#105/#120: a DEMOTED secret must be clearable through the editor ------
  // The host blanks a demoted envelope and restores it if the field comes home untouched.
  // An ordinary text input sends "" when emptied, which is byte-identical to what an
  // untouched blanked field sends — so without an explicit Clear the host restores over a
  // deliberate clear and the field can NEVER be emptied. Only driving the real editor
  // catches that: asserting the host's three cases directly (P36h2) passes while this is
  // broken, because that probe supplies the marker the UI never produced.
  // A fresh settings-init: everything above has restructured the layout, and this block
  // needs the pristine fixture — one slot, the demoted property still blanked and named.
  await page.evaluate((payload) => window.__hostPush(payload), JSON.stringify({
    type: 'settings-init',
    data: {
      layout, widgets, sensors: [], backgroundHost: 'backgrounds.wsw',
      status: { elevated: false, version: 'v0.2.0 (probe)' },
    },
  }));
  await page.waitForTimeout(400);
  await page.locator('#slotList .slot-chip .chip-main').first().click();
  await page.waitForTimeout(250);
  const demoted = page.locator('#slotDetail .restorable-wrap');
  const demotedRows = await demoted.count();
  check('E28 setup: the demoted field renders its own row, not a secret one',
    demotedRows === 1, String(demotedRows));
  // Bail rather than drive a control that is not there. Every interaction below waits on
  // an element, so a regression that stops rendering the row would hang the suite for two
  // minutes instead of failing — which reads as an infrastructure problem, not a defect.
  if (demotedRows !== 1) {
    console.log('  SKIP E28a-E28i — no restorable row to drive');
    await browser.close();
    shellSrv.close();
    console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
    process.exit(failures ? 1 : 0);
  }
  check('E28a it is an ordinary TEXT input — the manifest calls this property ordinary now, '
    + 'so the user must be able to see what they type into it',
    await demoted.locator('input').getAttribute('type') === 'text',
    await demoted.locator('input').getAttribute('type'));
  check('E28b it says a previous value is stored, since it cannot show one',
    ((await demoted.locator('input').getAttribute('placeholder')) || '').includes('stored'),
    await demoted.locator('input').getAttribute('placeholder'));
  check('E28c and it offers a Clear affordance', await demoted.locator('button').count() === 1,
    String(await demoted.locator('button').count()));
  check('E28d the secret rows are unaffected — this is not one of them',
    await page.locator('#slotDetail .secret-wrap').count() === 2,
    String(await page.locator('#slotDetail .secret-wrap').count()));

  // Clear: the explicit signal, which is the whole reason the affordance exists.
  await demoted.locator('button').click();
  await page.waitForTimeout(100);
  await page.locator('#save').click();
  await page.waitForTimeout(400);
  let last = saved[saved.length - 1].pages[0].slots[0];
  check('E28e pressing Clear sends the marker, so the host removes the value instead of '
    + 'restoring it', last.settings.legacyToken === ''
      && (last.secretsCleared || []).includes('legacyToken'),
    JSON.stringify(last.settings.legacyToken));
  // The marker DOES travel back on the slot, exactly as `secretsSet` has always done —
  // the editor echoes the slot it was given. What must never happen is it becoming a
  // SETTING, which is the only way it could reach a widget or survive a round trip.
  // Keeping it off layout.json is the host's job and P36g4 asserts it there:
  // LayoutSlot has no matching member, so deserialize drops both markers.
  check('E28e2 the marker stays a slot projection and never becomes a setting',
    !('secretsRestorable' in last.settings) && !('secretsSet' in last.settings),
    JSON.stringify(Object.keys(last.settings)));

  // Typing replaces it, verbatim and unmasked.
  await demoted.locator('input').fill('now-an-ordinary-value');
  await page.waitForTimeout(100);
  await page.locator('#save').click();
  await page.waitForTimeout(400);
  last = saved[saved.length - 1].pages[0].slots[0];
  check('E28f typed text is saved verbatim — no cipher, no escaping',
    last.settings.legacyToken === 'now-an-ordinary-value',
    JSON.stringify(last.settings.legacyToken));

  // Emptying is the same deliberate clear by another route, and must NOT be a bare "".
  await demoted.locator('input').fill('');
  await page.waitForTimeout(100);
  await page.locator('#save').click();
  await page.waitForTimeout(400);
  last = saved[saved.length - 1].pages[0].slots[0];
  check('E28g emptying the field sends the marker too, so the value the user just deleted '
    + 'is not restored underneath them',
    last.settings.legacyToken === '' && (last.secretsCleared || []).includes('legacyToken'),
    JSON.stringify(last.settings.legacyToken));

  // ---- E29 · the affordance is property-type agnostic ---------------------------------
  // A demoted `color` is blanked and listed exactly like a demoted `text`, but its own
  // reset ("Use theme") deletes the key and the host reads that as untouched. Keying the
  // Clear on the LIST rather than on the control is what reaches every type.
  const tintField = page.locator('#slotDetail .prop-field').filter({ hasText: 'Legacy tint' });
  check('E29 a demoted non-text property gets a Clear too',
    await tintField.locator('.prop-clear').count() === 1,
    String(await tintField.locator('.prop-clear').count()));
  check('E29b while an ordinary property of the same type does not',
    await page.locator('#slotDetail .prop-field').filter({ hasText: 'Repository' })
      .locator('.prop-clear').count() === 0);
  await tintField.locator('.prop-clear').click();
  await page.waitForTimeout(150);
  await page.locator('#save').click();
  await page.waitForTimeout(400);
  last = saved[saved.length - 1].pages[0].slots[0];
  check('E29c and clearing it names the address, so the host removes rather than restores',
    (last.secretsCleared || []).includes('legacyTint') && last.settings.legacyTint === '',
    JSON.stringify({ cleared: last.secretsCleared, value: last.settings.legacyTint }));

  // ---- E30 · a replacement CANCELS a pending removal ----------------------------------
  // The name is a statement of intent, and the intent changes the moment the user sets a
  // value. Latched, the sequence "clear, then pick a replacement" deleted the property
  // instead of storing what was just chosen — the affordance destroying the edit it was
  // supposed to make room for.
  const tintField2 = page.locator('#slotDetail .prop-field').filter({ hasText: 'Legacy tint' });
  await tintField2.locator('.prop-clear').click();
  await page.waitForTimeout(120);
  await tintField2.locator('input[type=color]').evaluate((el) => {
    el.value = '#123456';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(120);
  await page.locator('#save').click();
  await page.waitForTimeout(400);
  last = saved[saved.length - 1].pages[0].slots[0];
  check('E30 picking a replacement after a Clear cancels the removal',
    !((last.secretsCleared) || []).includes('legacyTint'),
    JSON.stringify(last.secretsCleared));
  check('E30b and the replacement is what gets saved',
    last.settings.legacyTint === '#123456', JSON.stringify(last.settings.legacyTint));

  // ---- E31 · an EMPTY choice does not cancel a removal -------------------------------
  // The cancel added for E30 was unconditional, which put the latch back the other way
  // round: an sd-profiles select's "" means "first available" and is a real selection,
  // but "" is also the shape the host reads as untouched. Cancelling on it made "clear,
  // then pick the default" restore the envelope the user had just asked to delete.
  const profileField = page.locator('#slotDetail .prop-field').filter({ hasText: 'Legacy profile' });
  check('E31 a demoted select gets the Clear affordance too',
    await profileField.locator('.prop-clear').count() === 1,
    String(await profileField.locator('.prop-clear').count()));
  await profileField.locator('.prop-clear').click();
  await page.waitForTimeout(120);
  await profileField.locator('select').evaluate((el) => {
    el.value = '';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(120);
  await page.locator('#save').click();
  await page.waitForTimeout(400);
  last = saved[saved.length - 1].pages[0].slots[0];
  check('E31b choosing the empty default after a Clear keeps the removal',
    (last.secretsCleared || []).includes('legacyProfile'),
    JSON.stringify({ cleared: last.secretsCleared, value: last.settings.legacyProfile }));

  // ...and the cancel still works for a value that IS one. Both directions, so a fix
  // that simply stopped cancelling would fail here.
  await profileField.locator('select').evaluate((el) => {
    el.add(new Option('prod', 'prod', false, true));
    el.value = 'prod';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(120);
  await page.locator('#save').click();
  await page.waitForTimeout(400);
  last = saved[saved.length - 1].pages[0].slots[0];
  check('E31c and a real choice after a Clear still cancels the removal',
    !((last.secretsCleared) || []).includes('legacyProfile')
      && last.settings.legacyProfile === 'prod',
    JSON.stringify({ cleared: last.secretsCleared, value: last.settings.legacyProfile }));

  // ---- E32 · the marker survives a replica capture ------------------------------------
  // mergeReplicaCapture returned a captured slot wholesale when the widget declared no
  // secret names — which is exactly what a DEMOTED property is, the manifest having
  // stopped calling it secret. The clear was recorded on state.layout, the capture came
  // back from the replica without it, and the save restored the envelope instead.
  // The capture mirrors the replica's own scrubbed view: it carries no projections at
  // all. slots[1] is the widget that declares NO secret, which is what made the old
  // name-list gate return it wholesale.
  const survived = await page.evaluate(() => {
    const merged = window.__wwMergeReplicaCapture({
      pages: [{
        name: 'Main',
        slots: [
          { widgetId: 'test.gh', size: 'half', instanceId: 'gh1', settings: {} },
          { widgetId: 'test.demoted', size: 'half', instanceId: 'dm1', settings: {} },
        ],
      }],
    });
    return {
      demoted: merged.pages[0].slots[1].secretsRestorable || [],
      withSecrets: merged.pages[0].slots[0].secretsRestorable || [],
    };
  });
  check('E32 a capture cannot drop the projections of a widget that declares no secret',
    survived.demoted.includes('legacyOnly'), JSON.stringify(survived));
  check('E32b and the widget that does declare one keeps them too',
    survived.withSecrets.includes('legacyToken'), JSON.stringify(survived));

  // ---- E33 · the replica can CONTRADICT a pending removal -----------------------------
  // replicaLayout passes secretsCleared through, so the on-panel editor receives the
  // marker and cancels it by setting a value — and cancelling deletes the key, which is
  // indistinguishable from a capture that never carried one. Restoring the prior marker
  // unconditionally meant a replacement typed in the PREVIEW was deleted by the next
  // desktop Save. The value is the signal, exactly as it is inside the editors.
  // The marker has to be REAL. E31 left one standing on legacyToken, put there by the
  // editor's own Clear — seeding secretsCleared into a fixture would fake a projection
  // the host never sends, and prove nothing about the merge.
  const contradiction = await page.evaluate(() => {
    const cap = (value) => window.__wwMergeReplicaCapture({
      pages: [{
        name: 'Main',
        slots: [{
          widgetId: 'test.gh', size: 'half', instanceId: 'gh1',
          settings: { legacyToken: value },
        }],
      }],
    }).pages[0].slots[0];
    return {
      replaced: cap('typed-in-the-preview').secretsCleared || [],
      emptied: cap('').secretsCleared || [],
      replacedValue: cap('typed-in-the-preview').settings.legacyToken,
    };
  });
  check('E33 setup: a real pending removal is standing before the merge',
    contradiction.emptied.includes('legacyToken'), JSON.stringify(contradiction));
  check('E33b a replacement captured from the replica cancels the pending removal',
    !contradiction.replaced.includes('legacyToken')
      && contradiction.replacedValue === 'typed-in-the-preview',
    JSON.stringify(contradiction));

  // ---- E34 · the replica can INITIATE a removal, not only cancel one -------------------
  // The preview has its own Clear (#153). Pressing it names the address in the CAPTURED
  // slot, where the desktop copy has no prior marker at all — so sourcing the merge only
  // from prior deleted the intent on its way back and the Save restored the envelope.
  // legacyTint carries no pending removal here: E30 cancelled it with a replacement.
  const initiated = await page.evaluate(() => {
    const merged = window.__wwMergeReplicaCapture({
      pages: [{
        name: 'Main',
        slots: [{
          widgetId: 'test.gh', size: 'half', instanceId: 'gh1',
          settings: { legacyTint: '' },
          secretsCleared: ['legacyTint'],
        }],
      }],
    }).pages[0].slots[0];
    return merged.secretsCleared || [];
  });
  check('E34 a removal started in the replica survives the merge',
    initiated.includes('legacyTint'), JSON.stringify(initiated));
  check('E34b and it does not displace one already standing on the desktop side',
    initiated.includes('legacyToken'), JSON.stringify(initiated));

  // An ordinary property the host never blanked keeps its plain behaviour: there is
  // nothing to restore, so "" is unambiguous and no affordance is needed.
  const plain = page.locator('#slotDetail .prop-field').filter({ hasText: 'Repository' });
  check('E28h an ordinary field gets no Clear affordance and no restorable row',
    await plain.locator('.restorable-wrap').count() === 0);

  // Every ordinary property is planned RestoreIfUntouched now, so the host reads the clear
  // marker as protocol wherever it appears. An ordinary setting that happens to BE that
  // string must still be storeable, which means ordinary inputs escape the reserved
  // namespace exactly as the secret control always has.
  await plain.locator('input').fill('__ww_secret_cleared__');
  await page.waitForTimeout(100);
  await page.locator('#save').click();
  await page.waitForTimeout(400);
  last = saved[saved.length - 1].pages[0].slots[0];
  check('E28h2 an ordinary value equal to the old sentinel is stored verbatim, and an '
    + 'unrelated save cannot delete it',
    last.settings.repo === '__ww_secret_cleared__'
      && !((last.secretsCleared) || []).includes('repo'),
    JSON.stringify(last.settings.repo));
  await demoted.locator('input').fill('__ww_secret_cleared__');
  await page.waitForTimeout(100);
  await page.locator('#save').click();
  await page.waitForTimeout(400);
  last = saved[saved.length - 1].pages[0].slots[0];
  check('E28h3 and so is one typed into a DEMOTED field, which had the same hazard',
    last.settings.legacyToken === '__ww_secret_cleared__'
      && !((last.secretsCleared) || []).includes('legacyToken'),
    JSON.stringify(last.settings.legacyToken));
  await plain.locator('input').fill('');
  await demoted.locator('input').fill('');
  await page.waitForTimeout(100);
  await plain.locator('input').fill('');
  await page.waitForTimeout(100);
  await page.locator('#save').click();
  await page.waitForTimeout(400);
  last = saved[saved.length - 1].pages[0].slots[0];
  check('E28i and emptying it sends a plain empty string', last.settings.repo === '',
    JSON.stringify(last.settings.repo));

  await browser.close();
  shellSrv.close();
  console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
