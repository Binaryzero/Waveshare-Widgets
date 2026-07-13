// iCUE widget compatibility shim (Widget API 1.4.0 surface). Injected (with
// widget-api.js) into every widget iframe, it emulates the runtime surface iCUE
// widgets are written against, per the official plugin references:
//
//   - Injected globals BEFORE widget scripts run: property values (via the
//     #ww-settings URL fragment), uniqueId (per-instance storage key), device
//     ({deviceId}), the iCUE utility object, plugin objects on window.plugins,
//     and plugin<Name>_initialized flags. iCUE_initialized flips true when the
//     lifecycle events fire (the documented late-load path).
//   - Plugins: Sensorsdataprovider (full contract: requestId/asyncResponse,
//     change signals, default-sensor lookup, documented type/kind vocabulary),
//     Mediadataprovider (song/artist + transport triggers), Linkprovider,
//     plus Fpsdataprovider/Deviceactionprovider stubs that report no data so
//     dependent widgets degrade instead of hanging.
//   - Lifecycle: plugin<Name>Events.onInitialized() then icueEvents.onICUEInitialized()
//     once DOM + first data + translations are ready; icueEvents.onDataUpdated() on
//     settings re-delivery.
//   - CORS relief: fetch falls back to a host-proxied request when the network
//     layer (or a bot wall serving 403/429 with CORS headers) blocks it.
(function () {
  'use strict';
  if (window.top === window || window.__wwIcue) return;
  window.__wwIcue = true;

  // --- instance identity + early globals (must exist before widget scripts) ---

  const slotTag = (location.hash.match(/ww-slot=([\w-]+)/) || [])[1] || 'slot';

  if (!('uniqueId' in window))
    window.uniqueId = 'ww-' + location.hostname + '-' + slotTag;
  if (!('iCUE_initialized' in window))
    window.iCUE_initialized = false; // flipped to true when the init events fire

  function pseudoUuid(seed) {
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < seed.length; i++) {
      h1 = Math.imul(h1 ^ seed.charCodeAt(i), 0x01000193) >>> 0;
      h2 = Math.imul(h2 + seed.charCodeAt(i), 0x85ebca6b) >>> 0;
    }
    const hex = (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).repeat(2);
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
           hex.slice(16, 20) + '-' + hex.slice(20, 32);
  }

  window.device = window.device || { deviceId: pseudoUuid(location.hostname + slotTag) };

  window.iCUE = window.iCUE || {
    iCUELanguage: (navigator.language || 'en').split('-')[0],
    fpsLimit: 30,
    isPreview: false,
    widgetId: window.uniqueId,
    defaultTemperatureUnit() {
      return /^en-(us|bs|bz|ky|pw|pr)/i.test(navigator.language || '') ? '°F' : '°C';
    },
  };

  const readings = new Map();   // sensorId -> {id, name, device, deviceType, type, units, value}
  const injected = new Set();   // property globals owned by the shim
  let initialized = false;
  let domReady = document.readyState !== 'loading';
  let gotInit = false;
  let trReady = false;

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

  // Spec parity: iCUE injects property values before widget scripts execute. The
  // shell passes this slot's merged settings in the URL fragment for that reason.
  try {
    const encoded = (location.hash.match(/ww-settings=([^&]+)/) || [])[1];
    if (encoded) setPropertyGlobals(JSON.parse(decodeURIComponent(encoded)));
  } catch (e) { /* fall back to ww-init delivery */ }

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

  // --- Qt-style signals ---

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

  // --- sensor type/kind translation (our LHM-style types -> iCUE's documented model) ---

  function typeFor(reading) {
    if (!reading) return '';
    if (reading.type === 'Level' && reading.id.startsWith('corsair:')) return 'battery-charge';
    const type = String(reading.type || '').toLowerCase();
    return type === 'control' || type === 'level' ? 'load' : type;
  }

  function kindFor(reading) {
    if (!reading) return '';
    const name = String(reading.name || '').toLowerCase();
    const deviceType = String(reading.deviceType || '').toLowerCase();
    const isGpu = deviceType.includes('gpu');
    const isCpu = deviceType.includes('cpu');
    if (reading.type === 'Temperature') {
      if (isCpu) return /core #/.test(name) ? 'core' : name.includes('package') ? 'package' : 'cpu-temp';
      if (isGpu) return 'gpu-temp';
      return 'default';
    }
    if (reading.type === 'Load') {
      if (isGpu && name.includes('memory')) return 'memory-load';
      if (name.includes('frame buffer')) return 'frame-buffer-load';
      if (name.includes('video')) return 'video-engine-load';
      if (name.includes('bus')) return 'bus-interface-load';
      if (isGpu) return 'gpu-load';
      return 'default';
    }
    if (reading.type === 'Fan' && name.includes('pump')) return 'cpu-pump';
    return 'default';
  }

  function defaultSensorId(sensorType, preferredKind) {
    const all = [...readings.values()];
    if (preferredKind) {
      const both = all.find((r) => typeFor(r) === sensorType && kindFor(r) === preferredKind);
      if (both) return both.id;
    }
    const typeOnly = all.find((r) => typeFor(r) === sensorType);
    if (typeOnly) return typeOnly.id;
    return all.length ? all[0].id : '';
  }

  // --- Sensorsdataprovider ---

  const sensors = {
    asyncResponse: makeSignal(),
    sensorValueChanged: makeSignal(),
    sensorUnitsChanged: makeSignal(),
    sensorDataChanged: makeSignal(),
    sensorAdded: makeSignal(),
    sensorRemoved: makeSignal(),
    // Documented blocking call: returns the best-match sensor id synchronously.
    getDefaultSensorIdBlock(sensorType, preferredKind) {
      return defaultSensorId(String(sensorType || ''), String(preferredKind || ''));
    },
  };

  function respond(signal, requestId, value) {
    setTimeout(() => signal.__emit(requestId, value), 0);
  }

  // Per spec, sensor values transport as strings.
  sensors.getAllSensorIds = (rid) => respond(sensors.asyncResponse, rid, [...readings.keys()]);
  sensors.getSensorValue = (rid, id) => {
    const v = readings.get(id)?.value;
    respond(sensors.asyncResponse, rid, v == null ? '' : String(v));
  };
  sensors.getSensorUnits = (rid, id) => respond(sensors.asyncResponse, rid, readings.get(id)?.units ?? '');
  sensors.getSensorName = (rid, id) => respond(sensors.asyncResponse, rid, readings.get(id)?.name ?? '');
  sensors.getSensorDeviceName = (rid, id) => respond(sensors.asyncResponse, rid, readings.get(id)?.device ?? '');
  sensors.getSensorType = (rid, id) => respond(sensors.asyncResponse, rid, typeFor(readings.get(id)));
  sensors.getSensorKind = (rid, id) => respond(sensors.asyncResponse, rid, kindFor(readings.get(id)));
  sensors.sensorIsConnected = (rid, id) => respond(sensors.asyncResponse, rid, readings.has(id));
  sensors.getDefaultSensorId = (rid, sensorType, preferredKind) =>
    respond(sensors.asyncResponse, rid, defaultSensorId(String(sensorType || ''), String(preferredKind || '')));

  // --- Mediadataprovider (backed by the host's media session pipeline) ---

  const media = {
    asyncResponse: makeSignal(),
    songName: '',
    artist: '',
    getSongName(rid) { respond(media.asyncResponse, rid, media.songName); },
    getArtist(rid) { respond(media.asyncResponse, rid, media.artist); },
    triggerPlayPause() { parent.postMessage({ type: 'ww-media-control', action: 'toggle' }, '*'); },
    triggerNextTrack() { parent.postMessage({ type: 'ww-media-control', action: 'next' }, '*'); },
    triggerPreviousTrack() { parent.postMessage({ type: 'ww-media-control', action: 'prev' }, '*'); },
  };

  function applyMedia(state) {
    media.songName = (state && state.title) || '';
    media.artist = (state && state.artist) || '';
  }

  // --- Fpsdataprovider / Deviceactionprovider: honest no-data stubs ---

  const fps = {
    asyncResponse: makeSignal(),
    fpsUpdated: makeSignal(),
    fpsAvailabilityChanged: makeSignal(),
    processChanged: makeSignal(),
    currentFps: 0,
    fpsAvailable: false,
    currentProcess: '',
    getCurrentFps(rid) { respond(fps.asyncResponse, rid, 0); },
    getFpsAvailable(rid) { respond(fps.asyncResponse, rid, false); },
    getCurrentProcess(rid) { respond(fps.asyncResponse, rid, ''); },
  };

  const deviceAction = {
    dialTriggered: makeSignal(), // never emitted (matches documented preview-mode behavior)
    initDevice() { /* no dials on this panel */ },
  };

  // --- Linkprovider ---

  const link = {
    open(url) { parent.postMessage({ type: 'ww-open-url', url: String(url) }, '*'); },
  };

  window.plugins = window.plugins || {};
  window.plugins.Sensorsdataprovider = sensors;
  window.plugins.Mediadataprovider = media;
  window.plugins.Fpsdataprovider = fps;
  window.plugins.Deviceactionprovider = deviceAction;
  window.plugins.Linkprovider = link;
  window.pluginSensorsdataprovider_initialized = true;
  window.pluginMediadataprovider_initialized = true;
  window.pluginFpsdataprovider_initialized = true;
  window.pluginDeviceactionprovider_initialized = true;
  window.pluginLinkprovider_initialized = true;

  // --- fetch fallback: iCUE's runtime is CORS-relaxed, standards WebView2 is not ---

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

  // --- sensor snapshot handling ---

  function applySensors(list, quiet) {
    const previous = new Map(readings);
    readings.clear();
    for (const reading of list || []) readings.set(reading.id, reading);
    if (quiet) return;

    for (const [id, reading] of readings) {
      const old = previous.get(id);
      if (!old) sensors.sensorAdded.__emit(id);
      if (!old || old.value !== reading.value) {
        sensors.sensorValueChanged.__emit(id, reading.value == null ? '' : String(reading.value));
        sensors.sensorDataChanged.__emit(id);
      }
      if (old && old.units !== reading.units) sensors.sensorUnitsChanged.__emit(id, reading.units);
    }
    for (const id of previous.keys()) {
      if (!readings.has(id)) sensors.sensorRemoved.__emit(id);
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
    const fire = (fn) => { try { fn && fn(); } catch (e) { console.error('[icue-shim]', e); } };
    fire(window.pluginSensorsdataproviderEvents?.onInitialized);
    fire(window.pluginMediadataproviderEvents?.onInitialized);
    fire(window.pluginFpsdataproviderEvents?.onInitialized);
    fire(window.pluginDeviceactionproviderEvents?.onInitialized);
    fire(window.pluginLinkproviderEvents?.onInitialized);
    fire(window.icueEvents?.onICUEInitialized);
  }

  window.addEventListener('message', (ev) => {
    const msg = ev.data || {};
    if (msg.type === 'ww-init') {
      setPropertyGlobals(msg.settings);
      applySensors(msg.sensors, !initialized);
      applyMedia(msg.media);
      if (initialized) {
        try { window.icueEvents?.onDataUpdated?.(); } catch (e) { console.error('[icue-shim]', e); }
      } else {
        gotInit = true;
        maybeInit();
      }
    } else if (msg.type === 'ww-sensors' && initialized) {
      applySensors(msg.sensors, false);
    } else if (msg.type === 'ww-media') {
      applyMedia(msg.media);
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
