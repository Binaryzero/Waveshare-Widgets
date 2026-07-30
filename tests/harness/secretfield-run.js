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

  await browser.close();
  shellSrv.close();
  console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
