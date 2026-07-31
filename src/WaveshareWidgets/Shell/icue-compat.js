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
  // Only iCUE packages carry translation.json — fetching it unconditionally put a
  // FILE_NOT_FOUND console line into every stock widget on every load (#36). The
  // reliable tell for an iCUE package is its x-icue-* meta declarations, so wait
  // for the DOM and fetch only when they are present.
  function loadTranslations() {
    // An iCUE package WITHOUT a translation.json 404s this probe on every single
    // load — with per-widget re-inits that reads as endless console spam (#36).
    // Remember the miss for the session and skip the fetch. Keyed per DOCUMENT
    // PATH, not per origin: several documents can share an origin (the shell and
    // settings pages both live on app.wsw) and one document's miss must never
    // suppress another's real translation file.
    let missKey = null;
    try {
      missKey = 'ww-tr-missing:' + location.pathname;
      if (sessionStorage.getItem(missKey) === '1') { trReady = true; maybeInit(); return; }
    } catch (e) { missKey = null; /* storage unavailable: probe as before */ }
    fetch('translation.json')
      .then((r) => {
        if (r.ok) return r.json();
        if (missKey) { try { sessionStorage.setItem(missKey, '1'); } catch (e) { /* ignore */ } }
        return null;
      })
      .then((json) => {
        if (json && typeof json === 'object') {
          // Either a flat {key: text} map or nested per-language tables.
          translations = (json.en && typeof json.en === 'object') ? json.en : json;
        }
      })
      // A rejected fetch is NOT a missing file: transient navigation/network
      // failures must stay retryable, or one hiccup mutes translations for the
      // whole session. Only the definitive not-ok response above memoizes.
      .catch(() => { /* transient failure: no memo, retry on next load */ })
      .finally(() => { trReady = true; maybeInit(); });
    setTimeout(() => { if (!trReady) { trReady = true; maybeInit(); } }, 1500);
  }
  function armTranslations() {
    // iCUE packages may use tr() + translation.json WITHOUT declaring any property
    // metas (translations are documented independently in ICUE-API-REFERENCE), so
    // metas alone can't gate the fetch. The reliable NEGATIVE tell is our own
    // widget-api script tag — native widgets carry it, iCUE packages never do.
    const icueMetas = document.querySelector('meta[name="x-icue-property"], meta[name="x-icue-groups"]');
    const nativeApi = document.querySelector('script[src*="widget-api.js"]');
    if (icueMetas || !nativeApi) loadTranslations();
    else { trReady = true; maybeInit(); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', armTranslations);
  else armTranslations();

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

  // Mirrors WW.fetch's escalation exactly (issue #37 — the shim's relief must
  // give marketplace widgets the same treatment stock widgets get):
  //  - a native fetch that failed once marks the origin proxy-first for the
  //    session, so repeat polls skip the doomed browser attempt;
  //  - the proxy hop forwards the request HEADERS. iCUE widgets authenticate
  //    through plain window.fetch, and dropping an Authorization header on the
  //    hop turns a private feed into a bot-wall-looking 403 no proxy tier can
  //    rescue (the field's readit multireddit).
  window.fetch = function (input, init) {
    const url = proxyableUrl(input);
    let memoKey = null;
    let remembered = false;
    if (url) {
      try {
        memoKey = 'ww-proxy-first:' + new URL(url).origin;
        remembered = sessionStorage.getItem(memoKey) === '1';
      } catch (e) { memoKey = null; /* storage unavailable */ }
    }
    // fetch(new Request(...)) carries method/headers/body ON THE INPUT: read
    // the proxy-relevant bits off the Request — init fields overriding per
    // spec — so an escalated request keeps its method and headers instead of
    // degrading to a headerless GET (Codex, round 3). Headers serialize NOW:
    // native fetch snapshots its headers at call time, and the async
    // escalation must retry what was actually SENT — not whatever the caller
    // mutated the live Headers object into since (Codex, round 5).
    const req = (input && typeof input === 'object' && typeof input.url === 'string') ? input : null;
    const initBody = (init && init.body != null) ? init.body : null;
    const rawHeaders = (init && init.headers) || (req && req.headers) || null;
    const effSignal = (init && init.signal) || (req && req.signal) || null;
    const eff = {
      method: (init && init.method) || (req && req.method) || 'GET',
      contentType: contentTypeOf(rawHeaders),
      headers: headersToObject(rawHeaders),
      body: typeof initBody === 'string' ? initBody : null,
    };
    // The proxy can faithfully replay only string (or empty) bodies — a
    // FormData/Blob/URLSearchParams POST must keep LEADING with the native
    // attempt: it reaches the server even when its response is CORS-blocked,
    // and routing it proxy-first would silently send an empty body instead.
    // A Request's own body is a one-shot stream that can't be inspected here,
    // so any non-GET/HEAD Request without an overriding init body may carry one.
    const effMethod = String(eff.method || 'GET').toUpperCase();
    // A Request whose body accessor is observably null carries NO body — a
    // bodyless POST/PUT keeps full proxy relief (Codex, round 9). Only when
    // the accessor is missing does the method stay the conservative signal.
    const mayCarryStreamBody = !!req && initBody == null && effMethod !== 'GET' && effMethod !== 'HEAD' &&
      !(('body' in req) && req.body === null);
    const replayable = !mayCarryStreamBody && (initBody == null || typeof initBody === 'string');
    // An already-aborted request must reject with AbortError no matter what
    // the memo says (Codex, round 5 — the memo branch ran before the abort
    // check): the native path answers that correctly and touches no network.
    if (effSignal && effSignal.aborted) return nativeFetch(input, init);
    // Requests that lean on the browser's ambient cookies (credentials:
    // 'include') stay native-first: the host strips Cookie by design, and an
    // unauthenticated proxy hop can even 200 on a login-page redirect — a
    // wrong answer no status check can catch (Codex, round 7).
    const credentialed = (((init && init.credentials) || (req && req.credentials)) === 'include');
    if (url && remembered && replayable && !credentialed) {
      // Memory can go stale two ways: the proxy TRANSPORT failing (CORS fixed
      // upstream), and the proxy being the wrong PATH for this request — an
      // auth-shaped 401/403 answer may just mean the request needed the
      // browser's ambient cookies, which never cross the proxy hop (the host
      // rejects forwarded Cookie headers by design). Retry native for those
      // and keep the proxy's answer when the native path can't do better.
      return proxyFetch(url, eff, effSignal).then((response) => {
        if (response.status !== 401 && response.status !== 403) return response;
        return nativeFetch(input, init).then(
          (native) => (native.ok ? native : response),
          (err) => {
            // A mid-retry abort is the caller's cancellation, never masked.
            if (err && err.name === 'AbortError') throw err;
            return response;
          });
      }, (err) => {
        if (err && err.name === 'AbortError') throw err;
        return nativeFetch(input, init);
      });
    }
    return nativeFetch(input, init).then((response) => {
      // Bot walls (Reddit's in particular) sometimes serve their block page WITH
      // CORS headers, so the request "succeeds" as a 403/429; retry via the host
      // — but only when the proxy can replay the request faithfully.
      return (response.status === 403 || response.status === 429) && url && replayable
        ? proxyFetch(url, eff, effSignal).catch((err) => {
            // An abort during the retry is the caller's cancellation — it must
            // surface, never be masked by the original bot-wall response.
            if (err && err.name === 'AbortError') throw err;
            return response;
          })
        : response;
    }, (error) => {
      if (!url) throw error;
      // A caller-initiated abort is not a network failure: no memo, no
      // escalation — a cancellation is the caller's intent (Codex, r4).
      if ((error && error.name === 'AbortError') || (effSignal && effSignal.aborted)) throw error;
      // A browser-level failure (CORS, mixed content, TLS) repeats forever.
      if (memoKey) { try { sessionStorage.setItem(memoKey, '1'); } catch (e) { /* storage off */ } }
      // The native attempt may have DELIVERED a non-replayable body before its
      // response was blocked — an empty proxy replay would hit the server a
      // second time with corrupted (missing) payload. Surface the real error.
      if (!replayable) throw error;
      return proxyFetch(url, eff, effSignal);
    });
  };

  // eff carries PRE-SERIALIZED contentType/headers (snapshotted at wrapper
  // entry). The host hop can't carry an AbortSignal — honor it locally: never
  // start an already-aborted request, drop an in-flight one when it fires.
  function proxyFetch(url, eff, signal) {
    return new Promise((resolve, reject) => {
      const id = 'f' + (++fetchSeq) + '-' + Math.floor(performance.now());
      const entry = { resolve, reject, cleanup: null };
      pendingFetches.set(id, entry);
      const timer = setTimeout(() => {
        if (pendingFetches.delete(id)) {
          if (entry.cleanup) entry.cleanup();
          reject(new TypeError('proxy fetch timed out'));
        }
      }, 25000);
      if (signal) {
        const onAbort = () => {
          if (pendingFetches.delete(id)) {
            clearTimeout(timer);
            reject(new DOMException('The user aborted a request.', 'AbortError'));
          }
        };
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort);
        // A REUSED signal must not accumulate one listener per request:
        // cleanup runs when the request settles by any path (Codex, round 7).
        entry.cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); };
      } else {
        entry.cleanup = () => clearTimeout(timer);
      }
      parent.postMessage({
        type: 'ww-fetch',
        id,
        url,
        method: (eff.method || 'GET').toUpperCase(),
        body: typeof eff.body === 'string' ? eff.body : null,
        contentType: eff.contentType != null ? eff.contentType : null,
        headers: eff.headers || null,
      }, '*');
    });
  }

  function contentTypeOf(headers) {
    if (!headers) return null;
    try {
      if (typeof headers.get === 'function') return headers.get('content-type');
      if (Array.isArray(headers)) {
        // Tuple pairs: Object.keys would yield "0","1",… and miss the name.
        for (const pair of headers) {
          if (pair && String(pair[0]).toLowerCase() === 'content-type') return String(pair[1]);
        }
        return null;
      }
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'content-type') return headers[key];
      }
    } catch (e) { /* opaque headers */ }
    return null;
  }

  // Serializes any HeadersInit shape (Headers, [[k,v]] pairs, plain object) for
  // the proxy hop. Content-type is excluded — it already crosses as the
  // dedicated contentType field and would double up on the host's request.
  // Repeated names COMBINE case-insensitively with ", ", matching what native
  // fetch does when it builds Headers from the same init.
  function headersToObject(headers) {
    if (!headers) return null;
    const out = {};
    const keyFor = {}; // lower-cased name -> the first-seen spelling
    const add = (name, value) => {
      const lower = String(name).toLowerCase();
      if (keyFor[lower] === undefined) {
        keyFor[lower] = String(name);
        out[String(name)] = String(value);
      } else {
        out[keyFor[lower]] += ', ' + String(value);
      }
    };
    try {
      // Array check FIRST: arrays have a forEach of their own whose callback
      // is (element, index) — the Headers/Map branch would mangle pairs.
      if (Array.isArray(headers)) {
        for (const pair of headers) if (pair && pair.length >= 2) add(pair[0], pair[1]);
      } else if (typeof headers.forEach === 'function') {
        headers.forEach((value, key) => add(key, value));
      } else {
        for (const key of Object.keys(headers)) add(key, headers[key]);
      }
    } catch (e) { return null; }
    for (const key of Object.keys(out)) {
      if (key.toLowerCase() === 'content-type') delete out[key];
    }
    return Object.keys(out).length ? out : null;
  }

  function onFetchResult(msg) {
    const pending = pendingFetches.get(msg.id);
    if (!pending) return;
    pendingFetches.delete(msg.id);
    if (pending.cleanup) pending.cleanup();
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
    // 204/205/304 are null-body statuses: Response() THROWS on ANY body for
    // them (an empty Uint8Array included), and an exception here would strand
    // the promise forever — the entry is already out of the map, so even the
    // timeout can't fire. Build them bodyless, and reject on any construction
    // failure instead of hanging.
    const nullBody = msg.status === 204 || msg.status === 205 || msg.status === 304;
    try {
      pending.resolve(new Response(nullBody ? null : bytes, {
        status: msg.status || 200,
        statusText: msg.statusText || '',
        headers: msg.contentType ? { 'Content-Type': msg.contentType } : {},
      }));
    } catch (e) {
      pending.reject(new TypeError('proxy fetch result invalid: ' + e));
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
    // Same gate as widget-api.js, and needed for the same reason: this file is injected
    // into every document too, so a page an iCUE widget frames can post to its parent
    // and forge ww-init (overwriting the property globals iCUE widgets read), ww-sensors,
    // ww-media, or a ww-fetch-result that resolves a pending request with its own data.
    // Two shims, one boundary — gating only one leaves the other as the way in.
    if (ev.source !== window.parent) return;
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
