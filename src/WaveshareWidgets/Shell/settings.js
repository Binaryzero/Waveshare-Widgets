// Settings editor: edits the layout (pages -> slots -> widget + size + properties)
// and posts it back to the host, which saves layout.json and reloads the dashboard.
(function () {
  'use strict';

  // Page capacity model: a 4-column x 2-row grid = 8 half-height cells.
  // A size token is a width (quarter=1, half=2, three-quarter=3, full=4 columns)
  // plus an optional -upper/-lower suffix (one row instead of both).
  const WIDTHS = ['quarter', 'half', 'three-quarter', 'full'];
  const WIDTH_COLS = { quarter: 1, half: 2, 'three-quarter': 3, full: 4 };
  const WIDTH_PX = { quarter: 320, half: 640, 'three-quarter': 960, full: 1280 };

  function parseSize(token) {
    let t = String(token || 'quarter').toLowerCase();
    let band = 'full';
    if (t.endsWith('-upper')) { band = 'upper'; t = t.slice(0, -6); }
    else if (t.endsWith('-lower')) { band = 'lower'; t = t.slice(0, -6); }
    if (!WIDTH_COLS[t]) t = 'quarter';
    return { width: t, band };
  }

  function sizeCells(token) {
    const { width, band } = parseSize(token);
    return WIDTH_COLS[width] * (band === 'full' ? 2 : 1);
  }

  let state = { layout: { pages: [] }, widgets: [], sensors: [] };
  let widgetsById = new Map();
  let selectedPage = 0;
  let selectedSlot = null;     // slot index (within the selected page) the detail panel shows
  let editMode = true;         // replica is the interactive WYSIWYG surface (default on)
  let dirty = false;           // unsaved edits pending Save & apply
  let editSeq = 0;             // bumps on every edit; the save ack only clears dirty
                               // when nothing changed since the acked snapshot
  let saveSeq = 0;             // request id sent with each save, echoed in the ack
  const pendingSaves = new Map(); // saveSeq -> editSeq at post time (in-flight saves)
  let initializing = false;    // suppress dirty-marking during a settings-init render
  let toastTimer = null;
  let backgroundHost = 'backgrounds.wsw';
  let pendingBgPick = null;    // callback(source, kind) for the in-flight file dialog
  let sdProfileWaiters = [];   // callbacks awaiting an sd-profiles-result
  let galleryOpen = false;     // settings-side add-widget gallery (Widget tab)
  let instanceSeq = 0;         // suffix for minted instanceIds (gallery adds)

  const el = (id) => document.getElementById(id);

  // ---- context tabs ----------------------------------------------------------
  // One panel, one job per tab: Page (name/capacity/delete/background), Widget
  // (chips + selected slot detail), Theme, Wallpaper. Selection events steer the
  // tab (a replica tap opens Widget); everything else leaves the user's tab alone.

  const TABS = { page: 'tabPage', widget: 'tabWidget', theme: 'tabTheme', wallpaper: 'tabWallpaper' };
  const PANES = { page: 'panePage', widget: 'paneWidget', theme: 'paneTheme', wallpaper: 'paneWallpaper' };
  let activeTab = 'page';

  function setTab(name) {
    if (!PANES[name]) name = 'page';
    activeTab = name;
    for (const key of Object.keys(TABS)) {
      const on = key === name;
      el(TABS[key]).classList.toggle('active', on);
      el(TABS[key]).setAttribute('aria-selected', String(on));
      el(PANES[key]).hidden = !on;
    }
  }

  // The panel is a transient floating INSPECTOR over the WYSIWYG preview, not a
  // permanent form region: it opens for one job (tapped widget, gallery, page,
  // theme, wallpaper) and closes out of the way. The preview is the interface.
  function panelTitleFor(name) {
    if (name === 'theme') return 'Theme';
    if (name === 'wallpaper') return 'Wallpaper';
    if (name === 'page') {
      const page = state.layout.pages[selectedPage];
      return page ? ('Page — ' + (page.name || 'Page ' + (selectedPage + 1))) : 'Page';
    }
    if (galleryOpen) return 'Add a widget';
    const page = state.layout.pages[selectedPage];
    const slot = page && selectedSlot != null ? (page.slots || [])[selectedSlot] : null;
    const widget = slot && widgetsById.get(slot.widgetId);
    return widget ? widget.name : 'Widget';
  }
  function openPanel(name) {
    setTab(name);
    el('panelTitle').textContent = panelTitleFor(name);
    const panel = el('contextPanel');
    // Float in the EMPTY region below the toolbar — never over the preview or
    // the chip row (a fixed top overlapped the toolbar and made chips
    // unclickable while the inspector was open).
    // Clamped: at the 780×480 minimum a wrapped toolbar can reach the viewport
    // bottom — the card then overlaps chrome rather than leaving the controls
    // unreachable below an overflow:hidden document.
    const top = Math.min(
      Math.round(el('toolbar').getBoundingClientRect().bottom + 10),
      Math.max(56, window.innerHeight - 300));
    panel.style.top = top + 'px';
    panel.style.maxHeight = 'calc(100vh - ' + (top + 16) + 'px)';
    panel.classList.add('open');
  }
  function closePanel() {
    el('contextPanel').classList.remove('open');
    // A gallery left "open" behind a closed card strands the toolbar button on
    // "✕ Close" and can resurface stale gallery content on the next open.
    if (galleryOpen) { galleryOpen = false; renderEditorPanel(); }
  }
  function panelOpen() {
    return el('contextPanel').classList.contains('open');
  }
  el('panelClose').addEventListener('click', closePanel);
  el('pageBtn').addEventListener('click', () => openPanel('page'));
  el('themeBtn').addEventListener('click', () => openPanel('theme'));
  el('wallpaperBtn').addEventListener('click', () => openPanel('wallpaper'));
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closePanel(); });

  // ---- host bridge -----------------------------------------------------------

  window.chrome.webview.addEventListener('message', (ev) => {
    const msg = ev.data || {};
    if (msg.type === 'settings-init') {
      state = msg.data || state;
      if (!state.layout || !Array.isArray(state.layout.pages)) state.layout = { pages: [] };
      backgroundHost = state.backgroundHost || backgroundHost;
      widgetsById = new Map((state.widgets || []).map((w) => [w.id, w]));
      // Build stamp in the header: "which version am I running" answered on sight.
      el('appVersion').textContent = (state.status && state.status.version) || '';
      selectedPage = Math.max(0, Math.min(selectedPage, state.layout.pages.length - 1));
      selectedSlot = null;
      lastWorkingLayout = replicaLayoutJson(); // loaded state IS the edit baseline
      initializing = true;
      renderAll();
      initializing = false;
      clearDirty(); // freshly loaded state IS the saved state
    } else if (msg.type === 'saved') {
      // Each ack names the save it answers (the host echoes our seq). Clear the
      // marker only when nothing changed since THAT snapshot was posted — an edit
      // racing the ack, or a second save still in flight, must stay visibly
      // unsaved or it's easy to close the window and lose it. An ack without a
      // seq (older host) falls back to the newest in-flight snapshot.
      const acked = msg.seq != null ? pendingSaves.get(msg.seq)
        : (pendingSaves.size ? [...pendingSaves.values()].pop() : undefined);
      if (msg.seq != null) pendingSaves.delete(msg.seq); else pendingSaves.clear();
      if (acked !== undefined && editSeq === acked) clearDirty();
      toast('Saved — dashboard updated');
    } else if (msg.type === 'save-failed') {
      if (msg.seq != null) pendingSaves.delete(msg.seq); else pendingSaves.clear();
      toast('Save failed: ' + msg.message, true);
    } else if (msg.type === 'widget-installed') {
      toast('Installed "' + msg.name + '"');
    } else if (msg.type === 'file-picked') {
      // Browse-button round trip (#48): fill the field that asked and commit
      // through its own handler. A null path is a cancelled dialog.
      const target = pendingFilePicks.get(msg.id);
      pendingFilePicks.delete(msg.id);
      if (target && msg.path) {
        target.value = msg.path;
        target.dispatchEvent(new Event('input'));
      }
    } else if (msg.type === 'background-picked') {
      const cb = pendingBgPick;
      pendingBgPick = null;
      if (cb) cb(msg.source, msg.kind);
    } else if (msg.type === 'background-failed') {
      pendingBgPick = null;
      toast('Could not load background: ' + msg.message, true);
    } else if (msg.type === 'sd-profiles-result') {
      const waiters = sdProfileWaiters.splice(0);
      const profiles = Array.isArray(msg.profiles) ? msg.profiles.filter((p) => typeof p === 'string') : [];
      waiters.forEach((cb) => cb(profiles));
    } else if (msg.type === 'preview-host') {
      // Live data (sensors/media) and replica request results from the host — keep our
      // snapshot fresh for the next replica re-init, then pass straight through.
      const m = msg.message || {};
      if (m.type === 'sensors') state.sensors = m.data || [];
      else if (m.type === 'media') state.media = m.data || null;
      replicaPost(m);
    }
  });

  function post(message) {
    window.chrome.webview.postMessage(message);
  }

  // ---- live replica -----------------------------------------------------------
  // The real shell (index.html?preview) embedded at native 1280×400 and scaled to
  // fit, driven with the EDITED (unsaved) layout and theme. Structural edits push a
  // debounced full re-init; theme edits ride a light token push (no iframe reloads).

  const previewFrame = el('previewFrame');
  const previewStage = el('previewStage');
  let replicaReady = false;
  let replicaTimer = null;
  let initGen = 0;            // bumped per replica init; captures echo the generation
                              // they were built under, so a save-layout the replica
                              // emitted BEFORE applying the latest init (posting is
                              // async) can be recognized as stale and dropped.
  let lastReplicaLayout = ''; // structural snapshot (theme excluded — it rides the light push)
  let lastWorkingLayout = ''; // edit detector: the working copy at the last layout render.
                              // Separate from lastReplicaLayout, which tracks REPLICA
                              // DELIVERY and goes stale while the preview is suspended —
                              // comparing against it re-marked a saved layout dirty on a
                              // mere page selection after editing with the preview hidden.

  const replicaLayoutJson = () => JSON.stringify(Object.assign({}, state.layout, { theme: null }));

  function replicaPost(message) {
    if (!replicaReady) return;
    try { previewFrame.contentWindow.postMessage({ type: 'ww-host', message }, '*'); } catch (e) { /* not loaded */ }
  }

  function replicaTheme() {
    return derivePalette(Object.assign({}, THEME_DEFAULTS, state.layout.theme || {}));
  }

  function replicaInit() {
    // This IS the delivery any armed debounce was waiting for — disarm it, both so
    // a 'ready' arriving mid-debounce can't double-init and so replicaTimer stays a
    // truthful "settings edits are still undelivered" signal for the capture guard.
    clearTimeout(replicaTimer);
    replicaTimer = null;
    initGen++;
    lastReplicaLayout = replicaLayoutJson();
    replicaPost({
      type: 'init',
      data: {
        gen: initGen,
        layout: state.layout,
        widgets: state.widgets,
        sensors: state.sensors,
        media: state.media || null,
        backgroundHost,
        theme: replicaTheme(),
        // settings-init only carries {elevated}; widgets still expect the panel's
        // full status shape, so keep apiVersion present in the replica too.
        status: Object.assign({ elevated: false, apiVersion: 1 }, state.status || {}),
        page: selectedPage,
      },
    });
    if (editMode) {
      // The replica just (re)built from scratch: put it straight back into edit
      // mode and restore the selection highlight (both are per-document state).
      replicaPost({ type: 'edit-mode', on: true });
      postReplicaSelection();
    }
  }

  function postReplicaSelection() {
    if (selectedSlot == null || !state.layout.pages[selectedPage]) return;
    replicaPost({ type: 'select-slot', page: selectedPage, index: selectedSlot });
  }

  /** kind: 'layout' (debounced full re-init) | 'theme' (light token push). */
  function refreshReplica(kind) {
    if (kind === 'theme') {
      markDirty();
      if (!replicaReady || previewStage.classList.contains('collapsed')) return;
      // seeds ride along so the replica's styled slots re-derive their overrides
      // against the edited theme instead of keeping stale (or losing) seeds.
      replicaPost({ type: 'theme', data: replicaTheme(), seeds: state.layout.theme || null });
      return;
    }
    const json = replicaLayoutJson();
    if (json !== lastWorkingLayout) { // a real structural edit, replica alive or not
      lastWorkingLayout = json;
      markDirty();
    }
    if (!replicaReady || previewStage.classList.contains('collapsed')) return;
    // Selection-only renders (nothing structural changed) just steer the replica to
    // the selected page — a full re-init would needlessly reload every widget. The
    // replica already shows exactly this layout, so an earlier armed re-init (e.g.
    // an edit since reverted) has nothing left to deliver: disarm it.
    if (json === lastReplicaLayout) {
      clearTimeout(replicaTimer);
      replicaTimer = null;
      replicaPost({ type: 'page', index: selectedPage });
      return;
    }
    clearTimeout(replicaTimer);
    replicaTimer = setTimeout(replicaInit, 350);
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== previewFrame.contentWindow) return;
    const msg = ev.data || {};
    if (msg.type !== 'ww-shell') return;
    const m = msg.message || {};
    if (m.type === 'ready') {
      replicaReady = true;
      clearTimeout(replicaWatchdog);
      el('previewHint').textContent = PREVIEW_HINT_DEFAULT;
      el('previewHint').classList.remove('warn');
      replicaInit();
    } else if (m.type === 'page-changed') {
      // The editing replica navigated (page add, edge-drop, capsule arrows): follow
      // it, or the rail/detail/Add-widget keep operating on the page the preview no
      // longer shows. Out-of-range indices (capture was dropped) are ignored; our
      // own 'page' steering echoes back as an equal index and no-ops here.
      // Same staleness rules as captures and selections: a navigation the OLD
      // replica completed while settings edits are undelivered (armed debounce)
      // or before applying the latest init (generation echo) indexes a layout we
      // no longer hold — following it would point every page/widget edit at the
      // wrong page after a reorder or deletion.
      // A DROPPED navigation must still converge: unlike captures (the imminent
      // re-init repaints the replica), nothing else corrects a page split, and
      // the field showed the strip stuck on one page while the preview displayed
      // another — with every edit landing on the wrong page's state. Steer the
      // replica back to OUR page so the two surfaces re-agree visibly.
      if (replicaTimer || (m.gen | 0) !== initGen) {
        replicaPost({ type: 'page', index: selectedPage });
        return;
      }
      const idx = m.index | 0;
      if (idx !== selectedPage && idx >= 0 && idx < state.layout.pages.length) {
        selectedPage = idx;
        selectedSlot = null; // a follow-up slot-selected re-adopts if a tile moved with us
        galleryOpen = false; // an open gallery was aimed at the page we just left
        renderPageList();
        renderEditorPanel();
        // An open widget inspector points at a selection that no longer exists —
        // close it rather than showing an orphaned card. Theme/wallpaper/page
        // inspectors are page-independent and stay.
        if (activeTab === 'widget' && panelOpen()) closePanel();
      }
    } else if (m.type === 'save-layout') {
      // The interactive replica IS the editor (#32): its continuous persists are the
      // edit stream. Captured into the working copy — unsaved until Save & apply —
      // never forwarded to the real host.
      captureReplicaLayout(m.layout, m.gen);
    } else if (m.type === 'slot-selected') {
      // Click-to-configure: the replica says which tile the user tapped (or where a
      // mutation moved the already-selected one, or -1/-1 when it went away).
      onReplicaSelection(m.page | 0, m.index | 0, m.instanceId || null, m.gen);
    } else if (m.type === 'style-widget') {
      // 🎨 on a preview tile: the slot-selected handoff (posted first) already
      // adopted the tile — just make sure its inspector is open.
      if ((m.gen | 0) === initGen && !replicaTimer) openPanel('widget');
    } else if (m.type === 'add-widget') {
      // The replica's "+" zone hands the add over to us (#45): a modal palette
      // inside the scaled strip covered the very layout being edited. Follow the
      // page the tap happened on, then open the settings-side gallery.
      // Same staleness rules as page-changed/slot-selected: a tap in the OLD
      // replica (undelivered edits or an outdated generation) indexes a layout
      // we no longer hold — following it would open the gallery on, and add the
      // widget to, the wrong page after a reorder or deletion.
      if (replicaTimer || (m.gen | 0) !== initGen) return;
      const idx = m.index | 0;
      if (idx !== selectedPage && idx >= 0 && idx < state.layout.pages.length) {
        selectedPage = idx;
        selectedSlot = null;
        renderPageList();
      }
      openGallery();
    } else if (m.type === 'fetch' || m.type === 'ping' || m.type === 'media-list' || m.type === 'audio-get') {
      post({ type: 'preview-data', message: m });
    } else if (m.type === 'notifications-watch') {
      // The host's toast mirror is demand-gated by the PANEL shell; the preview must
      // never add/remove real watch demand (SetWatching is one toggle — a second
      // writer would fight the dashboard's bookkeeping). Answer with representative
      // sample toasts instead (theme-panel sample-tile spirit), or the widget sits
      // on its loading spinner forever in the replica.
      if (m.on !== false) replicaPost({ type: 'notifications', data: sampleNotifications() });
    }
    // Everything else (media-control, actions, audio-set, sd-*, log) is dropped:
    // the replica edits the layout, but is never an actor for the outside world.
  });

  // ---- WYSIWYG capture --------------------------------------------------------
  // The replica shell edits its own copy of the layout and streams every mutation
  // as a save-layout post. Adopt that copy as the working state and refresh the
  // panels around the preview WITHOUT re-initing the replica — it already shows
  // exactly this layout (the lastReplicaLayout snapshot swallows the echo).

  function captureReplicaLayout(layout, gen) {
    if (!layout || !Array.isArray(layout.pages)) return;
    // A capture built under an older init generation comes from a document state
    // we have since replaced: clearing replicaTimer happens when the init is
    // POSTED, but the replica applies it asynchronously, and a gesture (or a
    // deferred view-transition mutation) completing in that gap streams the OLD
    // copy. The armed-timer guard below can't see it — the timer is already
    // clear — so the generation echo is the authority: stale gen, stale capture.
    if ((gen | 0) !== initGen) return;
    // An armed re-init debounce means the settings side holds edits the replica has
    // NOT received yet — this capture was built from a stale copy, and adopting it
    // would silently revert those edits (and the still-armed timer would then
    // re-init the replica as a pure echo, reloading every widget). Drop it: the
    // imminent re-init repaints the replica from the settings truth, visibly
    // superseding the replica gesture instead of corrupting the working copy.
    if (replicaTimer) return;
    state.layout = layout;
    lastReplicaLayout = replicaLayoutJson();
    lastWorkingLayout = lastReplicaLayout; // replica edits advance the edit baseline too
    selectedPage = Math.max(0, Math.min(selectedPage, state.layout.pages.length - 1));
    markDirty();
    renderPageList();
    renderEditorPanel();
  }

  function onReplicaSelection(pageIdx, slotIdx, instanceId, gen) {
    // An armed re-init debounce means the replica still shows a layout we have
    // since edited: every index it emits — select AND deselect — references the
    // OLD copy, and a mere existence check can bless the WRONG slot (delete slot
    // 0 from the strip, tap the tile still showing old slot 1: our slot 1 is a
    // different widget). Same rule as captureReplicaLayout: drop it — the
    // imminent re-init repaints the replica and re-imposes our selection.
    // The generation echo covers the post-to-apply gap the timer can't see, and
    // unlike the instanceId check below it also protects LEGACY slots that have
    // no id to verify: a matching generation proves the replica applied the
    // current init, so its indices refer to the layout we hold right now.
    if (replicaTimer || (gen | 0) !== initGen) return;
    if (pageIdx < 0 || slotIdx < 0) {
      if (selectedSlot === null) return;
      selectedSlot = null;
      renderEditorPanel();
      return;
    }
    if (pageIdx === selectedPage && slotIdx === selectedSlot) return; // echo of our own select-slot
    // Only adopt indices that exist in OUR copy. A tap can race a pending structural
    // edit (e.g. the rail just deleted the page the replica still shows): its indices
    // reference a layout we no longer hold, and adopting the slot index would render
    // ANOTHER slot's properties. The imminent re-init resets the replica anyway.
    const page = state.layout.pages[pageIdx];
    if (!page || !(page.slots || [])[slotIdx]) return;
    // Identity check for the residual window the timer can't see (an init posted
    // but not yet applied by the iframe): when the replica names the tapped tile,
    // adopt the indices only if OUR slot at that position is the same instance.
    if (instanceId && (page.slots || [])[slotIdx].instanceId !== instanceId) return;
    selectedPage = pageIdx;
    selectedSlot = slotIdx;
    galleryOpen = false; // the tap picked an existing widget — detail takes over
    renderPageList();
    renderEditorPanel();
    openPanel('widget'); // a real adoption (tap / palette add) — open the inspector
  }

  function markDirty() {
    if (initializing) return;
    editSeq++; // every edit bumps, even while already dirty — the save ack compares
    if (dirty) return;
    dirty = true;
    el('save').classList.add('dirty');
    el('save').title = 'You have unsaved changes';
  }

  function clearDirty() {
    dirty = false;
    el('save').classList.remove('dirty');
    el('save').title = '';
  }

  function sampleNotifications() {
    const now = Date.now();
    return { state: 'allowed', items: [
      { id: 1, app: 'Mail', appId: 'preview.mail', title: 'Sample notification', body: 'This is how mirrored toasts will look on the panel.', time: now - 40000 },
      { id: 2, app: 'Mail', appId: 'preview.mail', title: 'Meeting in 15 minutes', body: 'Design sync — Room 4.', time: now - 300000 },
      { id: 3, app: 'Chat', appId: 'preview.chat', title: 'Alex', body: 'Preview data — real notifications appear on the panel itself.', time: now - 3600000 },
    ] };
  }

  // The preview is a STRIP above the editor, not the centerpiece: fit the stage
  // width but never scale past native or past a strip height — unbounded fitting
  // rendered the panel BIGGER than 1280×400 on wide windows, eating most of the
  // screen and pushing the whole editor into scroll (#27). The strip height
  // follows the window (~30%, clamped 160–320): a fixed cap read "too small" on
  // large screens and would dominate small ones. While "Edit layout" is on the
  // strip IS the editing surface, so the cap rises to ~45% for usable targets —
  // the same clamp logic, just a taller ceiling (#32).
  function fitReplica() {
    const width = previewStage.clientWidth || 1;
    const maxH = editMode
      ? Math.max(200, Math.min(430, Math.round(window.innerHeight * 0.45)))
      : Math.max(160, Math.min(320, Math.round(window.innerHeight * 0.3)));
    const scale = Math.min(width / 1280, maxH / 400, 1);
    previewFrame.style.transform = 'scale(' + scale + ')';
    previewFrame.style.marginLeft = Math.max(0, Math.round((width - 1280 * scale) / 2)) + 'px';
    previewStage.style.height = Math.round(400 * scale) + 'px';
  }
  new ResizeObserver(fitReplica).observe(previewStage);
  window.addEventListener('resize', fitReplica); // stage width alone misses height-only resizes

  // A dead preview must say so, not sit there as a black slab: if the shell never
  // reports ready, surface it where the user is looking (#27 companion diagnostic).
  const PREVIEW_HINT_DEFAULT = el('previewHint').textContent;
  let replicaWatchdog = null;
  function armReplicaWatchdog() {
    clearTimeout(replicaWatchdog);
    replicaWatchdog = setTimeout(() => {
      if (replicaReady) return;
      el('previewHint').textContent =
        'Preview did not start — the panel shell failed to load here. Check app.log (enable dev tools in config.json for details).';
      el('previewHint').classList.add('warn');
    }, 6000);
  }

  el('previewToggle').addEventListener('click', () => {
    const collapsed = previewStage.classList.toggle('collapsed');
    el('previewToggle').textContent = collapsed ? 'Show' : 'Hide';
    if (collapsed) {
      previewFrame.removeAttribute('src'); // suspend: no hidden widgets burning CPU
      replicaReady = false;
      // An intentionally suspended preview is not a failure — a watchdog armed in
      // the last six seconds must not fire a false "did not start".
      clearTimeout(replicaWatchdog);
      el('previewHint').textContent = PREVIEW_HINT_DEFAULT;
      el('previewHint').classList.remove('warn');
    } else {
      previewFrame.src = 'index.html?preview=1';
      fitReplica();
      armReplicaWatchdog();
    }
  });

  // ---- WYSIWYG edit toggle ----------------------------------------------------
  // Default ON: the replica takes pointer input and runs the shell's own edit mode
  // (drag, resize, ✕, +, tap-to-configure). OFF returns the look-don't-touch strip.
  function applyEditMode() {
    const btn = el('editToggle');
    btn.classList.toggle('on', editMode);
    btn.setAttribute('aria-pressed', String(editMode));
    previewStage.classList.toggle('interactive', editMode);
    fitReplica();
    replicaPost({ type: 'edit-mode', on: editMode });
    if (editMode) postReplicaSelection();
  }
  el('editToggle').addEventListener('click', () => {
    editMode = !editMode;
    applyEditMode();
  });

  applyEditMode(); // stamp the initial classes (replica messages no-op until ready)
  previewFrame.src = 'index.html?preview=1';
  fitReplica();
  armReplicaWatchdog();

  // ---- top bar ----------------------------------------------------------------

  el('save').addEventListener('click', () => {
    const seq = ++saveSeq;
    pendingSaves.set(seq, editSeq); // the ack clears dirty only if this is still current
    post({ type: 'save-layout', layout: state.layout, seq });
  });
  el('installWidget').addEventListener('click', () => post({ type: 'install-widget' }));
  el('openFolder').addEventListener('click', () => post({ type: 'open-widgets-folder' }));
  el('openMedia').addEventListener('click', () => post({ type: 'open-media-folder' }));
  el('addPage').addEventListener('click', () => {
    state.layout.pages.push({ name: 'Page ' + (state.layout.pages.length + 1), slots: [] });
    selectedPage = state.layout.pages.length - 1;
    selectedSlot = null;
    renderAll();
  });

  // ---- page panel ----------------------------------------------------------------

  function renderAll() {
    renderPageList();
    renderThemeEditor();
    renderGlobalBackground();
    renderEditor();
  }

  function renderGlobalBackground() {
    renderBackgroundEditor(
      el('globalBg'),
      () => state.layout.background || null,
      (spec) => {
        if (spec) state.layout.background = spec; else delete state.layout.background;
        refreshReplica('layout');
      },
      { allowInherit: false });
  }

  // Stock seeds mirrored from PaletteEngine's defaults; shown when no theme is set.
  const THEME_DEFAULTS = { accent: '#4cc2ff', background: '#05070b', text: '#e8ecf2', panelAlpha: 0.92 };

  // Palette derivation lives in palette.js (shared with the dashboard shell for the
  // live replica and per-widget style overrides).
  const derivePalette = window.WWPalette.derive;

  function renderThemeEditor() {
    const container = el('themeEditor');
    container.textContent = '';

    // Live preview: a miniature widget tile over a wallpaper strip, restyled on every
    // input so each control's effect is visible immediately.
    const preview = document.createElement('div');
    preview.className = 'theme-preview';
    preview.innerHTML =
      '<div class="tp-tile">' +
        '<div class="tp-head"><span class="tp-kicker">CPU Load</span><span class="tp-pill">OK</span></div>' +
        '<div class="tp-reading"><span class="tp-value">57</span><span class="tp-unit">%</span></div>' +
        '<div class="tp-meter"><i></i></div>' +
        '<div class="tp-btns"><button type="button" class="tp-btn" tabindex="-1">Button</button>' +
        '<button type="button" class="tp-btn tp-primary" tabindex="-1">Accent</button></div>' +
      '</div>';

    const refreshPreview = () => {
      const t = Object.assign({}, THEME_DEFAULTS, state.layout.theme || {});
      const tokens = derivePalette(t);
      for (const name of Object.keys(tokens)) preview.style.setProperty(name, tokens[name]);
    };

    const setKey = (key, value) => {
      const t = state.layout.theme || (state.layout.theme = {});
      if (value == null) delete t[key]; else t[key] = value;
      if (!Object.keys(t).length) delete state.layout.theme;
      refreshPreview();
      refreshReplica('theme');
    };
    const cur = state.layout.theme || {};

    container.appendChild(preview);
    container.appendChild(bgColor('Accent', cur.accent || THEME_DEFAULTS.accent, (v) => setKey('accent', v)));
    container.appendChild(bgColor('Background', cur.background || THEME_DEFAULTS.background, (v) => setKey('background', v)));
    container.appendChild(bgColor('Text', cur.text || THEME_DEFAULTS.text, (v) => setKey('text', v)));
    const alphaPct = Math.round((cur.panelAlpha != null ? cur.panelAlpha : THEME_DEFAULTS.panelAlpha) * 100);
    container.appendChild(bgSlider('Panel opacity', alphaPct, 15, 100, 1, '%', (v) => setKey('panelAlpha', v / 100)));

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'ghost';
    reset.textContent = 'Reset to stock theme';
    reset.onclick = () => { delete state.layout.theme; renderThemeEditor(); refreshReplica('theme'); };
    container.appendChild(bgRow('', reset));
    refreshPreview();
  }

  // Horizontal pages strip: one chip per page (name + widget count); click selects
  // AND steers the replica there. The active chip carries the ◀ ▶ reorder arrows.
  function renderPageList() {
    const list = el('pageList');
    list.textContent = '';
    state.layout.pages.forEach((page, i) => {
      const item = document.createElement('li');
      item.classList.toggle('active', i === selectedPage);
      const name = document.createElement('span');
      name.textContent = page.name || 'Page ' + (i + 1);
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = (page.slots || []).length;
      item.append(name, count);
      if (i === selectedPage) {
        const left = chipMove('movePageLeft', '◀', 'Move page earlier', -1);
        left.disabled = i === 0;
        const right = chipMove('movePageRight', '▶', 'Move page later', 1);
        right.disabled = i === state.layout.pages.length - 1;
        item.append(left, right);
      }
      item.addEventListener('click', () => {
        if (selectedPage !== i) selectedSlot = null; // selection is per page
        selectedPage = i;
        renderAll();
      });
      list.appendChild(item);
    });
  }

  function chipMove(id, glyph, title, delta) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = id;
    btn.className = 'chip-move';
    btn.textContent = glyph;
    btn.title = title;
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation(); // the chip's own click would re-select
      movePage(delta);
    });
    return btn;
  }

  // ---- page editor ----------------------------------------------------------------

  function renderEditor() {
    refreshReplica('layout');
    renderEditorPanel();
  }

  // Everything below/around the preview, WITHOUT poking the replica — used directly
  // when the replica itself originated the change (capture) and already shows it.
  function renderEditorPanel() {
    const page = state.layout.pages[selectedPage];
    const hasPage = !!page;
    el('editorEmpty').hidden = hasPage;
    el('pageHeader').style.display = hasPage ? 'flex' : 'none';
    el('addSlot').style.display = hasPage ? 'block' : 'none';
    el('pageBgWrap').style.display = hasPage ? 'block' : 'none';
    el('slotList').textContent = '';
    el('slotDetail').textContent = '';
    if (!hasPage) {
      galleryOpen = false;
      renderWidgetGallery(null);
      // Nothing to manage widget-wise; the empty state lives on the Page tab.
      if (activeTab === 'widget' && panelOpen()) closePanel();
      return;
    }

    renderBackgroundEditor(
      el('pageBg'),
      () => page.background || null,
      (spec) => {
        if (spec) page.background = spec; else delete page.background;
        refreshReplica('layout');
      },
      { allowInherit: true });

    const nameInput = el('pageName');
    nameInput.value = page.name || '';
    // Renames go through the structural refresh like every other layout edit: it
    // arms the replica debounce, and the armed timer is exactly what makes
    // captureReplicaLayout drop stale replica copies — a rename that only touched
    // our side was silently reverted by the next replica gesture's capture.
    nameInput.oninput = () => { page.name = nameInput.value; renderPageList(); refreshReplica('layout'); };

    // Two-tap confirm: the first tap arms the button (and auto-disarms), only a
    // second tap actually deletes — a page full of tuned widgets is easy to fat-finger.
    const delBtn = el('deletePage');
    delBtn.textContent = 'Delete page';
    delete delBtn.dataset.armed;
    delBtn.onclick = () => {
      if (!delBtn.dataset.armed) {
        delBtn.dataset.armed = '1';
        delBtn.textContent = 'Tap again to delete';
        setTimeout(() => {
          if (delBtn.dataset.armed) {
            delete delBtn.dataset.armed;
            delBtn.textContent = 'Delete page';
          }
        }, 3500);
        return;
      }
      delete delBtn.dataset.armed;
      state.layout.pages.splice(selectedPage, 1);
      selectedPage = Math.max(0, selectedPage - 1);
      selectedSlot = null;
      renderAll();
    };

    el('addSlot').onclick = () => (galleryOpen ? closeGallery() : openGallery());

    page.slots = page.slots || [];
    if (selectedSlot !== null && !page.slots[selectedSlot]) selectedSlot = null; // stale index
    renderSlotStrip(page);
    renderSlotDetail(page);
    renderWidgetGallery(page);
    renderCapacity(page);
  }

  // ---- add-widget gallery -----------------------------------------------------
  // Settings-side picker (#45): the replica's modal palette covered the scaled
  // layout being edited, so adds happen HERE — whether they start from the
  // "+ Add widget" button (toggle: second click closes) or from the replica's
  // "+" zone (the shell bounces that tap up as an add-widget message).

  function openGallery() {
    galleryOpen = true;
    openPanel('widget');
    renderEditorPanel();
  }

  function closeGallery() {
    galleryOpen = false;
    renderEditorPanel();
  }

  // Mirror of the shell's defaultSizeFor: widest size that fits WITHOUT costing
  // any currently-placing slot its spot. Legacy layouts can carry slots that
  // already fail to place (over-full pages hide them) — they must not veto adds
  // into the free space that IS visible (field bug: every gallery entry said
  // "No room" while half the page sat empty).
  function defaultSizeFor(page, widget) {
    const widths = offeredWidths(widget).slice().reverse(); // widest first, shrink into the hole
    const slots = (page.slots = page.slots || []);
    const baseline = countUnplaced(slots);
    const probe = { size: 'quarter' };
    slots.push(probe);
    let found = null;
    outer:
    for (const band of ['full', 'upper', 'lower']) {
      for (const w of widths) {
        probe.size = w + (band === 'full' ? '' : '-' + band);
        if (countUnplaced(slots) === baseline) { found = probe.size; break outer; }
      }
    }
    slots.pop();
    return found;
  }

  function renderWidgetGallery(page) {
    const wrap = el('widgetGallery');
    const open = galleryOpen && !!page;
    wrap.hidden = !open;
    el('addSlot').classList.toggle('open', open);
    el('addSlot').textContent = open ? '✕ Close' : '+ Add widget';
    el('slotDetail').style.display = open ? 'none' : '';
    wrap.textContent = '';
    if (!open) return;
    for (const widget of state.widgets) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gallery-item';
      const size = defaultSizeFor(page, widget);
      const name = document.createElement('span');
      name.className = 'g-name';
      name.textContent = widget.name;
      const by = document.createElement('span');
      by.className = 'g-by';
      by.textContent = size ? (widget.author || '') : 'No room on this page';
      btn.append(name, by);
      btn.disabled = !size;
      btn.addEventListener('click', () => addWidgetToPage(page, widget));
      wrap.appendChild(btn);
    }
    // A wall of disabled entries reads as "broken", not "full" — say it plainly.
    if (![...wrap.children].some((b) => !b.disabled)) {
      const note = document.createElement('p');
      note.className = 'g-full panel-hint';
      note.textContent = 'This page is full — remove a widget or add a page.';
      wrap.prepend(note);
    }
  }

  function addWidgetToPage(page, widget) {
    const size = defaultSizeFor(page, widget); // sized against the page as it IS now
    if (!size) return;
    galleryOpen = false;
    page.slots.push({
      widgetId: widget.id,
      size,
      settings: {},
      // Minted like the shell does: a positional tag could collide with an
      // identity another slot froze earlier.
      instanceId: 'i' + Date.now().toString(36) + '-' + (++instanceSeq),
    });
    selectedSlot = page.slots.length - 1;
    openPanel('widget'); // gallery pick lands in the new widget's inspector
    renderPageList(); // the strip's widget count changed
    renderEditor();
  }

  function movePage(delta) {
    const target = selectedPage + delta;
    if (target < 0 || target >= state.layout.pages.length) return;
    const [page] = state.layout.pages.splice(selectedPage, 1);
    state.layout.pages.splice(target, 0, page);
    selectedPage = target;
    renderAll();
  }

  // Mirror of the shell's two-pass placement (anchors first, then order-based
  // first-fit). Total cells alone can't tell whether everything fits (five
  // quarter-uppers are only 5/8 cells, but the top row holds 4), and ignoring
  // `col` pins would let the gallery offer sizes the real placement then hides
  // (a pinned tile the simulation flowed left can block the columns the shell
  // actually keeps free) — so simulate the real 4x2 placement and count drops.
  function countUnplaced(slots) {
    const occupied = [new Array(4).fill(false), new Array(4).fill(false)]; // [row][col]
    const placed = new Array(slots.length).fill(false);
    const geo = (s) => {
      const { width, band } = parseSize(s.size);
      return { w: WIDTH_COLS[width], rows: band === 'full' ? [0, 1] : band === 'upper' ? [0] : [1] };
    };
    const free = (rows, col, w) => {
      if (col < 0 || col + w > 4) return false;
      for (const r of rows) for (let i = 0; i < w; i++) if (occupied[r][col + i]) return false;
      return true;
    };
    const take = (rows, col, w) => {
      for (const r of rows) for (let i = 0; i < w; i++) occupied[r][col + i] = true;
    };
    // Pass A — anchored slots (1-based col) claim their column; a blocked
    // anchor falls through to the flow pass, exactly like the shell.
    slots.forEach((s, i) => {
      const anchor = (s.col >= 1 && s.col <= 4) ? s.col - 1 : null;
      if (anchor === null) return;
      const { w, rows } = geo(s);
      if (free(rows, anchor, w)) { take(rows, anchor, w); placed[i] = true; }
    });
    // Pass B — everything else flows first-fit in array order.
    let dropped = 0;
    slots.forEach((s, i) => {
      if (placed[i]) return;
      const { w, rows } = geo(s);
      let col = -1;
      for (let c = 0; c + w <= 4; c++) if (free(rows, c, w)) { col = c; break; }
      if (col >= 0) take(rows, col, w); else dropped++;
    });
    return dropped;
  }

  function renderCapacity(page) {
    const slots = page.slots || [];
    const used = slots.reduce((sum, s) => sum + sizeCells(s.size), 0);
    const dropped = countUnplaced(slots);
    const cap = el('capacity');
    cap.textContent = 'Space used: ' + used + ' / 8';
    cap.classList.toggle('warn', dropped > 0);
    if (dropped > 0)
      cap.textContent += ' — ' + dropped + ' widget' + (dropped > 1 ? 's' : '') + ' won\'t fit and will be dropped';
  }

  // ---- slot strip (compact chips) + detail panel ------------------------------------
  // Master–detail: the strip lists this page's widgets (click to configure, ✕ to
  // remove) and doubles as the selection path when the preview is hidden or dead;
  // the detail panel shows ONLY the selected slot's properties.

  const CHIP_WIDTH = { quarter: '¼', half: '½', 'three-quarter': '¾', full: 'Full' };
  const CHIP_BAND = { full: '', upper: ' ▀', lower: ' ▄' };

  function renderSlotStrip(page) {
    const strip = el('slotList');
    page.slots.forEach((slot, i) => {
      const chip = document.createElement('div');
      chip.className = 'slot-chip' + (i === selectedSlot ? ' active' : '');
      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'chip-main';
      const w = widgetsById.get(slot.widgetId);
      const name = document.createElement('span');
      name.textContent = w ? w.name : slot.widgetId;
      const size = document.createElement('span');
      size.className = 'chip-size';
      const parts = parseSize(slot.size);
      size.textContent = CHIP_WIDTH[parts.width] + CHIP_BAND[parts.band];
      main.append(name, size);
      main.addEventListener('click', () => selectSlot(i));
      chip.append(main, iconButton('✕', 'Remove', () => removeSlotAt(page, i), true));
      strip.appendChild(chip);
    });
  }

  function selectSlot(i) {
    selectedSlot = selectedSlot === i ? null : i; // click the active chip to deselect
    galleryOpen = false; // chip interaction takes the Widget tab over from the gallery
    renderEditorPanel();
    if (selectedSlot != null) openPanel('widget'); // chip select opens the inspector
    // Mirror into the replica (index -1 clears its highlight).
    replicaPost({ type: 'select-slot', page: selectedPage, index: selectedSlot == null ? -1 : selectedSlot });
  }

  function removeSlotAt(page, i) {
    page.slots.splice(i, 1);
    if (selectedSlot !== null) {
      if (selectedSlot === i) selectedSlot = null;
      else if (selectedSlot > i) selectedSlot--;
    }
    renderEditor();
  }

  function renderSlotDetail(page) {
    const host = el('slotDetail');
    const slot = selectedSlot !== null ? page.slots[selectedSlot] : null;
    if (!slot) {
      const hint = document.createElement('p');
      hint.className = 'panel-hint detail-hint';
      hint.textContent = page.slots.length
        ? 'Select a widget in the preview to configure it.'
        : 'This page is empty. Add widgets with “+ Add widget” or the + zone in the preview.';
      host.appendChild(hint);
      return;
    }
    host.appendChild(renderSlotCard(page, slot, selectedSlot));
  }

  function renderSlotCard(page, slot, index) {
    const card = document.createElement('div');
    card.className = 'slot-card';

    const row = document.createElement('div');
    row.className = 'slot-row';

    // widget picker
    const widgetSelect = document.createElement('select');
    widgetSelect.className = 'widget';
    for (const w of state.widgets) {
      const opt = new Option(w.name + '  (' + w.id + ')', w.id, false, w.id === slot.widgetId);
      widgetSelect.add(opt);
    }
    if (slot.widgetId && !widgetsById.has(slot.widgetId)) {
      widgetSelect.add(new Option(slot.widgetId + '  (not installed)', slot.widgetId, false, true));
    }
    widgetSelect.onchange = () => {
      slot.widgetId = widgetSelect.value;
      slot.settings = {};
      const w = widgetsById.get(slot.widgetId);
      const widths = offeredWidths(w);
      const current = parseSize(slot.size);
      if (!widths.includes(current.width))
        slot.size = widths[0] + (current.band === 'full' ? '' : '-' + current.band);
      renderEditor();
    };

    // size picker: every offered width, each at full height or just the top/bottom band
    const sizeSelect = document.createElement('select');
    sizeSelect.className = 'size';
    const widget = widgetsById.get(slot.widgetId);
    for (const width of offeredWidths(widget)) {
      for (const band of ['', '-upper', '-lower']) {
        const value = width + band;
        sizeSelect.add(new Option(sizeLabel(value), value, false, value === slot.size));
      }
    }
    if (![...sizeSelect.options].some((o) => o.selected))
      sizeSelect.add(new Option(sizeLabel(slot.size), slot.size, false, true));
    sizeSelect.onchange = () => { slot.size = sizeSelect.value; renderEditor(); };

    // Hide this widget while a fullscreen game runs (its grid cell is kept).
    const gameWrap = document.createElement('label');
    gameWrap.className = 'game-hide';
    gameWrap.title = 'Hide this widget while a fullscreen game is running';
    const gameCheck = document.createElement('input');
    gameCheck.type = 'checkbox';
    gameCheck.checked = slot.hideInGame === true;
    gameCheck.onchange = () => {
      if (gameCheck.checked) slot.hideInGame = true; else delete slot.hideInGame;
      refreshReplica('layout');
    };
    gameWrap.append(gameCheck, document.createTextNode('🎮✕'));

    row.append(widgetSelect, sizeSelect, gameWrap,
      iconButton('◀', 'Move earlier', () => moveSlot(page, index, -1)),
      iconButton('▶', 'Move later', () => moveSlot(page, index, 1)),
      iconButton('✕', 'Remove', () => removeSlotAt(page, index), true));
    card.appendChild(row);

    card.appendChild(renderSlotStyle(slot));

    // property editors, sectioned by group where the widget declares them
    if (widget && widget.properties && widget.properties.length) {
      const grid = document.createElement('div');
      grid.className = 'props';
      slot.settings = slot.settings || {};
      // Controls that need the full panel width; everything else packs two-up so
      // a widget's settings sit on screen instead of scrolling as a form.
      const WIDE_TYPES = new Set(['list', 'sensors-factory', 'location', 'media-selector']);
      let lastGroup = null;
      for (const prop of widget.properties) {
        if (prop.group && prop.group !== lastGroup) {
          lastGroup = prop.group;
          const heading = document.createElement('div');
          heading.className = 'group-title';
          heading.textContent = prop.group;
          grid.appendChild(heading);
        }
        const label = document.createElement('label');
        label.textContent = prop.label || prop.name;
        // One malformed property (e.g. an old host stripping manifest keys from the
        // projection) must not take the whole panel down with it.
        let editor;
        try {
          editor = propEditor(prop, slot);
        } catch (e) {
          editor = document.createElement('span');
          editor.className = 'prop-error';
          editor.textContent = (prop.label || prop.name || 'property') + ' — this control failed to render';
        }
        const field = document.createElement('div');
        field.className = 'prop-field' + (WIDE_TYPES.has(prop.type) ? ' wide' : '');
        field.append(label, editor);
        grid.appendChild(field);
      }
      card.appendChild(grid);
    }
    return card;
  }

  // Per-slot appearance overrides — THE appearance control for a widget (#42), the
  // same seeds the on-panel 🎨 editor writes into def.style: checked keys re-derive
  // this one widget's palette (contrast repair included); everything unchecked
  // keeps following the global theme (Theme tab).
  function renderSlotStyle(slot) {
    const wrap = document.createElement('div');
    wrap.className = 'slot-style';
    const title = document.createElement('div');
    title.className = 'section-title';
    title.textContent = 'Appearance — overrides the theme for this widget only';
    wrap.appendChild(title);

    const setStyleKey = (key, value) => {
      const s = slot.style || (slot.style = {});
      if (value == null) delete s[key]; else s[key] = value;
      if (!Object.keys(s).length) delete slot.style;
      refreshReplica('layout');
    };
    const cur = slot.style || {};
    const seeds = Object.assign({}, THEME_DEFAULTS, state.layout.theme || {});
    const hex6 = (v, fb) => (/^#[0-9a-f]{6}$/i.test(v || '') ? v : fb);

    for (const [key, labelText] of [['accent', 'Accent'], ['background', 'Background'], ['text', 'Text']]) {
      const row = document.createElement('div');
      row.className = 'style-row';
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = cur[key] != null;
      const label = document.createElement('label');
      label.textContent = labelText;
      const color = document.createElement('input');
      color.type = 'color';
      color.disabled = !check.checked;
      color.value = hex6(cur[key], hex6(seeds[key], '#4cc2ff'));
      check.onchange = () => {
        color.disabled = !check.checked;
        setStyleKey(key, check.checked ? color.value : null);
      };
      color.oninput = () => setStyleKey(key, color.value);
      row.append(check, label, color);
      wrap.appendChild(row);
    }

    const row = document.createElement('div');
    row.className = 'style-row';
    const check = document.createElement('input');
    check.type = 'checkbox';
    const label = document.createElement('label');
    label.textContent = 'Panel opacity';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = 15; range.max = 100; range.step = 1;
    const out = document.createElement('output');
    check.checked = cur.panelAlpha != null;
    range.disabled = !check.checked;
    range.value = String(Math.round((cur.panelAlpha != null ? cur.panelAlpha : seeds.panelAlpha) * 100));
    out.value = range.value + '%';
    check.onchange = () => {
      range.disabled = !check.checked;
      setStyleKey('panelAlpha', check.checked ? Number(range.value) / 100 : null);
    };
    range.oninput = () => {
      out.value = range.value + '%';
      setStyleKey('panelAlpha', Number(range.value) / 100);
    };
    row.append(check, label, range, out);
    wrap.appendChild(row);
    return wrap;
  }

  function moveSlot(page, index, delta) {
    const target = index + delta;
    if (target < 0 || target >= page.slots.length) return;
    const [slot] = page.slots.splice(index, 1);
    page.slots.splice(target, 0, slot);
    // ◀/▶ is an ORDER gesture: column pins on the swapped pair would override
    // the reorder (placement claims anchors before consulting order) and the
    // move would persist invisibly. Both pins dissolve — same rule as dropping
    // one tile onto another on the panel.
    delete slot.col;
    if (page.slots[index]) delete page.slots[index].col;
    if (selectedSlot === index) selectedSlot = target;       // selection follows its slot
    else if (selectedSlot === target) selectedSlot = index;  // ±1 swap displaced the neighbor
    renderEditor();
  }

  function iconButton(text, title, onClick, danger) {
    const btn = document.createElement('button');
    btn.className = 'icon ghost' + (danger ? ' danger' : '');
    btn.textContent = text;
    btn.title = title;
    btn.addEventListener('click', onClick);
    return btn;
  }

  // ---- field pickers (#48) ----------------------------------------------------
  // Manifest fields/properties can declare picker:'emoji' (icon fields) or
  // picker:'file' (path targets) — free-text stays available, the picker just
  // stops "type an emoji" and "type C:\...\app.exe" from being the ONLY way.

  const EMOJI_CHOICES = [
    '🧮', '🌐', '📁', '📷', '🎨', '📝', '📊', '💻', '🖥️', '⌨️', '🖱️', '🎧',
    '🎮', '🕹️', '🎬', '🎵', '📺', '📻', '🔊', '🔇', '⏯️', '⏭️', '⏮️', '⏹️',
    '🚀', '⚡', '🔥', '⭐', '❤️', '🏠', '🔧', '⚙️', '🔒', '🔑', '🛡️', '📦',
    '💬', '📧', '📅', '⏰', '🌙', '☀️', '☁️', '💡', '🔋', '📶', '🧭', '🗺️',
  ];

  // Leading emoji plus trailing whitespace — what a picker:'emoji-prefix' pick
  // swaps out so the text after the icon survives (launcher labels: "🎮 Steam"
  // → "🚀 Steam"). Covers regional-indicator flags (🇺🇸) and keycaps (1️⃣) as
  // well as pictographic VS16/skin-tone/ZWJ/tag sequences — mirror of the
  // launcher widget's own leading-icon matcher.
  const LEAD_EMOJI_RE = /^(?:[\u{1F1E6}-\u{1F1FF}]{2}|[0-9#*]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}\uFE0F?|\p{Emoji_Modifier}|[\u{E0020}-\u{E007F}])*)\s*/u;

  function closeEmojiPop() {
    const pop = document.querySelector('.emoji-pop');
    if (pop) pop.remove();
    document.removeEventListener('pointerdown', onEmojiOutside, true);
  }
  function onEmojiOutside(ev) {
    if (!ev.target.closest('.emoji-pop')) closeEmojiPop();
  }

  function makeEmojiBtn(input, prefix) {
    return iconButton('😀', 'Pick an icon', (ev) => {
      ev.stopPropagation();
      if (document.querySelector('.emoji-pop')) { closeEmojiPop(); return; }
      const pop = document.createElement('div');
      pop.className = 'emoji-pop';
      for (const e of EMOJI_CHOICES) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = e;
        b.addEventListener('click', () => {
          // prefix mode keeps the text and swaps only the leading icon.
          input.value = prefix ? (e + ' ' + input.value.replace(LEAD_EMOJI_RE, '')).trimEnd() : e;
          input.dispatchEvent(new Event('input')); // commits through the field's handler
          closeEmojiPop();
        });
        pop.appendChild(b);
      }
      document.body.appendChild(pop);
      const r = ev.currentTarget.getBoundingClientRect();
      pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
      pop.style.top = Math.min(r.bottom + 4, window.innerHeight - pop.offsetHeight - 8) + 'px';
      document.addEventListener('pointerdown', onEmojiOutside, true);
    });
  }

  let filePickSeq = 0;
  const pendingFilePicks = new Map(); // id -> input awaiting the host's dialog

  function makeFileBtn(input) {
    return iconButton('📂', 'Browse for a program or file', () => {
      const id = 'fp' + (++filePickSeq);
      pendingFilePicks.set(id, input);
      post({ type: 'pick-file', id });
    });
  }

  function attachFieldPicker(container, spec, input) {
    if (spec.picker === 'emoji' || spec.picker === 'emoji-prefix')
      container.appendChild(makeEmojiBtn(input, spec.picker === 'emoji-prefix'));
    else if (spec.picker === 'file') container.appendChild(makeFileBtn(input));
  }

  // Widths a widget can take: its declared supported widths, plus three-quarter for
  // anything fluid enough to declare half or full (all stock widgets are vh-fluid).
  function offeredWidths(widget) {
    const declared = (widget && widget.supportedSlots && widget.supportedSlots.length)
      ? widget.supportedSlots.map((s) => parseSize(s).width) : WIDTHS.slice();
    const set = new Set(declared);
    if (set.has('half') || set.has('full')) set.add('three-quarter');
    return WIDTHS.filter((w) => set.has(w));
  }

  function sizeLabel(size) {
    const { width, band } = parseSize(size);
    const name = { quarter: 'Quarter', half: 'Half', 'three-quarter': 'Three-quarter', full: 'Full' }[width];
    const px = WIDTH_PX[width];
    if (band === 'full') return name + ' (' + px + '×400)';
    return name + ' · ' + (band === 'upper' ? 'top' : 'bottom') + ' (' + px + '×200)';
  }

  // ---- property editors -------------------------------------------------------------

  function makeSensorSelect(currentId, sensorType, onChange) {
    const select = document.createElement('select');
    select.add(new Option('Auto / none', '', false, !currentId));
    const sensors = (state.sensors || []).filter((s) => !sensorType || s.type === sensorType);
    for (const s of sensors) {
      const text = s.device + ' — ' + s.name + (s.value != null ? '  (' + s.value + ' ' + s.units + ')' : '');
      select.add(new Option(text, s.id, false, s.id === currentId));
    }
    if (currentId && !sensors.some((s) => s.id === currentId)) {
      select.add(new Option(currentId + '  (missing)', currentId, false, true));
    }
    select.onchange = () => onChange(select.value);
    return select;
  }

  /** Segmented button group for short static option lists: every choice visible,
   * the current one lit. Option entries are strings or {value, label}. */
  function segmented(options, current, commit) {
    const seg = document.createElement('div');
    seg.className = 'seg';
    seg.setAttribute('role', 'group');
    const valueOf = (o) => String((o && typeof o === 'object') ? o.value : o);
    const textOf = (o) => (o && typeof o === 'object') ? (o.label || o.value) : o;
    const light = (chosen) => {
      for (const b of seg.querySelectorAll('button')) b.classList.toggle('active', b.dataset.v === chosen);
    };
    for (const o of options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg-btn';
      b.dataset.v = valueOf(o);
      b.textContent = textOf(o);
      b.addEventListener('click', () => { commit(valueOf(o)); light(valueOf(o)); });
      seg.appendChild(b);
    }
    light(current != null ? String(current) : '');
    return seg;
  }

  function propEditor(prop, slot) {
    const current = slot.settings[prop.name] !== undefined ? slot.settings[prop.name] : prop.default;
    const set = (value) => { slot.settings[prop.name] = value; refreshReplica('layout'); };

    switch (prop.type) {
      case 'switch': { // iCUE boolean toggle — rendered as a real switch, not a form checkbox
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'toggle-check';
        input.checked = current === true || current === 'true';
        input.onchange = () => set(input.checked);
        return input;
      }
      case 'sensors-factory': { // iCUE "add sensors" list: [{sensorId, color}]
        const wrap = document.createElement('div');
        wrap.className = 'factory';
        const items = Array.isArray(current)
          ? current.filter((x) => x && typeof x === 'object')
              .map((x) => ({ sensorId: x.sensorId || '', color: x.color || '#76b900' }))
          : [];
        const commit = () => set(items.map((x) => ({ sensorId: x.sensorId, color: x.color })));
        const renderList = () => {
          wrap.textContent = '';
          items.forEach((item, i) => {
            const row = document.createElement('div');
            row.className = 'factory-row';
            const sensor = makeSensorSelect(item.sensorId, prop.sensor_type, (v) => { item.sensorId = v; commit(); });
            const color = document.createElement('input');
            color.type = 'color';
            color.value = /^#[0-9a-f]{6}$/i.test(item.color) ? item.color : '#76b900';
            color.oninput = () => { item.color = color.value; commit(); };
            row.append(sensor, color,
              iconButton('✕', 'Remove sensor', () => { items.splice(i, 1); commit(); renderList(); }, true));
            wrap.appendChild(row);
          });
          const add = document.createElement('button');
          add.className = 'ghost';
          add.textContent = '+ Add sensor';
          add.addEventListener('click', () => {
            // Seed from the sensors this property actually accepts — the first
            // sensor overall is usually a temperature, and a Fan-typed picker
            // preselecting it reads as "selected fans not found" (Codex, #38).
            const pool = (state.sensors || []).filter((s) => !prop.sensor_type || s.type === prop.sensor_type);
            items.push({ sensorId: (pool[0] || {}).id || '', color: '#76b900' });
            commit();
            renderList();
          });
          wrap.appendChild(add);
        };
        renderList();
        return wrap;
      }
      case 'media-selector': { // iCUE background image/video picker — not supported yet
        const note = document.createElement('span');
        note.className = 'muted';
        note.textContent = 'Background media is not supported yet.';
        return note;
      }
      case 'location': { // city search: disambiguates duplicate place names (Lewisville TX vs NC…)
        const wrap = document.createElement('div');
        wrap.className = 'location-picker';

        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'Search city…';
        const results = document.createElement('select');
        results.hidden = true;
        const chosen = document.createElement('span');
        chosen.className = 'muted';

        let value = current;
        let found = [];
        let searchTimer = null;

        const describe = () => {
          if (value && typeof value === 'object' && value.label) chosen.textContent = 'Selected: ' + value.label;
          else if (typeof value === 'string' && value.trim()) chosen.textContent = 'Will use the best match for "' + value.trim() + '" — pick from the list to be exact.';
          else chosen.textContent = 'Type a city name and pick a match.';
        };
        input.value = value && typeof value === 'object' ? (value.label || '') : (typeof value === 'string' ? value : '');
        describe();

        input.addEventListener('input', () => {
          clearTimeout(searchTimer);
          const query = input.value.trim();
          value = query;         // fallback: raw string, widget resolves best match
          set(value);
          describe();
          if (query.length < 2) { results.hidden = true; return; }
          searchTimer = setTimeout(async () => {
            try {
              const response = await fetch(
                'https://geocoding-api.open-meteo.com/v1/search?count=8&language=en&format=json&name=' +
                encodeURIComponent(query));
              const data = await response.json();
              found = data.results || [];
              results.textContent = '';
              results.add(new Option(found.length ? 'Pick a match…' : 'No matches found', ''));
              found.forEach((hit, i) => {
                const label = [hit.name, hit.admin1, hit.country].filter(Boolean).join(', ');
                const pop = hit.population ? '  ·  pop ' + hit.population.toLocaleString() : '';
                results.add(new Option(label + pop, String(i)));
              });
              results.hidden = false;
            } catch (e) {
              chosen.textContent = 'Search unavailable (offline?) — the typed name will be matched at runtime.';
            }
          }, 400);
        });

        results.addEventListener('change', () => {
          const hit = found[Number(results.value)];
          if (!hit) return;
          const label = [hit.name, hit.admin1, hit.country].filter(Boolean).join(', ');
          value = { label, latitude: hit.latitude, longitude: hit.longitude };
          set(value);
          input.value = label;
          results.hidden = true;
          describe();
        });

        wrap.append(input, results, chosen);
        return wrap;
      }
      case 'color': {
        // Widgets only let a color setting override the theme tokens when it differs
        // from its manifest default — but a native color input can never be cleared,
        // so once touched a color was pinned forever (#29). The row now says which
        // side it's on and offers the way back.
        const wrap = document.createElement('div');
        wrap.className = 'color-wrap';
        const input = document.createElement('input');
        input.type = 'color';
        const def = typeof prop.default === 'string' && /^#[0-9a-f]{6}$/i.test(prop.default) ? prop.default : '#00d4ff';
        input.value = typeof current === 'string' && /^#[0-9a-f]{6}$/i.test(current) ? current : def;
        const state = document.createElement('span');
        state.className = 'color-state';
        const reset = document.createElement('button');
        reset.type = 'button';
        reset.className = 'color-reset';
        reset.textContent = 'Use theme';
        reset.title = 'Clear this override and follow the theme';
        const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
        const sync = () => {
          const overridden = slot.settings[prop.name] !== undefined && norm(slot.settings[prop.name]) !== norm(prop.default);
          state.textContent = overridden ? 'custom' : 'themed';
          state.classList.toggle('overridden', overridden);
          reset.hidden = !overridden;
        };
        input.oninput = () => { set(input.value); sync(); };
        reset.onclick = () => {
          delete slot.settings[prop.name]; // absent = default = the theme shows through
          input.value = def;
          refreshReplica('layout');
          sync();
        };
        sync();
        wrap.append(input, state, reset);
        return wrap;
      }
      case 'slider': {
        const wrap = document.createElement('div');
        wrap.className = 'slider-wrap';
        const input = document.createElement('input');
        input.type = 'range';
        input.min = prop.min != null ? prop.min : 0;
        input.max = prop.max != null ? prop.max : 100;
        input.step = prop.step != null ? prop.step : 1;
        input.value = current != null ? current : input.min;
        const out = document.createElement('output');
        out.value = String(input.value);
        input.oninput = () => { out.value = String(input.value); set(parseFloat(input.value)); };
        wrap.append(input, out);
        return wrap;
      }
      case 'number': {
        const input = document.createElement('input');
        input.type = 'number';
        if (prop.min != null) input.min = prop.min;
        if (prop.max != null) input.max = prop.max;
        // Without a declared step the HTML default of 1 would fail validity on
        // fractional values the manifest never prohibited (e.g. 1.5).
        input.step = prop.step != null ? prop.step : 'any';
        input.value = current != null ? current : '';
        input.oninput = () => {
          // Constraint validation doesn't block input events: without the
          // validity check an out-of-range value (dwell=1 against min 4) would
          // commit and reach widgets that don't defensively clamp.
          const parsed = parseFloat(input.value);
          if (!Number.isNaN(parsed) && input.validity.valid) set(parsed);
        };
        return input;
      }
      case 'select': {
        // Static short option lists render as segmented BUTTONS — every choice on
        // screen at once, current one lit — instead of a closed dropdown (field
        // report: settings should be visible, not a wall of form controls).
        // Dynamic lists (host-backed profiles, sensors) keep the dropdown.
        const staticOpts = prop.options || [];
        if (!prop.optionsSource && staticOpts.length >= 2 && staticOpts.length <= 5) {
          return segmented(staticOpts, current, set);
        }
        const select = document.createElement('select');
        for (const option of prop.options || []) {
          select.add(new Option(option, option, false, option === current));
        }
        if (prop.optionsSource === 'sd-profiles') {
          // Options come from the host (discovered Virtual Stream Deck profiles) —
          // the user picks from a list instead of typing a profile name.
          select.add(new Option('First available (default)', '', false, !current));
          if (current) select.add(new Option(current, current, false, true));
          sdProfileWaiters.push((profiles) => {
            if (!select.isConnected) return;
            const chosen = select.value;
            select.textContent = '';
            select.add(new Option('First available (default)', '', false, !chosen));
            for (const name of profiles) {
              select.add(new Option(name, name, false, name === chosen));
            }
            if (chosen && !profiles.includes(chosen)) {
              select.add(new Option(chosen + '  (not found right now)', chosen, false, true));
            }
          });
          post({ type: 'sd-profiles' });
        }
        select.onchange = () => set(select.value);
        return select;
      }
      case 'list': { // structured rows — the user never types a delimited string
        // A projection without `fields` (old hosts stripped them from the manifest on
        // the way here) cannot back a structured editor: guessed keys would corrupt
        // the stored value. Fall back to the legacy single text input instead.
        if (!Array.isArray(prop.fields) || !prop.fields.length) {
          const input = document.createElement('input');
          input.type = 'text';
          if (prop.placeholder) input.placeholder = String(prop.placeholder);
          input.value = Array.isArray(current)
            ? current.map((x) => (x && typeof x === 'object') ? Object.values(x).join('=') : String(x)).join(', ')
            : (current != null ? String(current) : '');
          input.oninput = () => set(input.value);
          return input;
        }
        const wrap = document.createElement('div');
        wrap.className = 'factory list-editor';
        const fields = prop.fields;

        // Accept the stored array; migrate a legacy JSON-ARRAY string (the old
        // Control Deck stored its buttons that way — splitting it as "A=B" pairs
        // rendered JSON fragments as rows and the first edit wrote them back,
        // corrupting the config); or convert a legacy "A=B, C=D" delimited string
        // into rows mapped onto the first two fields. Extra keys on parsed
        // objects (e.g. the old deck's `kind`) ride along untouched — widgets
        // that honor them keep working.
        let items;
        let legacyJson = null;
        if (typeof current === 'string' && current.trim().startsWith('[')) {
          try { legacyJson = JSON.parse(current); } catch (e) { legacyJson = null; }
          if (!Array.isArray(legacyJson)) legacyJson = null;
        }
        if (Array.isArray(current) || legacyJson) {
          items = (legacyJson || current).filter((x) => x && typeof x === 'object').map((x) => Object.assign({}, x));
        } else if (typeof current === 'string' && current.trim()) {
          items = current.split(',').map((pair) => {
            const eq = pair.indexOf('=');
            const item = {};
            item[fields[0].key] = (eq < 0 ? pair : pair.slice(0, eq)).trim();
            if (fields[1]) item[fields[1].key] = eq < 0 ? '' : pair.slice(eq + 1).trim();
            return item;
          }).filter((x) => Object.values(x).some((v) => v));
        } else {
          items = [];
        }

        const commit = () => set(items.map((x) => Object.assign({}, x)));
        // A legacy string value renders as rows immediately, but only writes back as an
        // array once the user touches the editor — untouched layouts stay byte-identical.
        const renderList = () => {
          wrap.textContent = '';
          items.forEach((item, i) => {
            const row = document.createElement('div');
            row.className = 'factory-row';
            for (const field of fields) {
              const input = document.createElement('input');
              if (field.type === 'color') {
                input.type = 'color';
                input.value = /^#[0-9a-f]{6}$/i.test(item[field.key]) ? item[field.key] : '#4cc2ff';
              } else {
                input.type = 'text';
                input.placeholder = field.placeholder || field.label || '';
                input.value = item[field.key] != null ? String(item[field.key]) : '';
              }
              input.setAttribute('aria-label', field.label || field.key);
              input.oninput = () => { item[field.key] = input.value; commit(); };
              row.appendChild(input);
              attachFieldPicker(row, field, input); // picker:'emoji' / picker:'file' (#48)
            }
            row.appendChild(iconButton('✕', 'Remove ' + (prop.itemLabel || 'item'), () => {
              items.splice(i, 1); commit(); renderList();
            }, true));
            wrap.appendChild(row);
          });
          // A declared maxItems caps the editor too — rows the widget will never
          // render must not be addable (they'd look configured and do nothing).
          const cap = Math.max(0, Math.round(Number(prop.maxItems) || 0));
          if (cap && items.length >= cap) {
            const full = document.createElement('p');
            full.className = 'panel-hint';
            full.textContent = 'Limit reached — this widget shows at most ' + cap + ' ' +
              (prop.itemLabel || 'item') + 's.';
            wrap.appendChild(full);
          } else {
            const add = document.createElement('button');
            add.className = 'ghost';
            add.textContent = '+ Add ' + (prop.itemLabel || 'item');
            add.addEventListener('click', () => {
              const item = {};
              for (const field of fields) item[field.key] = field.type === 'color' ? '#4cc2ff' : '';
              items.push(item);
              commit();
              renderList();
              const first = wrap.querySelector('.factory-row:last-of-type input');
              if (first) first.focus();
            });
            wrap.appendChild(add);
          }
        };
        renderList();
        return wrap;
      }
      case 'sensor': {
        const select = document.createElement('select');
        select.add(new Option('Auto (recommended)', '', false, !current));
        const sensors = (state.sensors || []).filter((s) =>
          !prop.sensor_type || s.type === prop.sensor_type);
        for (const s of sensors) {
          const text = s.device + ' — ' + s.name + (s.value != null ? '  (' + s.value + ' ' + s.units + ')' : '');
          select.add(new Option(text, s.id, false, s.id === current));
        }
        if (current && !sensors.some((s) => s.id === current)) {
          select.add(new Option(current + '  (missing)', current, false, true));
        }
        select.onchange = () => set(select.value);
        return select;
      }
      default: { // text
        const input = document.createElement('input');
        input.type = 'text';
        // The sanctioned place to teach an expected format — labels must not.
        if (prop.placeholder) input.placeholder = String(prop.placeholder);
        input.value = current != null ? String(current) : '';
        input.oninput = () => set(input.value);
        if (prop.picker) {
          // picker:'emoji' / picker:'file' on a top-level text property (#48).
          const wrap = document.createElement('div');
          wrap.className = 'picker-wrap';
          wrap.appendChild(input);
          attachFieldPicker(wrap, prop, input);
          return wrap;
        }
        return input;
      }
    }
  }

  // ---- background editor ---------------------------------------------------------------

  // Renders a compact wallpaper editor into `container`. getSpec()/setSpec(spec|null)
  // read and write the target background (a page's or the dashboard's). setSpec(null)
  // clears it; for a page that means "inherit the dashboard background".
  function renderBackgroundEditor(container, getSpec, setSpec, opts) {
    opts = opts || {};
    container.textContent = '';
    const spec = getSpec();
    const type = spec ? (spec.type || 'none') : (opts.allowInherit ? 'inherit' : 'none');

    const choices = [];
    if (opts.allowInherit) choices.push(['inherit', 'Use dashboard default']);
    choices.push(['none', 'None'], ['color', 'Solid color'], ['gradient', 'Gradient'],
      ['image', 'Image'], ['video', 'Video (animated)']);

    const typeSel = document.createElement('select');
    for (const [value, label] of choices) typeSel.add(new Option(label, value, false, value === type));
    typeSel.onchange = () => {
      const v = typeSel.value;
      if (v === 'inherit') setSpec(null);
      else if (v === 'none') setSpec({ type: 'none' });
      else {
        // Merge from the LIVE spec (getSpec), not the render-time snapshot, so a color/
        // slider edit made just before switching type isn't discarded.
        const next = Object.assign({ type: 'none', fit: 'cover', angle: 135, dim: 0, blur: 0 }, getSpec() || {}, { type: v });
        if (v === 'color' || v === 'gradient') { next.dim = 0; next.blur = 0; } // flat fills aren't dimmed/blurred
        setSpec(next);
      }
      renderBackgroundEditor(container, getSpec, setSpec, opts);
    };
    container.appendChild(bgRow('Type', typeSel));

    if (type === 'inherit' || type === 'none') return;

    const patch = (p) => setSpec(Object.assign({}, getSpec(), p));
    const cur = getSpec() || {};

    if (type === 'color') {
      container.appendChild(bgColor('Color', cur.color || '#101418', (v) => patch({ color: v })));
    } else if (type === 'gradient') {
      container.appendChild(bgColor('Color 1', cur.color || '#101418', (v) => patch({ color: v })));
      container.appendChild(bgColor('Color 2', cur.color2 || '#0b0e14', (v) => patch({ color2: v })));
      container.appendChild(bgSlider('Angle', cur.angle != null ? cur.angle : 135, 0, 360, 5, '°', (v) => patch({ angle: v })));
    } else if (type === 'image' || type === 'video') {
      container.appendChild(bgFile(container, getSpec, setSpec, opts, type));
      container.appendChild(bgFitField(cur.fit || 'cover', (v) => patch({ fit: v })));
      container.appendChild(bgSlider('Dim', cur.dim || 0, 0, 100, 5, '%', (v) => patch({ dim: v })));
      container.appendChild(bgSlider('Blur', cur.blur || 0, 0, 40, 1, 'px', (v) => patch({ blur: v })));
    }
  }

  function bgRow(labelText, control) {
    const row = document.createElement('div');
    row.className = 'bg-row';
    const label = document.createElement('label');
    label.textContent = labelText;
    row.append(label, control);
    return row;
  }

  // <input type=color> only accepts #rrggbb; normalize any valid CSS hex to it so a
  // hand-authored #fff or #112233ff shows the real color instead of the theme default.
  function toHex6(value) {
    if (typeof value !== 'string') return '#101418';
    const m = value.trim().match(/^#([0-9a-fA-F]{3,8})$/);
    if (!m) return '#101418';
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; // expand, drop alpha
    else if (h.length === 6 || h.length === 8) h = h.slice(0, 6);                      // drop alpha
    else return '#101418';                                                             // 5/7 digits: invalid
    return '#' + h.toLowerCase();
  }

  function bgColor(labelText, value, onChange) {
    const input = document.createElement('input');
    input.type = 'color';
    input.value = toHex6(value);
    input.oninput = () => onChange(input.value);
    return bgRow(labelText, input);
  }

  function bgSlider(labelText, value, min, max, step, unit, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'slider-wrap';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min; input.max = max; input.step = step;
    input.value = value;
    const out = document.createElement('output');
    out.value = value + (unit || '');
    input.oninput = () => { out.value = input.value + (unit || ''); onChange(parseFloat(input.value)); };
    wrap.append(input, out);
    return bgRow(labelText, wrap);
  }

  function bgFitField(value, onChange) {
    const select = document.createElement('select');
    for (const [v, label] of [['cover', 'Cover'], ['contain', 'Contain'], ['stretch', 'Stretch'],
      ['tile', 'Tile'], ['center', 'Center']]) {
      select.add(new Option(label, v, false, v === value));
    }
    select.onchange = () => onChange(select.value);
    return bgRow('Fit', select);
  }

  function bgFile(container, getSpec, setSpec, opts, type) {
    const wrap = document.createElement('div');
    wrap.className = 'bg-file';

    const spec = getSpec() || {};
    if (spec.source) {
      const url = 'https://' + backgroundHost + '/' + encodeURIComponent(spec.source);
      const preview = type === 'video' ? document.createElement('video') : document.createElement('img');
      preview.className = 'bg-preview';
      preview.src = url;
      if (type === 'video') { preview.muted = true; preview.loop = true; preview.autoplay = true; preview.setAttribute('playsinline', ''); }
      preview.onerror = () => { preview.classList.add('broken'); };
      wrap.appendChild(preview);
    }

    const btn = document.createElement('button');
    btn.className = 'ghost';
    btn.textContent = spec.source ? 'Change file…' : 'Choose file…';
    btn.onclick = () => {
      pendingBgPick = (source, kind) => {
        // If the chosen file's kind differs from the control (image vs video), follow it.
        const nextType = kind === 'video' ? 'video' : 'image';
        setSpec(Object.assign({ fit: 'cover', angle: 135, dim: 0, blur: 0 }, getSpec() || {}, { type: nextType, source }));
        renderBackgroundEditor(container, getSpec, setSpec, opts);
      };
      post({ type: 'pick-background', target: opts.allowInherit ? ('page:' + selectedPage) : 'global' });
    };
    wrap.appendChild(btn);

    const name = document.createElement('span');
    name.className = 'bg-filename muted';
    name.textContent = spec.source || 'No file chosen';
    wrap.appendChild(name);

    return bgRow(type === 'video' ? 'Video' : 'Image', wrap);
  }

  // ---- toast ---------------------------------------------------------------------------

  function toast(message, isError) {
    const node = el('toast');
    node.textContent = message;
    node.classList.toggle('error', !!isError);
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 3200);
  }

  // ---- go -------------------------------------------------------------------------------

  post({ type: 'settings-ready' });
})();
