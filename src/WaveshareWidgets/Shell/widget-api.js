// Waveshare Widgets — widget API (v1).
// The dashboard injects this into every widget iframe automatically; the explicit
//   <script src="https://app.wsw/widget-api.js"></script>
// include is optional (kept for standalone-browser widget development).
// Everything lives on the global `WW` object. See docs/WIDGET-SPEC.md.
(function () {
  'use strict';
  if (window.WW) return; // already installed (injected + script tag)

  const listeners = { init: [], sensors: [], media: [] };
  const state = { settings: {}, sensors: [], media: null, status: null, ready: false };

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
    }
  });

  const WW = {
    /** Injected values of the properties declared in manifest.json. */
    get settings() { return state.settings; },
    /** Latest sensor snapshot: [{id, name, device, deviceType, type, units, value}]. */
    get sensors() { return state.sensors; },
    /** Latest media state: {available, title, artist, album, status, thumbnail}. */
    get media() { return state.media; },
    /** Host status: {elevated, apiVersion}. */
    get status() { return state.status; },

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

    /** Writes to the host's app.log — useful for debugging on the panel. */
    log(message) { parent.postMessage({ type: 'ww-log', message: String(message) }, '*'); },
  };

  window.WW = WW;
  parent.postMessage({ type: 'ww-ready' }, '*');
})();
