// iCUE widget compatibility shim (Widget API 1.5.0 surface — the documented 1.4.0
// contract plus what iCUE's own stock widgets observably rely on). Injected (with
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
//     Mediadataprovider (song/artist + property-NOTIFY signals + transport
//     triggers), Linkprovider, Notificationsprovider (count backed by the host's
//     Windows notification mirror), Streamdeck (virtual-deck contract backed by
//     the host's Elgato VSD bridge: profile faces, live capture sliced per key,
//     press/release click injection), plus Fpsdataprovider/Deviceactionprovider
//     stubs that report no data so dependent widgets degrade instead of hanging.
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
    // Undocumented members the stock clocks lean on (their combobox data-values and
    // data-default expressions call these; some widgets also read them at runtime).
    allTimeZones() {
      try { return Intl.supportedValuesOf('timeZone'); }
      catch (e) { return [this.defaultTimeZone()]; }
    },
    defaultTimeZone() {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
      catch (e) { return 'UTC'; }
    },
    default24HourFormat() {
      // Returns the tab-buttons KEY the stock clocks declare, not a boolean.
      try {
        const cycle = new Intl.DateTimeFormat(navigator.language, { hour: 'numeric' })
          .resolvedOptions().hourCycle;
        return cycle === 'h23' || cycle === 'h24' ? '24h' : '12h';
      } catch (e) { return '24h'; }
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
      if (value === undefined || value === null) {
        // A DECLARED property whose default was an expression the reader couldn't
        // evaluate arrives as null. iCUE always creates the global, and widgets read
        // it BARE (`timeZone || fallback`) — so the binding must exist, as undefined,
        // which their own typeof/|| guards handle. Skipping it entirely turned every
        // such read into a top-level ReferenceError that killed the widget script.
        if (!(name in window)) {
          try { window[name] = undefined; injected.add(name); } catch (e) { /* non-writable */ }
        }
        continue;
      }
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
    // In iCUE's page runtime tr() returns a PROMISE — stock widgets call
    // tr('AM').then(...) and `await tr(...)`. Plinth resolves translations
    // synchronously, so hand back the string boxed with a spec-shaped then():
    // string contexts (textContent, template literals, concatenation) read the
    // text via toString, while .then()/await/Promise.all see a thenable.
    window.tr = function (key) {
      const text = (translations && translations[key] != null) ? String(translations[key]) : String(key);
      const boxed = new String(text);
      boxed.then = (onFulfilled, onRejected) => Promise.resolve(text).then(onFulfilled, onRejected);
      return boxed;
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
    // settings pages both live on app.plinth) and one document's miss must never
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
          // Shapes seen in the field: a flat {key: text} map, per-language tables
          // {en: {...}}, and the i18next nesting iCUE's own packages ship —
          // {en: {translation: {...}}} — whose extra level made every lookup miss
          // and silently disabled localization. Select by UI language, then unwrap.
          const lang = String((window.iCUE && window.iCUE.iCUELanguage) || 'en');
          let table = json[lang] || json[lang.split('-')[0]] || json.en || json;
          if (table && typeof table === 'object' &&
              table.translation && typeof table.translation === 'object')
            table = table.translation;
          if (table && typeof table === 'object') translations = table;
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
    // Qt property-NOTIFY signals for songName/artist. Undocumented but load-bearing:
    // the stock Media widget polls once at init and then refreshes ONLY from these,
    // so without them it froze on the first track forever.
    songNameChanged: makeSignal(),
    artistChanged: makeSignal(),
    songName: '',
    artist: '',
    getSongName(rid) { respond(media.asyncResponse, rid, media.songName); },
    getArtist(rid) { respond(media.asyncResponse, rid, media.artist); },
    triggerPlayPause() { parent.postMessage({ type: 'ww-media-control', action: 'toggle' }, '*'); },
    triggerNextTrack() { parent.postMessage({ type: 'ww-media-control', action: 'next' }, '*'); },
    triggerPreviousTrack() { parent.postMessage({ type: 'ww-media-control', action: 'prev' }, '*'); },
  };

  function applyMedia(state) {
    const song = (state && state.title) || '';
    const artist = (state && state.artist) || '';
    const songChanged = song !== media.songName;
    const artistChanged = artist !== media.artist;
    media.songName = song;
    media.artist = artist;
    if (songChanged) media.songNameChanged.__emit(song);
    if (artistChanged) media.artistChanged.__emit(artist);
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

  // --- Notificationsprovider (widgetbuilder.notificationsprovider) ---
  //
  // Backed by the host's Windows notification mirror — the same demand-gated
  // ww-notifications channel the stock Notifications widget rides. The watch is
  // armed only when a widget actually touches the plugin, so an iCUE package that
  // merely COULD count notifications never starts the host polling.

  let notifCount = 0;
  let notifWatchArmed = false;

  function armNotifWatch() {
    if (notifWatchArmed) return;
    notifWatchArmed = true;
    parent.postMessage({ type: 'ww-notifications-watch', on: true }, '*');
  }

  function applyNotifications(data) {
    const count = (data && data.state === 'allowed' && Array.isArray(data.items))
      ? data.items.length : 0;
    if (count === notifCount) return;
    notifCount = count;
    notifications.notificationCountChanged.__emit();
  }

  const notifications = {
    asyncResponse: makeSignal(),
    notificationCountChanged: makeSignal(),
    getNotificationCount(rid) {
      armNotifWatch();
      respond(notifications.asyncResponse, rid, notifCount);
    },
  };
  {
    // First interest arms the mirror: either a count request (above) or a signal
    // subscription — the stock widget subscribes before it ever polls.
    const baseConnect = notifications.notificationCountChanged.connect;
    notifications.notificationCountChanged.connect = (cb) => { armNotifWatch(); baseConnect(cb); };
  }

  // --- Streamdeck (widgetbuilder.streamdeck) ---
  //
  // iCUE's plugin is a NETWORK client, not a window mirror, and the difference is the
  // whole design of this shim. It talks to a device the Stream Deck app reports as model
  // VSD2/WiFi — Elgato's string for a Stream Deck Mobile-class device, which iCUE's
  // bridge registers AS rather than a type iCUE invents. It pairs with the app (the
  // widget's own card says "Go to the Stream Deck app and approve the iCUE connection"),
  // then receives per-key faces over that connection and sends presses back down it.
  //
  // No local API can drive such a device, and that is settled, not pending: the Stream
  // Deck plugin WebSocket has no actuation command at all (keyDown/keyUp are inbound
  // only) and the SDK states the isolation as a design property — "it is not possible to
  // access or control actions that are not owned by your plugin" — while the network
  // transport is pairing-authenticated with no published spec and no client. The obstacle
  // is not specifically Corsair's, so there is no other side to try.
  //
  // Plinth's OWN Stream Deck widget is the other thing entirely: it mirrors a LOCAL
  // "UI Stream Deck" — Elgato's on-screen Virtual Stream Deck — by capturing its Qt
  // window with PrintWindow and clicking it with PostMessage. Conflating the two is
  // what made an earlier round of this shim wrong, so the split is stated here rather
  // than left to be rediscovered.
  //
  // This emulation keeps the plugin's contract (connect → virtualDeviceCreated, per-key
  // buttonIconUpdated pushes, sendKeyPress with press/release) and backs it with the
  // local deck: profile icons as the fallback face, the live window capture sliced into
  // per-key tiles for dynamic faces, and key presses landing as real down/up click
  // phases on the window. So the widget mirrors a deck whose keys actually work.
  //
  // The host never offers a network deck for this, even though it can read one: a deck
  // that renders perfectly and presses nothing is worse than none. `streamdeckUnreachable`
  // therefore means "no deck this host can drive", with app.log naming which decks exist
  // and why each was passed over.
  //
  // A press still needs the deck's window OPEN at the moment of the tap, which the
  // profile — read from disk — cannot tell us. The host reports it per poll, and a tap
  // with nowhere to land is refused out loud instead of posted into a closed window.
  //
  // The authentication signals never fire (this backend has no pairing handshake to
  // fail), so widgets never show their pairing states.

  const sdState = {
    widgetId: null,
    cols: 0, rows: 0,          // the grid the WIDGET asked for
    connected: false,
    announced: false,          // virtualDeviceCreated emitted for the current deck
    unreachable: false,        // last availability signalled, to emit transitions only
    profile: null,             // last available ww-sd-profile payload
    hasWindow: true,           // a deck window exists right now: presses can land
    warnedNoWindow: false,     // "presses go nowhere" said once, not per tap
    pressOutstanding: false,   // a down was accepted and its up is still owed
    tiles: [],                 // slot index -> last data URL emitted (dedup)
    captureHash: '',           // `have` receipt for the capture fast path
    answered: false,           // has the host answered a profile poll at all?
    connectGen: 0,             // which connect a pending no-reply timer belongs to
    profileTimer: null,
    captureTimer: null,
    pending: new Map(),        // request id -> 'profile' | 'capture'
    seq: 0,
    canvas: null,
  };

  // The emulation reported nothing, so a widget stuck on its "unreachable" card looked
  // identical whether the host said available:false or never answered at all. These lines
  // go to app.log; they are bounded — connect, the first reply, availability TRANSITIONS,
  // and a one-shot warning if the host never answers — never per-poll.
  function sdLog(message) {
    try { parent.postMessage({ type: 'ww-log', message: 'streamdeck-emu: ' + message }, '*'); }
    catch (e) { /* frame gone */ }
  }

  // What "a new connection" means, in one place. sendKeyPress's `pressOutstanding` is
  // deliberately NOT here: a press the host already accepted still owes its release, and
  // that release is the one message that must survive anything — clearing the flag would
  // strand WM_LBUTTONDOWN on a real window until the host's 10s safety timer.
  function sdFreshConnection() {
    return {
      announced: false,      // virtualDeviceCreated must fire again for this connection
      unreachable: false,    // …and so must streamdeckUnreachable, if it still applies
      profile: null,         // the previous deck is not this connection's deck
      tiles: [],             // no face has been pushed yet
      captureHash: '',       // nothing received, so nothing to dedup against
      answered: false,       // the no-reply diagnostic is armed for this connection
      warnedNoWindow: false, // a new connection may say it once more
      hasWindow: true,       // optimistic until a reply says otherwise
    };
  }

  function sdTrack(kind) {
    const id = 'icue-sd-' + (++sdState.seq);
    sdState.pending.set(id, kind);
    // The shell's reply route expires at 15s; a reply that never comes must not
    // leave the id behind forever.
    setTimeout(() => sdState.pending.delete(id), 15000);
    return id;
  }

  function sdPollProfile() {
    // hideWindow is deliberately ABSENT, not false. It is a user setting the stock Stream
    // Deck widget exposes and posts on its own 4s poll; asserting it here on ours meant
    // two loops fighting over the same window, and with both widgets on the dashboard and
    // the native one set to "off" the deck window ping-ponged between -32000,-32000 and
    // 60,60 every few seconds. Omitting it leaves whatever the user last chose.
    //
    // Restoring the window on disconnect is NOT the missing half: HideVsdWindow(false)
    // hardcodes SetWindowPos(60, 60), so it would move the window somewhere new rather
    // than back where it was.
    parent.postMessage({
      type: 'ww-sd-profile', id: sdTrack('profile'),
      profileName: '', live: false,
    }, '*');
  }

  function sdPollCapture() {
    parent.postMessage({ type: 'ww-sd-capture', id: sdTrack('capture'), have: sdState.captureHash }, '*');
  }

  function sdStopTimers() {
    clearInterval(sdState.profileTimer);
    clearInterval(sdState.captureTimer);
    sdState.profileTimer = null;
    sdState.captureTimer = null;
  }

  function sdStartTimers() {
    sdStopTimers();
    if (!sdState.connected || document.hidden) return;
    // The capture poll runs under 1s deliberately: it is the live mirror (native
    // widget default is 400ms), and the host answers {unchanged:true} for identical
    // frames, so an idle deck costs a hash compare, not pixels.
    sdState.profileTimer = setInterval(sdPollProfile, 4000);
    sdState.captureTimer = setInterval(sdPollCapture, 500);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { sdStopTimers(); return; }
    if (sdState.connected) { sdStartTimers(); sdPollProfile(); sdPollCapture(); }
  });

  function sdEmitTile(index, dataUrl) {
    if (sdState.tiles[index] === dataUrl) return;
    sdState.tiles[index] = dataUrl;
    sd.buttonIconUpdated.__emit(sdState.widgetId, index, dataUrl);
  }

  // A face for a key that has a title but no image — the widget renders ONLY what
  // buttonIconUpdated hands it, so a text-only key must become pixels here. Empty
  // cells emit '' and the widget substitutes its own blank-key art.
  function sdTitleTile(title) {
    if (!title) return '';
    const safe = String(title).slice(0, 20)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">' +
      '<rect x="2" y="2" width="92" height="92" rx="14" fill="#222" stroke="#3a3a3a"/>' +
      '<text x="48" y="53" text-anchor="middle" font-family="sans-serif" font-size="13" fill="#eee">' +
      safe + '</text></svg>';
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }

  // Fallback faces from the parsed profile — only while no live frame has arrived;
  // once the capture is flowing, its tiles own the key faces.
  function sdPaintFromProfile() {
    const profile = sdState.profile;
    if (!profile || sdState.captureHash) return;
    const byCell = new Map();
    for (const b of profile.buttons || []) byCell.set(b.row + ',' + b.col, b);
    for (let r = 0; r < sdState.rows; r++) {
      for (let c = 0; c < sdState.cols; c++) {
        const button = byCell.get(r + ',' + c);
        sdEmitTile(r * sdState.cols + c, button ? (button.image || sdTitleTile(button.title)) : '');
      }
    }
  }

  // Slice one whole-window frame into per-key tiles. The capture is the VSD client
  // area; cells are the uniform VSD grid (the same assumption the click math makes),
  // contain-fitted into square PNGs so off-square cells letterbox instead of squash.
  function sdSliceCapture(imageDataUri) {
    const profile = sdState.profile;
    if (!profile) return;
    const img = new Image();
    img.onload = () => {
      const vRows = profile.rows || 3;
      const vCols = profile.cols || 5;
      const cellW = img.naturalWidth / vCols;
      const cellH = img.naturalHeight / vRows;
      if (!(cellW > 0) || !(cellH > 0)) return;
      const size = 96;
      const canvas = sdState.canvas || (sdState.canvas = document.createElement('canvas'));
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      const fit = Math.min(size / cellW, size / cellH);
      const drawW = cellW * fit, drawH = cellH * fit;
      for (let r = 0; r < sdState.rows; r++) {
        for (let c = 0; c < sdState.cols; c++) {
          const index = r * sdState.cols + c;
          if (r >= vRows || c >= vCols) { sdEmitTile(index, ''); continue; }
          ctx.clearRect(0, 0, size, size);
          ctx.drawImage(img, c * cellW, r * cellH, cellW, cellH,
            (size - drawW) / 2, (size - drawH) / 2, drawW, drawH);
          sdEmitTile(index, canvas.toDataURL('image/png'));
        }
      }
    };
    img.src = imageDataUri;
  }

  function sdOnProfile(profile) {
    const first = !sdState.answered;
    sdState.answered = true;
    if (!profile || !profile.available) {
      // Deliberately NOT "there is no deck": available:false is also what an
      // unreadable or unparseable profile produces, and — since the recognized device
      // models are a list the iCUE-created type may not be on yet — what a deck this
      // bridge does not recognize produces. Naming the host log is what separates them;
      // asserting the categorical answer sent the last round chasing the wrong repair.
      if (first || !sdState.unreachable)
        sdLog('host found no compatible Stream Deck profile it could read — see the ' +
              'app.log "Stream Deck:" lines for which profiles exist and why each was ' +
              'skipped (unrecognized device model, unreadable manifest, or none present)');
    } else if (first || sdState.unreachable) {
      sdLog('deck available: "' + (profile.name || '') + '" ' +
            (profile.rows || 0) + 'x' + (profile.cols || 0) + ', ' +
            ((profile.buttons || []).length) + ' key(s), model ' +
            (profile.model || 'unknown'));
    }
    if (!profile || !profile.available) {
      sdState.profile = null;
      sdState.announced = false;
      sdState.captureHash = '';
      if (!sdState.unreachable) {
        sdState.unreachable = true;
        sd.streamdeckUnreachable.__emit(sdState.widgetId);
      }
      return;
    }
    sdState.unreachable = false;
    sdState.profile = profile;
    // Absent means yes: a host that predates this field only ever mirrors a deck it can
    // click, so reading absence as "no window" would drop presses it CAN deliver.
    const hasWindow = profile.windowAvailable !== false;
    if (hasWindow !== sdState.hasWindow) {
      sdState.hasWindow = hasWindow;
      // A window that came back re-arms the warning, so the next closure is reported
      // rather than swallowed by the first one.
      if (hasWindow) sdState.warnedNoWindow = false;
      else sdLog('the deck window is not open — its keys render from the profile, but a ' +
                 'press has nowhere to land until the Virtual Stream Deck is open in the ' +
                 'Stream Deck app');
    }
    if (!sdState.announced) {
      sdState.announced = true;
      sd.virtualDeviceCreated.__emit(sdState.widgetId, window.device.deviceId);
    }
    sdPaintFromProfile();
  }

  function sdOnCapture(data) {
    if (!data || data.unchanged) return;
    if (data.available === false) {
      // Only a TRANSITION (we had frames, now none: window went away) forgets the
      // frame and refreshes availability early. A deck whose capture never works —
      // some GPU pipelines refuse PrintWindow — answers available:false on every
      // poll, and reacting to each would re-poll the profile at capture cadence
      // forever; steady-state stays on profile icons and the 4s profile timer.
      if (sdState.captureHash) {
        sdState.captureHash = '';
        sdPollProfile();
      }
      return;
    }
    if (!data.image || typeof data.hash !== 'string') return;
    sdState.captureHash = data.hash;
    sdSliceCapture(data.image);
  }

  const sd = {
    virtualDeviceCreated: makeSignal(),
    buttonIconUpdated: makeSignal(),
    streamdeckUnreachable: makeSignal(),
    authenticationRequired: makeSignal(),  // never emitted: no pairing in this backend
    authenticationRejected: makeSignal(),  // never emitted
    connectStreamDeck(widgetId, deviceId, columns, rows) {
      Object.assign(sdState, sdFreshConnection());
      sdState.widgetId = widgetId;
      sdState.cols = Math.max(1, columns | 0);
      sdState.rows = Math.max(1, rows | 0);
      sdState.connected = true;
      // Every field that describes ONE connection, reset from a single definition. Doing
      // it by hand here meant remembering each one: `announced` suppressed
      // virtualDeviceCreated for the new connection, a stale `captureHash` made
      // sdPaintFromProfile bail (a set hash reads as "live capture is driving the faces")
      // while the capture poll quoted it so an unchanged host frame returned no pixels,
      // and `unreachable` swallowed streamdeckUnreachable so a widget that cleared its
      // state on disconnect got no terminal answer at all. Three of those were found one
      // at a time. Adding state to sdFreshConnection is now what resets it.
      // Replies owed to the PREVIOUS connection are not answers to this one. Left in
      // place, a late one would set `answered` on the connection that just reset it —
      // suppressing this connection's no-reply diagnostic and announcing the old deck as
      // the current one. Stamping the timer with a generation (below) does not cover
      // this: the reply route is keyed on the request id, not on the timer.
      sdState.pending.clear();
      sdLog('connect requested for a ' + sdState.cols + 'x' + sdState.rows + ' deck');
      // If the poll is never answered the widget sits on its parse-time card forever,
      // which is exactly what an available:false answer looks like. Say which it was.
      //
      // Stamped with the connect it belongs to: connectStreamDeck can run again (the
      // widget's own reconnect path is right below), and `connected`/`answered` are
      // shared, so an earlier timer would otherwise observe the NEW connection and
      // report "after 10s" moments after it — breaking both the timing claim and the
      // one-shot bound this comment promises.
      const gen = ++sdState.connectGen;
      setTimeout(() => {
        if (sdState.connectGen === gen && sdState.connected && !sdState.answered)
          sdLog('NO REPLY from the host to the profile poll after 10s — the bridge did not answer');
      }, 10000);
      sdStartTimers();
      sdPollProfile();
    },
    reconnectStreamDeck(widgetId) {
      // Delegate rather than hand-roll. The old body guarded on `connected` and so was a
      // permanent no-op after disconnectStreamDeck — which is the one state a reconnect
      // exists for. A widget that suspends on hide and resumes on show called a
      // documented API that did nothing, forever, and never learned it.
      //
      // connectStreamDeck is the whole resume sequence and gets it right: it clears
      // sdState.pending (so a reply owed to the previous connection cannot settle this
      // one), resets announced/tiles, bumps connectGen for the no-reply timer, and starts
      // the polls. Reproducing any of that here would drift.
      if (sdState.widgetId == null) return;
      sd.connectStreamDeck(sdState.widgetId, null, sdState.cols, sdState.rows);
    },
    disconnectStreamDeck(widgetId) {
      sdState.connected = false;
      sdStopTimers();
    },
    updateVirtualDeviceSize(widgetId, columns, rows) {
      const cols = Math.max(1, columns | 0);
      const rows2 = Math.max(1, rows | 0);
      if (cols === sdState.cols && rows2 === sdState.rows) return;
      sdState.cols = cols;
      sdState.rows = rows2;
      sdState.tiles = [];
      sdPaintFromProfile();
      if (sdState.connected) sdPollCapture();
    },
    sendKeyPress(widgetId, buttonIndex, pressed) {
      // A RELEASE owed to an accepted press always goes through — FIRST, before any
      // other guard. The host's up path releases without needing a window or a profile,
      // so nothing below can make this fail; anything below it can make it not happen.
      //
      // It sat under the profile guard until now, which made it a no-op in the very case
      // it was written for: sdState.profile is nulled by ANY poll that answers
      // unavailable, the poll runs every 4s, so a press held across one returned at
      // `!profile` and the release never posted. The host then held WM_LBUTTONDOWN on a
      // real window until the 10s safety timer — the exact outcome this prevents.
      if (!pressed && sdState.pressOutstanding) {
        sdState.pressOutstanding = false;
        parent.postMessage({ type: 'ww-sd-click', rows: 1, cols: 1, row: 0, col: 0,
          phase: 'up' }, '*');
        return;
      }
      const profile = sdState.profile;
      if (!profile || !sdState.cols) return;
      if (!sdState.hasWindow) {
        // Posting a PRESS here would look like it worked: the host finds no window,
        // logs a warning, and the widget — which never learns the outcome — keeps
        // rendering a deck whose keys do nothing. Say it once, on the press half only.
        if (pressed && !sdState.warnedNoWindow) {
          sdState.warnedNoWindow = true;
          sdLog('key press ignored: no deck window is open, so there is nothing to click. ' +
                'Open the Virtual Stream Deck in the Stream Deck app.');
        }
        return;
      }
      const index = buttonIndex | 0;
      const row = Math.floor(index / sdState.cols);
      const col = index % sdState.cols;
      const vRows = profile.rows || 3;
      const vCols = profile.cols || 5;
      // Beyond the mirrored deck's grid there is nothing to press.
      if (row < 0 || col < 0 || row >= vRows || col >= vCols) return;
      parent.postMessage({
        type: 'ww-sd-click',
        row, col, rows: vRows, cols: vCols,
        // Cell center as fractions of the capture — the same uniform-grid escape
        // hatch the mirror widget uses for exact click placement.
        fx: (col + 0.5) / vCols,
        fy: (row + 0.5) / vRows,
        // True press/release: the widget sends down on pointerdown and up on
        // pointerup/leave/cancel, so holds reach the deck as holds.
        phase: pressed ? 'down' : 'up',
      }, '*');
      // Tracked from here, after the grid bounds check, so only a press the host was
      // actually asked to make owes a release.
      sdState.pressOutstanding = pressed === true;
    },
  };

  window.plugins = window.plugins || {};
  window.plugins.Sensorsdataprovider = sensors;
  window.plugins.Mediadataprovider = media;
  window.plugins.Fpsdataprovider = fps;
  window.plugins.Deviceactionprovider = deviceAction;
  window.plugins.Linkprovider = link;
  window.plugins.Streamdeck = sd;
  window.plugins.Notificationsprovider = notifications;

  const pluginNames = ['Sensorsdataprovider', 'Mediadataprovider', 'Fpsdataprovider',
    'Deviceactionprovider', 'Linkprovider', 'Streamdeck', 'Notificationsprovider'];
  for (const name of pluginNames) {
    // Late-load handshake parity with iCUE: the *_initialized flags exist from the
    // first parsed line (widgets read them BARE, so the bindings must exist) but
    // flip true only when maybeInit fires the onInitialized events. The old
    // always-true flags made the documented handshake run handlers twice — once
    // from the widget's own flag check at parse time, again from the event.
    if (!('plugin' + name + '_initialized' in window))
      window['plugin' + name + '_initialized'] = false;
    // Stock widgets ASSIGN `plugin<Name>Events = {...}` (and `icueEvents = {...}`)
    // as bare identifiers. In a <script type="module"> — strict mode — that throws
    // ReferenceError unless the global property already exists, killing the module
    // on its first statement. iCUE's bootstrap predeclares them; so must this shim.
    if (!('plugin' + name + 'Events' in window))
      window['plugin' + name + 'Events'] = undefined;
  }
  if (!('icueEvents' in window)) window.icueEvents = undefined;

  // --- fetch fallback: iCUE's runtime is CORS-relaxed, standards WebView2 is not ---

  const nativeFetch = window.fetch.bind(window);
  const pendingFetches = new Map();
  let fetchSeq = 0;

  function proxyableUrl(input) {
    try {
      const url = new URL(typeof input === 'string' ? input : (input && input.url) || '', location.href);
      if ((url.protocol === 'http:' || url.protocol === 'https:') &&
          !url.hostname.endsWith('.plinth') && url.origin !== location.origin)
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
    // The allow-listed response headers the host carried back (#169). This shim and
    // widget-api.js are injected independently and each rebuilds the proxied Response, so
    // there are TWO of these and fixing one leaves an iCUE or marketplace widget — which
    // reaches the ladder through plain window.fetch — reading nothing but Content-Type
    // once its request escalates. Kept deliberately identical to widget-api.js's copy;
    // tests/harness/icuefetch-run.js asserts both shims answer the same, because separate
    // scripts cannot share a helper and only a check keeps them together.
    //
    // Content-Type is applied AFTER, so the dedicated field stays the single source. A
    // header that Headers refuses is skipped rather than thrown on: one bad name is not
    // worth failing an otherwise good response over. An ARRAY is not a header map, and
    // typeof an array is 'object', so the obvious test would admit one.
    const headers = {};
    if (msg.headers && typeof msg.headers === 'object' && !Array.isArray(msg.headers)) {
      for (const name of Object.keys(msg.headers)) {
        const value = msg.headers[name];
        if (typeof value !== 'string') continue;
        try { new Headers({ [name]: value }); } catch (e) { continue; }
        headers[name] = value;
      }
    }
    if (msg.contentType) headers['Content-Type'] = msg.contentType;
    try {
      pending.resolve(new Response(nullBody ? null : bytes, {
        status: msg.status || 200,
        statusText: msg.statusText || '',
        headers,
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
    // Flags flip BEFORE the events fire, so a handler that re-checks its flag —
    // the documented pattern — sees the state the event announces.
    for (const name of pluginNames) window['plugin' + name + '_initialized'] = true;
    const fire = (fn) => { try { fn && fn(); } catch (e) { console.error('[icue-shim]', e); } };
    for (const name of pluginNames) fire(window['plugin' + name + 'Events']?.onInitialized);
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
      if (msg.notifications) applyNotifications(msg.notifications);
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
    } else if (msg.type === 'ww-notifications') {
      applyNotifications(msg.data);
    } else if (msg.type === 'ww-sd-profile') {
      // Both shims listen on this document; each consumes only ids it minted
      // (widget-api.js keys on its own sdRequests set the same way).
      if (sdState.pending.get(msg.id) !== 'profile') return;
      sdState.pending.delete(msg.id);
      sdOnProfile(msg.profile || { available: false });
    } else if (msg.type === 'ww-sd-capture-result') {
      if (sdState.pending.get(msg.id) !== 'capture') return;
      sdState.pending.delete(msg.id);
      sdOnCapture(msg.data || { available: false });
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
