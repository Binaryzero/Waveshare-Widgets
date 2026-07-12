// Dashboard shell: receives host messages over the WebView2 bridge, lays out the
// configured pages/slots as per-widget iframes, and relays sensor/media data to them.
(function () {
  'use strict';

  const pagesEl = document.getElementById('pages');
  const dotsEl = document.getElementById('dots');
  const emptyEl = document.getElementById('empty');

  /** @type {{frame: HTMLIFrameElement, settings: object, initialized: boolean}[]} */
  let slots = [];
  let latestSensors = [];
  let latestMedia = null;
  let status = { elevated: false, apiVersion: 1 };
  let dotsIdleTimer = null;

  // ---- host bridge -----------------------------------------------------------

  window.chrome.webview.addEventListener('message', (ev) => {
    const msg = ev.data || {};
    if (msg.type === 'init') onInit(msg.data);
    else if (msg.type === 'sensors') { latestSensors = msg.data || []; broadcast({ type: 'ww-sensors', sensors: latestSensors }); }
    else if (msg.type === 'media') { latestMedia = msg.data; broadcast({ type: 'ww-media', media: latestMedia }); }
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
      if (slot && !slot.initialized) {
        slot.initialized = true;
        sendToSlot(slot, initMessage(slot));
      }
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
    for (const page of pages) {
      const pageEl = document.createElement('section');
      pageEl.className = 'page';

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
          frame.src = widget.url;
          slotEl.appendChild(frame);
          slots.push({ frame, settings: mergedSettings(widget, slotDef), initialized: false });
          slotCount++;
        }
        pageEl.appendChild(slotEl);
      }
      pagesEl.appendChild(pageEl);

      const dot = document.createElement('span');
      dotsEl.appendChild(dot);
    }

    emptyEl.hidden = slotCount > 0 || pages.length > 0;
    updateDots();
  }

  function mergedSettings(widget, slotDef) {
    const settings = {};
    for (const prop of widget.properties || []) {
      if (prop.name) settings[prop.name] = prop.default;
    }
    Object.assign(settings, slotDef.settings || {});
    return settings;
  }

  // ---- page dots ----------------------------------------------------------------

  function updateDots() {
    const index = Math.round(pagesEl.scrollLeft / Math.max(1, pagesEl.clientWidth));
    [...dotsEl.children].forEach((dot, i) => dot.classList.toggle('active', i === index));

    dotsEl.classList.remove('idle');
    clearTimeout(dotsIdleTimer);
    dotsIdleTimer = setTimeout(() => dotsEl.classList.add('idle'), 2500);
  }

  pagesEl.addEventListener('scroll', updateDots, { passive: true });

  // ---- go -------------------------------------------------------------------------

  postToHost({ type: 'ready' });
})();
