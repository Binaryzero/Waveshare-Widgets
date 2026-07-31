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
  // The shell's origin, learned from the init it answered us with — the shim is
  // injected into every document in the WebView and has no script URL of its own to
  // read it from, and hardcoding a host would break both the harness fixtures and
  // standalone widget development. Until the shell has spoken, '*' is all we have.
  let shellOrigin = null;
  const shellTarget = () => shellOrigin || '*';
  const pendingFetches = new Map();
  const pendingPings = new Map();
  const pendingMediaLists = new Map();
  const pendingAudioGets = new Map();
  const pendingAudioSets = new Map();
  // Stream Deck replies are emitted to listeners rather than resolving a promise, so
  // unlike fetch/ping/media/audio there is no per-document pending map to make a stale
  // answer harmless. A reloaded slot keeps its WindowProxy, so a request the PREVIOUS
  // document made can still be answered into this one and overwrite the profile it just
  // selected. Tracking the ids we issued restores the symmetry: this set is empty in a
  // fresh document, so nothing the old one asked for is accepted here.
  const sdRequests = new Set();
  /// Remembers an outstanding request, and forgets it if no answer comes. Without the
  /// expiry the set only ever grows: the settings preview drops every sd-* message by
  /// design, so a live widget polling four times a second would add an id per poll for
  /// the lifetime of the preview, and a host failure or the shell's own 15s route
  /// timeout does the same on the panel. The other pending collections all expire; this
  /// one matches the shell's route lifetime so the two sides forget together.
  function trackSdRequest(id) {
    sdRequests.add(id);
    setTimeout(() => sdRequests.delete(id), 15000);
    return id;
  }
  // Hash of the last capture frame this DOCUMENT actually received. It is sent with every
  // capture request, and it is the entire dedup: the host answers "unchanged" only when
  // the pixels it just captured hash to what the asker says it already has.
  //
  // The host used to remember this per consumer, and every way that memory could outlive
  // what it described was a widget frozen on a blank mirror — a reloaded slot, a reloaded
  // shell, a reply that expired before it arrived, a consumer evicted from a bounded
  // table. None of those are reachable from here: this variable dies with the document
  // whose pixels it describes, and it only advances below, where the frame is delivered.
  let lastCaptureHash = '';
  // >>> BODY-CAP BEGIN — tests/harness/bodycap-run.js lifts this block out and drives it
  // directly. Extracted by marker rather than copied, so the probe can never diverge from
  // what ships; the browser harness cannot reach the chunked path (its widget page is
  // https, so an http fixture is blocked as mixed content) and this is where the streaming
  // budget is actually exercisable.
  // Largest response body WW.fetch will materialise, in bytes. The host enforces the same
  // ceiling on both of its own tiers; this is the widget-side half, and tools/FetchLimits
  // asserts the two numbers stay equal — a widget reading gigabytes into the panel's
  // renderer is the same failure whichever path delivered them.
  //
  // Lowerable per call with init.maxBytes, for a widget that knows its payload should be
  // small and wants to say so. LOWERABLE ONLY — see resolveCap.
  const MAX_BODY_BYTES = 5 * 1024 * 1024;

  /// Starts a cancel and does NOT wait for it. Awaiting looks tidier and deadlocks: a body
  /// obtained from clone() is one branch of a tee, and cancelling one branch does not settle
  /// until the other is cancelled too — so the await would never return, the RangeError would
  /// never be thrown, and the source would go on filling the unread branch's queue. Exactly
  /// the unbounded accumulation the budget exists to stop.
  function cancelQuietly(cancellable) {
    try {
      const p = cancellable && cancellable.cancel();
      if (p && typeof p.catch === 'function') p.catch(() => { /* already gone */ });
    } catch (e) { /* nothing to cancel */ }
  }

  /// Reads a Response body with a byte budget, refusing WITHOUT materialising the excess.
  /// The check is asked before each chunk is kept, and the transfer is cancelled rather
  /// than abandoned — walking away from an unread body leaves it downloading in the
  /// background, which is most of what a ceiling is for.
  async function readCapped(response, maxBytes) {
    if (!response.body) return new Uint8Array(0);   // 204/205/304 have no body to read
    // Only when the body is not encoded. Content-Length describes the bytes on the wire,
    // while response.body yields DECODED ones, so for a Content-Encoding response the two
    // measure different things — and an incompressible payload can declare slightly more
    // than it decodes to, which would refuse a body the streaming check would rightly
    // accept. The streaming check covers this case on its own.
    const encoded = !!response.headers.get('content-encoding');
    const declared = encoded ? 0 : Number(response.headers.get('content-length') || 0);
    if (declared > maxBytes) {
      cancelQuietly(response.body);
      throw new RangeError('response too large: ' + declared + ' bytes exceeds ' + maxBytes);
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.length > maxBytes) {
        cancelQuietly(reader);
        throw new RangeError('response too large: exceeds ' + maxBytes + ' bytes');
      }
      chunks.push(value);
      total += value.length;
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }

  /// A ReadableStream that relays the response's own and ERRORS past the budget rather than
  /// relaying more.
  ///
  /// Built only when a widget actually reaches for .body: getReader() locks the source, so
  /// constructing one eagerly for every wrapped response would break text() and friends on
  /// the far more common path where nobody touches the stream at all.
  function cappedStream(source, maxBytes) {
    const reader = source.getReader();
    let total = 0;
    return new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) { controller.close(); return; }
        if (total + value.length > maxBytes) {
          cancelQuietly(reader);
          controller.error(new RangeError('response too large: exceeds ' + maxBytes + ' bytes'));
          return;
        }
        total += value.length;
        controller.enqueue(value);
      },
      cancel() { cancelQuietly(reader); },
    });
  }

  /// The ceiling for one call: init.maxBytes when it is a usable number, else the default.
  ///
  /// It can only LOWER the default, never raise it. WW.fetch has five return paths across two
  /// tiers, and the host proxy tier enforces FetchLimits.MaxBodyBytes in C# — an init field
  /// the shim invents cannot lift it, and whether a given call takes that tier is decided by
  /// the REMOTE server's status code, not by the widget. So a raise would work or not work
  /// depending on whether the target happened to answer 403 that minute: an option whose
  /// effect the caller cannot predict is worse than no option. Clamping keeps the meaning the
  /// same on every path — "no more than this, and never more than the host's ceiling".
  ///
  /// Inside the extracted block so the plumbing is drivable, not just the wrapper it feeds —
  /// a probe that called cappedResponse directly would test the budget and never test which
  /// budget WW.fetch actually picks.
  function resolveCap(init) {
    const asked = init && init.maxBytes;
    return Number.isFinite(asked) && asked > 0
      ? Math.min(Math.floor(asked), MAX_BODY_BYTES)
      : MAX_BODY_BYTES;
  }

  /// Wraps a Response so its body readers obey the budget, and forwards everything else.
  ///
  /// A PROXY rather than a hand-written stand-in: widgets read status, ok, headers,
  /// redirected, url, type, and whatever the platform adds next, and a copy would silently
  /// stop matching. Property reads go to the real Response with the real Response as the
  /// receiver — Response's getters need their internal slot, and handing them the proxy
  /// instead throws.
  function cappedResponse(response, maxBytes) {
    const decode = (bytes) => new TextDecoder().decode(bytes);
    const overrides = {
      arrayBuffer: async () => (await readCapped(response, maxBytes)).buffer,
      text: async () => decode(await readCapped(response, maxBytes)),
      json: async () => JSON.parse(decode(await readCapped(response, maxBytes))),
      blob: async () => new Blob([await readCapped(response, maxBytes)],
        { type: response.headers.get('content-type') || '' }),
      bytes: async () => readCapped(response, maxBytes),
      // Not a body reader itself, but it PARSES one — and parsing a multipart body the
      // platform read for us would be exactly the unbounded materialisation this exists to
      // stop. Read within the budget first, then let the platform parse the capped copy.
      formData: async () => new Response(await readCapped(response, maxBytes),
        { headers: response.headers }).formData(),
      // A clone has to stay capped, or a widget could read the body through it uncapped.
      clone: () => cappedResponse(response.clone(), maxBytes),
    };
    // .body is handled in the trap rather than here: it is THE gap that made every override
    // above optional — a widget can skip all of them and pull the stream itself — but it has
    // to be wrapped lazily, because building it locks the source and most responses are read
    // through text() or json() and never touch .body at all.
    let wrappedBody;
    return new Proxy(response, {
      get(target, prop) {
        if (prop === 'body') {
          if (!target.body) return null;
          if (!wrappedBody) wrappedBody = cappedStream(target.body, maxBytes);
          return wrappedBody;
        }
        if (Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop];
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  // <<< BODY-CAP END

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
    // Only the shell speaks this protocol, and the shell is always this frame's
    // parent. Without the check, a page this widget frames can post to its parent —
    // us — and forge ww-init (fake settings), ww-sensors (fake readings) or a
    // ww-fetch-result that resolves a pending WW.fetch with data of its choosing.
    if (ev.source !== window.parent) return;
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
      if (ev.origin && ev.origin !== 'null') shellOrigin = ev.origin;
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
      if (!sdRequests.delete(msg.id)) return;
      emit('streamdeck', msg.profile || { available: false });
    } else if (msg.type === 'ww-sd-capture-result') {
      if (!sdRequests.delete(msg.id)) return;
      const data = msg.data || { available: false };
      // Advance the baseline HERE — past the id check, on the way to the listeners — so
      // it can only ever describe pixels this document was actually handed. A reply that
      // never arrives, or arrives for a request this document did not make, leaves it
      // exactly where it was.
      if (data.image && typeof data.hash === 'string') lastCaptureHash = data.hash;
      emit('sdcapture', data);
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
      if (pending.cleanup) pending.cleanup();
      if (msg.error) {
        // The host refuses an oversized body with its own exception, and it arrives here as
        // a STRING — so without this it would land as a TypeError while the identical refusal
        // on the browser tier is a RangeError. A widget cannot ask which tier served it (the
        // remote server's status code decides that), so a type that depends on the tier is a
        // type nothing can branch on: the REST widget's "Response too large" state simply
        // would not appear for proxied targets. One refusal, one type, either way.
        const tooLarge = /too large/i.test(msg.error);
        const Ctor = tooLarge ? RangeError : TypeError;
        pending.reject(new Ctor('proxy fetch failed: ' + msg.error));
        return;
      }
      let bytes = new Uint8Array(0);
      if (msg.bodyBase64) {
        const raw = atob(msg.bodyBase64);
        bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      }
      // 204/205/304 are null-body statuses: Response() THROWS on ANY body for
      // them (an empty Uint8Array included), and an exception here would
      // strand the promise forever — the entry is already out of the map, so
      // even the timeout can't fire. Build them bodyless, and reject on any
      // construction failure instead of hanging.
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
  });

  // Serializes an init for the proxy hop, SNAPSHOTTING the headers at call
  // time: native fetch snapshots its headers when invoked, and the async
  // escalation must retry what was actually sent — not whatever the caller
  // mutated the live Headers object into since. Request headers survive the
  // hop (needed by APIs like Hue CLIP v2 — and any authenticated feed: a
  // dropped Authorization header reads as a bot-wall 403 downstream). Headers
  // instances and [[k,v]] pairs serialize too, not just plain objects,
  // repeated names combining with ", " like native fetch (#37 parity with the
  // iCUE shim). Content-Type moves to the dedicated field — a copy in the
  // generic map would double up against the host's StringContent and hand
  // APIs an invalid body type. init.insecure permits self-signed TLS,
  // honored by the host for LAN hosts only.
  function serializeProxyInit(init) {
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
    return {
      method: (init.method || 'GET').toUpperCase(),
      body: typeof init.body === 'string' ? init.body : null,
      contentType: bodyContentType,
      headers,
      insecure: init.insecure === true,
    };
  }

  /// A body-size refusal from either tier — the browser tier throws RangeError directly,
  /// and the proxy tier's string is turned into one where the reply is handled.
  ///
  /// The escalation ladder below falls back whenever a tier fails, on the reasoning that the
  /// other tier might do better. This failure is the exception: it is a fact about the
  /// RESOURCE, not about the transport, and no other tier is going to make the body smaller.
  /// Falling back on it pulls the same oversized response down a second time, and then
  /// reports whatever the fallback happened to hit — so the widget names the wrong problem
  /// and the field checks a URL and a network that are both fine. Treated like AbortError,
  /// which every handler here already refuses to mask, and for the same reason: it is an
  /// answer, not a failure to get one.
  const isTooLarge = (err) => err instanceof RangeError;

  // The host hop can't carry an AbortSignal — honor it locally: never start an
  // already-aborted request, and drop an in-flight one when it fires.
  function proxyFetch(url, snap, signal) {
    return new Promise((resolve, reject) => {
      const id = reqId('w');
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
        // cleanup runs when the request settles by any path.
        entry.cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); };
      } else {
        entry.cleanup = () => clearTimeout(timer);
      }
      parent.postMessage(Object.assign({ type: 'ww-fetch', id, url: String(url) }, snap), shellTarget());
    });
  }

  /** Scales `el`'s font-size so its text fits a box, and returns the size used.
   *
   * Widgets run in an iframe sized to their slot, so `vh`/`vw` look like they measure
   * the tile — but a rule written against ONE axis silently clips on the other. The
   * clock sized its time on `34vh` alone: correct at full width, and in a 320x400
   * quarter it asked for 136px glyphs across 320px of tile, so "09:11:52" came out as
   * "9:11:5" with both ends cut off (#76). A fixed `vw` term is not the fix either,
   * because the string length is a setting — 12/24-hour and seconds on/off swing it
   * between five and ten characters — so any static guess is wrong for most of them.
   *
   * Measure instead. Text scales linearly with font-size, so one pass at a reference
   * size gives the exact ratio. The caller supplies the box because only the widget
   * knows its own layout (the clock must leave room for the date beneath).
   *
   * `el` must be shrink-to-fit — a block that stretches measures the container, not
   * the text, and every ratio comes out as 1. A flex item under `align-items: center`
   * qualifies; a plain `div` does not.
   */
  function fitText(el, opts) {
    const o = opts || {};
    const maxW = Math.max(0, Number(o.width) || 0);
    const maxH = Math.max(0, Number(o.height) || 0);
    if (!el || !maxW || !maxH || !el.textContent) return 0;
    const REF = 100;
    const prev = el.style.fontSize;
    el.style.fontSize = REF + 'px';
    // Sub-pixel: scrollWidth rounds to an integer, which at small sizes is a
    // several-percent error and reads as a stray clipped pixel.
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) { el.style.fontSize = prev; return 0; }
    const scale = Number(o.scale);
    const min = Number(o.min) || 6;
    const max = Number(o.max) || 400;
    // Cap the FIT first, then take the user's fraction of it. Scaling before the cap
    // makes the slider inert wherever the raw fit exceeds `max`: a 400px-high slot fits
    // the clock's date well above its 26px cap, so every fraction from 0.5 to 1 clamped
    // back to 26 and the Date size control did nothing. Which is the exact complaint
    // this widget's own size sliders are being fixed for.
    const fitted = Math.min(max, REF * Math.min(maxW / rect.width, maxH / rect.height));
    let size = fitted * (Number.isFinite(scale) && scale > 0 ? scale : 1);
    size = Math.max(min, Math.min(max, size));
    el.style.fontSize = size + 'px';
    return size;
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

    /** Scale an element's font-size to fit a box: WW.fitText(el, {width, height,
     * scale, min, max}). Returns the px size applied. See the note above the
     * implementation for why one-axis viewport units clip (#76). */
    fitText,

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
    watchNotifications(on) { parent.postMessage({ type: 'ww-notifications-watch', on: on !== false }, shellTarget()); },
    /** Dismiss one mirrored notification by its id. */
    dismissNotification(id) { parent.postMessage({ type: 'ww-notification-dismiss', id }, shellTarget()); },
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
    mediaControl(action) { parent.postMessage({ type: 'ww-media-control', action }, shellTarget()); },

    /** Open a URL in the desktop browser. */
    openUrl(url) { parent.postMessage({ type: 'ww-open-url', url: String(url) }, shellTarget()); },

    /** Run a host action: kind 'launch'|'url'|'hotkey'|'media', target the argument. */
    action(kind, target) { parent.postMessage({ type: 'ww-action', kind, target: String(target == null ? '' : target) }, shellTarget()); },

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
      // Every return path below goes through this, so there is one place a body can be
      // read and no path that forgets. Applied to the RESULT rather than inside each
      // branch because the escalation ladder has five of them.
      const cap = resolveCap(init);
      const capped = (p) => p.then((response) => cappedResponse(response, cap));
      // Aborted before we start: the native path rejects with the spec's
      // AbortError and touches no network — no memo, no proxy.
      if (init.signal && init.signal.aborted) return capped(fetch(url, init));
      let memoKey = null;
      let remembered = false;
      try {
        memoKey = 'ww-proxy-first:' + new URL(url, location.href).origin;
        remembered = sessionStorage.getItem(memoKey) === '1';
      } catch (e) { memoKey = null; /* unparsable url or storage unavailable */ }
      // Headers serialize NOW: the async proxy retry must send what the native
      // attempt sent, not the caller's later mutations of a live Headers object.
      const snap = serializeProxyInit(init);
      // The proxy can faithfully replay only string (or empty) bodies: a
      // FormData/Blob POST keeps leading with the native attempt (which reaches
      // the server even when its response is CORS-blocked) instead of being
      // routed proxy-first into an empty-body replay.
      const replayable = init.body == null || typeof init.body === 'string';
      // Requests that lean on the browser's ambient cookies (credentials:
      // 'include') stay native-first: the host strips Cookie by design, and
      // an unauthenticated proxy hop can even 200 on a login-page redirect —
      // a wrong answer no status check can catch.
      const credentialed = init.credentials === 'include';
      if (init.proxy === 'always' || (init.proxy !== 'never' && remembered && replayable && !credentialed)) {
        return capped(proxyFetch(url, snap, init.signal).then((response) => {
          // An auth-shaped 401/403 from the proxy may just mean the request
          // needed the browser's ambient cookies, which never cross the proxy
          // hop — retry native (unless the caller opted out of the browser
          // path entirely) and keep the proxy's answer if native can't do better.
          if (init.proxy === 'always' || (response.status !== 401 && response.status !== 403)) return response;
          return fetch(url, init).then(
            (native) => (native.ok ? native : response),
            (err) => {
              // A mid-retry abort is the caller's cancellation, never masked.
              if (err && err.name === 'AbortError') throw err;
              return response;
            });
        }, (err) => {
          if (init.proxy === 'always' || (err && err.name === 'AbortError') || isTooLarge(err)) throw err;
          return fetch(url, init); // memory can go stale (CORS fixed upstream): last resort
        }));
      }
      return capped(fetch(url, init).then((response) => {
        // Bot walls sometimes serve their block page WITH CORS headers, so the
        // request "succeeds" as a 403/429; retry those via the host — unless the
        // caller opted out of the proxy, or the body can't be replayed faithfully.
        if ((response.status === 403 || response.status === 429) && init.proxy !== 'never' && replayable) {
          return proxyFetch(url, snap, init.signal).catch((err) => {
            // An abort during the retry is the caller's cancellation — it must
            // surface, never be masked by the original bot-wall response. Nor may a
            // size refusal: the proxy got PAST the wall and found the body too large,
            // so handing back the 403 would send the field to check credentials for a
            // resource whose only problem is its size.
            if ((err && err.name === 'AbortError') || isTooLarge(err)) throw err;
            return response;
          });
        }
        return response;
      }, (err) => {
        if (init.proxy === 'never') throw err;
        // A caller-initiated abort is not a network failure: no memo, no
        // escalation — a cancellation is the caller's intent.
        if ((err && err.name === 'AbortError') || (init.signal && init.signal.aborted)) throw err;
        // A browser-level failure (CORS, mixed content, TLS) repeats forever —
        // remember the origin so later calls skip straight to the proxy.
        if (memoKey) { try { sessionStorage.setItem(memoKey, '1'); } catch (e) { /* storage off */ } }
        // The native attempt may have DELIVERED a non-replayable body before its
        // response was blocked — an empty replay would double-hit the server.
        if (!replayable) throw err;
        return proxyFetch(url, snap, init.signal);
      }));
    },

    /** Request the Virtual Stream Deck profile; delivered via onStreamDeck(cb).
     * opts: { profileName, hideWindow, live }. With live:true the reply also carries
     * `capture` — a screenshot of the VSD window ({image,w,h}) for real-time mirroring
     * of dynamic key faces — when the host can capture it. */
    requestStreamDeck(opts) {
      opts = opts || {};
      // The id is what lets the shell send the answer to THIS frame rather than to
      // everyone who ever asked (#127). Callback-shaped API is unchanged.
      const id = trackSdRequest(reqId('sd'));
      parent.postMessage({ type: 'ww-sd-profile', id, profileName: opts.profileName || '', hideWindow: opts.hideWindow !== false, live: opts.live === true }, shellTarget());
    },
    /** cb(profile) — {available, name, rows, cols, buttons:[{row,col,title,image}], capture?}. */
    onStreamDeck(cb) { listeners.streamdeck.push(cb); },
    /** Capture-only fast path for live mirroring: cheaper than requestStreamDeck (no
     * profile re-parse; the host skips the frame entirely when pixels are unchanged). */
    requestStreamDeckCapture() {
      parent.postMessage(
        { type: 'ww-sd-capture', id: trackSdRequest(reqId('sd')), have: lastCaptureHash },
        shellTarget());
    },
    /** cb(data) — {image,w,h,hash} on a new frame, {unchanged:true}, or {available:false}. */
    onStreamDeckCapture(cb) { listeners.sdcapture.push(cb); },
    /** Trigger a Stream Deck button by its grid cell. */
    streamDeckClick(row, col, rows, cols) {
      parent.postMessage({ type: 'ww-sd-click', row, col, rows, cols }, shellTarget());
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
        parent.postMessage({ type: 'ww-ping', id, hosts: (hosts || []).map(String).slice(0, 16) }, shellTarget());
      });
    },

    /** Lists the user's media library (Settings → "Open media folder"); files serve as
     * https://media.wsw/<name>. Resolves to [{name, kind: 'image'|'video'}]. */
    listMedia() {
      return new Promise((resolve, reject) => {
        const id = reqId('m');
        pendingMediaLists.set(id, { resolve, reject });
        setTimeout(() => { if (pendingMediaLists.delete(id)) reject(new TypeError('media list timed out')); }, 10000);
        parent.postMessage({ type: 'ww-media-list', id }, shellTarget());
      });
    },

    /** Current audio state: {available, master: {level, muted}, sessions: [{pid, name, level, muted}]}.
     * Levels are 0..1. */
    getAudio() {
      return new Promise((resolve, reject) => {
        const id = reqId('a');
        pendingAudioGets.set(id, { resolve, reject });
        setTimeout(() => { if (pendingAudioGets.delete(id)) reject(new TypeError('audio get timed out')); }, 10000);
        parent.postMessage({ type: 'ww-audio-get', id }, shellTarget());
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
        }, shellTarget());
      });
    },

    /** Writes to the host's app.log — useful for debugging on the panel. */
    log(message) { parent.postMessage({ type: 'ww-log', message: String(message) }, shellTarget()); },
  };

  // --- runtime diagnostics -------------------------------------------------------
  // Widgets are third-party code; when one dies (an uncaught error kills a timer
  // chain and the widget silently freezes) the panel gives no clue. Forward every
  // uncaught error / rejection — and visibility changes, which explain throttled
  // timers — to the host's app.log. Budgeted so a crash-looping widget can't spam.
  //
  // Only from a real slot frame, because WebView2 injects this file into EVERY document
  // — including a remote page a widget frames, whose parent is then the widget rather
  // than the shell. Reporting from there would hand the embedding widget that page's
  // error text, script URLs and post-redirect hostname: cross-origin detail the
  // same-origin policy exists to withhold, delivered by us.
  //
  // Nothing IN a message can establish this. The obvious rule — wait to be answered by
  // the shell — fails against the case that matters, because for a nested page the
  // widget IS window.parent, so a widget can forge its own ww-init downward and unlock
  // exactly what the rule was withholding from it. The attacker sits on the
  // authenticated side of any such check.
  //
  // Topology settles it. A widget slot is a DIRECT child of the shell document, so its
  // parent and top are the same window; anything nested one level deeper has them
  // differ, and no script can move itself up a level. That is a fact about the frame
  // tree rather than a claim in a payload.
  //
  // Cost, stated plainly: in the settings preview the shell is itself framed, so a
  // previewed widget's parent is the replica and top is the settings page — its
  // diagnostics are dropped. The dashboard is where widgets run unattended and where
  // app.log is the only witness, so that is the side worth keeping.
  const SLOT_TOPOLOGY = window.parent !== window && window.parent === window.top;
  let diagBudget = 15;
  function diag(kind, message) {
    if (!SLOT_TOPOLOGY) return;   // nested frame, or a top-level document: not a slot
    if (diagBudget-- <= 0) return;
    try {
      parent.postMessage({ type: 'ww-log',
        message: '[widget ' + location.hostname + '] ' + kind + ': ' + String(message).slice(0, 500) },
        shellTarget());
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
  parent.postMessage({ type: 'ww-ready' }, shellTarget());
})();
