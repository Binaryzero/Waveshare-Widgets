// iCUE widget compatibility shim. Injected (with widget-api.js) into every widget
// iframe, it emulates the runtime surface iCUE widgets are written against:
//
//   - window.plugins.Sensorsdataprovider: Qt-WebChannel-style async API. Request
//     methods are called as method(requestId, ...args) and answer through the
//     asyncResponse signal; sensorValueChanged/sensorUnitsChanged push live updates.
//   - Settings are injected as global variables (matching the x-icue-property meta
//     tags that IcueManifestReader parses into the Settings UI).
//   - Lifecycle: pluginSensorsdataproviderEvents.onInitialized() then
//     icueEvents.onICUEInitialized() once the DOM is ready and the first data arrived;
//     icueEvents.onDataUpdated() when settings are re-delivered.
(function () {
  'use strict';
  if (window.top === window || window.__wwIcue) return;
  window.__wwIcue = true;

  // iCUE injects per-instance globals that widgets read at script-parse time —
  // Doodle Pad does `const widgetId = uniqueId;` unguarded, so these must exist
  // before any widget script runs. The shell tags each iframe URL with a stable
  // slot fragment so storage keyed on uniqueId survives reloads.
  if (!('uniqueId' in window)) {
    const slotTag = (location.hash.match(/ww-slot=([\w-]+)/) || [])[1] || 'slot';
    window.uniqueId = 'ww-' + location.hostname + '-' + slotTag;
  }
  if (!('iCUE_initialized' in window))
    window.iCUE_initialized = false; // flipped to true when the init events fire

  function makeSignal() {
    const callbacks = new Set();
    return {
      connect(cb) { if (typeof cb === 'function') callbacks.add(cb); },
      disconnect(cb) { callbacks.delete(cb); },
      __emit(...args) {
        for (const cb of callbacks) {
          try { cb(...args); } catch (e) { console.error('[icue-shim]', e); }
        }
      },
    };
  }

  const readings = new Map();   // sensorId -> {id, name, device, deviceType, type, units, value}
  const injected = new Set();   // property globals owned by the shim
  let initialized = false;
  let domReady = document.readyState !== 'loading';
  let gotInit = false;
  let trReady = false;

  // --- tr(): iCUE's translation function, backed by the package's translation.json ---

  let translations = null;
  if (!('tr' in window)) {
    window.tr = function (key) {
      return (translations && translations[key] != null) ? String(translations[key]) : String(key);
    };
  }
  fetch('translation.json')
    .then((r) => (r.ok ? r.json() : null))
    .then((json) => {
      if (json && typeof json === 'object') {
        // Either a flat {key: text} map or nested per-language tables.
        translations = (json.en && typeof json.en === 'object') ? json.en : json;
      }
    })
    .catch(() => { /* no translation file */ })
    .finally(() => { trReady = true; maybeInit(); });
  setTimeout(() => { if (!trReady) { trReady = true; maybeInit(); } }, 1500);

  // --- sensor type/kind translation (our LHM-style types -> iCUE's lowercase model) ---

  function typeFor(reading) {
    if (!reading) return '';
    const type = String(reading.type || '').toLowerCase();
    return type === 'control' ? 'load' : type;
  }

  function kindFor(reading) {
    if (!reading) return '';
    const name = String(reading.name || '').toLowerCase();
    const isGpu = String(reading.deviceType || '').toLowerCase().includes('gpu');
    if (reading.type === 'Load') {
      if (isGpu && name.includes('memory')) return 'memory-load';
      if (name.includes('frame buffer')) return 'frame-buffer-load';
      if (name.includes('video')) return 'video-engine-load';
      if (name.includes('bus')) return 'bus-interface-load';
      if (isGpu) return 'gpu-load';
    }
    if (reading.type === 'Fan' && name.includes('pump')) return 'pump';
    return '';
  }

  // --- the provider object ---

  const provider = {
    asyncResponse: makeSignal(),
    sensorValueChanged: makeSignal(),
    sensorUnitsChanged: makeSignal(),
    sensorAdded: makeSignal(),
    sensorRemoved: makeSignal(),
    // Called synchronously inside x-icue-property default expressions.
    getDefaultSensorIdBlock() { return []; },
  };

  function respond(requestId, value) {
    setTimeout(() => provider.asyncResponse.__emit(requestId, value), 0);
  }

  provider.getAllSensorIds = (rid) => respond(rid, [...readings.keys()]);
  provider.getSensorValue = (rid, id) => respond(rid, readings.get(id)?.value ?? null);
  provider.getSensorUnits = (rid, id) => respond(rid, readings.get(id)?.units ?? '');
  provider.getSensorName = (rid, id) => respond(rid, readings.get(id)?.name ?? '');
  provider.getSensorDeviceName = (rid, id) => respond(rid, readings.get(id)?.device ?? '');
  provider.getSensorType = (rid, id) => respond(rid, typeFor(readings.get(id)));
  provider.getSensorKind = (rid, id) => respond(rid, kindFor(readings.get(id)));
  provider.sensorIsConnected = (rid, id) => respond(rid, readings.has(id));

  window.plugins = window.plugins || {};
  window.plugins.Sensorsdataprovider = provider;
  window.pluginSensorsdataprovider_initialized = true;

  // Link provider: iCUE opens URLs on the desktop; we ask the host to do the same.
  window.plugins.Linkprovider = {
    open(url) { parent.postMessage({ type: 'ww-open-url', url: String(url) }, '*'); },
  };
  window.pluginLinkprovider_initialized = true;

  // --- fetch fallback: iCUE's runtime is CORS-relaxed, standards WebView2 is not.
  // Try the normal fetch first; when it fails at the network/CORS layer, retry the
  // request through the host process, which is not subject to browser CORS.
  const nativeFetch = window.fetch.bind(window);
  const pendingFetches = new Map();
  let fetchSeq = 0;

  function proxyableUrl(input) {
    try {
      const url = new URL(typeof input === 'string' ? input : (input && input.url) || '', location.href);
      if ((url.protocol === 'http:' || url.protocol === 'https:') &&
          !url.hostname.endsWith('.wsw') && url.origin !== location.origin)
        return url.href;
    } catch (e) { /* unparseable */ }
    return null;
  }

  window.fetch = function (input, init) {
    return nativeFetch(input, init).then((response) => {
      // Bot walls (Reddit's in particular) sometimes serve their block page WITH
      // CORS headers, so the request "succeeds" as a 403/429; retry via the host.
      const url = (response.status === 403 || response.status === 429) && proxyableUrl(input);
      return url ? proxyFetch(url, init || {}).catch(() => response) : response;
    }, (error) => {
      const url = proxyableUrl(input);
      if (!url) throw error;
      return proxyFetch(url, init || {});
    });
  };

  function proxyFetch(url, init) {
    return new Promise((resolve, reject) => {
      const id = 'f' + (++fetchSeq) + '-' + Math.floor(performance.now());
      pendingFetches.set(id, { resolve, reject });
      setTimeout(() => {
        if (pendingFetches.delete(id)) reject(new TypeError('proxy fetch timed out'));
      }, 25000);
      parent.postMessage({
        type: 'ww-fetch',
        id,
        url,
        method: (init.method || 'GET').toUpperCase(),
        body: typeof init.body === 'string' ? init.body : null,
        contentType: contentTypeOf(init.headers),
      }, '*');
    });
  }

  function contentTypeOf(headers) {
    if (!headers) return null;
    try {
      if (typeof headers.get === 'function') return headers.get('content-type');
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'content-type') return headers[key];
      }
    } catch (e) { /* opaque headers */ }
    return null;
  }

  function onFetchResult(msg) {
    const pending = pendingFetches.get(msg.id);
    if (!pending) return;
    pendingFetches.delete(msg.id);
    if (msg.error) {
      pending.reject(new TypeError('proxy fetch failed: ' + msg.error));
      return;
    }
    let bytes = new Uint8Array(0);
    if (msg.bodyBase64) {
      const raw = atob(msg.bodyBase64);
      bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    }
    pending.resolve(new Response(bytes, {
      status: msg.status || 200,
      statusText: msg.statusText || '',
      headers: msg.contentType ? { 'Content-Type': msg.contentType } : {},
    }));
  }

  // --- settings -> globals (like iCUE's property injection) ---

  function setPropertyGlobals(settings) {
    for (const [name, value] of Object.entries(settings || {})) {
      if (value === undefined || value === null) continue;
      // Never clobber real window members (location, name, ...) we did not create.
      if (name in window && !injected.has(name)) continue;
      try {
        window[name] = value;
        injected.add(name);
      } catch (e) { /* non-writable */ }
    }
  }

  // --- sensor snapshot handling ---

  function applySensors(list, quiet) {
    const previous = new Map(readings);
    readings.clear();
    for (const reading of list || []) readings.set(reading.id, reading);
    if (quiet) return;

    for (const [id, reading] of readings) {
      const old = previous.get(id);
      if (!old) provider.sensorAdded.__emit(id);
      if (!old || old.value !== reading.value) provider.sensorValueChanged.__emit(id, reading.value);
      if (old && old.units !== reading.units) provider.sensorUnitsChanged.__emit(id, reading.units);
    }
    for (const id of previous.keys()) {
      if (!readings.has(id)) provider.sensorRemoved.__emit(id);
    }
  }

  // --- lifecycle ---

  // Fire the iCUE init events only after: the first settings/sensor delivery arrived,
  // the DOM is parsed (widgets assign icueEvents in body scripts), and translations
  // finished loading (or timed out) so tr() is meaningful during first render.
  function maybeInit() {
    if (initialized || !gotInit || !domReady || !trReady) return;
    initialized = true;
    window.iCUE_initialized = true;
    try { window.pluginSensorsdataproviderEvents?.onInitialized?.(); } catch (e) { console.error('[icue-shim]', e); }
    try { window.pluginLinkproviderEvents?.onInitialized?.(); } catch (e) { console.error('[icue-shim]', e); }
    try { window.icueEvents?.onICUEInitialized?.(); } catch (e) { console.error('[icue-shim]', e); }
  }

  window.addEventListener('message', (ev) => {
    const msg = ev.data || {};
    if (msg.type === 'ww-init') {
      setPropertyGlobals(msg.settings);
      applySensors(msg.sensors, !initialized);
      if (initialized) {
        try { window.icueEvents?.onDataUpdated?.(); } catch (e) { console.error('[icue-shim]', e); }
      } else {
        gotInit = true;
        maybeInit();
      }
    } else if (msg.type === 'ww-sensors' && initialized) {
      applySensors(msg.sensors, false);
    } else if (msg.type === 'ww-fetch-result') {
      onFetchResult(msg);
    }
  });

  if (!domReady) {
    document.addEventListener('DOMContentLoaded', () => {
      domReady = true;
      maybeInit();
    });
  }
})();
