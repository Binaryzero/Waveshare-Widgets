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

    renderAll();
  }

  function renderAll() {
    cancelDrag();   // a re-init mid-drag must not orphan the ghost / dragging state
    closePalette(); // palette entries capture page objects this rebuild replaces
    closeStyleEditor(false); // its record is about to be replaced
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
    if (PREVIEW && editing) postToHost({ type: 'page-changed', index: clamped });
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
    document.getElementById('editDone').style.display = 'none';
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
      instanceId: (selected && selected.def.instanceId) || null });
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
    postToHost({ type: 'save-layout', layout: layoutData });
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
    if (on && layoutData.pages.length === 0) {
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

  function movePage(delta) {
    const i = editIndex();
    const j = i + delta;
    if (j < 0 || j >= layoutData.pages.length) return;
    const [page] = layoutData.pages.splice(i, 1);
    layoutData.pages.splice(j, 0, page);
    syncPageOrder(); refreshBgSpecs();
    persistLayout();
    goToPage(j);
    updateEditBar();
  }
  document.getElementById('pageMoveLeft').addEventListener('click', () => movePage(-1));
  document.getElementById('pageMoveRight').addEventListener('click', () => movePage(1));

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
    size.addEventListener('click', (ev) => { ev.stopPropagation(); cycleWidth(record, syncLabels); });
    band.addEventListener('click', (ev) => { ev.stopPropagation(); cycleBand(record, syncLabels); });
    ov.appendChild(size);
    ov.appendChild(band);

    if (widget) {
      const style = document.createElement('button');
      style.className = 'style';
      style.textContent = '🎨';
      style.title = 'Style this widget';
      style.addEventListener('click', (ev) => { ev.stopPropagation(); openStyleEditor(record); });
      ov.appendChild(style);
    }

    bindDrag(ov, record);
    return ov;
  }

  function removeSlot(record) {
    if (drag && drag.record === record) cancelDrag(); // removed out from under a drag
    if (styleTarget === record) closeStyleEditor(false);
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

  // Would every slot on the page still fit if `def` had `size`?
  function fitsWithSize(page, def, size) {
    const original = def.size;
    def.size = size;
    const ok = placeSlots(page.slots || []).every((p) => p !== null);
    def.size = original;
    return ok;
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

  // ---- add widget (palette) --------------------------------------------------------

  function defaultSizeFor(page, widget) {
    const widths = allowedWidths(widget).slice().reverse(); // widest first, shrink into the hole
    const probe = { widgetId: widget.id, size: 'quarter', settings: {} };
    (page.slots = page.slots || []).push(probe);
    let found = null;
    outer:
    for (const band of ['full', 'upper', 'lower']) {
      for (const w of widths) {
        probe.size = makeSize(w, band);
        if (placeSlots(page.slots).every((p) => p !== null)) { found = probe.size; break outer; }
      }
    }
    page.slots.pop();
    return found;
  }

  function openPalette(page) {
    cancelDrag(); // a second finger can reach the add-zone while a drag holds
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
      buildSlot(page, def);
      relayoutPage(page);
      armWatchdog(generation);
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
      drag = { record, pointerId: ev.pointerId, startX: ev.clientX, startY: ev.clientY, active: false, ghost: null, raf: 0, last: null, targetSlot: null, targetEdge: null, canLeft: false, canRight: false };
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

  function pageFits(page, def) {
    (page.slots = page.slots || []).push(def);
    const ok = placeSlots(page.slots).every((p) => p !== null);
    page.slots.pop();
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
    if (edgeOk) {
      // Slots reach the screen edge, so a point over the edge zone usually also hits a
      // slot beneath it — the glowing edge is what the user is aiming at, so it wins.
      drag.targetSlot = null;
      drag.targetEdge = edgeHit;
      edgeHit.classList.add('drop-page');
    } else {
      drag.targetSlot = slotRec ? slotHit : null;
      drag.targetEdge = null;
      if (drag.targetSlot) drag.targetSlot.classList.add('drop-target');
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
          defs.splice(srcIdx, 1);
          // Dragging forward drops AFTER the target, dragging back drops BEFORE it —
          // insert-before alone would put a forward drag right back where it started.
          defs.splice(defs.indexOf(target.def) + (srcIdx < tgtIdx ? 1 : 0), 0, d.record.def);
          relayoutPage(d.record.page);
        });
      }
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
