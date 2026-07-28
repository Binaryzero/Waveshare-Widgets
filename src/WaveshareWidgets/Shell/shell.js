// Dashboard shell: receives host messages over the WebView2 bridge, lays out the
// configured pages/slots as per-widget iframes, and relays sensor/media data to them.
(function () {
  'use strict';

  const pagesEl = document.getElementById('pages');
  const dotsEl = document.getElementById('dots');
  const emptyEl = document.getElementById('empty');

  /** @type {{frame: HTMLIFrameElement, el: HTMLElement, settings: object, initialized: boolean, retries: number}[]} */
  let slots = [];
  let latestSensors = [];
  let latestMedia = null;
  let latestTheme = null;
  let latestNotifications = null;   // last projected payload from the host
  let gameState = { active: false, process: '' };
  let status = { elevated: false, apiVersion: 1 };
  let dotsIdleTimer = null;
  let bgSettleTimer = null;    // debounces the wallpaper swap during multi-page scrolls
  let generation = 0;          // invalidates watchdogs from a previous layout
  const fetchRoutes = new Map(); // proxy-fetch id -> widget iframe window
  const pingRoutes = new Map();  // ping id -> widget iframe window
  const mediaRoutes = new Map(); // media-list id -> widget iframe window
  const audioRoutes = new Map(); // audio-get id -> widget iframe window

  let backgroundHost = 'backgrounds.wsw';
  let bgGlobal = null;         // dashboard-wide background spec
  let bgPages = [];            // per-page background specs (null = inherit global)
  const bg = createBackgroundController();

  // Live layout model (mutated by the on-panel editor, persisted via save-layout).
  let layoutData = { pages: [] };
  let widgetLib = [];
  let widgetsById = new Map();
  const pageEls = new Map();   // page object -> its <section class="page">
  let slotUid = 0;
  let editing = false;

  // ---- host bridge -----------------------------------------------------------

  // Preview mode: the shell is embedded as a live replica inside the settings window
  // (index.html?preview). The "host" is then the settings page, bridged over
  // window.postMessage — ww-shell wraps outgoing messages, ww-host wraps incoming.
  const PREVIEW = new URLSearchParams(location.search).has('preview');
  let previewPage = null; // page the settings window wants the replica to show
  let previewGen = 0;     // init generation this document state was built under;
                          // echoed on every persist so the settings window can drop
                          // captures that raced a newer init (posting is async)

  if (!PREVIEW && window.chrome && window.chrome.webview) {
    window.chrome.webview.addEventListener('message', (ev) => handleHostMessage(ev.data || {}));
  }

  function handleHostMessage(msg) {
    if (msg.type === 'init') onInit(msg.data);
    else if (msg.type === 'theme') {
      // Live retheme (settings replica): refresh the seeds first so styled slots
      // re-derive against the EDITED theme, then push per slot — a slot carrying
      // style overrides keeps its own palette instead of being flattened to the
      // global map.
      if ('seeds' in msg) layoutData.theme = msg.seeds || undefined;
      applyThemeTokens(msg.data);
      for (const slot of slots) {
        if (slot.initialized) sendToSlot(slot, { type: 'ww-theme', theme: slotTheme(slot) });
      }
    }
    else if (msg.type === 'page') {
      // Replica steering: the preview is pointer-events:none, so the settings window
      // drives which page is visible (its selected page).
      if (PREVIEW) { previewPage = msg.index | 0; goToPage(previewPage); }
    }
    else if (msg.type === 'edit-mode') {
      // WYSIWYG settings (#32): the embedding settings window drives the replica's
      // edit mode so the preview becomes the primary editing surface. Explicit
      // opt-in and PREVIEW-gated — a real panel never receives this message, and a
      // host that never sends it keeps the old view-only replica.
      if (PREVIEW) setEditing(!!msg.on);
    }
    else if (msg.type === 'select-slot') {
      // Settings-side selection (its slot list / a re-init restore) mirrored into
      // the replica's highlight. Never announced back — the host already knows.
      if (PREVIEW && editing) selectSlotAt(msg.page | 0, msg.index | 0, false);
    }
    else if (msg.type === 'open-palette') {
      // Settings "+ Add widget" fallback: open the shell's own add-widget palette.
      if (PREVIEW && editing && layoutData.pages.length) {
        const p = layoutData.pages[Math.max(0, Math.min(layoutData.pages.length - 1, msg.index | 0))];
        if (p) openPalette(p);
      }
    }
    else if (msg.type === 'sensors') { latestSensors = msg.data || []; broadcast({ type: 'ww-sensors', sensors: latestSensors }); }
    else if (msg.type === 'media') { latestMedia = msg.data; broadcast({ type: 'ww-media', media: latestMedia }); }
    else if (msg.type === 'notifications') { latestNotifications = msg.data || null; broadcast({ type: 'ww-notifications', data: latestNotifications }); }
    else if (msg.type === 'game-mode') {
      gameState = { active: !!(msg.data && msg.data.active), process: (msg.data && msg.data.process) || '' };
      applyGameMode();
      broadcast({ type: 'ww-game', game: gameState });
    }
    else if (msg.type === 'fetch-result') {
      const target = fetchRoutes.get(msg.data && msg.data.id);
      if (target) {
        fetchRoutes.delete(msg.data.id);
        try { target.postMessage({ type: 'ww-fetch-result', ...msg.data }, '*'); } catch (e) { /* frame gone */ }
      }
    } else if (msg.type === 'sd-profiles-result') {
      // Discovered VSD profile list for the settings sheet's host-backed selects.
      const waiters = psProfileWaiters.splice(0);
      const profiles = ((msg.data && msg.data.profiles) || []).filter((p) => typeof p === 'string');
      waiters.forEach((cb) => { try { cb(profiles); } catch (e) { /* row rebuilt */ } });
    } else if (msg.type === 'sd-profile-result') {
      broadcast({ type: 'ww-sd-profile', profile: msg.data });
    } else if (msg.type === 'sd-capture-result') {
      broadcast({ type: 'ww-sd-capture-result', data: msg.data });
    } else if (msg.type === 'ping-result') {
      const target = pingRoutes.get(msg.data && msg.data.id);
      if (target) {
        pingRoutes.delete(msg.data.id);
        try { target.postMessage({ type: 'ww-ping-result', ...msg.data }, '*'); } catch (e) { /* frame gone */ }
      }
    } else if (msg.type === 'media-list-result') {
      const target = mediaRoutes.get(msg.data && msg.data.id);
      if (target) {
        mediaRoutes.delete(msg.data.id);
        try { target.postMessage({ type: 'ww-media-list-result', ...msg.data }, '*'); } catch (e) { /* frame gone */ }
      }
    } else if (msg.type === 'audio-result') {
      const target = audioRoutes.get(msg.data && msg.data.id);
      if (target) {
        audioRoutes.delete(msg.data.id);
        try { target.postMessage({ type: 'ww-audio-result', ...msg.data }, '*'); } catch (e) { /* frame gone */ }
      }
    }
  }

  function postToHost(message) {
    if (PREVIEW) {
      try { window.parent.postMessage({ type: 'ww-shell', message }, '*'); } catch (e) { /* parent gone */ }
      return;
    }
    window.chrome.webview.postMessage(message);
  }

  // ---- widget iframe bridge ---------------------------------------------------

  window.addEventListener('message', (ev) => {
    const msg = ev.data || {};
    if (PREVIEW && msg.type === 'ww-host' && ev.source === window.parent) {
      handleHostMessage(msg.message || {});
      return;
    }
    if (msg.type === 'ww-media-control' && typeof msg.action === 'string') {
      postToHost({ type: 'media-control', action: msg.action });
    } else if (msg.type === 'ww-log') {
      postToHost({ type: 'log', message: String(msg.message).slice(0, 2000) });
    } else if (msg.type === 'ww-ready') {
      const slot = slots.find((s) => s.frame && s.frame.contentWindow === ev.source);
      if (slot) {
        // Always answer, even for an already-initialized slot: the iframe may have
        // crashed and reloaded (common under cold-start resource pressure), and the
        // fresh document would otherwise run on its built-in defaults forever.
        slot.initialized = true;
        const stale = slot.el.querySelector('.error');
        if (stale) stale.remove();
        sendToSlot(slot, initMessage(slot));
      }
    } else if (msg.type === 'ww-open-url' && typeof msg.url === 'string') {
      postToHost({ type: 'open-url', url: msg.url });
    } else if (msg.type === 'ww-action' && typeof msg.kind === 'string') {
      postToHost({ type: 'action', kind: msg.kind, target: String(msg.target || '') });
    } else if (msg.type === 'ww-sd-profile') {
      postToHost({ type: 'sd-profile', profileName: msg.profileName || '', hideWindow: msg.hideWindow !== false, live: msg.live === true });
    } else if (msg.type === 'ww-sd-capture') {
      postToHost({ type: 'sd-capture' });
    } else if (msg.type === 'ww-sd-click') {
      postToHost({ type: 'sd-click', row: msg.row | 0, col: msg.col | 0, rows: msg.rows | 0, cols: msg.cols | 0 });
    } else if (msg.type === 'ww-fetch' && msg.id) {
      fetchRoutes.set(msg.id, ev.source);
      setTimeout(() => fetchRoutes.delete(msg.id), 30000);
      postToHost({ type: 'fetch', id: msg.id, url: msg.url, method: msg.method, body: msg.body, contentType: msg.contentType, headers: msg.headers, insecure: msg.insecure === true });
    } else if (msg.type === 'ww-ping' && msg.id) {
      pingRoutes.set(msg.id, ev.source);
      setTimeout(() => pingRoutes.delete(msg.id), 15000);
      postToHost({ type: 'ping', id: msg.id, hosts: Array.isArray(msg.hosts) ? msg.hosts.slice(0, 16) : [] });
    } else if (msg.type === 'ww-media-list' && msg.id) {
      mediaRoutes.set(msg.id, ev.source);
      setTimeout(() => mediaRoutes.delete(msg.id), 15000);
      postToHost({ type: 'media-list', id: msg.id });
    } else if (msg.type === 'ww-audio-get' && msg.id) {
      audioRoutes.set(msg.id, ev.source);
      setTimeout(() => audioRoutes.delete(msg.id), 15000);
      postToHost({ type: 'audio-get', id: msg.id });
    } else if (msg.type === 'ww-notifications-watch') {
      // Demand is tracked per slot and only on/off TRANSITIONS reach the host —
      // otherwise nothing would ever send watch(false) when the last watching
      // widget is removed, and the host would poll notifications forever.
      const slot = slots.find((s) => s.frame && s.frame.contentWindow === ev.source);
      if (slot) slot.notifWatch = msg.on !== false;
      syncNotificationDemand();
    } else if (msg.type === 'ww-notification-dismiss' && msg.id != null) {
      postToHost({ type: 'notification-dismiss', id: msg.id });
    } else if (msg.type === 'ww-audio-set') {
      if (msg.id) {
        audioRoutes.set(msg.id, ev.source);
        setTimeout(() => audioRoutes.delete(msg.id), 15000);
      }
      postToHost({ type: 'audio-set', id: msg.id, target: String(msg.target || 'master'), level: msg.level, muted: msg.muted });
    }
  });

  function initMessage(slot) {
    return {
      type: 'ww-init',
      settings: slot.settings,
      sensors: latestSensors,
      media: latestMedia,
      theme: slotTheme(slot),
      notifications: latestNotifications,
      game: gameState,
      status,
    };
  }

  // Notification polling is demand-gated in the host; recomputed from the live slot
  // records after anything that adds or removes them, so removing the last watching
  // widget (edit-mode ✕, page delete, re-init) actually stops the host's polling.
  let notifWatchOn = false; // last demand posted to the host
  function syncNotificationDemand() {
    const on = slots.some((s) => s.notifWatch);
    if (on === notifWatchOn) return;
    notifWatchOn = on;
    postToHost({ type: 'notifications-watch', on });
  }

  // Game mode: pause the shell's own chrome cost and hide slots the user marked
  // hide-in-game (their grid cell is kept, so they come back exactly where they were).
  function applyGameMode() {
    document.documentElement.dataset.game = gameState.active ? 'on' : 'off';
    for (const slot of slots) {
      if (slot.def && slot.def.hideInGame)
        slot.el.style.visibility = (gameState.active && !editing) ? 'hidden' : '';
    }
  }

  function sendToSlot(slot, message) {
    if (!slot.frame) return; // not-installed placeholder
    try {
      slot.frame.contentWindow.postMessage(message, '*');
    } catch (e) { /* frame may be reloading */ }
  }

  function broadcast(message) {
    for (const slot of slots) {
      if (slot.initialized) sendToSlot(slot, message);
    }
  }

  // ---- layout rendering --------------------------------------------------------

  // Size tokens: a width (quarter | half | three-quarter | full) with an optional
  // "-upper" / "-lower" suffix selecting the top or bottom half of the page.
  function parseSize(token) {
    let t = String(token || 'quarter').toLowerCase();
    let band = 'full';
    if (t.endsWith('-upper')) { band = 'upper'; t = t.slice(0, -6); }
    else if (t.endsWith('-lower')) { band = 'lower'; t = t.slice(0, -6); }
    const widths = { quarter: 1, half: 2, 'three-quarter': 3, threequarter: 3, full: 4 };
    return { w: widths[t] || 1, band };
  }

  // First-fit placement on the page's 4x2 cell grid, in slot order (left to right,
  // full-height and upper slots in the top row first, lower slots in the bottom).
  // Returns per-slot {col, w, band} or null when the page is already full.
  function placeSlots(slotDefs) {
    const occupied = [new Array(4).fill(false), new Array(4).fill(false)]; // [row][col]
    return slotDefs.map((def) => {
      const { w, band } = parseSize(def.size);
      const rows = band === 'full' ? [0, 1] : band === 'upper' ? [0] : [1];
      for (let col = 0; col + w <= 4; col++) {
        let fits = true;
        for (const r of rows) for (let i = 0; i < w && fits; i++) if (occupied[r][col + i]) fits = false;
        if (!fits) continue;
        for (const r of rows) for (let i = 0; i < w; i++) occupied[r][col + i] = true;
        return { col, w, band };
      }
      return null;
    });
  }

  function applyThemeTokens(tokens) {
    if (!tokens || typeof tokens !== 'object') return;
    latestTheme = tokens;
    for (const [name, value] of Object.entries(tokens)) {
      if (name.startsWith('--')) document.documentElement.style.setProperty(name, String(value));
    }
  }

  function onInit(data) {
    if (PREVIEW) previewGen = data.gen | 0;
    if (PREVIEW && typeof data.page === 'number') previewPage = data.page;
    latestSensors = data.sensors || [];
    latestMedia = data.media;
    status = data.status || status;
    // Game state rides init: a game already fullscreen when the shell loads fired
    // its transition before shell-ready, and the host's poll dedups it forever.
    if (data.game) gameState = { active: !!data.game.active, process: data.game.process || '' };
    applyThemeTokens(data.theme);

    layoutData = (data.layout && Array.isArray(data.layout.pages)) ? data.layout : { pages: [] };
    widgetLib = data.widgets || [];
    widgetsById = new Map(widgetLib.map((w) => [w.id, w]));
    backgroundHost = data.backgroundHost || backgroundHost;

    // Instance identity must be unique: layouts from older builds can carry
    // DUPLICATE instanceIds (positional freezes colliding with earlier
    // adoptions), and two look-alike widgets sharing one id share widget-local
    // storage — settings and state on one tile visibly bleed into the other
    // (field report: "editing settings on the top one directly impacts the one
    // below it"). Collisions are checked against each slot's EFFECTIVE tag —
    // a slot with no instanceId runs under its derived positional tag
    // ("p0s0"), which an explicit id elsewhere can collide with just as hard.
    // Re-mint duplicates here; the panel persists the healed ids.
    const seenIds = new Set();
    let reMinted = 0;
    layoutData.pages.forEach((page, pi) => {
      (page.slots || []).forEach((def, si) => {
        let effective = def.instanceId || ('p' + pi + 's' + si);
        if (seenIds.has(effective)) {
          def.instanceId = 'i' + Date.now().toString(36) + '-' + (++instanceSeq) + 'd';
          effective = def.instanceId;
          reMinted++;
        }
        seenIds.add(effective);
      });
    });

    renderAll();

    if (reMinted && !PREVIEW) {
      // Heal the stored layout so the dupes never come back. The replica skips
      // this: its capture stream must never dirty a freshly opened editor.
      postToHost({ type: 'log', message: 'healed ' + reMinted + ' duplicate widget instanceId(s)' });
      persistLayout();
    }
  }

  function renderAll() {
    cancelDrag();   // a re-init mid-drag must not orphan the ghost / dragging state
    closePalette(); // palette entries capture page objects this rebuild replaces
    closeStyleEditor(false); // its record is about to be replaced
    closePropSheet(false);   // ditto for the settings sheet
    const keepPage = (PREVIEW && previewPage != null) ? previewPage
      : currentPage(); // a re-init (hot reload, replica refresh) keeps the page
    refreshBgSpecs();
    bg.reset();

    pagesEl.textContent = '';
    pageEls.clear();
    slots = [];
    selected = null; // records are being replaced; the settings window re-sends select-slot after a re-init

    for (const page of layoutData.pages) buildPage(page);
    syncPageOrder();
    rebuildDots();

    emptyEl.hidden = editing || slots.length > 0 || layoutData.pages.length > 0;
    pagesEl.scrollLeft = Math.min(keepPage, Math.max(0, layoutData.pages.length - 1)) * pagesEl.clientWidth;
    updateDots();
    bg.applyForPage(currentPage()); // paint the initial page's background at once (updateDots only debounces)

    generation++;
    armWatchdog(generation);
    applyGameMode();
    syncNotificationDemand(); // fresh records carry no demand; rebuilt widgets re-watch
    if (editing) updateEditBar();
  }

  function buildPage(page) {
    const pageEl = document.createElement('section');
    pageEl.className = 'page';
    pageEls.set(page, pageEl);

    // "+ add widget" affordance: positioned over the page's largest free rectangle
    // while editing (relayoutPage keeps it placed and hides it when the page is full).
    const addZone = document.createElement('button');
    addZone.className = 'add-zone';
    addZone.textContent = '+';
    addZone.addEventListener('click', () => openPalette(page));
    pageEl.appendChild(addZone);

    for (const slotDef of page.slots || []) buildSlot(page, slotDef);
    relayoutPage(page);
    pagesEl.appendChild(pageEl);
    return pageEl;
  }

  function buildSlot(page, slotDef) {
    const pageEl = pageEls.get(page);
    const slotEl = document.createElement('div');
    slotEl.className = 'slot';
    const uid = ++slotUid;
    const widget = widgetsById.get(slotDef.widgetId);
    let record;

    if (!widget) {
      const err = document.createElement('div');
      err.className = 'error';
      err.textContent = `Widget "${slotDef.widgetId}" is not installed`;
      slotEl.appendChild(err);
      record = { frame: null, el: slotEl, def: slotDef, page, uid, settings: {}, initialized: true, retries: 9 };
    } else {
      const frame = document.createElement('iframe');
      // allow-same-origin is safe here: each widget is served from its own
      // virtual host, so widgets cannot reach the shell's or each other's origin.
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      // Fragment carries a stable per-slot tag (backs the iCUE `uniqueId` global)
      // plus this slot's merged settings, so the shim can inject property globals
      // BEFORE widget scripts run — matching iCUE's documented injection timing.
      // A persisted instanceId (assigned on first on-panel edit) is the permanent
      // identity; never-edited layouts keep the positional tag, exactly as before.
      const settings = mergedSettings(widget, slotDef);
      const tag = slotDef.instanceId ||
        ('p' + Math.max(0, layoutData.pages.indexOf(page)) + 's' + Math.max(0, (page.slots || []).indexOf(slotDef)));
      let slotHash = '#ww-slot=' + tag;
      try {
        slotHash += '&ww-settings=' + encodeURIComponent(JSON.stringify(settings));
      } catch (e) { /* unserializable settings: init delivery still applies them */ }
      frame.src = widget.url + slotHash;
      slotEl.appendChild(frame);
      record = { frame, el: slotEl, url: widget.url, hash: slotHash, tag, def: slotDef, page, uid, settings, initialized: false, retries: 0 };
    }

    slotEl.appendChild(buildOverlay(record, widget));
    slots.push(record);
    pageEl.appendChild(slotEl);
    return record;
  }

  // Applies grid placement for every slot of a page (and the add-zone). Slots that no
  // longer fit are hidden rather than overlapped; the editor's fit checks prevent that
  // for its own operations, so this only triggers for hand-edited layout files.
  function relayoutPage(page) {
    const defs = page.slots || [];
    const placements = placeSlots(defs);
    defs.forEach((def, i) => {
      const rec = slots.find((s) => s.def === def);
      if (!rec) return;
      const place = placements[i];
      if (!place) {
        rec.el.style.display = 'none';
        return;
      }
      rec.el.style.display = '';
      rec.el.style.gridColumn = (place.col + 1) + ' / span ' + place.w;
      rec.el.style.gridRow = place.band === 'full' ? '1 / span 2' : place.band === 'upper' ? '1' : '2';
    });
    positionAddZone(page, placements);
  }

  function positionAddZone(page, placements) {
    const pageEl = pageEls.get(page);
    const zone = pageEl && pageEl.querySelector('.add-zone');
    if (!zone) return;
    const occupied = [new Array(4).fill(false), new Array(4).fill(false)];
    for (const place of placements || placeSlots(page.slots || [])) {
      if (!place) continue;
      const rows = place.band === 'full' ? [0, 1] : place.band === 'upper' ? [0] : [1];
      for (const r of rows) for (let i = 0; i < place.w; i++) occupied[r][place.col + i] = true;
    }
    let best = null;
    for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++) {
      for (let h = 1; r + h <= 2; h++) for (let w = 1; c + w <= 4; w++) {
        let free = true;
        for (let i = r; i < r + h && free; i++) for (let j = c; j < c + w && free; j++) if (occupied[i][j]) free = false;
        if (free && (!best || w * h > best.w * best.h)) best = { r, c, w, h };
      }
    }
    if (!best) { zone.style.display = 'none'; return; }
    zone.style.display = '';
    zone.style.gridColumn = (best.c + 1) + ' / span ' + best.w;
    zone.style.gridRow = best.h === 2 ? '1 / span 2' : String(best.r + 1);
  }

  // Pages are ordered with flex `order` so reordering never moves DOM nodes —
  // moving an iframe in the DOM reloads it.
  function syncPageOrder() {
    layoutData.pages.forEach((page, i) => {
      const el = pageEls.get(page);
      if (el) el.style.order = String(i);
    });
  }

  function rebuildDots() {
    dotsEl.textContent = '';
    layoutData.pages.forEach((_, i) => {
      const dot = document.createElement('span');
      dot.addEventListener('click', () => goToPage(i));
      dotsEl.appendChild(dot);
    });
  }

  function refreshBgSpecs() {
    bgGlobal = layoutData.background || null;
    bgPages = layoutData.pages.map((p) => p.background || null);
  }

  // Widget loads can flake (virtual-host races, heavy first paints); retry stragglers
  // a couple of times before declaring them failed.
  function armWatchdog(gen) {
    setTimeout(() => {
      if (gen !== generation) return;
      let retrying = false;
      for (const slot of slots) {
        if (slot.initialized || !slot.frame) continue;
        if (slot.retries < 2) {
          slot.retries++;
          retrying = true;
          // A changed query forces a real navigation (re-assigning a same-URL-with-
          // fragment src is treated as a fragment jump and does not reload).
          try { slot.frame.src = slot.url + '?wwr=' + slot.retries + slot.hash; } catch (e) { /* frame gone */ }
          postToHost({ type: 'log', message: 'watchdog: reloading slow widget (attempt ' + slot.retries + ')' });
        } else if (!slot.el.querySelector('.error')) {
          const err = document.createElement('div');
          err.className = 'error';
          err.textContent = 'Widget failed to load';
          slot.el.appendChild(err);
        }
      }
      if (retrying) armWatchdog(gen);
    }, 7000);
  }

  function mergedSettings(widget, slotDef) {
    const settings = {};
    for (const prop of widget.properties || []) {
      if (prop.name) settings[prop.name] = prop.default;
    }
    Object.assign(settings, slotDef.settings || {});
    return settings;
  }

  // ---- page navigation (dots + edge zones) ----------------------------------------

  const edgeLeft = document.getElementById('edgeLeft');
  const edgeRight = document.getElementById('edgeRight');

  function currentPage() {
    return Math.round(pagesEl.scrollLeft / Math.max(1, pagesEl.clientWidth));
  }

  // While a goToPage glide is still animating, scrollLeft reports the page being LEFT
  // (or one glided past), so edit operations must act on the destination instead.
  let navTarget = null;

  function editIndex() {
    return navTarget !== null ? navTarget : currentPage();
  }

  function goToPage(index) {
    const count = dotsEl.children.length;
    const clamped = Math.max(0, Math.min(count - 1, index));
    const left = clamped * pagesEl.clientWidth;
    navTarget = Math.abs(pagesEl.scrollLeft - left) < 2 ? null : clamped; // no scroll -> no scrollend
    if (editing) disarmPageDelete(); // an armed delete must not carry over to another page
    // WYSIWYG: page moves initiated inside the editing replica (add page, edge-drop,
    // capsule arrows) must steer the settings window too, or its rail/detail panel
    // keeps operating on the page the preview no longer shows.
    if (PREVIEW && editing) postToHost({ type: 'page-changed', index: clamped, gen: previewGen });
    pagesEl.scrollTo({ left, behavior: 'smooth' });
    wakeChrome();
  }

  function wakeChrome() {
    for (const el of [dotsEl, edgeLeft, edgeRight, editBtn]) el.classList.remove('idle');
    clearTimeout(dotsIdleTimer);
    if (editing) return; // chrome stays awake for the whole edit session
    dotsIdleTimer = setTimeout(() => {
      for (const el of [dotsEl, edgeLeft, edgeRight, editBtn]) el.classList.add('idle');
    }, 2500);
  }

  function updateDots() {
    const index = currentPage();
    if (navTarget !== null && Math.abs(pagesEl.scrollLeft - navTarget * pagesEl.clientWidth) < 2) navTarget = null; // settled (scrollend fallback)
    [...dotsEl.children].forEach((dot, i) => dot.classList.toggle('active', i === index));
    // Dot highlighting tracks the scroll live, but applying a background is expensive
    // (for video it creates + network-loads + plays an element), so a single tap that
    // jumps several pages must not paint every page scrolled past. Defer the swap until
    // scrolling settles and paint only the page we actually land on.
    clearTimeout(bgSettleTimer);
    bgSettleTimer = setTimeout(() => bg.applyForPage(currentPage()), 140);
    wakeChrome();
    if (editing) updateEditBar();
  }

  // ---- wallpaper (dashboard/page background) ---------------------------------------

  function createBackgroundController() {
    const layers = [document.getElementById('bgLayer0'), document.getElementById('bgLayer1')];
    const dim = document.getElementById('bgDim');
    let front = 0;         // index of the layer currently shown
    let currentKey = null; // spec key currently shown, to skip redundant swaps

    const validColor = (c, fallback) =>
      // Only 3/4/6/8-digit hex are valid CSS; 5- and 7-digit would be applied then
      // silently dropped by the browser, so reject them and use the fallback.
      (typeof c === 'string' && /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(c.trim())) ? c.trim() : fallback;

    function resolveUrl(source) {
      return 'https://' + backgroundHost + '/' + encodeURIComponent(source);
    }

    function applyImageFit(layer, fit) {
      switch (fit) {
        case 'contain': layer.style.backgroundSize = 'contain'; layer.style.backgroundRepeat = 'no-repeat'; break;
        case 'stretch': layer.style.backgroundSize = '100% 100%'; layer.style.backgroundRepeat = 'no-repeat'; break;
        case 'tile':    layer.style.backgroundSize = 'auto';      layer.style.backgroundRepeat = 'repeat'; break;
        case 'center':  layer.style.backgroundSize = 'auto';      layer.style.backgroundRepeat = 'no-repeat'; break;
        default:        layer.style.backgroundSize = 'cover';     layer.style.backgroundRepeat = 'no-repeat'; break;
      }
    }

    function videoObjectFit(fit) {
      if (fit === 'contain') return 'contain';
      if (fit === 'stretch') return 'fill';
      if (fit === 'center' || fit === 'tile') return 'none';
      return 'cover';
    }

    function clearVideo(layer) {
      const v = layer.querySelector('video');
      if (v) {
        try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) { /* ignore */ }
        v.remove();
      }
    }

    function paint(layer, spec) {
      clearVideo(layer);
      layer.style.background = '';
      layer.style.backgroundColor = '';
      layer.style.backgroundImage = '';
      layer.style.filter = '';
      if (!spec || !spec.type || spec.type === 'none') return;

      const blur = Math.max(0, Math.min(40, Number(spec.blur) || 0));
      layer.classList.toggle('blurred', blur > 0);
      if (blur) layer.style.filter = 'blur(' + blur + 'px)';

      if (spec.type === 'color') {
        layer.style.backgroundColor = validColor(spec.color, '#101418');
      } else if (spec.type === 'gradient') {
        const angle = Number.isFinite(Number(spec.angle)) ? Number(spec.angle) : 135;
        layer.style.background = 'linear-gradient(' + angle + 'deg, ' +
          validColor(spec.color, '#101418') + ', ' + validColor(spec.color2, '#0b0e14') + ')';
      } else if (spec.type === 'image' && spec.source) {
        applyImageFit(layer, spec.fit);
        layer.style.backgroundImage = 'url("' + resolveUrl(spec.source) + '")';
      } else if (spec.type === 'video' && spec.source) {
        const v = document.createElement('video');
        v.autoplay = true; v.loop = true; v.muted = true; v.defaultMuted = true;
        v.setAttribute('muted', ''); v.setAttribute('playsinline', '');
        v.style.objectFit = videoObjectFit(spec.fit);
        v.src = resolveUrl(spec.source);
        layer.appendChild(v);
        v.play().catch(() => { /* autoplay policies: muted loop is allowed, ignore */ });
      }
    }

    function show(spec) {
      const key = spec ? JSON.stringify(spec) : 'none';
      if (key === currentKey) return;
      currentKey = key;

      const back = 1 - front;
      paint(layers[back], spec);
      layers[back].classList.add('show');
      layers[front].classList.remove('show');
      front = back;

      // Only image/video wallpapers can be dimmed (the editor exposes Dim for those
      // only); never darken a solid color or gradient the user picked at full strength.
      const dimmable = spec && (spec.type === 'image' || spec.type === 'video');
      dim.style.opacity = String((dimmable ? Math.max(0, Math.min(100, Number(spec.dim) || 0)) : 0) / 100);

      // After the fade, fully release any video in the now-hidden layer — pausing alone
      // keeps its decoded frame + buffers resident, which matters on the small device.
      setTimeout(() => {
        for (const l of layers) {
          if (!l.classList.contains('show')) clearVideo(l);
        }
      }, 650);
    }

    return {
      applyForPage(index) {
        show((bgPages[index] || bgGlobal) || null);
      },
      reset() { currentKey = null; },
    };
  }

  // Edge zones: tap or horizontal swipe switches pages. Needed because widget iframes
  // consume touches over their whole area, leaving no reliable swipe surface.
  function bindEdge(el, direction) {
    let startX = null;
    el.addEventListener('pointerdown', (ev) => { startX = ev.clientX; el.setPointerCapture(ev.pointerId); wakeChrome(); });
    el.addEventListener('pointerup', (ev) => {
      if (startX === null) return;
      const dx = ev.clientX - startX;
      startX = null;
      if (Math.abs(dx) < 12) goToPage(currentPage() + direction);      // tap
      else goToPage(currentPage() + (dx < 0 ? 1 : -1));                // swipe
    });
    el.addEventListener('pointercancel', () => { startX = null; });
  }
  bindEdge(edgeLeft, -1);
  bindEdge(edgeRight, 1);

  pagesEl.addEventListener('scroll', updateDots, { passive: true });
  pagesEl.addEventListener('scrollend', () => { navTarget = null; });

  // ---- on-panel edit mode ----------------------------------------------------------
  // Everything is edited in place on the live dashboard: transparent overlays above the
  // widget iframes capture gestures (widgets never see them), every mutation re-lays the
  // affected page out and persists immediately, and "Done" only exits.

  const editBtn = document.getElementById('editBtn');
  const editBar = document.getElementById('editBar');
  if (PREVIEW) {
    // In the settings replica the HOST owns edit mode (its "Edit layout" toggle):
    // hide the pencil and Done so the replica can't fall out of sync with it.
    editBtn.style.display = 'none';
    // Nothing floats over the canvas in the replica (field report: the capsule
    // and style panel covered — and BLOCKED — the very tiles being edited). The
    // settings window around this frame owns page management, navigation (pages
    // strip + the dots) and appearance; the preview shows only widgets.
    editBar.style.display = 'none';
    document.body.classList.add('preview'); // CSS scoping for replica-only styling
  }
  const paletteEl = document.getElementById('palette');
  const paletteGrid = document.getElementById('paletteGrid');
  const pageDeleteBtn = document.getElementById('pageDelete');

  const WIDTH_ORDER = ['quarter', 'half', 'three-quarter', 'full'];
  const WIDTH_LABELS = { quarter: '¼', half: '½', 'three-quarter': '¾', full: 'Full' };
  const BAND_LABELS = { full: '⬍', upper: '▀', lower: '▄' };

  let instanceSeq = 0;

  // ---- preview slot selection (WYSIWYG settings, #32) ------------------------------
  // In the settings replica, tapping a tile selects it: the tile gets a highlight and
  // the settings window is told which slot to show in its detail panel. The panel
  // (non-preview) never posts selection — the dashboard has no detail panel.
  let selected = null;

  function applySelectionClass() {
    for (const s of slots) s.el.classList.toggle('selected', s === selected);
    // Spotlight scoping: with a selection active the replica dims everything else,
    // so "which of the four identical widgets am I editing" answers itself.
    document.body.classList.toggle('has-selection', !!selected);
  }

  function postSelection() {
    if (!PREVIEW) return;
    let pageIdx = -1, slotIdx = -1;
    if (selected) {
      pageIdx = layoutData.pages.indexOf(selected.page);
      slotIdx = (selected.page.slots || []).indexOf(selected.def);
      if (pageIdx < 0 || slotIdx < 0) { selected = null; pageIdx = -1; slotIdx = -1; }
    }
    postToHost({ type: 'slot-selected', page: pageIdx, index: slotIdx,
      instanceId: (selected && selected.def.instanceId) || null, gen: previewGen });
  }

  function selectRecord(record, announce) {
    selected = record || null;
    applySelectionClass();
    if (announce !== false) postSelection();
  }

  function selectSlotAt(pageIdx, slotIdx, announce) {
    const page = layoutData.pages[pageIdx];
    const def = page && (page.slots || [])[slotIdx];
    selectRecord((def && slots.find((s) => s.def === def)) || null, announce);
  }

  function persistLayout() {
    // Editing makes positional identity unstable, so the first persist freezes every
    // instance's identity: each def adopts the tag its iframe is ALREADY running under
    // (stored widget state carries over seamlessly); defs without a live record (e.g.
    // hidden over-full slots) get a fresh unique id.
    for (const page of layoutData.pages) {
      for (const def of page.slots || []) {
        if (def.instanceId) continue;
        const rec = slots.find((s) => s.def === def);
        def.instanceId = (rec && rec.tag) ||
          ('i' + Date.now().toString(36) + '-' + (++instanceSeq));
      }
    }
    const save = { type: 'save-layout', layout: layoutData };
    if (PREVIEW) save.gen = previewGen; // stale-capture detection in the settings window
    postToHost(save);
    // Mutations shift indices; keep the settings window's detail panel pointed at
    // the same slot it was showing (it captures the layout above, then this).
    if (PREVIEW && selected) postSelection();
  }

  // Wraps a mutation in a View Transition when available so tiles glide instead of jump.
  function mutate(fn) {
    const step = () => { fn(); persistLayout(); };
    if (document.startViewTransition) {
      try { document.startViewTransition(step); return; } catch (e) { /* fall through */ }
    }
    step();
  }

  function sizeParts(token) {
    let t = String(token || 'quarter').toLowerCase();
    let band = 'full';
    if (t.endsWith('-upper')) { band = 'upper'; t = t.slice(0, -6); }
    else if (t.endsWith('-lower')) { band = 'lower'; t = t.slice(0, -6); }
    if (t === 'threequarter') t = 'three-quarter';
    if (!WIDTH_ORDER.includes(t)) t = 'quarter';
    return { width: t, band };
  }
  function makeSize(width, band) { return width + (band === 'full' ? '' : '-' + band); }

  function setEditing(on) {
    editing = on;
    document.body.classList.toggle('editing', on);
    // Game-mode visibility depends on `editing`, and no game-mode EVENT arrives at
    // edit enter/exit (the host only posts on change): re-apply here, or a game
    // running right now leaves hide-in-game slots invisible while editing — and
    // visible after Done until the game next flips state.
    applyGameMode();
    editBar.hidden = !on;
    // On-device, entering edit on an empty panel needs a page to drop widgets on.
    // NEVER in the replica: the settings window owns page management there, and
    // auto-creating one after the user deleted their last page silently undid the
    // deletion (the capture stream adopted the unsolicited page right back).
    if (on && !PREVIEW && layoutData.pages.length === 0) {
      const page = { name: 'Page 1', slots: [] };
      layoutData.pages.push(page);
      buildPage(page);
      syncPageOrder(); rebuildDots(); refreshBgSpecs();
      persistLayout();
    }
    if (on) {
      emptyEl.hidden = true;
      for (const page of layoutData.pages) positionAddZone(page);
      updateEditBar();
    } else {
      emptyEl.hidden = slots.length > 0 || layoutData.pages.length > 0;
      closePalette();
      cancelDrag();
      closeStyleEditor(); // flushes any trailing style edit
      closePropSheet();   // same flush-on-close contract for settings edits
      if (PREVIEW) selectRecord(null, false); // highlight off; the host keeps its own selection
      // Armed confirms must not survive the session: re-entering edit within the
      // 2.5s window would otherwise turn the first tap into an instant delete.
      disarmPageDelete();
      for (const btn of document.querySelectorAll('.edit-overlay .remove.confirm')) resetConfirm(btn, '✕');
    }
    wakeChrome();
  }
  editBtn.addEventListener('click', () => setEditing(true));
  document.getElementById('editDone').addEventListener('click', () => setEditing(false));

  function updateEditBar() {
    const i = editIndex();
    document.getElementById('pageMoveLeft').disabled = i <= 0;
    document.getElementById('pageMoveRight').disabled = i >= layoutData.pages.length - 1;
    pageDeleteBtn.disabled = layoutData.pages.length <= 1;
  }

  // Two-tap confirm for destructive buttons (no native dialogs on the panel).
  function confirmThen(btn, restoreText, needsConfirm, action) {
    if (!needsConfirm || btn.classList.contains('confirm')) {
      resetConfirm(btn, restoreText);
      action();
      return;
    }
    btn.classList.add('confirm');
    btn.textContent = 'Sure?';
    btn._confirmTimer = setTimeout(() => resetConfirm(btn, restoreText), 2500);
  }

  function resetConfirm(btn, restoreText) {
    btn.classList.remove('confirm');
    btn.textContent = restoreText;
    clearTimeout(btn._confirmTimer);
  }

  function disarmPageDelete() {
    resetConfirm(pageDeleteBtn, '✕ Page');
  }

  // ---- page management -------------------------------------------------------------

  document.getElementById('pageAdd').addEventListener('click', () => {
    const page = { name: 'Page ' + (layoutData.pages.length + 1), slots: [] };
    layoutData.pages.push(page);
    buildPage(page);
    syncPageOrder(); rebuildDots(); refreshBgSpecs();
    persistLayout();
    goToPage(layoutData.pages.length - 1);
    updateEditBar();
  });

  pageDeleteBtn.addEventListener('click', () => {
    const i = editIndex();
    const page = layoutData.pages[i];
    if (!page || layoutData.pages.length <= 1) return;
    confirmThen(pageDeleteBtn, '✕ Page', (page.slots || []).length > 0, () => {
      if (styleTarget && styleTarget.page === page) closeStyleEditor(false); // its tile goes away with the page
      if (propTarget && propTarget.page === page) closePropSheet(false);
      if (selected && selected.page === page) selectRecord(null); // the detail target's page is going away
      for (const rec of slots.filter((s) => s.page === page)) rec.el.remove();
      slots = slots.filter((s) => s.page !== page);
      syncNotificationDemand();
      const el = pageEls.get(page);
      if (el) el.remove();
      pageEls.delete(page);
      layoutData.pages.splice(i, 1);
      syncPageOrder(); rebuildDots(); refreshBgSpecs();
      persistLayout();
      goToPage(Math.min(i, layoutData.pages.length - 1));
      bg.applyForPage(currentPage());
      updateEditBar();
    });
  });

  // The capsule arrows NAVIGATE. They used to reorder the current page — which
  // moved the dot indicator without changing the visible content (the viewed page
  // travels with the reorder), reading as a dead control and silently rearranging
  // the page order (#39). Reordering lives in the settings window's pages strip.
  document.getElementById('pageMoveLeft').addEventListener('click', () => goToPage(editIndex() - 1));
  document.getElementById('pageMoveRight').addEventListener('click', () => goToPage(editIndex() + 1));

  // ---- per-slot controls -----------------------------------------------------------

  function buildOverlay(record, widget) {
    const ov = document.createElement('div');
    ov.className = 'edit-overlay';

    const grip = document.createElement('span');
    grip.className = 'grip';
    grip.textContent = widget ? widget.name : record.def.widgetId;
    ov.appendChild(grip);

    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.textContent = '✕';
    remove.addEventListener('click', (ev) => {
      ev.stopPropagation();
      confirmThen(remove, '✕', true, () => removeSlot(record));
    });
    ov.appendChild(remove);

    const size = document.createElement('button');
    size.className = 'size';
    const band = document.createElement('button');
    band.className = 'band';
    const syncLabels = () => {
      const parts = sizeParts(record.def.size);
      size.textContent = WIDTH_LABELS[parts.width];
      band.textContent = BAND_LABELS[parts.band];
    };
    syncLabels();
    record.syncLabels = syncLabels; // drag drops can change the band; the chips must follow
    size.addEventListener('click', (ev) => { ev.stopPropagation(); cycleWidth(record, syncLabels); });
    band.addEventListener('click', (ev) => { ev.stopPropagation(); cycleBand(record, syncLabels); });
    ov.appendChild(size);
    ov.appendChild(band);

    // No 🎨/⚙ in the replica: the settings window's Appearance section and Widget
    // tab are the one editor there — two editors for the same values on one
    // screen had them visibly fighting (field report: "double settings menu").
    if (widget && !PREVIEW) {
      const style = document.createElement('button');
      style.className = 'style';
      style.textContent = '🎨';
      style.title = 'Style this widget';
      style.addEventListener('click', (ev) => { ev.stopPropagation(); openStyleEditor(record); });
      ov.appendChild(style);
      // On-device access to the widget's OWN settings (#48): the pencil could
      // move and restyle tiles but never configure them.
      if ((widget.properties || []).length) {
        const gear = document.createElement('button');
        gear.className = 'gear';
        gear.textContent = '⚙';
        gear.title = 'Widget settings';
        gear.addEventListener('click', (ev) => { ev.stopPropagation(); openPropSheet(record); });
        ov.appendChild(gear);
      }
    }

    bindDrag(ov, record);
    return ov;
  }

  function removeSlot(record) {
    if (drag && drag.record === record) cancelDrag(); // removed out from under a drag
    if (styleTarget === record) closeStyleEditor(false);
    if (propTarget === record) closePropSheet(false);
    if (selected === record) selectRecord(null); // tell the host its detail target is gone
    mutate(() => {
      const defs = record.page.slots || [];
      const i = defs.indexOf(record.def);
      if (i >= 0) defs.splice(i, 1);
      record.el.remove();
      slots = slots.filter((s) => s !== record);
      relayoutPage(record.page);
      syncNotificationDemand();
    });
  }

  function allowedWidths(widget) {
    const declared = new Set((widget && widget.supportedSlots && widget.supportedSlots.length)
      ? widget.supportedSlots : WIDTH_ORDER);
    // Per WIDGET-SPEC, widgets declaring half or full are also offered three-quarter.
    if (declared.has('half') || declared.has('full')) declared.add('three-quarter');
    return WIDTH_ORDER.filter((w) => declared.has(w));
  }

  // Would `def` at `size` place, without costing any currently-placing OTHER
  // slot its spot? (Slots that already fail to place — legacy over-full pages —
  // don't veto; hidden slots becoming visible is fine, visible ones vanishing
  // is not, even when the totals balance out.)
  function fitsWithSize(page, def, size) {
    const defs = page.slots || [];
    const original = def.size;
    const beforePlaced = placedSet(defs);
    def.size = size;
    const places = placeSlots(defs);
    const selfPlaced = places[defs.indexOf(def)] !== null;
    const othersKeep = defs.every((d, i) => d === def || !beforePlaced.has(d) || places[i] !== null);
    def.size = original;
    return selfPlaced && othersKeep;
  }

  // The fit checks run INSIDE the mutation step: view transitions run steps
  // asynchronously, so a decision taken at tap time could be validated against a
  // page state an earlier queued mutation is about to change.
  function cycleWidth(record, syncLabels) {
    mutate(() => {
      const widget = widgetsById.get(record.def.widgetId);
      const { width, band } = sizeParts(record.def.size);
      const order = allowedWidths(widget);
      const start = Math.max(0, order.indexOf(width));
      for (let k = 1; k <= order.length; k++) {
        const cand = order[(start + k) % order.length];
        if (cand === width) break;
        if (fitsWithSize(record.page, record.def, makeSize(cand, band))) {
          applySize(record, makeSize(cand, band), syncLabels);
          return;
        }
      }
    });
  }

  function cycleBand(record, syncLabels) {
    mutate(() => {
      const { width, band } = sizeParts(record.def.size);
      const orderB = ['full', 'upper', 'lower'];
      const start = orderB.indexOf(band);
      for (let k = 1; k < orderB.length; k++) {
        const cand = orderB[(start + k) % orderB.length];
        if (fitsWithSize(record.page, record.def, makeSize(width, cand))) {
          applySize(record, makeSize(width, cand), syncLabels);
          return;
        }
      }
    });
  }

  function applySize(record, size, syncLabels) {
    record.def.size = size;
    relayoutPage(record.page);
    syncLabels();
  }

  // ---- per-widget style editor -----------------------------------------------------
  // A right-docked panel over the live tile: checked rows re-specify theme seeds for
  // this instance only; the full palette is re-derived (contrast repair included) and
  // pushed live via ww-theme, then persisted debounced.

  const stylePanel = document.getElementById('stylePanel');
  const spRows = document.getElementById('spRows');
  const spTitle = document.getElementById('spTitle');
  const STOCK_SEEDS = { accent: '#4cc2ff', background: '#05070b', text: '#e8ecf2', panelAlpha: 0.92 };
  let styleTarget = null;
  let stylePersistTimer = null;

  function themeSeeds() {
    return Object.assign({}, STOCK_SEEDS, layoutData.theme || {});
  }

  /** The token map a slot should run under: global theme, or re-derived from the
   * merged seeds when the slot carries style overrides. */
  function slotTheme(slot) {
    const style = slot.def && slot.def.style;
    if (!style || !Object.keys(style).length) return latestTheme;
    return window.WWPalette.derive(Object.assign(themeSeeds(), style));
  }

  function pushSlotTheme(record) {
    sendToSlot(record, { type: 'ww-theme', theme: slotTheme(record) || window.WWPalette.derive(themeSeeds()) });
  }

  function openStyleEditor(record) {
    if (PREVIEW) return; // the settings window's Appearance section owns styling there
    closePropSheet();    // one right-docked editor at a time
    styleTarget = record;
    const widget = widgetsById.get(record.def.widgetId);
    spTitle.textContent = widget ? widget.name : record.def.widgetId;
    for (const s of slots) s.el.classList.toggle('style-editing', s === record);
    buildStyleRows();
    stylePanel.hidden = false;
  }

  function closeStyleEditor(flush) {
    if (flush !== false && stylePersistTimer) {
      clearTimeout(stylePersistTimer);
      stylePersistTimer = null;
      persistLayout(); // flush-on-close: never lose a trailing edit
    }
    styleTarget = null;
    stylePanel.hidden = true;
    for (const s of slots) s.el.classList.remove('style-editing');
  }

  function styleChanged() {
    if (!styleTarget) return;
    const style = styleTarget.def.style;
    if (style && !Object.keys(style).length) delete styleTarget.def.style;
    pushSlotTheme(styleTarget);
    clearTimeout(stylePersistTimer);
    stylePersistTimer = setTimeout(() => { stylePersistTimer = null; persistLayout(); }, 300);
  }

  function buildStyleRows() {
    spRows.textContent = '';
    const def = styleTarget.def;
    const seeds = themeSeeds();
    const hex = (v, fallback) => (/^#[0-9a-f]{6}$/i.test(v || '') ? v : fallback);

    for (const r of [{ key: 'accent', label: 'Accent' }, { key: 'background', label: 'Background' }, { key: 'text', label: 'Text' }]) {
      const row = document.createElement('div');
      row.className = 'sp-row';
      const check = document.createElement('input');
      check.type = 'checkbox';
      const label = document.createElement('label');
      label.textContent = r.label;
      const color = document.createElement('input');
      color.type = 'color';
      const cur = def.style && def.style[r.key];
      check.checked = cur != null;
      color.disabled = !check.checked;
      color.value = hex(cur, hex(seeds[r.key], '#4cc2ff'));
      check.addEventListener('change', () => {
        color.disabled = !check.checked;
        const style = def.style || (def.style = {});
        if (check.checked) style[r.key] = color.value; else delete style[r.key];
        styleChanged();
      });
      color.addEventListener('input', () => {
        (def.style || (def.style = {}))[r.key] = color.value;
        styleChanged();
      });
      row.append(check, label, color);
      spRows.appendChild(row);
    }

    const row = document.createElement('div');
    row.className = 'sp-row';
    const check = document.createElement('input');
    check.type = 'checkbox';
    const label = document.createElement('label');
    label.textContent = 'Panel opacity';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = 15; range.max = 100; range.step = 1;
    const out = document.createElement('output');
    const cur = def.style && def.style.panelAlpha;
    check.checked = cur != null;
    range.disabled = !check.checked;
    range.value = String(Math.round((cur != null ? cur : seeds.panelAlpha) * 100));
    out.value = range.value + '%';
    check.addEventListener('change', () => {
      range.disabled = !check.checked;
      const style = def.style || (def.style = {});
      if (check.checked) style.panelAlpha = Number(range.value) / 100; else delete style.panelAlpha;
      styleChanged();
    });
    range.addEventListener('input', () => {
      out.value = range.value + '%';
      (def.style || (def.style = {})).panelAlpha = Number(range.value) / 100;
      styleChanged();
    });
    row.append(check, label, range, out);
    spRows.appendChild(row);
  }

  document.getElementById('spClose').addEventListener('click', () => closeStyleEditor());
  document.getElementById('spReset').addEventListener('click', () => {
    if (!styleTarget) return;
    delete styleTarget.def.style;
    pushSlotTheme(styleTarget);
    buildStyleRows();
    persistLayout();
  });

  // ---- per-widget settings editor (#48) ---------------------------------------------
  // On-device counterpart of the settings window's Widget tab: a right-docked sheet
  // of touch-first controls generated from the widget's manifest properties. Every
  // change applies to the live tile immediately (the tile IS the preview) and
  // persists debounced, flushing on close — same contract as the style editor.

  const propSheet = document.getElementById('propSheet');
  const psRows = document.getElementById('psRows');
  const psTitle = document.getElementById('psTitle');
  let propTarget = null;
  let propPersistTimer = null;
  let psProfileWaiters = []; // callbacks awaiting an sd-profiles-result
  let propReloadSeq = 0;     // cache-busting nonce: fragment-only src changes don't navigate

  const PS_EMOJI = [
    '🧮', '🌐', '📁', '📷', '🎨', '📝', '📊', '💻', '🖥️', '⌨️', '🖱️', '🎧',
    '🎮', '🕹️', '🎬', '🎵', '📺', '📻', '🔊', '🔇', '⏯️', '⏭️', '⏮️', '⏹️',
    '🚀', '⚡', '🔥', '⭐', '❤️', '🏠', '🔧', '⚙️', '🔒', '🔑', '🛡️', '📦',
    '💬', '📧', '📅', '⏰', '🌙', '☀️', '☁️', '💡', '🔋', '📶', '🧭', '🗺️',
  ];

  function closeEmojiPop() {
    const pop = document.querySelector('.emoji-pop');
    if (pop) pop.remove();
    document.removeEventListener('pointerdown', onEmojiOutside, true);
  }
  function onEmojiOutside(ev) {
    if (!ev.target.closest('.emoji-pop')) closeEmojiPop();
  }
  function openEmojiPop(anchor, onPick) {
    if (document.querySelector('.emoji-pop')) { closeEmojiPop(); return; }
    const pop = document.createElement('div');
    pop.className = 'emoji-pop';
    for (const e of PS_EMOJI) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = e;
      b.addEventListener('click', () => { onPick(e); closeEmojiPop(); });
      pop.appendChild(b);
    }
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left - pop.offsetWidth + r.width, window.innerWidth - pop.offsetWidth - 8)) + 'px';
    pop.style.top = Math.max(8, Math.min(r.bottom + 4, window.innerHeight - pop.offsetHeight - 8)) + 'px';
    document.addEventListener('pointerdown', onEmojiOutside, true);
  }

  function openPropSheet(record) {
    if (PREVIEW) return; // the settings window's Widget tab owns properties there
    closePropSheet();    // flush the PREVIOUS target's pending apply/persist first —
                         // retargeting mid-debounce must not strand its edit or
                         // apply it to the newly opened widget
    closeStyleEditor();  // one right-docked editor at a time
    propTarget = record;
    const widget = widgetsById.get(record.def.widgetId);
    psTitle.textContent = widget ? widget.name : record.def.widgetId;
    for (const s of slots) s.el.classList.toggle('style-editing', s === record);
    buildPropRows(record, widget);
    propSheet.hidden = false;
  }

  function closePropSheet(flush) {
    if (!propTarget) return; // never wipe the style editor's highlight
    if (flush !== false) {
      // Flush-on-close: the live tile must show the trailing edit and the
      // layout must carry it — never lose either to a still-armed debounce.
      if (propApplyTimer) {
        clearTimeout(propApplyTimer);
        propApplyTimer = null;
        applyPropNow(propTarget);
      }
      if (propPersistTimer) {
        clearTimeout(propPersistTimer);
        propPersistTimer = null;
        persistLayout();
      }
    }
    closeEmojiPop();
    propTarget = null;
    propSheet.hidden = true;
    for (const s of slots) s.el.classList.remove('style-editing');
  }

  /** Apply the edited stored settings by RELOADING the tile, never by re-initing
   * the live document: widgets treat ww-init as boot, and a second one can stack
   * what boot started (the stock Reddit widget's refresh interval, for one).
   * A fresh document is the one path every widget already handles. The record's
   * settings snapshot is re-merged (defaults + stored) so the reload boots
   * exactly like a cold load would. */
  function applyPropNow(record) {
    const widget = widgetsById.get(record.def.widgetId);
    record.settings = mergedSettings(widget, record.def);
    if (!record.frame) return;
    let hash = '#ww-slot=' + record.tag;
    try {
      hash += '&ww-settings=' + encodeURIComponent(JSON.stringify(record.settings));
    } catch (e) { /* unserializable settings: init delivery still applies them */ }
    record.hash = hash;
    record.initialized = false; // the fresh document's ww-ready gets a full init
    record.frame.src = record.url + '?r=' + (++propReloadSeq) + hash;
    // This navigation can flake exactly like an initial load (virtual-host races,
    // heavy first paints) — and the boot watchdog chain has long since finished.
    // Fresh retry budget, fresh watchdog, or a failed reload would sit silent
    // forever: no ww-ready, no retries, no failure overlay.
    record.retries = 0;
    armWatchdog(generation);
  }

  let propApplyTimer = null;
  function applyPropChange() {
    if (!propTarget) return;
    // Debounced: a keystroke stream must not reload the iframe per key.
    const target = propTarget;
    clearTimeout(propApplyTimer);
    propApplyTimer = setTimeout(() => {
      propApplyTimer = null;
      if (propTarget === target) applyPropNow(target);
    }, 400);
    clearTimeout(propPersistTimer);
    propPersistTimer = setTimeout(() => { propPersistTimer = null; persistLayout(); }, 600);
  }

  function buildPropRows(record, widget) {
    psRows.textContent = '';
    if (!widget) return;
    const stored = () => (record.def.settings = record.def.settings || {});
    const cur = (prop) => {
      const s = record.def.settings || {};
      return s[prop.name] !== undefined ? s[prop.name] : prop.default;
    };
    const set = (prop, v) => { stored()[prop.name] = v; applyPropChange(); };

    for (const prop of widget.properties || []) {
      const field = document.createElement('div');
      field.className = 'ps-field';
      const label = document.createElement('label');
      label.textContent = prop.label || prop.name;
      field.appendChild(label);
      field.appendChild(psControl(prop, cur, set));
      psRows.appendChild(field);
    }
  }

  function psControl(prop, cur, set) {
    const current = cur(prop);
    switch (prop.type) {
      case 'select': {
        const select = document.createElement('select');
        for (const o of prop.options || []) {
          const value = (o && typeof o === 'object') ? o.value : o;
          const text = (o && typeof o === 'object') ? (o.label || o.value) : o;
          select.add(new Option(text, value, false, String(value) === String(current)));
        }
        if (prop.optionsSource === 'sd-profiles') {
          // Host-backed options (discovered Virtual Stream Deck profiles) — same
          // flow as the desktop editor; without it this dropdown would be empty.
          select.add(new Option('First available (default)', '', false, !current));
          if (current) select.add(new Option(current, current, false, true));
          psProfileWaiters.push((profiles) => {
            const chosen = select.value;
            while (select.options.length) select.remove(0);
            select.add(new Option('First available (default)', '', false, !chosen));
            for (const p of profiles) select.add(new Option(p, p, false, p === chosen));
            if (chosen && !profiles.includes(chosen)) {
              select.add(new Option(chosen + '  (not found right now)', chosen, false, true));
            }
          });
          postToHost({ type: 'sd-profiles' });
        }
        select.onchange = () => set(prop, select.value);
        return select;
      }
      case 'location': {
        // Location values are STRUCTURED (label + coordinates picked via the
        // desktop search) — a text box would show "[object Object]" and one
        // keystroke would replace precise coordinates with garbage. Show the
        // label, keep the value untouched; picking needs the desktop's search.
        const wrap = document.createElement('div');
        wrap.className = 'ps-field';
        const shown = document.createElement('input');
        shown.type = 'text';
        shown.readOnly = true;
        shown.value = (current && typeof current === 'object')
          ? String(current.label || current.name || 'Picked location')
          : (current != null ? String(current) : '');
        const hint = document.createElement('p');
        hint.className = 'ps-cap';
        hint.textContent = 'Pick the location in the desktop settings window (it has the city search).';
        wrap.append(shown, hint);
        return wrap;
      }
      case 'slider': {
        const wrap = document.createElement('div');
        wrap.className = 'ps-inline';
        const range = document.createElement('input');
        range.type = 'range';
        range.min = prop.min != null ? prop.min : 0;
        range.max = prop.max != null ? prop.max : 100;
        range.step = prop.step != null ? prop.step : 1;
        range.value = Number(current) || 0;
        const out = document.createElement('output');
        out.value = String(range.value);
        // Track live, commit on release — a re-init per dragged pixel is thrash.
        range.oninput = () => { out.value = String(range.value); };
        range.onchange = () => set(prop, Number(range.value));
        wrap.append(range, out);
        return wrap;
      }
      case 'number': {
        const input = document.createElement('input');
        input.type = 'number';
        if (prop.min != null) input.min = prop.min;
        if (prop.max != null) input.max = prop.max;
        if (prop.step != null) input.step = prop.step;
        input.value = current != null ? String(current) : '';
        input.oninput = () => {
          // Same rule as the desktop editor: a cleared/half-typed field commits
          // nothing — Number('') is 0, which would persist a below-minimum zero
          // the moment the debounce (or Done) fired.
          const parsed = parseFloat(input.value);
          if (!Number.isNaN(parsed)) set(prop, parsed);
        };
        return input;
      }
      case 'switch': {
        // Boolean toggle (iCUE + native). Falling through to text would show
        // "true" and store the string "false" — which is truthy downstream.
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = current === true || current === 'true';
        input.onchange = () => set(prop, input.checked);
        return input;
      }
      case 'color': {
        const input = document.createElement('input');
        input.type = 'color';
        input.value = /^#[0-9a-f]{6}$/i.test(String(current)) ? current : '#4cc2ff';
        input.oninput = () => set(prop, input.value);
        return input;
      }
      case 'sensor': {
        const select = document.createElement('select');
        select.add(new Option('Auto (recommended)', '', false, !current));
        const pool = (latestSensors || []).filter((s) =>
          !prop.sensor_type || s.type === prop.sensor_type);
        for (const s of pool) {
          select.add(new Option(s.device + ' — ' + s.name, s.id, false, s.id === current));
        }
        if (current && !pool.some((s) => s.id === current)) {
          select.add(new Option(current + '  (missing)', current, false, true));
        }
        select.onchange = () => set(prop, select.value);
        return select;
      }
      case 'sensors-factory': return psSensorsFactory(prop, cur, set);
      case 'list': return psList(prop, cur, set);
      default: { // text
        const input = document.createElement('input');
        input.type = 'text';
        if (prop.placeholder) input.placeholder = String(prop.placeholder);
        input.value = current != null ? String(current) : '';
        input.oninput = () => set(prop, input.value);
        if (prop.picker === 'emoji') {
          const wrap = document.createElement('div');
          wrap.className = 'ps-inline';
          wrap.appendChild(input);
          wrap.appendChild(psEmojiBtn(input));
          return wrap;
        }
        return input; // picker:'file' stays free-text on-device (no dialog host here)
      }
    }
  }

  function psEmojiBtn(input) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ps-pick';
    btn.textContent = '😀';
    btn.title = 'Pick an icon';
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openEmojiPop(btn, (e) => {
        input.value = e;
        input.dispatchEvent(new Event('input'));
      });
    });
    return btn;
  }

  /** Structured list (deck buttons, launcher shortcuts): one card per item with
   * labeled fields; the same legacy migrations as the settings window (JSON-array
   * string, "A=B" pairs) so old layouts edit cleanly here too. */
  function psList(prop, cur, set) {
    const wrap = document.createElement('div');
    wrap.className = 'ps-field';
    const fields = (prop.fields && prop.fields.length) ? prop.fields
      : [{ key: 'label', label: 'Label', type: 'text' }, { key: 'value', label: 'Value', type: 'text' }];
    const current = cur(prop);
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
    const commit = () => set(prop, items.map((x) => Object.assign({}, x)));
    const renderItems = () => {
      wrap.textContent = '';
      items.forEach((item, i) => {
        const card = document.createElement('div');
        card.className = 'ps-item';
        const head = document.createElement('div');
        head.className = 'ps-item-head';
        const tag = document.createElement('span');
        tag.textContent = (prop.itemLabel || 'item') + ' ' + (i + 1);
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'ps-remove';
        del.textContent = '✕';
        del.title = 'Remove this ' + (prop.itemLabel || 'item');
        del.addEventListener('click', () => { items.splice(i, 1); commit(); renderItems(); });
        head.append(tag, del);
        card.appendChild(head);
        for (const f of fields) {
          const input = document.createElement('input');
          if (f.type === 'color') {
            input.type = 'color';
            input.value = /^#[0-9a-f]{6}$/i.test(item[f.key]) ? item[f.key] : '#4cc2ff';
          } else {
            input.type = 'text';
            input.placeholder = f.placeholder || f.label || '';
            input.value = item[f.key] != null ? String(item[f.key]) : '';
          }
          input.setAttribute('aria-label', f.label || f.key);
          input.oninput = () => { item[f.key] = input.value; commit(); };
          if (f.picker === 'emoji') {
            const row = document.createElement('div');
            row.className = 'ps-inline';
            row.appendChild(input);
            row.appendChild(psEmojiBtn(input));
            card.appendChild(row);
          } else {
            card.appendChild(input);
          }
        }
        wrap.appendChild(card);
      });
      const cap = Math.max(0, Math.round(Number(prop.maxItems) || 0));
      if (cap && items.length >= cap) {
        const full = document.createElement('p');
        full.className = 'ps-cap';
        full.textContent = 'Limit reached — this widget shows at most ' + cap + ' ' +
          (prop.itemLabel || 'item') + 's.';
        wrap.appendChild(full);
      } else {
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'ps-add';
        add.textContent = '+ Add ' + (prop.itemLabel || 'item');
        add.addEventListener('click', () => {
          const item = {};
          for (const f of fields) item[f.key] = f.type === 'color' ? '#4cc2ff' : '';
          items.push(item);
          commit();
          renderItems();
        });
        wrap.appendChild(add);
      }
    };
    renderItems();
    return wrap;
  }

  /** Sensor picker rows (fans): sensor select + per-row color, add/remove; the
   * pool honors the property's sensor_type filter, matching the settings window. */
  function psSensorsFactory(prop, cur, set) {
    const wrap = document.createElement('div');
    wrap.className = 'ps-field';
    const pool = (latestSensors || []).filter((s) =>
      !prop.sensor_type || s.type === prop.sensor_type);
    const current = cur(prop);
    const items = (Array.isArray(current) ? current : [])
      .filter((x) => x && typeof x === 'object').map((x) => Object.assign({}, x));
    const commit = () => set(prop, items.map((x) => Object.assign({}, x)));
    const renderItems = () => {
      wrap.textContent = '';
      items.forEach((item, i) => {
        const row = document.createElement('div');
        row.className = 'ps-inline';
        const select = document.createElement('select');
        for (const s of pool) {
          select.add(new Option(s.device + ' — ' + s.name, s.id, false, s.id === item.sensorId));
        }
        if (item.sensorId && !pool.some((s) => s.id === item.sensorId)) {
          select.add(new Option(item.sensorId + '  (missing)', item.sensorId, false, true));
        }
        select.onchange = () => { item.sensorId = select.value; commit(); };
        const color = document.createElement('input');
        color.type = 'color';
        color.value = /^#[0-9a-f]{6}$/i.test(item.color) ? item.color : '#4cc2ff';
        color.oninput = () => { item.color = color.value; commit(); };
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'ps-remove';
        del.textContent = '✕';
        del.title = 'Remove sensor';
        del.addEventListener('click', () => { items.splice(i, 1); commit(); renderItems(); });
        row.append(select, color, del);
        wrap.appendChild(row);
      });
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'ps-add';
      add.textContent = '+ Add sensor';
      add.disabled = !pool.length;
      add.addEventListener('click', () => {
        // Seed from the FILTERED pool — the first sensor of any type would be a
        // temperature on most systems and could never resolve (Codex round 5).
        items.push({ sensorId: pool[0].id, color: '#4cc2ff' });
        commit();
        renderItems();
      });
      wrap.appendChild(add);
    };
    renderItems();
    return wrap;
  }

  document.getElementById('psClose').addEventListener('click', () => closePropSheet());

  // ---- add widget (palette) --------------------------------------------------------

  function defaultSizeFor(page, widget) {
    const widths = allowedWidths(widget).slice().reverse(); // widest first, shrink into the hole
    const probe = { widgetId: widget.id, size: 'quarter', settings: {} };
    const defs = (page.slots = page.slots || []);
    const before = unplacedCount(defs);
    defs.push(probe);
    let found = null;
    outer:
    for (const band of ['full', 'upper', 'lower']) {
      for (const w of widths) {
        probe.size = makeSize(w, band);
        if (unplacedCount(defs) === before) { found = probe.size; break outer; }
      }
    }
    defs.pop();
    return found;
  }

  function openPalette(page) {
    cancelDrag(); // a second finger can reach the add-zone while a drag holds
    // Toggle: pressing "+" again dismisses instead of stacking a re-open (#46).
    if (!paletteEl.hidden) { closePalette(); return; }
    if (PREVIEW && editing) {
      // The replica is a small scaled strip inside the settings window — a modal
      // palette here covers the very layout being edited (#46). Hand off to the
      // settings window's widget gallery instead.
      postToHost({ type: 'add-widget', index: Math.max(0, layoutData.pages.indexOf(page)), gen: previewGen });
      return;
    }
    paletteGrid.textContent = '';
    for (const widget of widgetLib) {
      const btn = document.createElement('button');
      const name = document.createElement('span');
      name.className = 'p-name';
      name.textContent = widget.name;
      const by = document.createElement('span');
      by.className = 'p-by';
      by.textContent = defaultSizeFor(page, widget) ? (widget.author || '') : 'No room on this page';
      btn.append(name, by);
      btn.disabled = !defaultSizeFor(page, widget);
      btn.addEventListener('click', () => addWidget(page, widget));
      paletteGrid.appendChild(btn);
    }
    // A wall of disabled entries reads as "broken", not "full" — say it plainly.
    if (![...paletteGrid.children].some((b) => !b.disabled)) {
      const note = document.createElement('p');
      note.className = 'p-full';
      note.textContent = 'This page is full — remove a widget or add a page.';
      paletteGrid.prepend(note);
    }
    paletteEl.hidden = false;
  }
  function closePalette() { paletteEl.hidden = true; }
  document.getElementById('paletteBackdrop').addEventListener('click', closePalette);

  function addWidget(page, widget) {
    closePalette();
    mutate(() => {
      const size = defaultSizeFor(page, widget); // sized against the page as it IS now
      if (!size) return;
      // instanceId minted upfront: a positional tag here could collide with an
      // identity another slot froze earlier (e.g. a previously adopted "p0s1").
      const def = {
        widgetId: widget.id, size, settings: {},
        instanceId: 'i' + Date.now().toString(36) + '-' + (++instanceSeq),
      };
      (page.slots = page.slots || []).push(def);
      const rec = buildSlot(page, def);
      relayoutPage(page);
      armWatchdog(generation);
      // The just-added widget is what the user configures next: select it so the
      // settings detail panel binds to it (#41). Announced by persistLayout right
      // after this mutation — the layout lands before the selection referencing it.
      if (PREVIEW) selectRecord(rec, false);
    });
  }

  // ---- drag to rearrange -----------------------------------------------------------
  // Pointer capture from pointerdown; 7px threshold separates tap from drag; a fixed
  // ghost follows the finger; elementsFromPoint decides the drop target every frame.
  // Dropping on a slot reorders within the page; dropping on an edge zone moves the
  // widget to the adjacent page (validated at drag start so a full page never lights).

  let drag = null;

  function bindDrag(overlay, record) {
    overlay.addEventListener('pointerdown', (ev) => {
      // One drag at a time: a second finger touching another tile mid-drag must not
      // hijack the state (that would orphan the first drag's ghost forever).
      if (!editing || drag || ev.target.closest('button')) return;
      overlay.setPointerCapture(ev.pointerId);
      drag = { record, pointerId: ev.pointerId, startX: ev.clientX, startY: ev.clientY, active: false, ghost: null, raf: 0, last: null, targetSlot: null, targetEdge: null, targetCell: null, hint: null, canLeft: false, canRight: false };
    });
    overlay.addEventListener('pointermove', (ev) => {
      if (!drag || drag.record !== record || ev.pointerId !== drag.pointerId) return;
      drag.last = { x: ev.clientX, y: ev.clientY };
      if (!drag.active) {
        if (Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) < 7) return;
        beginDrag(record);
      }
      if (!drag.raf) drag.raf = requestAnimationFrame(trackDrag);
    });
    // Only the finger that started the drag may finish it.
    overlay.addEventListener('pointerup', (ev) => {
      if (drag && drag.record === record && ev.pointerId === drag.pointerId) finishDrag(true);
    });
    overlay.addEventListener('pointercancel', (ev) => {
      if (drag && drag.record === record && ev.pointerId === drag.pointerId) finishDrag(false);
    });
  }

  // Abandons an in-flight drag without committing (re-init, tile removed, edit exit).
  function cancelDrag() {
    if (drag) finishDrag(false);
  }

  // Legacy layouts can carry slots that ALREADY fail to place (over-full pages
  // hide them instead of rejecting the file). Field bug: one hidden slot made
  // every fit check on the page fail — adds all "No room", drops all bouncing —
  // while free space sat visibly on screen. The bar for any edit is "nobody who
  // places today loses their spot", never "the whole page is perfect". That bar
  // is about IDENTITY, not counts: a count comparison would accept trading a
  // visible widget for a previously hidden one (Codex, #38).
  function unplacedCount(defs) {
    return placeSlots(defs).reduce((n, p) => n + (p === null ? 1 : 0), 0);
  }

  // The defs (by object identity) that currently get a spot on the page.
  function placedSet(defs) {
    const places = placeSlots(defs);
    const set = new Set();
    defs.forEach((def, i) => { if (places[i] !== null) set.add(def); });
    return set;
  }

  function pageFits(page, def) {
    const defs = (page.slots = page.slots || []);
    const before = unplacedCount(defs);
    defs.push(def);
    const ok = unplacedCount(defs) === before; // the pushed def is last: unchanged count = it placed
    defs.pop();
    return ok;
  }

  function beginDrag(record) {
    drag.active = true;
    const rect = record.el.getBoundingClientRect();
    const ghost = document.createElement('div');
    ghost.id = 'dragGhost';
    ghost.style.width = Math.min(280, Math.max(120, rect.width * 0.6)) + 'px';
    ghost.style.height = Math.min(140, Math.max(70, rect.height * 0.5)) + 'px';
    const widget = widgetsById.get(record.def.widgetId);
    ghost.textContent = widget ? widget.name : record.def.widgetId;
    document.body.appendChild(ghost);
    record.el.classList.add('drag-src');
    document.body.classList.add('dragging'); // re-enables the edge zones as drop targets
    drag.ghost = ghost;
    const i = layoutData.pages.indexOf(record.page);
    drag.canLeft = i > 0 && pageFits(layoutData.pages[i - 1], record.def);
    drag.canRight = i >= 0 && i < layoutData.pages.length - 1 && pageFits(layoutData.pages[i + 1], record.def);
  }

  function clearDropHighlights() {
    for (const s of slots) s.el.classList.remove('drop-target');
    edgeLeft.classList.remove('drop-page');
    edgeRight.classList.remove('drop-page');
    if (drag && drag.hint) drag.hint.style.display = 'none';
  }

  // Maps a pointer position over the dragged widget's own page to a landing spot in
  // FREE grid space. Empty cells are first-class drop targets (#40 — the field demo
  // showed drags ending on the "+" zone bouncing back): half-height widgets adopt the
  // band of the row under the pointer, and a widget pointed at a hole SMALLER than
  // itself shrinks into it instead of bouncing back (field report: "onto a smaller
  // space ... it should be the smaller size"). Landing where the user points wins;
  // at equal distance the largest size that fits wins — so a plain move into open
  // space keeps the size, and only a genuinely tighter hole resizes.
  // Returns { index, size, place, dist } or null when nothing fits anywhere near.
  function cellTargetAt(x, y) {
    const rec = drag.record;
    const pageEl = pageEls.get(rec.page);
    if (!pageEl) return null;
    const rect = pageEl.getBoundingClientRect();
    if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) return null;
    const col = Math.max(0, Math.min(3, Math.floor(((x - rect.left) / Math.max(1, rect.width)) * 4)));
    const row = (y - rect.top) < rect.height / 2 ? 0 : 1;
    const parts = sizeParts(rec.def.size);
    const rowBand = row === 0 ? 'upper' : 'lower';
    const widths = allowedWidths(widgetsById.get(rec.def.widgetId));
    const startW = Math.max(0, widths.indexOf(parts.width));
    const widthList = [parts.width].concat(widths.slice(0, startW).reverse()); // current, then narrower
    const bandList = parts.band === 'full' ? ['full', rowBand] : [rowBand];
    const candidates = [];
    for (const band of bandList) {
      for (const width of widthList) {
        candidates.push({ size: makeSize(width, band),
          area: (WIDTH_ORDER.indexOf(width) + 1) * (band === 'full' ? 2 : 1) });
      }
    }
    candidates.sort((a, b) => b.area - a.area); // biggest footprint first
    const rest = (rec.page.slots || []).filter((d) => d !== rec.def);
    // The protected set is what was visible BEFORE the gesture, computed on the
    // FULL page: merely removing the dragged widget can let a hidden legacy slot
    // grab the freed space and knock a previously visible one off screen — a set
    // built after removal would bless exactly that swap. Hidden slots never veto.
    const beforePlaced = placedSet(rec.page.slots || []);
    let best = null;
    for (let c = 0; c < candidates.length; c++) {
      const cand = candidates[c];
      for (let i = 0; i <= rest.length; i++) {
        const probe = rest.slice();
        probe.splice(i, 0, { size: cand.size }); // placeSlots only reads .size — never mutate the live def
        const places = placeSlots(probe);
        if (places[i] === null) continue;
        if (!probe.every((d, k) => k === i || !beforePlaced.has(d) || places[k] !== null)) continue;
        // Distance from the pointed-at column to the placed SPAN (not its left
        // edge): pointing at the right half of a wide landing spot must not read
        // as "missed it" and hand the win to a smaller size.
        const right = places[i].col + places[i].w - 1;
        const dist = col < places[i].col ? places[i].col - col : (col > right ? col - right : 0);
        if (!best || dist < best.dist || (dist === best.dist && c < best.rank)) {
          best = { index: i, size: cand.size, place: places[i], dist, rank: c };
        }
      }
    }
    return best;
  }

  function showCellHint(place) {
    if (!drag.hint) {
      const el = document.createElement('div');
      el.className = 'cell-hint';
      pageEls.get(drag.record.page).appendChild(el);
      drag.hint = el;
    }
    drag.hint.style.display = '';
    drag.hint.style.gridColumn = (place.col + 1) + ' / span ' + place.w;
    drag.hint.style.gridRow = place.band === 'full' ? '1 / span 2' : place.band === 'upper' ? '1' : '2';
  }

  function trackDrag() {
    if (!drag || !drag.active || !drag.last) return;
    drag.raf = 0;
    const { x, y } = drag.last;
    drag.ghost.style.left = (x - parseFloat(drag.ghost.style.width) / 2) + 'px';
    drag.ghost.style.top = (y - parseFloat(drag.ghost.style.height) / 2) + 'px';

    let slotHit = null;
    let edgeHit = null;
    for (const el of document.elementsFromPoint(x, y)) {
      if (!slotHit && el.classList && el.classList.contains('slot') && el !== drag.record.el) slotHit = el;
      if (!edgeHit && el.classList && el.classList.contains('edge')) edgeHit = el;
    }
    const slotRec = slotHit && slots.find((s) => s.el === slotHit && s.page === drag.record.page);
    const edgeOk = edgeHit && ((edgeHit === edgeLeft && drag.canLeft) || (edgeHit === edgeRight && drag.canRight));

    clearDropHighlights();
    drag.targetSlot = null;
    drag.targetEdge = null;
    drag.targetCell = null;
    if (edgeOk) {
      // Slots reach the screen edge, so a point over the edge zone usually also hits a
      // slot beneath it — the glowing edge is what the user is aiming at, so it wins.
      drag.targetEdge = edgeHit;
      edgeHit.classList.add('drop-page');
    } else if (slotRec) {
      drag.targetSlot = slotHit;
      drag.targetSlot.classList.add('drop-target');
    } else {
      // Free space (including the "+" zone and the widget's own footprint).
      const cell = cellTargetAt(x, y);
      if (cell) {
        drag.targetCell = cell;
        showCellHint(cell.place);
      }
    }
  }

  function finishDrag(commit) {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.raf) cancelAnimationFrame(d.raf);
    if (!d.active) {
      // A tap (never crossed the drag threshold): in the settings replica that is
      // the click-to-configure gesture — select this slot for the detail panel.
      if (commit && PREVIEW && editing) selectRecord(d.record);
      return;
    }
    d.ghost.remove();
    if (d.hint) d.hint.remove();
    d.record.el.classList.remove('drag-src');
    document.body.classList.remove('dragging');
    clearDropHighlights();
    if (!commit) return;

    if (d.targetSlot) {
      const target = slots.find((s) => s.el === d.targetSlot);
      if (target && target.page === d.record.page) {
        mutate(() => {
          const defs = d.record.page.slots;
          const srcIdx = defs.indexOf(d.record.def);
          const tgtIdx = defs.indexOf(target.def);
          if (srcIdx < 0 || tgtIdx < 0) return; // either side removed while dragging
          // Dropping onto a tile in the OTHER half-height band adopts that band —
          // reorder alone would first-fit the widget straight back into its old
          // row, which reads as a bounce-back (#40).
          const srcParts = sizeParts(d.record.def.size);
          const tgtParts = sizeParts(target.def.size);
          const oldSize = d.record.def.size;
          const beforeOrder = defs.slice();
          const beforePlaced = placedSet(defs);
          if (srcParts.band !== 'full' && tgtParts.band !== 'full' && srcParts.band !== tgtParts.band)
            d.record.def.size = makeSize(srcParts.width, tgtParts.band);
          defs.splice(srcIdx, 1);
          // Dragging forward drops AFTER the target, dragging back drops BEFORE it —
          // insert-before alone would put a forward drag right back where it started.
          defs.splice(defs.indexOf(target.def) + (srcIdx < tgtIdx ? 1 : 0), 0, d.record.def);
          // If ANY slot that was visible before — the dragged one included — would
          // lose its spot, revert the WHOLE gesture: on legacy over-full pages the
          // reorder alone can hand a hidden slot the freed space and push visible
          // widgets off screen, so restoring just the size would keep the damage
          // (identity, not counts: totals can balance while widgets trade places).
          const adoptedPlaces = placeSlots(defs);
          if (!defs.every((dd, k) => !beforePlaced.has(dd) || adoptedPlaces[k] !== null)) {
            d.record.def.size = oldSize;
            defs.splice(0, defs.length, ...beforeOrder);
          }
          if (d.record.syncLabels) d.record.syncLabels();
          relayoutPage(d.record.page);
        });
      }
    } else if (d.targetCell) {
      const t = d.targetCell;
      mutate(() => {
        const defs = d.record.page.slots || [];
        const from = defs.indexOf(d.record.def);
        if (from < 0) return; // removed while dragging
        defs.splice(from, 1);
        d.record.def.size = t.size; // targetCell was validated against the live page
        defs.splice(Math.min(t.index, defs.length), 0, d.record.def);
        if (d.record.syncLabels) d.record.syncLabels();
        relayoutPage(d.record.page);
      });
    } else if (d.targetEdge) {
      const dir = d.targetEdge === edgeLeft ? -1 : 1;
      const from = d.record.page;
      const srcIdx = (from.slots || []).indexOf(d.record.def);
      const toIdx = layoutData.pages.indexOf(from) + dir;
      const to = layoutData.pages[toIdx];
      if (srcIdx >= 0 && to && pageFits(to, d.record.def)) {
        from.slots.splice(srcIdx, 1);
        to.slots.push(d.record.def);
        d.record.page = to;
        // Moving the element between pages re-navigates the iframe; treat it as a
        // fresh load so the watchdog covers it.
        d.record.initialized = false;
        d.record.retries = 0;
        pageEls.get(to).appendChild(d.record.el);
        relayoutPage(from);
        relayoutPage(to);
        armWatchdog(generation);
        persistLayout();
        goToPage(toIdx);
        updateEditBar();
      }
    }
  }

  // ---- go -------------------------------------------------------------------------

  postToHost({ type: 'ready' });
})();
