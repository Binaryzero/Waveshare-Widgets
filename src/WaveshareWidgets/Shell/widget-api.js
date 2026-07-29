// Waveshare Widgets — widget API (v1).
// The dashboard injects this into every widget iframe automatically; the explicit
//   <script src="https://app.wsw/widget-api.js"></script>
// include is optional (kept for standalone-browser widget development).
// Everything lives on the global `WW` object. See docs/WIDGET-SPEC.md.
(function () {
  'use strict';
  if (window.WW) return; // already installed (injected + script tag)

  const listeners = { init: [], sensors: [], media: [], theme: [], streamdeck: [], sdcapture: [], notifications: [], game: [] };
  // Stamped until the first ww-init arrives; widget-base.css shows a muted
  // "waiting for panel data…" hint so delivery failures are visible in the field.
  if (document.documentElement) document.documentElement.dataset.wwWaiting = '1';
  else document.addEventListener('DOMContentLoaded', function () {
    if (document.documentElement && !state.ready) document.documentElement.dataset.wwWaiting = '1';
  }, { once: true });
  const state = { settings: {}, sensors: [], media: null, status: null, theme: null, notifications: null, game: { active: false, process: '' }, ready: false };
  const pendingFetches = new Map();
  const pendingPings = new Map();
  const pendingMediaLists = new Map();
  const pendingAudioGets = new Map();
  const pendingAudioSets = new Map();
  let fetchSeq = 0;
  // The shell routes results by id alone, across EVERY widget frame — a per-frame
  // counter plus a ms-floored clock can collide between frames loaded in the same
  // tick, delivering one widget's result to another. A random tail prevents that.
  const reqId = (prefix) =>
    prefix + (++fetchSeq) + '-' + Math.floor(performance.now()) + '-' + Math.random().toString(36).slice(2, 8);

  function emit(kind, payload) {
    for (const cb of listeners[kind]) {
      try { cb(payload); } catch (e) { console.error('[WW]', e); }
    }
  }

  function applyThemeTokens(theme) {
    if (!theme || typeof theme !== 'object') return;
    state.theme = theme;
    const apply = function () {
      const root = document.documentElement;
      if (!root) return;
      for (const name of Object.keys(state.theme)) {
        if (name.indexOf('--') === 0) root.style.setProperty(name, String(state.theme[name]));
      }
      root.dataset.appearance = String(state.theme['--appearance'] || 'dark');
    };
    // A push delivered at document-start (injection-time races) can precede the root
    // element; applying then would throw and swallow the message. Defer until <html>.
    if (document.documentElement) apply();
    else document.addEventListener('DOMContentLoaded', apply, { once: true });
  }

  function applyGame(game) {
    state.game = { active: !!(game && game.active), process: (game && game.process) || '' };
    const stamp = function () {
      if (document.documentElement)
        document.documentElement.dataset.game = state.game.active ? 'on' : 'off';
    };
    if (document.documentElement) stamp();
    else document.addEventListener('DOMContentLoaded', stamp, { once: true });
  }

  window.addEventListener('message', (ev) => {
    const msg = ev.data || {};
    if (msg.type === 'ww-init') {
      state.settings = msg.settings || {};
      state.sensors = msg.sensors || [];
      state.media = msg.media || null;
      state.status = msg.status || null;
      if (msg.notifications !== undefined) state.notifications = msg.notifications;
      if (msg.game) applyGame(msg.game);
      // Design tokens land on :root before init callbacks so first paint is themed.
      applyThemeTokens(msg.theme);
      // Clears the "waiting for panel data" stamp widget-base.css renders: a
      // widget that loads but never receives init must say so ON SCREEN instead
      // of sitting as an undiagnosable blank tile (field report: empty deck).
      if (document.documentElement) delete document.documentElement.dataset.wwWaiting;
      state.ready = true;
      emit('init', state);
      emit('sensors', state.sensors);
      if (state.media) emit('media', state.media);
    } else if (msg.type === 'ww-theme') {
      // Live theme push (settings replica edits, per-widget style overrides): tokens
      // update in place — token-driven CSS repaints with zero widget code; canvas
      // widgets can re-read via WW.onTheme.
      applyThemeTokens(msg.theme);
      emit('theme', state.theme);
    } else if (msg.type === 'ww-notifications') {
      state.notifications = msg.data || null;
      emit('notifications', state.notifications);
    } else if (msg.type === 'ww-game') {
      applyGame(msg.game);
      emit('game', state.game);
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
      const setPending = pendingAudioSets.get(msg.id);
      if (setPending) {
        pendingAudioSets.delete(msg.id);
        setPending.resolve({ ok: msg.ok !== false });
      }
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
      const id = reqId('w');
      pendingFetches.set(id, { resolve, reject });
      setTimeout(() => {
        if (pendingFetches.delete(id)) reject(new TypeError('proxy fetch timed out'));
      }, 25000);
      // Request headers survive the proxy hop (needed by APIs like Hue CLIP v2 —
      // and any authenticated feed: a dropped Authorization header reads as a
      // bot-wall 403 downstream). Headers instances and [[k,v]] pairs serialize
      // too, not just plain objects, repeated names combining with ", " like
      // native fetch (#37 parity with the iCUE shim). Content-Type moves to the
      // dedicated field — a copy in the generic map would double up against the
      // host's StringContent and hand APIs an invalid body type.
      // init.insecure permits self-signed TLS, honored by the host for LAN hosts only.
      let headers = null;
      let bodyContentType = null;
      if (init.headers && typeof init.headers === 'object') {
        headers = {};
        const keyFor = {}; // lower-cased name -> the first-seen spelling
        const add = (name, value) => {
          const lower = String(name).toLowerCase();
          if (keyFor[lower] === undefined) {
            keyFor[lower] = String(name);
            headers[String(name)] = String(value);
          } else {
            headers[keyFor[lower]] += ', ' + String(value);
          }
        };
        try {
          // Array check FIRST: arrays have a forEach of their own whose callback
          // is (element, index) — the Headers/Map branch would mangle pairs.
          if (Array.isArray(init.headers)) {
            for (const pair of init.headers) if (pair && pair.length >= 2) add(pair[0], pair[1]);
          } else if (typeof init.headers.forEach === 'function') {
            init.headers.forEach((value, key) => add(key, value));
          } else {
            for (const key of Object.keys(init.headers)) add(key, init.headers[key]);
          }
        } catch (e) { headers = null; /* opaque headers */ }
        if (headers) {
          for (const key of Object.keys(headers)) {
            if (key.toLowerCase() === 'content-type') {
              bodyContentType = headers[key];
              delete headers[key];
            }
          }
          if (!Object.keys(headers).length) headers = null;
        }
      }
      parent.postMessage({
        type: 'ww-fetch',
        id,
        url: String(url),
        method: (init.method || 'GET').toUpperCase(),
        body: typeof init.body === 'string' ? init.body : null,
        contentType: bodyContentType,
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
    /** cb(theme) — fires when the token map changes live (style edits); tokens are
     * already on :root by then. Only needed by widgets that paint on canvas. */
    onTheme(cb) { listeners.theme.push(cb); },
    /** Mirrored Windows toasts: {state: 'allowed'|'denied'|'unavailable', items:[...]}.
     * null until watching (call WW.watchNotifications(true) first). */
    get notifications() { return state.notifications; },
    /** cb(payload) — fires when the mirrored notification list changes. */
    onNotifications(cb) { listeners.notifications.push(cb); },
    /** Start/stop the host's notification polling. Demand-gated: watch on init,
     * and the host stops polling when no widget is watching. */
    watchNotifications(on) { parent.postMessage({ type: 'ww-notifications-watch', on: on !== false }, '*'); },
    /** Dismiss one mirrored notification by its id. */
    dismissNotification(id) { parent.postMessage({ type: 'ww-notification-dismiss', id }, '*'); },
    /** Game mode: {active, process}. Also stamped as html[data-game="on"|"off"];
     * widget-base.css pauses CSS animation while on. */
    get game() { return state.game; },
    /** cb(game) — fires when game mode flips; pause your own timers/streams. */
    onGame(cb) { listeners.game.push(cb); },

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
     *
     * init.proxy: 'always' skips the browser attempt (targets that can NEVER succeed
     * from a widget origin: LAN bridges behind self-signed TLS, plain-http endpoints
     * blocked as mixed content, APIs without CORS) — the doomed browser attempt would
     * spray a console error on every poll. 'never' disables the proxy fallback.
     * Targets that fail browser-side once are remembered for the session (per target
     * origin) and go proxy-first from then on, so repeat polls stay quiet even for
     * widgets that never pass the option.
     */
    fetch(url, init) {
      init = init || {};
      let memoKey = null;
      let remembered = false;
      try {
        memoKey = 'ww-proxy-first:' + new URL(url, location.href).origin;
        remembered = sessionStorage.getItem(memoKey) === '1';
      } catch (e) { memoKey = null; /* unparsable url or storage unavailable */ }
      // The proxy can faithfully replay only string (or empty) bodies: a
      // FormData/Blob POST keeps leading with the native attempt (which reaches
      // the server even when its response is CORS-blocked) instead of being
      // routed proxy-first into an empty-body replay.
      const replayable = init.body == null || typeof init.body === 'string';
      if (init.proxy === 'always' || (init.proxy !== 'never' && remembered && replayable)) {
        return proxyFetch(url, init).then((response) => {
          // An auth-shaped 401/403 from the proxy may just mean the request
          // needed the browser's ambient cookies, which never cross the proxy
          // hop — retry native (unless the caller opted out of the browser
          // path entirely) and keep the proxy's answer if native can't do better.
          if (init.proxy === 'always' || (response.status !== 401 && response.status !== 403)) return response;
          return fetch(url, init).then(
            (native) => (native.ok ? native : response), () => response);
        }, (err) => {
          if (init.proxy === 'always') throw err;
          return fetch(url, init); // memory can go stale (CORS fixed upstream): last resort
        });
      }
      return fetch(url, init).then((response) => {
        // Bot walls sometimes serve their block page WITH CORS headers, so the
        // request "succeeds" as a 403/429; retry those via the host — unless the
        // caller explicitly opted out of the proxy entirely.
        if ((response.status === 403 || response.status === 429) && init.proxy !== 'never') {
          return proxyFetch(url, init).catch(() => response);
        }
        return response;
      }, (err) => {
        if (init.proxy === 'never') throw err;
        // A browser-level failure (CORS, mixed content, TLS) repeats forever —
        // remember the origin so later calls skip straight to the proxy.
        if (memoKey) { try { sessionStorage.setItem(memoKey, '1'); } catch (e) { /* storage off */ } }
        return proxyFetch(url, init);
      });
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
        const id = reqId('p');
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
        const id = reqId('m');
        pendingMediaLists.set(id, { resolve, reject });
        setTimeout(() => { if (pendingMediaLists.delete(id)) reject(new TypeError('media list timed out')); }, 10000);
        parent.postMessage({ type: 'ww-media-list', id }, '*');
      });
    },

    /** Current audio state: {available, master: {level, muted}, sessions: [{pid, name, level, muted}]}.
     * Levels are 0..1. */
    getAudio() {
      return new Promise((resolve, reject) => {
        const id = reqId('a');
        pendingAudioGets.set(id, { resolve, reject });
        setTimeout(() => { if (pendingAudioGets.delete(id)) reject(new TypeError('audio get timed out')); }, 10000);
        parent.postMessage({ type: 'ww-audio-get', id }, '*');
      });
    },

    /** Set master ('master') or per-app (pid) volume/mute. opts: {level? 0..1, muted?}.
     * Resolves {ok} — ok:false means the host could not apply it (endpoint changed,
     * session gone). Hosts without the ack channel (settings preview, older builds)
     * resolve {ok:true} after a short wait so callers can always await this without
     * false-flashing. */
    setAudio(target, opts) {
      opts = opts || {};
      return new Promise((resolve) => {
        const id = reqId('as');
        pendingAudioSets.set(id, { resolve });
        setTimeout(() => { if (pendingAudioSets.delete(id)) resolve({ ok: true }); }, 3000);
        parent.postMessage({
          type: 'ww-audio-set',
          id,
          target: String(target == null ? 'master' : target),
          level: typeof opts.level === 'number' ? Math.max(0, Math.min(1, opts.level)) : undefined,
          muted: typeof opts.muted === 'boolean' ? opts.muted : undefined,
        }, '*');
      });
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
