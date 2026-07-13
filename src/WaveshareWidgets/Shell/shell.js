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
  let status = { elevated: false, apiVersion: 1 };
  let dotsIdleTimer = null;
  let generation = 0;          // invalidates watchdogs from a previous layout
  const fetchRoutes = new Map(); // proxy-fetch id -> widget iframe window

  // ---- host bridge -----------------------------------------------------------

  window.chrome.webview.addEventListener('message', (ev) => {
    const msg = ev.data || {};
    if (msg.type === 'init') onInit(msg.data);
    else if (msg.type === 'sensors') { latestSensors = msg.data || []; broadcast({ type: 'ww-sensors', sensors: latestSensors }); }
    else if (msg.type === 'media') { latestMedia = msg.data; broadcast({ type: 'ww-media', media: latestMedia }); }
    else if (msg.type === 'fetch-result') {
      const target = fetchRoutes.get(msg.data && msg.data.id);
      if (target) {
        fetchRoutes.delete(msg.data.id);
        try { target.postMessage({ type: 'ww-fetch-result', ...msg.data }, '*'); } catch (e) { /* frame gone */ }
      }
    } else if (msg.type === 'sd-profile-result') {
      broadcast({ type: 'ww-sd-profile', profile: msg.data });
    }
  });

  function postToHost(message) {
    window.chrome.webview.postMessage(message);
  }

  // ---- widget iframe bridge ---------------------------------------------------

  window.addEventListener('message', (ev) => {
    const msg = ev.data || {};
    if (msg.type === 'ww-media-control' && typeof msg.action === 'string') {
      postToHost({ type: 'media-control', action: msg.action });
    } else if (msg.type === 'ww-log') {
      postToHost({ type: 'log', message: String(msg.message).slice(0, 2000) });
    } else if (msg.type === 'ww-ready') {
      const slot = slots.find((s) => s.frame.contentWindow === ev.source);
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
      postToHost({ type: 'sd-profile', profileName: msg.profileName || '', hideWindow: msg.hideWindow !== false });
    } else if (msg.type === 'ww-sd-click') {
      postToHost({ type: 'sd-click', row: msg.row | 0, col: msg.col | 0, rows: msg.rows | 0, cols: msg.cols | 0 });
    } else if (msg.type === 'ww-fetch' && msg.id) {
      fetchRoutes.set(msg.id, ev.source);
      setTimeout(() => fetchRoutes.delete(msg.id), 30000);
      postToHost({ type: 'fetch', id: msg.id, url: msg.url, method: msg.method, body: msg.body, contentType: msg.contentType });
    }
  });

  function initMessage(slot) {
    return {
      type: 'ww-init',
      settings: slot.settings,
      sensors: latestSensors,
      media: latestMedia,
      status,
    };
  }

  function sendToSlot(slot, message) {
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

  function onInit(data) {
    latestSensors = data.sensors || [];
    latestMedia = data.media;
    status = data.status || status;

    const widgetsById = new Map((data.widgets || []).map((w) => [w.id, w]));
    const pages = (data.layout && data.layout.pages) || [];

    pagesEl.textContent = '';
    dotsEl.textContent = '';
    slots = [];

    let slotCount = 0;
    let pageIndexCounter = 0;
    for (const page of pages) {
      const pageEl = document.createElement('section');
      pageEl.className = 'page';
      const pageIdx = pageIndexCounter++;
      let slotIdx = 0;

      for (const slotDef of page.slots || []) {
        const slotEl = document.createElement('div');
        slotEl.className = `slot ${['quarter', 'half', 'full'].includes(slotDef.size) ? slotDef.size : 'quarter'}`;

        const widget = widgetsById.get(slotDef.widgetId);
        if (!widget) {
          const err = document.createElement('div');
          err.className = 'error';
          err.textContent = `Widget "${slotDef.widgetId}" is not installed`;
          slotEl.appendChild(err);
        } else {
          const frame = document.createElement('iframe');
          // allow-same-origin is safe here: each widget is served from its own
          // virtual host, so widgets cannot reach the shell's or each other's origin.
          frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
          // Fragment carries a stable per-slot tag (backs the iCUE `uniqueId` global)
          // plus this slot's merged settings, so the shim can inject property globals
          // BEFORE widget scripts run — matching iCUE's documented injection timing.
          const settings = mergedSettings(widget, slotDef);
          let slotHash = '#ww-slot=p' + pageIdx + 's' + (slotIdx++);
          try {
            slotHash += '&ww-settings=' + encodeURIComponent(JSON.stringify(settings));
          } catch (e) { /* unserializable settings: init delivery still applies them */ }
          frame.src = widget.url + slotHash;
          slotEl.appendChild(frame);
          slots.push({
            frame, el: slotEl, url: widget.url, hash: slotHash,
            settings, initialized: false, retries: 0,
          });
          slotCount++;
        }
        pageEl.appendChild(slotEl);
      }
      pagesEl.appendChild(pageEl);

      const dot = document.createElement('span');
      const pageIndex = dotsEl.children.length;
      dot.addEventListener('click', () => goToPage(pageIndex));
      dotsEl.appendChild(dot);
    }

    emptyEl.hidden = slotCount > 0 || pages.length > 0;
    updateDots();

    generation++;
    armWatchdog(generation);
  }

  // Widget loads can flake (virtual-host races, heavy first paints); retry stragglers
  // a couple of times before declaring them failed.
  function armWatchdog(gen) {
    setTimeout(() => {
      if (gen !== generation) return;
      let retrying = false;
      for (const slot of slots) {
        if (slot.initialized) continue;
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

  function goToPage(index) {
    const count = dotsEl.children.length;
    const clamped = Math.max(0, Math.min(count - 1, index));
    pagesEl.scrollTo({ left: clamped * pagesEl.clientWidth, behavior: 'smooth' });
    wakeChrome();
  }

  function wakeChrome() {
    for (const el of [dotsEl, edgeLeft, edgeRight]) el.classList.remove('idle');
    clearTimeout(dotsIdleTimer);
    dotsIdleTimer = setTimeout(() => {
      for (const el of [dotsEl, edgeLeft, edgeRight]) el.classList.add('idle');
    }, 2500);
  }

  function updateDots() {
    const index = currentPage();
    [...dotsEl.children].forEach((dot, i) => dot.classList.toggle('active', i === index));
    wakeChrome();
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

  // ---- go -------------------------------------------------------------------------

  postToHost({ type: 'ready' });
})();
