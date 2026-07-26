// Waveshare Widgets — widget API (v1).
// The dashboard injects this into every widget iframe automatically; the explicit
//   <script src="https://app.wsw/widget-api.js"></script>
// include is optional (kept for standalone-browser widget development).
// Everything lives on the global `WW` object. See docs/WIDGET-SPEC.md.
(function () {
  'use strict';
  if (window.WW) return; // already installed (injected + script tag)

  const listeners = { init: [], sensors: [], media: [], streamdeck: [], sdcapture: [] };
  const state = { settings: {}, sensors: [], media: null, status: null, theme: null, ready: false };
  const pendingFetches = new Map();
  const pendingPings = new Map();
  const pendingMediaLists = new Map();
  const pendingAudioGets = new Map();
  let fetchSeq = 0;

  function emit(kind, payload) {
    for (const cb of listeners[kind]) {
      try { cb(payload); } catch (e) { console.error('[WW]', e); }
    }
  }

  window.addEventListener('message', (ev) => {
    const msg = ev.data || {};
    if (msg.type === 'ww-init') {
      state.settings = msg.settings || {};
      state.sensors = msg.sensors || [];
      state.media = msg.media || null;
      state.status = msg.status || null;
      // Design tokens land on :root before init callbacks so first paint is themed.
      if (msg.theme && typeof msg.theme === 'object') {
        state.theme = msg.theme;
        const applyTheme = function () {
          const root = document.documentElement;
          if (!root) return;
          for (const name of Object.keys(state.theme)) {
            if (name.indexOf('--') === 0) root.style.setProperty(name, String(state.theme[name]));
          }
          root.dataset.appearance = String(state.theme['--appearance'] || 'dark');
        };
        // An init delivered at document-start (injection-time races) can precede the
        // root element; applying then would throw and swallow the whole init. Defer
        // until the parser has created <html>.
        if (document.documentElement) applyTheme();
        else document.addEventListener('DOMContentLoaded', applyTheme, { once: true });
      }
      state.ready = true;
      emit('init', state);
      emit('sensors', state.sensors);
      if (state.media) emit('media', state.media);
    } else if (msg.type === 'ww-sensors') {
      state.sensors = msg.sensors || [];
      emit('sensors', state.sensors);
    } else if (msg.type === 'ww-media') {
      state.media = msg.media || null;
      emit('media', state.media);
    } else if (msg.type === 'ww-sd-profile') {
      emit('streamdeck', msg.profile || { available: false });
    } else if (msg.type === 'ww-sd-capture-result') {
      emit('sdcapture', msg.data || { available: false });
    } else if (msg.type === 'ww-ping-result') {
      const pending = pendingPings.get(msg.id);
      if (pending) {
        pendingPings.delete(msg.id);
        pending.resolve(msg.results || []);
      }
    } else if (msg.type === 'ww-media-list-result') {
      const pending = pendingMediaLists.get(msg.id);
      if (pending) {
        pendingMediaLists.delete(msg.id);
        pending.resolve(msg.files || []);
      }
    } else if (msg.type === 'ww-audio-result') {
      const pending = pendingAudioGets.get(msg.id);
      if (pending) {
        pendingAudioGets.delete(msg.id);
        pending.resolve({ available: msg.available !== false, master: msg.master || null, sessions: msg.sessions || [] });
      }
    } else if (msg.type === 'ww-fetch-result') {
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
  });

  function proxyFetch(url, init) {
    init = init || {};
    return new Promise((resolve, reject) => {
      const id = 'w' + (++fetchSeq) + '-' + Math.floor(performance.now());
      pendingFetches.set(id, { resolve, reject });
      setTimeout(() => {
        if (pendingFetches.delete(id)) reject(new TypeError('proxy fetch timed out'));
      }, 25000);
      // Plain-object headers survive the proxy hop (needed by APIs like Hue CLIP v2);
      // init.insecure permits self-signed TLS, honored by the host for LAN hosts only.
      let headers = null;
      if (init.headers && typeof init.headers === 'object' && typeof init.headers.get !== 'function') {
        headers = {};
        for (const key of Object.keys(init.headers)) headers[key] = String(init.headers[key]);
      }
      parent.postMessage({
        type: 'ww-fetch',
        id,
        url: String(url),
        method: (init.method || 'GET').toUpperCase(),
        body: typeof init.body === 'string' ? init.body : null,
        contentType: null,
        headers,
        insecure: init.insecure === true,
      }, '*');
    });
  }

  const WW = {
    /** Injected values of the properties declared in manifest.json. */
    get settings() { return state.settings; },
    /** Latest sensor snapshot: [{id, name, device, deviceType, type, units, value}]. */
    get sensors() { return state.sensors; },
    /** Latest media state: {available, title, artist, album, status, thumbnail}. */
    get media() { return state.media; },
    /** Host status: {elevated, apiVersion}. */
    get status() { return state.status; },
    /** Design-token map ({'--surface': '#111314', ...}); applied to :root automatically. */
    get theme() { return state.theme; },

    /** cb(state) — fires once settings/sensors are first delivered. */
    onInit(cb) { listeners.init.push(cb); if (state.ready) cb(state); },
    /** cb(sensors) — fires on every poll tick (~2 s). */
    onSensors(cb) { listeners.sensors.push(cb); },
    /** cb(media) — fires when now-playing info changes. */
    onMedia(cb) { listeners.media.push(cb); },

    /** Find a sensor by exact id. */
    sensorById(id) {
      return state.sensors.find((s) => s.id === id) || null;
    },

    /**
     * Heuristic sensor lookup.
     * opts: { type, deviceTypeIncludes: [..], nameIncludes: [..], preferredNames: [..] }
     * preferredNames are tried in order as exact matches before falling back to
     * nameIncludes substring matching.
     */
    findSensor(opts) {
      opts = opts || {};
      let candidates = state.sensors;
      if (opts.type) candidates = candidates.filter((s) => s.type === opts.type);
      if (opts.deviceTypeIncludes) {
        const needles = opts.deviceTypeIncludes.map((n) => n.toLowerCase());
        candidates = candidates.filter((s) =>
          needles.some((n) => s.deviceType.toLowerCase().includes(n)));
      }
      for (const name of opts.preferredNames || []) {
        const hit = candidates.find((s) => s.name === name && s.value != null);
        if (hit) return hit;
      }
      if (opts.nameIncludes) {
        const needles = opts.nameIncludes.map((n) => n.toLowerCase());
        const hit = candidates.find((s) =>
          s.value != null && needles.some((n) => s.name.toLowerCase().includes(n)));
        if (hit) return hit;
      }
      return candidates.find((s) => s.value != null) || null;
    },

    /** Media transport: 'toggle' | 'next' | 'prev'. */
    mediaControl(action) { parent.postMessage({ type: 'ww-media-control', action }, '*'); },

    /** Open a URL in the desktop browser. */
    openUrl(url) { parent.postMessage({ type: 'ww-open-url', url: String(url) }, '*'); },

    /** Run a host action: kind 'launch'|'url'|'hotkey'|'media', target the argument. */
    action(kind, target) { parent.postMessage({ type: 'ww-action', kind, target: String(target == null ? '' : target) }, '*'); },

    /**
     * fetch() that survives CORS and bot walls: tries the browser's fetch first and
     * falls back to a host-proxied request (browser-grade headers, and a full hidden-
     * browser fetch for hosts that fingerprint TLS, like Reddit). Returns a Response.
     * Only GET/POST with string bodies are supported on the proxy path.
     */
    fetch(url, init) {
      return fetch(url, init).then((response) => {
        // Bot walls sometimes serve their block page WITH CORS headers, so the
        // request "succeeds" as a 403/429; retry those via the host.
        if (response.status === 403 || response.status === 429) {
          return proxyFetch(url, init).catch(() => response);
        }
        return response;
      }, () => proxyFetch(url, init));
    },

    /** Request the Virtual Stream Deck profile; delivered via onStreamDeck(cb).
     * opts: { profileName, hideWindow, live }. With live:true the reply also carries
     * `capture` — a screenshot of the VSD window ({image,w,h}) for real-time mirroring
     * of dynamic key faces — when the host can capture it. */
    requestStreamDeck(opts) {
      opts = opts || {};
      parent.postMessage({ type: 'ww-sd-profile', profileName: opts.profileName || '', hideWindow: opts.hideWindow !== false, live: opts.live === true }, '*');
    },
    /** cb(profile) — {available, name, rows, cols, buttons:[{row,col,title,image}], capture?}. */
    onStreamDeck(cb) { listeners.streamdeck.push(cb); },
    /** Capture-only fast path for live mirroring: cheaper than requestStreamDeck (no
     * profile re-parse; the host skips the frame entirely when pixels are unchanged). */
    requestStreamDeckCapture() { parent.postMessage({ type: 'ww-sd-capture' }, '*'); },
    /** cb(data) — {image,w,h} on a new frame, {unchanged:true}, or {available:false}. */
    onStreamDeckCapture(cb) { listeners.sdcapture.push(cb); },
    /** Trigger a Stream Deck button by its grid cell. */
    streamDeckClick(row, col, rows, cols) {
      parent.postMessage({ type: 'ww-sd-click', row, col, rows, cols }, '*');
    },

    /**
     * Real ICMP pings, performed by the host process (browsers can't ICMP — HTTP
     * timing only works against web servers and measures the wrong thing).
     * hosts: up to 16 hostnames/IPs. Resolves to [{host, ok, rttMs?, error?}].
     */
    ping(hosts) {
      return new Promise((resolve, reject) => {
        const id = 'p' + (++fetchSeq) + '-' + Math.floor(performance.now());
        pendingPings.set(id, { resolve, reject });
        setTimeout(() => {
          if (pendingPings.delete(id)) reject(new TypeError('ping timed out'));
        }, 12000);
        parent.postMessage({ type: 'ww-ping', id, hosts: (hosts || []).map(String).slice(0, 16) }, '*');
      });
    },

    /** Lists the user's media library (Settings → "Open media folder"); files serve as
     * https://media.wsw/<name>. Resolves to [{name, kind: 'image'|'video'}]. */
    listMedia() {
      return new Promise((resolve, reject) => {
        const id = 'm' + (++fetchSeq) + '-' + Math.floor(performance.now());
        pendingMediaLists.set(id, { resolve, reject });
        setTimeout(() => { if (pendingMediaLists.delete(id)) reject(new TypeError('media list timed out')); }, 10000);
        parent.postMessage({ type: 'ww-media-list', id }, '*');
      });
    },

    /** Current audio state: {available, master: {level, muted}, sessions: [{pid, name, level, muted}]}.
     * Levels are 0..1. */
    getAudio() {
      return new Promise((resolve, reject) => {
        const id = 'a' + (++fetchSeq) + '-' + Math.floor(performance.now());
        pendingAudioGets.set(id, { resolve, reject });
        setTimeout(() => { if (pendingAudioGets.delete(id)) reject(new TypeError('audio get timed out')); }, 10000);
        parent.postMessage({ type: 'ww-audio-get', id }, '*');
      });
    },

    /** Set master ('master') or per-app (pid) volume/mute. opts: {level? 0..1, muted?}. */
    setAudio(target, opts) {
      opts = opts || {};
      parent.postMessage({
        type: 'ww-audio-set',
        target: String(target == null ? 'master' : target),
        level: typeof opts.level === 'number' ? Math.max(0, Math.min(1, opts.level)) : undefined,
        muted: typeof opts.muted === 'boolean' ? opts.muted : undefined,
      }, '*');
    },

    /** Writes to the host's app.log — useful for debugging on the panel. */
    log(message) { parent.postMessage({ type: 'ww-log', message: String(message) }, '*'); },
  };

  // --- runtime diagnostics -------------------------------------------------------
  // Widgets are third-party code; when one dies (an uncaught error kills a timer
  // chain and the widget silently freezes) the panel gives no clue. Forward every
  // uncaught error / rejection — and visibility changes, which explain throttled
  // timers — to the host's app.log. Budgeted so a crash-looping widget can't spam.
  let diagBudget = 15;
  function diag(kind, message) {
    if (diagBudget-- <= 0) return;
    try {
      parent.postMessage({ type: 'ww-log', message: '[widget ' + location.hostname + '] ' + kind + ': ' + String(message).slice(0, 500) }, '*');
    } catch (e) { /* parent gone */ }
  }
  window.addEventListener('error', (ev) => {
    diag('uncaught', (ev.message || ev.error) + ' @ ' + String(ev.filename || '?').split('/').pop() + ':' + ev.lineno);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    diag('unhandled-rejection', (ev.reason && (ev.reason.stack || ev.reason.message)) || ev.reason);
  });
  if (document.visibilityState === 'hidden')
    diag('visibility', 'document loaded hidden — timers will be throttled');
  document.addEventListener('visibilitychange', () => diag('visibility', 'now ' + document.visibilityState));

  window.WW = WW;
  parent.postMessage({ type: 'ww-ready' }, '*');
})();
