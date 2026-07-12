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
  let initPending = false;

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

  function fireInit() {
    if (initialized) return;
    initialized = true;
    try { window.pluginSensorsdataproviderEvents?.onInitialized?.(); } catch (e) { console.error('[icue-shim]', e); }
    try { window.icueEvents?.onICUEInitialized?.(); } catch (e) { console.error('[icue-shim]', e); }
  }

  window.addEventListener('message', (ev) => {
    const msg = ev.data || {};
    if (msg.type === 'ww-init') {
      setPropertyGlobals(msg.settings);
      applySensors(msg.sensors, !initialized);
      if (!domReady) { initPending = true; return; }
      if (!initialized) fireInit();
      else { try { window.icueEvents?.onDataUpdated?.(); } catch (e) { console.error('[icue-shim]', e); } }
    } else if (msg.type === 'ww-sensors' && initialized) {
      applySensors(msg.sensors, false);
    }
  });

  if (!domReady) {
    document.addEventListener('DOMContentLoaded', () => {
      domReady = true;
      if (initPending) fireInit();
    });
  }
})();
