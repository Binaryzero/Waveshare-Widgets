// Dashboard shell: receives host messages over the WebView2 bridge, lays out the
// configured pages/slots as per-widget iframes, and relays sensor/media data to them.
(function () {
  'use strict';

  const pagesEl = document.getElementById('pages');
  const dotsEl = document.getElementById('dots');
  const emptyEl = document.getElementById('empty');

  /** @type {{frame: HTMLIFrameElement, el: HTMLElement, settings: object, initialized: boolean, retries: number}[]} */
  let slots = [];
  let latestSensors = [];
  let latestMedia = null;
  // The media-relay credential from the host's init. Forwarded ONLY inside ww-init,
  // which goes exclusively to verified slot documents (identity + origin checked) —
  // that verification is what makes the token mean "a real widget asked". Empty in
  // the settings replica: its channel is credential-free by design.
  let mediaRelayToken = '';
  let latestTheme = null;
  let latestNotifications = null;   // last projected payload from the host
  let status = { elevated: false, apiVersion: 1 };
  let dotsIdleTimer = null;
  let bgSettleTimer = null;    // debounces the wallpaper swap during multi-page scrolls
  let generation = 0;          // invalidates watchdogs from a previous layout
  const fetchRoutes = new Map(); // proxy-fetch id -> { win, origin } of the asking widget frame
  const pingRoutes = new Map();  // ping id -> { win, origin } of the asking widget frame
  const mediaRoutes = new Map(); // media-list id -> { win, origin } of the asking widget frame
  const audioRoutes = new Map(); // audio-get id -> { win, origin } of the asking widget frame
  const secureRoutes = new Map();// secure-store id -> { win, origin } of the asking widget frame
  // Stream Deck profile AND capture share one map: ids are unique across both, and both
  // are strict request->response. The host never pushes either unsolicited — live mode
  // just bundles a capture into the profile reply and the widget polls — so a route per
  // request is the whole mechanism, and the sticky per-slot flags this replaces could
  // not tell two askers apart (#127).
  const sdRoutes = new Map();    // sd request id -> { win, origin }
  let sdSeq = 0;                 // only for a caller that sent no id of its own
  // #210 — outstanding "which values can this setting take" questions, by id. The route
  // holds the SLOT asked, not just its window: only that frame's answer is accepted.
  const discoverRoutes = new Map(); // discovery id -> { slot, done, timer }
  let discoverSeq = 0;
  const DISCOVER_TIMEOUT_MS = 20000;
  // Find by query: the longest search passed on to a widget. Mirrored in settings.js, which
  // asks, and in SettingsWindow.HandleDiscover, which relays.
  const DISCOVER_QUERY_MAX = 100;

  let backgroundHost = 'backgrounds.plinth';
  let bgGlobal = null;         // dashboard-wide background spec
  let bgPages = [];            // per-page background specs (null = inherit global)
  const bg = createBackgroundController();

  // Live layout model. Only the settings replica mutates it: its editor persists through
  // save-layout to the settings window, never to the host. On the panel it is read-only.
  let layoutData = { pages: [] };
  let widgetLib = [];
  let widgetsById = new Map();
  const pageEls = new Map();   // page object -> its <section class="page">
  let slotUid = 0;
  let editing = false;

  // ---- host bridge -----------------------------------------------------------

  // Preview mode: the shell is embedded as a live replica inside the settings window
  // (index.html?preview). The "host" is then the settings page, bridged over
  // window.postMessage — ww-shell wraps outgoing messages, ww-host wraps incoming.
  const PREVIEW = new URLSearchParams(location.search).has('preview');
  let previewPage = null; // page the settings window wants the replica to show
  let previewGen = 0;     // init generation this document state was built under;
                          // echoed on every persist so the settings window can drop
                          // captures that raced a newer init (posting is async)

  if (!PREVIEW && window.chrome && window.chrome.webview) {
    window.chrome.webview.addEventListener('message', (ev) => handleHostMessage(ev.data || {}));
  }

  function handleHostMessage(msg) {
    if (msg.type === 'init') onInit(msg.data);
    else if (msg.type === 'theme') {
      // Live retheme (settings replica): refresh the seeds first so styled slots
      // re-derive against the EDITED theme, then push per slot — a slot carrying
      // style overrides keeps its own palette instead of being flattened to the
      // global map.
      if ('seeds' in msg) layoutData.theme = msg.seeds || undefined;
      applyThemeTokens(msg.data);
      for (const slot of slots) {
        if (slot.initialized) sendToSlot(slot, { type: 'ww-theme', theme: slotTheme(slot) });
      }
    }
    else if (msg.type === 'page') {
      // Replica steering: the preview is pointer-events:none, so the settings window
      // drives which page is visible (its selected page). Silent — the settings
      // window already shows this page; an echo would re-trigger its stale-nav
      // self-heal in a loop.
      if (PREVIEW) { previewPage = msg.index | 0; goToPage(previewPage, true); }
    }
    else if (msg.type === 'edit-mode') {
      // WYSIWYG settings (#32): the embedding settings window drives the replica's
      // edit mode so the preview becomes the primary editing surface. Explicit
      // opt-in and PREVIEW-gated — a real panel never receives this message, and a
      // host that never sends it keeps the old view-only replica.
      if (PREVIEW) setEditing(!!msg.on);
    }
    else if (msg.type === 'select-slot') {
      // Settings-side selection (its slot list / a re-init restore) mirrored into
      // the replica's highlight. Never announced back — the host already knows.
      if (PREVIEW && editing) selectSlotAt(msg.page | 0, msg.index | 0, false);
    }
    else if (msg.type === 'sensors') { latestSensors = msg.data || []; broadcast({ type: 'ww-sensors', sensors: latestSensors }); }
    else if (msg.type === 'media') { latestMedia = msg.data; broadcast({ type: 'ww-media', media: latestMedia }); }
    else if (msg.type === 'notifications') {
      // Dropped outright when nobody is watching. The host stops polling on demand=false,
      // but a poll already in flight lands after that — and the one-time clear at the
      // transition cannot help, because this arrives AFTER it. Kept, that payload becomes
      // live again the moment the next subscriber flips demand back on: the first
      // subscriber is refused by the hostWasPolling gate and then enables delivery for
      // the SECOND one, and for its own re-init through ww-init (#131 review).
      //
      // Demand is the whole condition. A payload nobody asked for is not stale data to
      // be aged out later, it is data we should never have been holding.
      if (!notifWatchOn) return;
      // ...and produced under the demand interval we are CURRENTLY in, not merely under
      // some demand. The check above asks whether anyone is watching now; this asks whether
      // this payload was made for the watching that is happening now. A payload queued as
      // the last watcher left passes the first and fails this one (#132).
      //
      // Envelopes are stamped in the host's PostToShell, so EVERY push carries `gen` — but
      // it is deliberately only CHECKED here, and adding another channel to this list is a
      // decision, not a formality:
      //
      //   `sensors` and `media` have no demand and no cache the shell ever clears, so they
      //   have no interval to belong to. A late payload is slightly-old sensor data, which
      //   is what a polled feed is, not a staleness bug.
      //
      // Correlated replies (fetch/ping/media-list/audio/sd-*) are not gated either: they
      // are already non-stale by construction, since each answers a request this shell has
      // outstanding, and dropping one strands its asker until the request times out.
      // ...and NOT in the replica, where there is no demand interval to be stale relative
      // to. The settings window is a second host: it answers a watch synchronously with
      // sample toasts (settings.js) and never withdraws demand, because it deliberately
      // refuses to touch the panel's SetWatching bookkeeping. Its reply carries no `gen`,
      // so gating it dropped every sample and left the replica's widget on its loading
      // spinner forever — the exact failure the sample data exists to prevent.
      if (!PREVIEW && msg.gen !== notifGen) return;
      latestNotifications = msg.data || null;
      deliverNotifications();
    }
    else if (msg.type === 'fetch-result') {
      routeReply(fetchRoutes, msg, 'ww-fetch-result');
    } else if (msg.type === 'discover') {
      // The settings window asks a placed widget for a setting's choices (#210). The
      // answer goes back to the host, which hands it to the settings window.
      const d = msg.data || {};
      const hostId = typeof d.id === 'string' ? d.id : '';
      if (!hostId || PREVIEW) return;
      discoverFrom(String(d.instanceId || ''), String(d.property || ''),
        d.field ? String(d.field) : null,
        (result) => postToHost(Object.assign({ type: 'discover-result', id: hostId }, result)),
        typeof d.query === 'string' ? d.query.slice(0, DISCOVER_QUERY_MAX) : '');
    } else if (msg.type === 'sd-profile-result') {
      routeSd(msg, (data) => ({ type: 'ww-sd-profile', profile: data }));
    } else if (msg.type === 'sd-capture-result') {
      // A capture is a SCREENSHOT of the user's Stream Deck keys. It goes to the frame
      // whose request produced it and nowhere else.
      routeSd(msg, (data) => ({ type: 'ww-sd-capture-result', data }));
    } else if (msg.type === 'secure-result') {
      // A stored credential. It goes to the frame whose request produced it and nowhere
      // else — routeReply is what makes that true, since the host answers the shell.
      routeReply(secureRoutes, msg, 'ww-secure-result');
    } else if (msg.type === 'ping-result') {
      routeReply(pingRoutes, msg, 'ww-ping-result');
    } else if (msg.type === 'media-list-result') {
      routeReply(mediaRoutes, msg, 'ww-media-list-result');
    } else if (msg.type === 'audio-result') {
      routeReply(audioRoutes, msg, 'ww-audio-result');
    }
  }

  /** Delivers a host answer to the frame that asked for it. Routes hold the origin the
   * asking frame was on, not just its window: a proxy fetch reply carries the response
   * body, so a frame that navigated between request and answer must not receive it. */
  function routeReply(routes, msg, type) {
    const id = msg.data && msg.data.id;
    const route = routes.get(id);
    if (!route) return;
    routes.delete(id);
    try { route.win.postMessage({ type, ...msg.data }, route.origin); } catch (e) { /* frame gone */ }
  }

  function postToHost(message) {
    if (PREVIEW) {
      try { window.parent.postMessage({ type: 'ww-shell', message }, '*'); } catch (e) { /* parent gone */ }
      return;
    }
    window.chrome.webview.postMessage(message);
  }

  // ---- widget iframe bridge ---------------------------------------------------

  window.addEventListener('message', (ev) => {
    const msg = ev.data || {};
    if (PREVIEW && msg.type === 'ww-host' && ev.source === window.parent) {
      handleHostMessage(msg.message || {});
      return;
    }
    // ONLY a registered widget frame may drive the native bridge.
    //
    // postMessage reaches window.top from ANY descendant, not just a direct child, so
    // a remote page nested inside a widget could send ww-action / ww-fetch / ww-audio-set
    // and have the host execute them — Process.Start, injected hotkeys, and the proxy
    // fetch used as an SSRF hop with the reply routed back to the sender. Three stock
    // widgets frame third-party content (twitch, youtube) and one frames a URL the user
    // types (iframe), so this is reachable without anything being "compromised" in the
    // usual sense: embedding a page that later turns hostile is enough.
    //
    // The sandbox does not help — allow-scripts is what makes the widget work, and
    // per-widget virtual hosts stop a frame READING the shell, not messaging it. Only
    // the WindowProxy identity distinguishes the widget frame from its descendants:
    // ev.origin of a nested Twitch frame is twitch.tv, but so would be a legitimate
    // one's, so origin alone cannot tell them apart.
    const sender = slots.find((s) => s.frame && s.frame.contentWindow === ev.source);
    if (!sender) return;
    // Identity alone is not enough EITHER. A slot frame that navigates away — to
    // attacker.example, or anywhere the widget's own code sends it — keeps the same
    // WindowProxy, so it still passes the check above while no longer being the
    // widget: it inherits the injected bridge and, unchecked, would be answered with
    // the slot's settings (credentials included), the sensor snapshot and the host
    // capabilities. Identity says WHICH slot is speaking; origin says whether the
    // widget is still the one speaking. Both, or neither.
    if (!sender.origin || ev.origin !== sender.origin) return;

    if (msg.type === 'ww-media-control' && typeof msg.action === 'string') {
      postToHost({ type: 'media-control', action: msg.action });
    } else if (msg.type === 'ww-log') {
      postToHost({ type: 'log', message: String(msg.message).slice(0, 2000) });
    } else if (msg.type === 'ww-ready') {
      // Always answer, even for an already-initialized slot: the iframe may have
      // crashed and reloaded (common under cold-start resource pressure), and the
      // fresh document would otherwise run on its built-in defaults forever.
      sender.initialized = true;
      const stale = sender.el.querySelector('.error');
      if (stale) stale.remove();
      sendToSlot(sender, initMessage(sender));
      // Open lookups for this tile (#210): asked while it reloaded, or asked of the
      // document this one replaced, which can no longer answer. Answered once either way —
      // the route goes with the first answer.
      for (const route of discoverRoutes.values())
        if (route.slot === sender) sendToSlot(sender, route.question);
    } else if (msg.type === 'ww-swipe' && (msg.dir === 1 || msg.dir === -1)) {
      // A deliberate horizontal swipe that started inside the widget (#257), recognised
      // by widget-api.js because touch-action has to keep refusing the native pan there
      // (#206). Only from a widget on the page being shown — or glided to — so a tile on
      // a page nobody can see cannot page the dashboard; and never in edit mode, where
      // overlays own every gesture and widgets are not live.
      if (editing || sender.page !== layoutData.pages[editIndex()]) return;
      goToPage(editIndex() + msg.dir);
    } else if (msg.type === 'ww-discover-result') {
      // Only the frame that was asked, and only once. A route is per question and holds
      // the slot record itself, so another widget — or this one after a reload that
      // outlived the question — cannot answer it.
      const route = discoverRoutes.get(msg.id);
      if (!route || route.slot !== sender) return;
      discoverRoutes.delete(msg.id);
      clearTimeout(route.timer);
      route.done(cleanDiscovery(msg));
    } else if (msg.type === 'ww-open-url' && typeof msg.url === 'string') {
      postToHost({ type: 'open-url', url: msg.url });
    } else if (msg.type === 'ww-action' && typeof msg.kind === 'string') {
      postToHost({ type: 'action', kind: msg.kind, target: String(msg.target || '') });
    } else if (msg.type === 'ww-sd-profile') {
      const id = armSdRoute(msg, ev);
      // hideWindow is forwarded only when the widget actually stated one. `!== false`
      // turned "did not ask" into "hide it", so a widget with no opinion overrode the
      // preference of one that had — every poll, at 4s, in both directions.
      const sdReq = { type: 'sd-profile', id, profileName: msg.profileName || '', live: msg.live === true };
      if (typeof msg.hideWindow === 'boolean') sdReq.hideWindow = msg.hideWindow;
      postToHost(sdReq);
    } else if (msg.type === 'ww-sd-capture') {
      // `have` is the hash of the last frame the ASKING DOCUMENT actually received, and
      // it is the whole dedup. Passed through rather than tracked here: a widget can only
      // mislead itself with it (claim a frame it lacks and get told "unchanged"; claim
      // none and get a redundant image), whereas anything the shell or the host remembers
      // on its behalf can outlive the document it describes — which is what kept freezing
      // mirrors on a blank frame. Bounded because it crosses to native.
      postToHost({
        type: 'sd-capture',
        id: armSdRoute(msg, ev),
        have: String(msg.have || '').slice(0, 128),
      });
    } else if (msg.type === 'ww-sd-click') {
      // fx/fy: the EXACT tap point as fractions of the mirrored capture. The capture is
      // the VSD's client area pixel for pixel, so the host clicks the key face the user
      // saw — cell-center math (the fallback when absent) assumes the keys fill the
      // window, and Elgato draws chrome inside it.
      // phase: 'down'/'up' from the iCUE Streamdeck emulation's real pointer state
      // (press-and-hold reaches the deck as a hold); absent means the atomic tap.
      const frac = (v) => (typeof v === 'number' && v >= 0 && v <= 1 ? v : undefined);
      postToHost({
        type: 'sd-click', row: msg.row | 0, col: msg.col | 0, rows: msg.rows | 0, cols: msg.cols | 0,
        fx: frac(msg.fx), fy: frac(msg.fy),
        phase: msg.phase === 'down' || msg.phase === 'up' ? msg.phase : undefined,
      });
    } else if (msg.type === 'ww-fetch' && msg.id) {
      fetchRoutes.set(msg.id, { win: ev.source, origin: ev.origin });
      setTimeout(() => fetchRoutes.delete(msg.id), 30000);
      // maxBytes travels too. widget-api.js states the requirement where it builds this
      // snapshot: the ceiling has to cross the hop, because without it the host fetches,
      // buffers, base64-encodes and posts its full default before the wrapper in the page
      // can refuse a byte — so a lowered ceiling costs exactly as much as no ceiling and
      // only looks different. DashboardWindow.RequestedCap reads it and clamps it downward
      // only, so a widget can lower the limit and never raise it.
      postToHost({ type: 'fetch', id: msg.id, url: msg.url, method: msg.method, body: msg.body, contentType: msg.contentType, headers: msg.headers, insecure: msg.insecure === true, maxBytes: msg.maxBytes });
    } else if (msg.type === 'ww-ping' && msg.id) {
      pingRoutes.set(msg.id, { win: ev.source, origin: ev.origin });
      setTimeout(() => pingRoutes.delete(msg.id), 15000);
      postToHost({ type: 'ping', id: msg.id, hosts: Array.isArray(msg.hosts) ? msg.hosts.slice(0, 16) : [] });
    } else if (msg.type === 'ww-media-list' && msg.id) {
      mediaRoutes.set(msg.id, { win: ev.source, origin: ev.origin });
      setTimeout(() => mediaRoutes.delete(msg.id), 15000);
      postToHost({ type: 'media-list', id: msg.id });
    } else if (msg.type === 'ww-audio-get' && msg.id) {
      audioRoutes.set(msg.id, { win: ev.source, origin: ev.origin });
      setTimeout(() => audioRoutes.delete(msg.id), 15000);
      postToHost({ type: 'audio-get', id: msg.id });
    } else if ((msg.type === 'ww-secure-get' || msg.type === 'ww-secure-set'
                || msg.type === 'ww-secure-delete') && msg.id) {
      // The SCOPE comes from the slot that sent this, never from the message (#175). A
      // widget naming its own scope could name ANOTHER widget's and read its tokens —
      // and this is the only place in the system that knows which widget is speaking,
      // having established it twice over above: WindowProxy identity says which slot,
      // origin says the widget is still the one in it.
      const widgetId = sender.def && sender.def.widgetId;
      if (!widgetId) return;
      // #226 — the store scopes per INSTANCE under the widget id, so the slot's instanceId
      // travels alongside widgetId, stamped by the shell from the SAME slot and never taken
      // from the message: a widget naming its own instance could name another tile's bucket.
      // An added tile has an id from placement; a never-edited legacy tile has none yet, and
      // rather than fall back to a positional scope (which #68 forbids for a credential) the
      // empty id is forwarded so the host answers `bad-scope` and the widget keeps its token
      // in memory — the same fallback it takes when sealing is unavailable.
      const instanceId = (sender.def && sender.def.instanceId) || '';
      // The settings preview answers here and forwards NOTHING. Two reasons, and the
      // second is why it is answered rather than dropped: the replica must never read
      // or write a live credential (it is a layout editor, and its widgets run outside
      // a real slot), and settings.js relays only fetch/ping/media-list/audio-get — so
      // a forwarded secure-* would be dropped silently and settle only on secureCall's
      // 10s timeout, leaving an OAuth widget that awaits secureGet before its first
      // paint blank for ten seconds on every preview reload. Same shape as the
      // notifications-watch answer settings.js already gives, and for the same reason.
      //
      // The answers are the honest ones, not placeholders: the preview really does have
      // nothing stored (a miss, which the spec tells widgets to treat as normal), and a
      // set really did not write (`unavailable` — keep it in memory and carry on).
      if (PREVIEW) {
        const reply = { type: 'ww-secure-result', id: msg.id, value: null, ok: true };
        if (msg.type === 'ww-secure-set') { reply.ok = false; reply.error = 'unavailable'; }
        try { ev.source.postMessage(reply, ev.origin); } catch (e) { /* frame gone */ }
        return;
      }
      secureRoutes.set(msg.id, { win: ev.source, origin: ev.origin });
      setTimeout(() => secureRoutes.delete(msg.id), 15000);
      // The value crosses unmodified. Truncating an over-long credential here would
      // store a CORRUPTED one — worse than refusing it — so the size cap lives in one
      // place, on the host, which answers `too-large` and writes nothing.
      postToHost({
        type: msg.type.slice(3),          // ww-secure-get -> secure-get
        id: msg.id,
        widgetId,
        instanceId,
        key: typeof msg.key === 'string' ? msg.key : '',
        value: typeof msg.value === 'string' ? msg.value : '',
      });
    } else if (msg.type === 'ww-notifications-watch') {
      // Demand is tracked per slot and only on/off TRANSITIONS reach the host —
      // otherwise nothing would ever send watch(false) when the last watching
      // widget is removed, and the host would poll notifications forever.
      const wasWatching = !!sender.notifWatch;
      sender.notifWatch = msg.on !== false;
      if (!sender.notifWatch) sender.notifSeen = null;
      syncNotificationDemand();
      // A slot that subscribes while ANOTHER already has the host polling gets no
      // transition to ride in on — syncNotificationDemand returns early because the
      // aggregate demand is unchanged, and the host dedupes an unchanged poll, so the
      // new subscriber would sit on null until a toast happened to change. Before the
      // routing fix the panel-wide ww-init carried the payload and hid this; scoping
      // delivery is what exposes it. Hand the newcomer what is already known.
      //
      // Safe to hand over whatever is cached, because of where the staleness is handled
      // rather than here: the cache is cleared when the last watcher leaves, and a
      // payload arriving with no demand is dropped instead of stored. Between them,
      // latestNotifications is non-null only while someone is watching (#128, #131).
      //
      // An earlier version also required the host to have been polling already. That
      // read as a second opinion but guarded nothing once the two rules above were in
      // place — removing it failed no probe — so it is gone rather than left as a layer
      // nothing can test.
      if (sender.notifWatch && !wasWatching && latestNotifications)
        sendToSlot(sender, { type: 'ww-notifications', data: noteDelivered(sender, latestNotifications) });
    } else if (msg.type === 'ww-notification-dismiss' && msg.id != null) {
      // Dismissal is scoped to what this slot was actually shown. Otherwise a widget
      // that never subscribed can still clear toasts it never saw — and since ids come
      // from the host, guessing is not required to sweep them.
      if (sender.notifSeen && sender.notifSeen.has(String(msg.id)))
        postToHost({ type: 'notification-dismiss', id: msg.id });
    } else if (msg.type === 'ww-audio-set') {
      if (msg.id) {
        audioRoutes.set(msg.id, { win: ev.source, origin: ev.origin });
        setTimeout(() => audioRoutes.delete(msg.id), 15000);
      }
      postToHost({ type: 'audio-set', id: msg.id, target: String(msg.target || 'master'), level: msg.level, muted: msg.muted });
    }
  });

  function initMessage(slot) {
    return {
      type: 'ww-init',
      settings: slot.settings,
      sensors: latestSensors,
      media: latestMedia,
      relayToken: mediaRelayToken,
      theme: slotTheme(slot),
      // Only for a slot that asked. A re-init used to hand the latest toasts — app
      // name, title, body — to every widget on the panel, subscriber or not, so a
      // widget needed no notification code at all to read the user's notifications.
      notifications: slot.notifWatch ? noteDelivered(slot, latestNotifications) : null,
      withheld: withheldSecrets(slot),
      status,
    };
  }

  /// The names of this slot's secret settings that hold a value the settings PREVIEW is
  /// not given (#59). Names only, never values: a widget that would otherwise fall back to
  /// a plain setting when its secret one reads empty can tell "withheld here" from "not
  /// set". Always empty on the panel, which is handed the real values.
  function withheldSecrets(slot) {
    if (!PREVIEW || !slot.def || !Array.isArray(slot.def.secretsSet)) return [];
    const cleared = Array.isArray(slot.def.secretsCleared) ? slot.def.secretsCleared : [];
    return slot.def.secretsSet.filter((n) => typeof n === 'string' && !cleared.includes(n));
  }

  /// Records which notification ids a slot has been shown, so a later dismiss can be
  /// checked against them. Returns the payload unchanged, for use at the delivery point.
  function noteDelivered(slot, payload) {
    const items = (payload && payload.items) || [];
    slot.notifSeen = slot.notifSeen || new Set();
    for (const n of items) if (n && n.id != null) slot.notifSeen.add(String(n.id));
    return payload;
  }

  /// Asks the placed widget with this instanceId which values one of its settings can take
  /// (#210), and calls done exactly once with the cleaned answer or a reason there is none.
  /// The widget answers with its own fetch and its own saved credential — the reason the
  /// question is asked here, on the panel, rather than in the settings window.
  function discoverFrom(instanceId, property, field, done, query) {
    const slot = instanceId && slots.find((s) => s.def && s.def.instanceId === instanceId && s.frame);
    if (!slot) { done({ ok: false, error: 'not-placed' }); return; }
    if (!slot.origin) { done({ ok: false, error: 'not-ready' }); return; }
    const id = 'dq' + (++discoverSeq) + '-' + Math.random().toString(36).slice(2);
    const timer = setTimeout(() => {
      if (discoverRoutes.delete(id)) done({ ok: false, error: 'timeout' });
    }, DISCOVER_TIMEOUT_MS);
    const question = { type: 'ww-discover', id, property, field: field || null, query: query || '' };
    discoverRoutes.set(id, { slot, done, timer, question });
    // A tile mid-reload has no document to ask yet. Its ww-ready sends every open
    // question on.
    if (slot.initialized) sendToSlot(slot, question);
  }

  // >>> ww-discover-clean — extracted and RUN by tests/harness/discover-run.js
  /** A widget's answer, reduced to what the editors show: at most 500 choices, each a
   * non-blank string value of at most 300 characters and a label (the value when none is
   * given), no repeats. The widget is the untrusted party here; nothing else it sent is
   * passed on. */
  function cleanDiscovery(msg) {
    const MAX = 500;
    const MAXLEN = 300;
    if (!msg || typeof msg !== 'object') return { ok: false, error: 'bad-reply' };
    if (msg.unsupported === true) return { ok: false, error: 'unsupported' };
    if (typeof msg.error === 'string' && msg.error.trim())
      return { ok: false, error: 'widget', message: msg.error.trim().slice(0, MAXLEN) };
    if (!Array.isArray(msg.options)) return { ok: false, error: 'bad-reply' };
    const seen = new Set();
    const options = [];
    let truncated = false;
    for (const o of msg.options) {
      let value;
      let label;
      if (typeof o === 'string') { value = o; label = o; }
      else if (o && typeof o === 'object' && typeof o.value === 'string') {
        value = o.value;
        label = typeof o.label === 'string' && o.label.trim() ? o.label : o.value;
      } else continue;
      if (!value.trim() || value.length > MAXLEN || seen.has(value)) continue;
      if (options.length >= MAX) { truncated = true; break; }
      seen.add(value);
      options.push({ value, label: label.trim().slice(0, MAXLEN) });
    }
    return { ok: true, options, truncated };
  }
  // <<< ww-discover-clean

  /// Remembers who asked, so the answer can go back to exactly that frame. The shim
  /// mints the id; a caller that sent none still works, on an id minted here, because a
  /// reply that cannot be routed would otherwise be dropped in silence.
  function armSdRoute(msg, ev) {
    const id = msg.id || ('sd-' + (++sdSeq));
    sdRoutes.set(id, { win: ev.source, origin: ev.origin });
    setTimeout(() => sdRoutes.delete(id), 15000);
    return id;
  }

  /// One answer, one requester. `build` shapes the payload because the profile and the
  /// capture reply differ in envelope while sharing this routing.
  function routeSd(msg, build) {
    const id = msg.data && msg.data.id;
    const route = sdRoutes.get(id);
    if (!route) return;
    sdRoutes.delete(id);
    // The id rides on the envelope as well as inside the payload, so the receiving
    // document can check it against the requests IT issued — a reload keeps the same
    // WindowProxy, so a route outliving its document would otherwise deliver the old
    // document's answer to the new one.
    const out = build(msg.data);
    out.id = id;
    try { route.win.postMessage(out, route.origin); } catch (e) { /* frame gone */ }
  }

  /// Delivers to the slots that asked for this kind of data, by slot-record flag. The
  /// panel-wide broadcast is right for state every widget is entitled to — sensors, the
  /// theme, game mode — and wrong for anything a widget has to request, because then the
  /// request is what distinguishes a subscriber from a bystander.
  function deliverTo(flag, message) {
    for (const slot of slots) if (slot.initialized && slot[flag]) sendToSlot(slot, message);
  }

  /// Notifications go to the slots that subscribed, not to the panel. The host's polling
  /// is already demand-gated per slot (syncNotificationDemand) — delivery simply had not
  /// been, so one widget enabling the feature exposed the payload to all of them.
  function deliverNotifications() {
    for (const slot of slots) {
      if (!slot.initialized || !slot.notifWatch) continue;
      sendToSlot(slot, { type: 'ww-notifications', data: noteDelivered(slot, latestNotifications) });
    }
  }

  // Notification polling is demand-gated in the host; recomputed from the live slot
  // records after anything that adds or removes them, so removing the last watching
  // widget (edit-mode ✕, page delete, re-init) actually stops the host's polling.
  let notifWatchOn = false; // last demand posted to the host

  /// Which demand interval we are in. Bumped on every transition and sent with the demand
  /// message, so the host can stamp what it produces and we can tell a payload made under
  /// the CURRENT demand from one made under a previous one.
  ///
  /// The guard below checks current demand, which is a different question: a payload
  /// produced while the last watcher was leaving can still be sitting in the WebView
  /// message queue when a new watcher arrives, and by the time it dispatches `notifWatchOn`
  /// is true again. It then passes, is cached, and is delivered as current (#132).
  ///
  /// The window is one message-queue hop, so the payload is barely old — but "barely old"
  /// and "produced under demand that has since been revoked and re-granted" are different
  /// claims, and only the second is what the cache is supposed to guarantee.
  // A generation is "<document>:<counter>". The counter alone restarts at zero in every
  // document, so a poll still in flight across a reload could carry a stamp the NEW document
  // will also produce — invalidating the host-side epoch cannot help, because that payload
  // was already authorised and stamped before the reload. The base comes from the host, which
  // counts documents, so the two ranges cannot overlap.
  let genBase = '0';
  let notifSeq = 0;
  let notifGen = '';
  function syncNotificationDemand() {
    const on = slots.some((s) => s.notifWatch);
    if (on === notifWatchOn) return;
    notifWatchOn = on;
    notifSeq++;
    notifGen = genBase + ':' + notifSeq;
    // The host stops polling when demand drops, so anything held here is frozen at the
    // moment the last watcher left and only gets staler. Dropping it means a later
    // subscriber waits for a real poll instead of being shown toasts that may no longer
    // exist — and that nothing can carry the stale set, ww-init included (#128).
    if (!on) latestNotifications = null;
    postToHost({ type: 'notifications-watch', on, gen: notifGen });
  }

  let panelNoticeTimer = null;

  /** Transient banner for what a tap cannot show on its own — a size change that did
   * nothing, and why (#77). The strip has no dialogs and no room for one, so this rides
   * above everything and clears itself; it is deliberately the only such surface. */
  function showPanelNotice(text) {
    let node = document.getElementById('panelNotice');
    if (!node) {
      node = document.createElement('div');
      node.id = 'panelNotice';
      node.className = 'panel-notice';
      document.body.appendChild(node);
    }
    node.textContent = text;
    node.hidden = false;
    clearTimeout(panelNoticeTimer);
    panelNoticeTimer = setTimeout(() => { node.hidden = true; }, 6000);
  }

  /** The origin a slot's frame must be on to count as that widget. Derived from the
   * widget's own URL rather than a hardcoded host pattern, so it holds for the real
   * `{slug}.widgets.plinth` mapping and for the harness fixtures alike. A URL that will
   * not parse yields null, which every caller treats as "refuse". */
  function originOf(url) {
    try { return new URL(url, location.href).origin; } catch (e) { return null; }
  }

  function sendToSlot(slot, message) {
    if (!slot.frame || !slot.origin) return; // not-installed placeholder / unparseable url
    try {
      // Targeted, never '*': a slot frame that has navigated away is still the same
      // WindowProxy, so an untargeted post would hand settings, sensors and media to
      // whatever now occupies it. The browser drops the message instead.
      slot.frame.contentWindow.postMessage(message, slot.origin);
    } catch (e) { /* frame may be reloading */ }
  }

  function broadcast(message) {
    for (const slot of slots) {
      if (slot.initialized) sendToSlot(slot, message);
    }
  }

  // ---- layout rendering --------------------------------------------------------

  // Size tokens: a width (quarter | half | three-quarter | full) with an optional
  // "-upper" / "-lower" suffix selecting the top or bottom half of the page.
  function parseSize(token) {
    let t = String(token || 'quarter').toLowerCase();
    let band = 'full';
    if (t.endsWith('-upper')) { band = 'upper'; t = t.slice(0, -6); }
    else if (t.endsWith('-lower')) { band = 'lower'; t = t.slice(0, -6); }
    const widths = { quarter: 1, half: 2, 'three-quarter': 3, threequarter: 3, full: 4 };
    return { w: widths[t] || 1, band };
  }

  // First-fit placement on the page's 4x2 cell grid, in slot order (left to right,
  // full-height and upper slots in the top row first, lower slots in the bottom).
  // Returns per-slot {col, w, band} or null when the page is already full.
  function placeSlots(slotDefs) {
    const occupied = [new Array(4).fill(false), new Array(4).fill(false)]; // [row][col]
    const results = new Array(slotDefs.length).fill(null);
    const rowsOf = (band) => band === 'full' ? [0, 1] : band === 'upper' ? [0] : [1];
    const free = (rows, col, w) => {
      if (col < 0 || col + w > 4) return false;
      for (const r of rows) for (let i = 0; i < w; i++) if (occupied[r][col + i]) return false;
      return true;
    };
    const take = (rows, col, w) => {
      for (const r of rows) for (let i = 0; i < w; i++) occupied[r][col + i] = true;
    };
    // Pass A — anchors first. A slot dropped onto a free cell carries `col`
    // (1-based): it claims THAT column. Without anchors, order-based first-fit
    // packs half-width tiles back to the left no matter where they were dropped
    // — the field recording's "drag and drop is still not working": dropping
    // onto the empty right half committed an order swap that rendered in the
    // exact same place. An anchor that no longer fits (resize, collision on an
    // old layout) falls back to flow placement below instead of vanishing.
    slotDefs.forEach((def, i) => {
      const anchor = (def.col >= 1 && def.col <= 4) ? def.col - 1 : null;
      if (anchor === null) return;
      const { w, band } = parseSize(def.size);
      const rows = rowsOf(band);
      if (free(rows, anchor, w)) {
        take(rows, anchor, w);
        results[i] = { col: anchor, w, band };
      }
    });
    // Pass B — everything else flows first-fit into the remaining cells
    // (the original model; unanchored layouts behave exactly as before).
    slotDefs.forEach((def, i) => {
      if (results[i] !== null) return;
      const { w, band } = parseSize(def.size);
      const rows = rowsOf(band);
      for (let col = 0; col + w <= 4; col++) {
        if (free(rows, col, w)) {
          take(rows, col, w);
          results[i] = { col, w, band };
          return;
        }
      }
    });
    return results;
  }

  function applyThemeTokens(tokens) {
    if (!tokens || typeof tokens !== 'object') return;
    latestTheme = tokens;
    for (const [name, value] of Object.entries(tokens)) {
      if (name.startsWith('--')) document.documentElement.style.setProperty(name, String(value));
    }
  }

  function onInit(data) {
    // Adopted before anything can declare demand, so the first watch already carries this
    // document's base.
    if (data.genBase !== undefined && data.genBase !== null) genBase = String(data.genBase);
    if (PREVIEW) previewGen = data.gen | 0;
    if (PREVIEW && typeof data.page === 'number') previewPage = data.page;
    latestSensors = data.sensors || [];
    latestMedia = data.media;
    if (typeof data.mediaRelayToken === 'string') mediaRelayToken = data.mediaRelayToken;
    status = data.status || status;
    // Game state rides init: a game already fullscreen when the shell loads fired
    // its transition before shell-ready, and the host's poll dedups it forever.
    applyThemeTokens(data.theme);

    layoutData = (data.layout && Array.isArray(data.layout.pages)) ? data.layout : { pages: [] };
    // Normalised at the one door the catalog comes through — see Shell/appearance.js.
    // Downstream (mergedSettings, the add-zones' fit checks) reads an already-correct
    // property list and needs no idea that some properties are the panel's, not the
    // widget author's.
    widgetLib = window.WWAppearance.normalizeCatalog(data.widgets);
    widgetsById = new Map(widgetLib.map((w) => [w.id, w]));
    backgroundHost = data.backgroundHost || backgroundHost;

    // Instance identity is unique by the time a layout gets here: the host re-mints a
    // repeated instanceId as it loads layout.json (LayoutStore.HealDuplicateIds), so two
    // look-alike tiles never share widget-local storage.
    renderAll();
  }

  function renderAll() {
    cancelDrag();   // a re-init mid-drag must not orphan the ghost / dragging state
    // A re-init (hot reload, replica refresh) keeps the page.
    const keepPage = (PREVIEW && previewPage != null) ? previewPage : currentPage();
    refreshBgSpecs();
    bg.reset();

    pagesEl.textContent = '';
    pageEls.clear();
    slots = [];
    selected = null; // records are being replaced; the settings window re-sends select-slot after a re-init

    for (const page of layoutData.pages) buildPage(page);
    syncPageOrder();
    rebuildDots();

    emptyEl.hidden = editing || slots.length > 0 || layoutData.pages.length > 0;
    pagesEl.scrollLeft = Math.min(keepPage, Math.max(0, layoutData.pages.length - 1)) * pagesEl.clientWidth;
    updateDots();
    bg.applyForPage(currentPage()); // paint the initial page's background at once (updateDots only debounces)

    generation++;
    armWatchdog(generation);
    syncNotificationDemand(); // fresh records carry no demand; rebuilt widgets re-watch
  }

  function buildPage(page) {
    const pageEl = document.createElement('section');
    pageEl.className = 'page';
    pageEls.set(page, pageEl);

    // "+ add widget" affordances, one per free region — built by relayoutPage, which
    // is the only place that knows what is free. A single zone over the largest hole
    // left every OTHER hole dead: visibly empty, and no way to put anything in it
    // (#84).
    for (const slotDef of page.slots || []) buildSlot(page, slotDef);
    relayoutPage(page);
    pagesEl.appendChild(pageEl);
    return pageEl;
  }

  function buildSlot(page, slotDef) {
    const pageEl = pageEls.get(page);
    const slotEl = document.createElement('div');
    slotEl.className = 'slot';
    const uid = ++slotUid;
    const widget = widgetsById.get(slotDef.widgetId);
    let record;

    if (!widget) {
      const err = document.createElement('div');
      err.className = 'error';
      err.textContent = `Widget "${slotDef.widgetId}" is not installed`;
      slotEl.appendChild(err);
      record = { frame: null, el: slotEl, def: slotDef, page, uid, settings: {}, initialized: true, retries: 9 };
    } else {
      const frame = document.createElement('iframe');
      // allow-same-origin is safe here: each widget is served from its own
      // virtual host, so widgets cannot reach the shell's or each other's origin.
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      // Fragment carries a stable per-slot tag (backs the iCUE `uniqueId` global)
      // plus this slot's merged settings, so the shim can inject property globals
      // BEFORE widget scripts run — matching iCUE's documented injection timing.
      // The persisted instanceId is the permanent identity. The host stamps one on every
      // slot as it loads layout.json (LayoutStore.MintMissingIds), adopting the positional
      // tag below, so the fallback only covers a def the replica has not persisted yet.
      const settings = mergedSettings(widget, slotDef);
      const tag = slotDef.instanceId ||
        ('p' + Math.max(0, layoutData.pages.indexOf(page)) + 's' + Math.max(0, (page.slots || []).indexOf(slotDef)));
      let slotHash = '#ww-slot=' + tag;
      try {
        slotHash += '&ww-settings=' + encodeURIComponent(JSON.stringify(settings));
      } catch (e) { /* unserializable settings: init delivery still applies them */ }
      frame.src = widget.url + slotHash;
      slotEl.appendChild(frame);
      record = { frame, el: slotEl, url: widget.url, origin: originOf(widget.url), hash: slotHash, tag,
        def: slotDef, page, uid, settings, initialized: false, retries: 0 };
    }

    slotEl.appendChild(buildOverlay(record, widget));
    slots.push(record);
    pageEl.appendChild(slotEl);
    return record;
  }

  // Applies grid placement for every slot of a page (and the add-zone). Slots that no
  // longer fit are hidden rather than overlapped; the editor's fit checks prevent that
  // for its own operations, so this only triggers for hand-edited layout files.
  function relayoutPage(page) {
    const defs = page.slots || [];
    const placements = placeSlots(defs);
    defs.forEach((def, i) => {
      const rec = slots.find((s) => s.def === def);
      if (!rec) return;
      const place = placements[i];
      if (!place) {
        rec.el.style.display = 'none';
        return;
      }
      rec.el.style.display = '';
      rec.el.style.gridColumn = (place.col + 1) + ' / span ' + place.w;
      rec.el.style.gridRow = place.band === 'full' ? '1 / span 2' : place.band === 'upper' ? '1' : '2';
    });
    positionAddZone(page, placements);
    refreshHiddenShelf(page, placements);
  }

  // Registered-but-invisible widgets must never be silent (field report:
  // "widgets become lost where they're no longer visible on the screen but
  // still registered"): a page hiding any slot grows an "Off screen" shelf in
  // edit mode naming each one — tapping a chip flows the widget back into the
  // free space, shrinking it if that's what it takes.
  function refreshHiddenShelf(page, placements) {
    const pageEl = pageEls.get(page);
    if (!pageEl) return;
    let shelf = pageEl.querySelector('.hidden-shelf');
    const defs = page.slots || [];
    const hidden = defs.filter((d, i) => placements[i] === null);
    if (!hidden.length) {
      if (shelf) shelf.remove();
      return;
    }
    if (!shelf) {
      shelf = document.createElement('div');
      shelf.className = 'hidden-shelf';
      pageEl.appendChild(shelf);
    }
    shelf.textContent = '';
    const label = document.createElement('span');
    label.className = 'hs-label';
    label.textContent = 'Off screen:';
    shelf.appendChild(label);
    for (const def of hidden) {
      const widget = widgetsById.get(def.widgetId);
      const chip = document.createElement('button');
      chip.className = 'hs-chip';
      chip.textContent = widget ? (widget.displayName || widget.name) : def.widgetId;
      chip.title = 'Registered but no room to render — tap to place it back (shrinks if needed)';
      chip.addEventListener('click', () => restoreHiddenSlot(page, def, chip));
      shelf.appendChild(chip);
    }
  }

  // Smallest change that gets a hidden widget back on screen: keep its size if
  // room opened up, else walk narrower widths in its band, then the other
  // bands. Probes run without its column pin — a hidden slot's pin points at
  // space someone else now owns.
  function findRestoreSize(page, def) {
    const defs = page.slots || [];
    if (!defs.includes(def)) return null;
    const savedCol = def.col;
    delete def.col;
    try {
      const { width, band } = sizeParts(def.size);
      const widthList = [width].concat(narrowerWidths(width, widgetsById.get(def.widgetId)));
      const bandList = [band].concat(['full', 'upper', 'lower'].filter((b) => b !== band));
      for (const b of bandList) for (const w of widthList) {
        if (fitsWithSize(page, def, makeSize(w, b))) return makeSize(w, b);
      }
      return null;
    } finally {
      if (savedCol !== undefined) def.col = savedCol;
    }
  }

  function restoreHiddenSlot(page, def, chip) {
    if (!findRestoreSize(page, def)) {
      // Genuinely no room even at the smallest allowed size — say so in place.
      const old = chip.textContent;
      chip.classList.add('no-room');
      chip.textContent = 'No room — remove a widget';
      setTimeout(() => { chip.classList.remove('no-room'); chip.textContent = old; }, 1800);
      return;
    }
    mutate(() => {
      // Re-check inside the mutation step: queued view transitions may have
      // changed the page since the tap was validated.
      const size = findRestoreSize(page, def);
      if (!size) return;
      delete def.col;
      def.size = size;
      relayoutPage(page);
      const rec = slots.find((s) => s.def === def);
      if (rec && rec.syncLabels) rec.syncLabels();
    });
  }

  /** Every free rectangle on the page, largest first, with no overlaps.
   *
   * One zone over the largest hole is what #84 reported: a page with two disjoint
   * holes showed an "Add widget" in one of them and left the other visibly empty with
   * no way to fill it. Reproduced at 1280x400 with a half-upper and a quarter-lower —
   * the zone took the 2x2 block on the right and the free quarter at row 2 col 2 got
   * nothing.
   *
   * Greedy: take the largest free rectangle, mark it used, repeat. The rectangles
   * tile the free cells rather than enumerating every rectangle that fits in them,
   * so no two zones ever overlap and every free cell belongs to exactly one. */
  /** The 2x4 occupancy grid [row][col] for a page: which cells its slots fill. Shared by
   *  freeRegions (which partitions the FREE cells into non-overlapping zones) and
   *  sizeInRegion (which sizes a widget against those free cells), so "is this cell free"
   *  has a single answer on both. */
  function occupancyGrid(page, placements) {
    const occupied = [new Array(4).fill(false), new Array(4).fill(false)];
    for (const place of placements || placeSlots(page.slots || [])) {
      if (!place) continue;
      const rows = place.band === 'full' ? [0, 1] : place.band === 'upper' ? [0] : [1];
      for (const r of rows) for (let i = 0; i < place.w; i++) occupied[r][place.col + i] = true;
    }
    return occupied;
  }

  function freeRegions(page, placements) {
    // Work on a COPY: the greedy pass marks each rectangle used as it extracts it, and
    // sizeInRegion still needs the untouched occupancy to size against.
    const occupied = occupancyGrid(page, placements).map((row) => row.slice());
    const regions = [];
    for (;;) {
      let best = null;
      for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++) {
        for (let h = 1; r + h <= 2; h++) for (let w = 1; c + w <= 4; w++) {
          let free = true;
          for (let i = r; i < r + h && free; i++) for (let j = c; j < c + w && free; j++) if (occupied[i][j]) free = false;
          if (free && (!best || w * h > best.w * best.h)) best = { r, c, w, h };
        }
      }
      if (!best) return regions;
      for (let i = best.r; i < best.r + best.h; i++)
        for (let j = best.c; j < best.c + best.w; j++) occupied[i][j] = true;
      regions.push(best);
    }
  }

  /** The size a widget takes when added from the zone anchored at `region`. Null when the
   *  widget cannot fit at all, which is what lets a zone say why it is unavailable (#77).
   *  The column count comes from parseSize, not a second width table, so a widget is never
   *  placed a column wider or narrower than the cells that were checked.
   *
   *  Two phases. First a fit BOUNDED by the tapped rectangle, banded to its own rows —
   *  widest supported width that fits the region's columns. This keeps the #84 promise that
   *  tapping a small hole gives a widget sized FOR it (a quarter stays a quarter) rather than
   *  one that spills into its neighbours. Only when NOTHING fits the rectangle does the
   *  partition itself become the problem #86 reports: the greedy free-space partition can
   *  split a still-valid footprint across two rectangles (a three-quarter-upper across a 2x2
   *  zone and the lone cell beside it), and a widget measured against either rectangle alone
   *  has no way in. So the fallback sizes against the actual free space (`occupied`): iterate
   *  widths widest-first, try the bands whose rows include the tapped region (its own shape
   *  first), and take the first footprint — anchored at region.c, extending right — whose
   *  every cell is free, even across two rectangles. That a pick can then extend past the
   *  zone the user tapped is the deliberate trade: a wider widget that fills the row beats no
   *  way to add one that fits. */
  function sizeInRegion(widget, region, occupied) {
    const widths = allowedWidths(widget).slice().reverse();   // widest first
    // Phase 1 — bounded by the rectangle (its cells are all free, being a free region).
    const ownBand = region.h === 2 ? 'full' : (region.r === 0 ? 'upper' : 'lower');
    for (const wName of widths) if (parseSize(wName).w <= region.w) return makeSize(wName, ownBand);
    // Phase 2 — nothing fit the rectangle; reach into adjacent free cells (#86).
    const bands = region.h === 2 ? ['full', 'upper', 'lower']
      : region.r === 0 ? ['upper', 'full'] : ['lower', 'full'];
    for (const wName of widths) {
      const w = parseSize(wName).w;
      if (region.c + w > 4) continue;   // would run off the grid
      for (const band of bands) {
        const rows = band === 'full' ? [0, 1] : band === 'upper' ? [0] : [1];
        let free = true;
        for (const r of rows) for (let i = 0; i < w && free; i++) if (occupied[r][region.c + i]) free = false;
        if (free) return makeSize(wName, band);
      }
    }
    return null;
  }

  function positionAddZone(page, placements) {
    const pageEl = pageEls.get(page);
    if (!pageEl) return;
    const regions = freeRegions(page, placements);
    // The raw occupancy behind those regions — sizeInRegion sizes against the free cells,
    // which may reach past a single zone's rectangle (#86).
    const occupied = occupancyGrid(page, placements);
    const zones = [...pageEl.querySelectorAll('.add-zone')];
    // Reuse what is there and trim the rest: rebuilding every zone on every relayout
    // would restart the pulse animation on tiles the user is not touching.
    while (zones.length > regions.length) zones.pop().remove();
    while (zones.length < regions.length) {
      const z = document.createElement('button');
      z.className = 'add-zone';
      // A bare "+" read as decoration in the field ("the palette icon is gone") —
      // say what the zone does.
      const plus = document.createElement('span');
      plus.className = 'az-plus';
      plus.textContent = '+';
      const label = document.createElement('span');
      label.className = 'az-label';
      z.append(plus, label);
      pageEl.appendChild(z);
      zones.push(z);
    }
    regions.forEach((region, i) => {
      const z = zones[i];
      z.style.display = '';
      z.style.gridColumn = (region.c + 1) + ' / span ' + region.w;
      z.style.gridRow = region.h === 2 ? '1 / span 2' : String(region.r + 1);
      // Unavailable WITH a reason (#77). A region no installed widget can occupy is
      // rare — every stock widget takes a quarter — but silence there would be the
      // same dead space this issue is about.
      const fits = widgetLib.some((w) => sizeInRegion(w, region, occupied));
      z.disabled = !fits;
      z.classList.toggle('full', !fits);
      z.querySelector('.az-plus').textContent = fits ? '+' : '·';
      z.querySelector('.az-label').textContent = fits ? 'Add widget' : 'Nothing fits here';
      z.title = fits ? 'Add a widget here' : 'No installed widget fits this space';
      z.onclick = fits ? () => requestAddWidget(page, region) : null;
    });
  }

  // Pages are ordered with flex `order` so reordering never moves DOM nodes —
  // moving an iframe in the DOM reloads it.
  function syncPageOrder() {
    layoutData.pages.forEach((page, i) => {
      const el = pageEls.get(page);
      if (el) el.style.order = String(i);
    });
  }

  function rebuildDots() {
    dotsEl.textContent = '';
    layoutData.pages.forEach((_, i) => {
      const dot = document.createElement('span');
      dot.addEventListener('click', () => goToPage(i));
      dotsEl.appendChild(dot);
    });
  }

  function refreshBgSpecs() {
    bgGlobal = layoutData.background || null;
    bgPages = layoutData.pages.map((p) => p.background || null);
  }

  // Widget loads can flake (virtual-host races, heavy first paints); retry stragglers
  // a couple of times before declaring them failed.
  let watchdogTimer = null;
  function armWatchdog(gen) {
    // ONE pending chain, ever: arming replaces the previous timer. Stacked chains
    // (rapid settings reloads each arming their own) would sweep the same
    // uninitialized slot at the spacing between edits and burn both retries in
    // fractions of the intended seven-second startup window.
    clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      watchdogTimer = null;
      if (gen !== generation) return;
      let retrying = false;
      for (const slot of slots) {
        if (slot.initialized || !slot.frame) continue;
        if (slot.retries < 2) {
          slot.retries++;
          retrying = true;
          // A changed query forces a real navigation (re-assigning a same-URL-with-
          // fragment src is treated as a fragment jump and does not reload).
          try { slot.frame.src = slot.url + '?wwr=' + slot.retries + slot.hash; } catch (e) { /* frame gone */ }
          postToHost({ type: 'log', message: 'watchdog: reloading slow widget (attempt ' + slot.retries + ')' });
        } else if (!slot.el.querySelector('.error')) {
          const err = document.createElement('div');
          err.className = 'error';
          err.textContent = 'Widget failed to load';
          slot.el.appendChild(err);
        }
      }
      if (retrying) armWatchdog(gen);
    }, 7000);
  }

  function mergedSettings(widget, slotDef) {
    const settings = {};
    for (const prop of widget.properties || []) {
      if (prop.name) settings[prop.name] = prop.default;
    }
    Object.assign(settings, slotDef.settings || {});
    // No unwrapping here any more. Protocol used to ride INSIDE values, so this had to
    // defend every widget against being handed a sentinel and reading it as a live
    // credential; a clear now travels as a name beside the layout and a value is only
    // ever itself.
    return settings;
  }

  // ---- page navigation (dots + edge zones) ----------------------------------------

  const edgeLeft = document.getElementById('edgeLeft');
  const edgeRight = document.getElementById('edgeRight');

  function currentPage() {
    return Math.round(pagesEl.scrollLeft / Math.max(1, pagesEl.clientWidth));
  }

  // While a goToPage glide is still animating, scrollLeft reports the page being LEFT
  // (or one glided past), so edit operations must act on the destination instead.
  let navTarget = null;

  function editIndex() {
    return navTarget !== null ? navTarget : currentPage();
  }

  function goToPage(index, silent) {
    const count = dotsEl.children.length;
    const clamped = Math.max(0, Math.min(count - 1, index));
    const left = clamped * pagesEl.clientWidth;
    navTarget = Math.abs(pagesEl.scrollLeft - left) < 2 ? null : clamped; // no scroll -> no scrollend
    // WYSIWYG: page moves initiated inside the editing replica (an edge drop, a tap on
    // the dots or an edge) must steer the settings window too, or its rail/detail panel
    // keeps operating on the page the preview no longer shows. HOST-steered moves
    // are silent: echoing them back turns the settings' own stale-navigation
    // re-steer into a message ping-pong until its debounce clears.
    if (PREVIEW && editing && !silent) postToHost({ type: 'page-changed', index: clamped, gen: previewGen });
    pagesEl.scrollTo({ left, behavior: 'smooth' });
    wakeChrome();
  }

  function wakeChrome() {
    for (const el of [dotsEl, edgeLeft, edgeRight]) el.classList.remove('idle');
    clearTimeout(dotsIdleTimer);
    if (editing) return; // chrome stays awake for the whole edit session
    dotsIdleTimer = setTimeout(() => {
      for (const el of [dotsEl, edgeLeft, edgeRight]) el.classList.add('idle');
    }, 2500);
  }

  function updateDots() {
    const index = currentPage();
    if (navTarget !== null && Math.abs(pagesEl.scrollLeft - navTarget * pagesEl.clientWidth) < 2) navTarget = null; // settled (scrollend fallback)
    [...dotsEl.children].forEach((dot, i) => dot.classList.toggle('active', i === index));
    // Dot highlighting tracks the scroll live, but applying a background is expensive
    // (for video it creates + network-loads + plays an element), so a single tap that
    // jumps several pages must not paint every page scrolled past. Defer the swap until
    // scrolling settles and paint only the page we actually land on.
    clearTimeout(bgSettleTimer);
    bgSettleTimer = setTimeout(() => bg.applyForPage(currentPage()), 140);
    wakeChrome();
  }

  // ---- wallpaper (dashboard/page background) ---------------------------------------

  function createBackgroundController() {
    const layers = [document.getElementById('bgLayer0'), document.getElementById('bgLayer1')];
    const dim = document.getElementById('bgDim');
    let front = 0;         // index of the layer currently shown
    let currentKey = null; // spec key currently shown, to skip redundant swaps

    const validColor = (c, fallback) =>
      // Only 3/4/6/8-digit hex are valid CSS; 5- and 7-digit would be applied then
      // silently dropped by the browser, so reject them and use the fallback.
      (typeof c === 'string' && /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(c.trim())) ? c.trim() : fallback;

    function resolveUrl(source) {
      return 'https://' + backgroundHost + '/' + encodeURIComponent(source);
    }

    function applyImageFit(layer, fit) {
      switch (fit) {
        case 'contain': layer.style.backgroundSize = 'contain'; layer.style.backgroundRepeat = 'no-repeat'; break;
        case 'stretch': layer.style.backgroundSize = '100% 100%'; layer.style.backgroundRepeat = 'no-repeat'; break;
        case 'tile':    layer.style.backgroundSize = 'auto';      layer.style.backgroundRepeat = 'repeat'; break;
        case 'center':  layer.style.backgroundSize = 'auto';      layer.style.backgroundRepeat = 'no-repeat'; break;
        default:        layer.style.backgroundSize = 'cover';     layer.style.backgroundRepeat = 'no-repeat'; break;
      }
    }

    function videoObjectFit(fit) {
      if (fit === 'contain') return 'contain';
      if (fit === 'stretch') return 'fill';
      if (fit === 'center' || fit === 'tile') return 'none';
      return 'cover';
    }

    function clearVideo(layer) {
      const v = layer.querySelector('video');
      if (v) {
        try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) { /* ignore */ }
        v.remove();
      }
    }

    function paint(layer, spec) {
      clearVideo(layer);
      layer.style.background = '';
      layer.style.backgroundColor = '';
      layer.style.backgroundImage = '';
      layer.style.filter = '';
      if (!spec || !spec.type || spec.type === 'none') return;

      const blur = Math.max(0, Math.min(40, Number(spec.blur) || 0));
      layer.classList.toggle('blurred', blur > 0);
      if (blur) layer.style.filter = 'blur(' + blur + 'px)';

      if (spec.type === 'color') {
        layer.style.backgroundColor = validColor(spec.color, '#101418');
      } else if (spec.type === 'gradient') {
        const angle = Number.isFinite(Number(spec.angle)) ? Number(spec.angle) : 135;
        layer.style.background = 'linear-gradient(' + angle + 'deg, ' +
          validColor(spec.color, '#101418') + ', ' + validColor(spec.color2, '#0b0e14') + ')';
      } else if (spec.type === 'image' && spec.source) {
        applyImageFit(layer, spec.fit);
        layer.style.backgroundImage = 'url("' + resolveUrl(spec.source) + '")';
      } else if (spec.type === 'video' && spec.source) {
        const v = document.createElement('video');
        v.autoplay = true; v.loop = true; v.muted = true; v.defaultMuted = true;
        v.setAttribute('muted', ''); v.setAttribute('playsinline', '');
        v.style.objectFit = videoObjectFit(spec.fit);
        v.src = resolveUrl(spec.source);
        layer.appendChild(v);
        v.play().catch(() => { /* autoplay policies: muted loop is allowed, ignore */ });
      }
    }

    function show(spec) {
      const key = spec ? JSON.stringify(spec) : 'none';
      if (key === currentKey) return;
      currentKey = key;

      const back = 1 - front;
      paint(layers[back], spec);
      layers[back].classList.add('show');
      layers[front].classList.remove('show');
      front = back;

      // Only image/video wallpapers can be dimmed (the editor exposes Dim for those
      // only); never darken a solid color or gradient the user picked at full strength.
      const dimmable = spec && (spec.type === 'image' || spec.type === 'video');
      dim.style.opacity = String((dimmable ? Math.max(0, Math.min(100, Number(spec.dim) || 0)) : 0) / 100);

      // After the fade, fully release any video in the now-hidden layer — pausing alone
      // keeps its decoded frame + buffers resident, which matters on the small device.
      setTimeout(() => {
        for (const l of layers) {
          if (!l.classList.contains('show')) clearVideo(l);
        }
      }, 650);
    }

    return {
      applyForPage(index) {
        show((bgPages[index] || bgGlobal) || null);
      },
      reset() { currentKey = null; },
    };
  }

  // Edge zones: tap or horizontal swipe switches pages. Needed because widget iframes
  // consume touches over their whole area, leaving no reliable swipe surface.
  function bindEdge(el, direction) {
    let startX = null;
    el.addEventListener('pointerdown', (ev) => { startX = ev.clientX; el.setPointerCapture(ev.pointerId); wakeChrome(); });
    el.addEventListener('pointerup', (ev) => {
      if (startX === null) return;
      const dx = ev.clientX - startX;
      startX = null;
      if (Math.abs(dx) < 12) goToPage(currentPage() + direction);      // tap
      else goToPage(currentPage() + (dx < 0 ? 1 : -1));                // swipe
    });
    el.addEventListener('pointercancel', () => { startX = null; });
  }
  bindEdge(edgeLeft, -1);
  bindEdge(edgeRight, 1);

  pagesEl.addEventListener('scroll', updateDots, { passive: true });
  pagesEl.addEventListener('scrollend', () => { navTarget = null; });

  // ---- edit mode (the settings replica) ---------------------------------------------
  // The panel only displays. Editing happens in the settings window, whose live preview is
  // this same shell embedded as a replica (index.html?preview) and switched into edit mode
  // by an `edit-mode` message: transparent overlays above the widget iframes capture
  // gestures (widgets never see them), and every mutation re-lays the affected page out
  // and persists to the settings window's working copy, which Save & apply writes.

  if (PREVIEW) document.body.classList.add('preview'); // CSS scoping for replica-only styling

  const WIDTH_ORDER = ['quarter', 'half', 'three-quarter', 'full'];
  const WIDTH_LABELS = { quarter: '¼', half: '½', 'three-quarter': '¾', full: 'Full' };
  const BAND_LABELS = { full: '⬍', upper: '▀', lower: '▄' };

  let instanceSeq = 0;

  // ---- preview slot selection (WYSIWYG settings, #32) ------------------------------
  // In the settings replica, tapping a tile selects it: the tile gets a highlight and
  // the settings window is told which slot to show in its detail panel. The panel
  // (non-preview) never posts selection — the dashboard has no detail panel.
  let selected = null;

  function applySelectionClass() {
    for (const s of slots) s.el.classList.toggle('selected', s === selected);
    // Spotlight scoping: with a selection active the replica dims everything else,
    // so "which of the four identical widgets am I editing" answers itself.
    document.body.classList.toggle('has-selection', !!selected);
  }

  function postSelection() {
    if (!PREVIEW) return;
    let pageIdx = -1, slotIdx = -1;
    if (selected) {
      pageIdx = layoutData.pages.indexOf(selected.page);
      slotIdx = (selected.page.slots || []).indexOf(selected.def);
      if (pageIdx < 0 || slotIdx < 0) { selected = null; pageIdx = -1; slotIdx = -1; }
    }
    postToHost({ type: 'slot-selected', page: pageIdx, index: slotIdx,
      instanceId: (selected && selected.def.instanceId) || null, gen: previewGen });
  }

  // The preview's ✕ does not retire here — it NAMES the slot and lets the settings
  // window run its own removeSlotAt against the UNSCRUBBED working copy. This document
  // is handed every secret blanked (settings.js replicaLayout), so a def retired here
  // would reach the attic empty, and nothing could reunite it with the value the user
  // typed. One retire path, and it is the one holding the credential.
  //
  // Deliberately NO mint. A replica-minted instanceId is the exact object the withdrawn
  // union died on: it links to nothing on the settings side, and bridging it would be
  // the "sole id-less slot of this widget" guess #68 forbids. Send the id we were given
  // or null, and let the side that can address the credential decide.
  function requestRemoveSlot(record) {
    if (!PREVIEW) return;
    // Resolve against the LIVE tree, never record.page — an init may have reassigned
    // layoutData while the two-tap confirm was armed.
    const page = layoutData.pages.find((p) => (p.slots || []).indexOf(record.def) >= 0);
    if (!page) {
      // Orphaned record: nothing left to name, but the tile is still on glass.
      record.el.remove();
      slots = slots.filter((s) => s !== record);
      return;
    }
    if (drag && drag.record === record) cancelDrag(); // removed out from under a drag
    // Dim now: the parent's answer arrives as a full re-init up to 350ms later, and a ✕
    // that does nothing visible reads as broken. Self-clearing, so a REFUSED request
    // un-dims on its own instead of stranding a ghost tile.
    record.el.classList.add('retiring');
    setTimeout(() => { record.el.classList.remove('retiring'); }, 1200);
    postToHost({
      type: 'remove-slot',
      page: layoutData.pages.indexOf(page),
      index: (page.slots || []).indexOf(record.def),
      instanceId: record.def.instanceId || null,
      gen: previewGen,
    });
  }

  function selectRecord(record, announce) {
    selected = record || null;
    applySelectionClass();
    if (announce !== false) postSelection();
  }

  function selectSlotAt(pageIdx, slotIdx, announce) {
    const page = layoutData.pages[pageIdx];
    const def = page && (page.slots || [])[slotIdx];
    selectRecord((def && slots.find((s) => s.def === def)) || null, announce);
  }

  function persistLayout() {
    // The panel never saves: it only displays what the host loaded. Only the settings
    // replica edits, and its persists go to the settings window's working copy.
    if (!PREVIEW) return;
    // Editing makes positional identity unstable, so the first persist freezes every
    // instance's identity: each def adopts the tag its iframe is ALREADY running under
    // (stored widget state carries over seamlessly); defs without a live record (e.g.
    // hidden over-full slots) get a fresh unique id.
    for (const page of layoutData.pages) {
      for (const def of page.slots || []) {
        if (def.instanceId) continue;
        const rec = slots.find((s) => s.def === def);
        def.instanceId = (rec && rec.tag) ||
          ('i' + Date.now().toString(36) + '-' + (++instanceSeq));
      }
    }
    // `gen` is for stale-capture detection in the settings window.
    postToHost({ type: 'save-layout', layout: layoutData, gen: previewGen });
    // Mutations shift indices; keep the settings window's detail panel pointed at
    // the same slot it was showing (it captures the layout above, then this).
    if (selected) postSelection();
  }

  // Wraps a mutation in a View Transition when available so tiles glide instead of jump.
  function mutate(fn) {
    const step = () => { fn(); persistLayout(); };
    if (document.startViewTransition) {
      try { document.startViewTransition(step); return; } catch (e) { /* fall through */ }
    }
    step();
  }

  function sizeParts(token) {
    let t = String(token || 'quarter').toLowerCase();
    let band = 'full';
    if (t.endsWith('-upper')) { band = 'upper'; t = t.slice(0, -6); }
    else if (t.endsWith('-lower')) { band = 'lower'; t = t.slice(0, -6); }
    if (t === 'threequarter') t = 'three-quarter';
    if (!WIDTH_ORDER.includes(t)) t = 'quarter';
    return { width: t, band };
  }
  function makeSize(width, band) { return width + (band === 'full' ? '' : '-' + band); }

  function setEditing(on) {
    editing = on;
    document.body.classList.toggle('editing', on);
    // No page is created here: the settings window owns page management, and a page
    // made by the preview would undo a deletion the user just made there.
    if (on) {
      emptyEl.hidden = true;
      for (const page of layoutData.pages) positionAddZone(page);
    } else {
      emptyEl.hidden = slots.length > 0 || layoutData.pages.length > 0;
      cancelDrag();
      if (PREVIEW) selectRecord(null, false); // highlight off; the host keeps its own selection
      // Armed confirms must not survive the session: re-entering edit within the
      // 2.5s window would otherwise turn the first tap into an instant delete.
      for (const btn of document.querySelectorAll('.edit-overlay .remove.confirm')) resetConfirm(btn, '✕');
    }
    wakeChrome();
  }

  // Two-tap confirm for destructive buttons (no native dialogs inside the preview).
  function confirmThen(btn, restoreText, needsConfirm, action) {
    if (!needsConfirm || btn.classList.contains('confirm')) {
      resetConfirm(btn, restoreText);
      action();
      return;
    }
    btn.classList.add('confirm');
    btn.textContent = 'Sure?';
    btn._confirmTimer = setTimeout(() => resetConfirm(btn, restoreText), 2500);
  }

  function resetConfirm(btn, restoreText) {
    btn.classList.remove('confirm');
    btn.textContent = restoreText;
    clearTimeout(btn._confirmTimer);
  }

  // ---- per-slot controls -----------------------------------------------------------

  function buildOverlay(record, widget) {
    const ov = document.createElement('div');
    ov.className = 'edit-overlay';

    const grip = document.createElement('span');
    grip.className = 'grip';
    grip.textContent = widget ? (widget.displayName || widget.name) : record.def.widgetId;
    ov.appendChild(grip);

    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.textContent = '✕';
    remove.title = 'Remove this widget (tap twice)';
    remove.addEventListener('click', (ev) => {
      ev.stopPropagation();
      // One retire path (#226): the replica hands the removal to the settings window,
      // the only side holding the unscrubbed def. Same shape as requestAddWidget's.
      confirmThen(remove, '✕', true, () => requestRemoveSlot(record));
    });
    ov.appendChild(remove);

    const size = document.createElement('button');
    size.className = 'size';
    const band = document.createElement('button');
    band.className = 'band';
    // Field report: the bottom-right chips were unexplained glyphs. The tooltip
    // names the CURRENT value and what tapping does, and the same words reach
    // assistive tech.
    const WIDTH_NAMES = { quarter: 'quarter', half: 'half', 'three-quarter': 'three-quarter', full: 'full' };
    const BAND_NAMES = { full: 'full height', upper: 'top half', lower: 'bottom half' };
    const syncLabels = () => {
      const parts = sizeParts(record.def.size);
      size.textContent = WIDTH_LABELS[parts.width];
      band.textContent = BAND_LABELS[parts.band];
      size.title = 'Width: ' + (WIDTH_NAMES[parts.width] || parts.width) + ' of the screen — tap to cycle';
      band.title = 'Height: ' + (BAND_NAMES[parts.band] || parts.band) + ' — tap to cycle';
      size.setAttribute('aria-label', size.title);
      band.setAttribute('aria-label', band.title);
    };
    syncLabels();
    record.syncLabels = syncLabels; // drag drops can change the band; the chips must follow
    size.addEventListener('click', (ev) => { ev.stopPropagation(); cycleWidth(record, syncLabels); });
    band.addEventListener('click', (ev) => { ev.stopPropagation(); cycleBand(record, syncLabels); });
    ov.appendChild(size);
    ov.appendChild(band);

    bindDrag(ov, record);
    return ov;
  }

  function allowedWidths(widget) {
    const declared = new Set((widget && widget.supportedSlots && widget.supportedSlots.length)
      ? widget.supportedSlots : WIDTH_ORDER);
    // Per WIDGET-SPEC, widgets declaring half or full are also offered three-quarter.
    if (declared.has('half') || declared.has('full')) declared.add('three-quarter');
    return WIDTH_ORDER.filter((w) => declared.has(w));
  }

  // Would `def` at `size` place, without costing any currently-placing OTHER
  // slot its spot? (Slots that already fail to place — legacy over-full pages —
  // don't veto; hidden slots becoming visible is fine, visible ones vanishing
  // is not, even when the totals balance out.)
  function fitsWithSize(page, def, size) {
    const defs = page.slots || [];
    const original = def.size;
    const beforePlaced = placedSet(defs);
    def.size = size;
    const places = placeSlots(defs);
    const selfPlaced = places[defs.indexOf(def)] !== null;
    const othersKeep = defs.every((d, i) => d === def || !beforePlaced.has(d) || places[i] !== null);
    def.size = original;
    return selfPlaced && othersKeep;
  }

  /** Where to begin cycling, given the widths a widget allows and the one it is
   * currently at. Normally that is simply the current width's index.
   *
   * A stored size can be one the widget no longer allows — a manifest narrows under an
   * existing layout, which is exactly what weather did in dropping `quarter` (#77).
   * `indexOf` returns -1 for those, and clamping that to 0 made the first candidate
   * whatever happened to sit at index 0: from a stored `quarter` against
   * [half, three-quarter, full] the first tap jumped to THREE-QUARTER, skipping past
   * the adjacent half. Every size was still reachable by cycling — half came round
   * last — but one tap on "next size" should not vault two sizes up.
   *
   * So an unsupported width starts where it WOULD sort, and the next candidate is the
   * next size up from it. Returns -1 for a width below everything allowed, which the
   * caller's `(start + k)` arithmetic handles because k begins at 1. */
  function cycleStart(order, width) {
    const here = order.indexOf(width);
    if (here >= 0) return here;
    const rank = WIDTH_ORDER.indexOf(width);
    let i = 0;
    while (i < order.length && WIDTH_ORDER.indexOf(order[i]) < rank) i++;
    return i - 1;
  }

  // The fit checks run INSIDE the mutation step: view transitions run steps
  // asynchronously, so a decision taken at tap time could be validated against a
  // page state an earlier queued mutation is about to change.
  function cycleWidth(record, syncLabels) {
    mutate(() => {
      const widget = widgetsById.get(record.def.widgetId);
      const { width, band } = sizeParts(record.def.size);
      const order = allowedWidths(widget);
      const start = cycleStart(order, width);
      for (let k = 1; k <= order.length; k++) {
        const cand = order[(start + k) % order.length];
        if (cand === width) break;
        if (fitsWithSize(record.page, record.def, makeSize(cand, band))) {
          applySize(record, makeSize(cand, band), syncLabels);
          return;
        }
      }
      // Nothing applied. Absorbing the tap is the worst answer on a touch strip: the
      // user cannot tell whether it registered, whether the app is busy, or whether
      // they missed (#77). The two reasons need different words, because only one of
      // them is something they can do anything about.
      explainNoSize(widget, order.length <= 1);
    });
  }

  /** Why a size change did nothing. `onlyOne` distinguishes "this widget has no other
   * size" from "no room right now" — the first is permanent and the second is not. */
  function explainNoSize(widget, onlyOne) {
    const name = (widget && (widget.displayName || widget.name)) || 'This widget';
    showPanelNotice(onlyOne
      ? name + ' has only one size.'
      : 'No room on this page for another size — move or remove a widget first.');
  }

  function cycleBand(record, syncLabels) {
    mutate(() => {
      const { width, band } = sizeParts(record.def.size);
      const orderB = ['full', 'upper', 'lower'];
      const start = orderB.indexOf(band);
      for (let k = 1; k < orderB.length; k++) {
        const cand = orderB[(start + k) % orderB.length];
        if (fitsWithSize(record.page, record.def, makeSize(width, cand))) {
          applySize(record, makeSize(width, cand), syncLabels);
          return;
        }
      }
      // Same rule as cycleWidth: a band change that cannot happen says so. There is
      // always more than one band, so the only reason to be here is room.
      explainNoSize(widgetsById.get(record.def.widgetId), false);
    });
  }

  function applySize(record, size, syncLabels) {
    record.def.size = size;
    relayoutPage(record.page);
    syncLabels();
  }

  // ---- per-slot theme -------------------------------------------------------------
  // A slot's saved style overrides (def.style, set in the settings window's Appearance
  // section) re-specify theme seeds for that instance only; the full palette is re-derived
  // from the merged seeds (contrast repair included) and handed to the tile with ww-init
  // and every ww-theme.

  const STOCK_SEEDS = { accent: '#4dd4e8', background: '#070b12', text: '#dde2e8', panelAlpha: 0.92 };

  function themeSeeds() {
    return Object.assign({}, STOCK_SEEDS, layoutData.theme || {});
  }

  /** The token map a slot should run under: global theme, or re-derived from the
   * merged seeds when the slot carries style overrides. */
  function slotTheme(slot) {
    const style = slot.def && slot.def.style;
    if (!style || !Object.keys(style).length) return latestTheme;
    return window.WWPalette.derive(Object.assign(themeSeeds(), style));
  }

  // ---- add widget ------------------------------------------------------------------

  // The replica is a small scaled strip inside the settings window, and a modal palette
  // here would cover the very layout being edited (#46). An add-zone tap hands off to the
  // settings window's widget gallery instead. The region travels with the request so the
  // settings side can fill the hole that was actually tapped.
  function requestAddWidget(page, region) {
    cancelDrag(); // a second finger can reach the add-zone while a drag holds
    if (!PREVIEW || !editing) return;
    postToHost({ type: 'add-widget', index: Math.max(0, layoutData.pages.indexOf(page)),
      target: region ? { col: region.c, row: region.r, w: region.w, h: region.h } : null,
      gen: previewGen });
  }

  // ---- drag to rearrange -----------------------------------------------------------
  // Pointer capture from pointerdown; 7px threshold separates tap from drag; a fixed
  // ghost follows the finger; elementsFromPoint decides the drop target every frame.
  // Dropping on a slot reorders within the page; dropping on an edge zone moves the
  // widget to the adjacent page (validated at drag start so a full page never lights).

  let drag = null;

  function bindDrag(overlay, record) {
    overlay.addEventListener('pointerdown', (ev) => {
      // One drag at a time: a second finger touching another tile mid-drag must not
      // hijack the state (that would orphan the first drag's ghost forever).
      if (!editing || drag || ev.target.closest('button')) return;
      overlay.setPointerCapture(ev.pointerId);
      drag = { record, pointerId: ev.pointerId, startX: ev.clientX, startY: ev.clientY, active: false, ghost: null, raf: 0, last: null, targetSlot: null, targetEdge: null, targetCell: null, hint: null, canLeft: false, canRight: false, availEls: null, swapOk: null };
    });
    overlay.addEventListener('pointermove', (ev) => {
      if (!drag || drag.record !== record || ev.pointerId !== drag.pointerId) return;
      drag.last = { x: ev.clientX, y: ev.clientY };
      if (!drag.active) {
        if (Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) < 7) return;
        beginDrag(record);
      }
      if (!drag.raf) drag.raf = requestAnimationFrame(trackDrag);
    });
    // Only the finger that started the drag may finish it.
    overlay.addEventListener('pointerup', (ev) => {
      if (drag && drag.record === record && ev.pointerId === drag.pointerId) finishDrag(true);
    });
    overlay.addEventListener('pointercancel', (ev) => {
      if (drag && drag.record === record && ev.pointerId === drag.pointerId) finishDrag(false);
    });
  }

  // Abandons an in-flight drag without committing (re-init, tile removed, edit exit).
  function cancelDrag() {
    if (drag) finishDrag(false);
  }

  // Legacy layouts can carry slots that ALREADY fail to place (over-full pages
  // hide them instead of rejecting the file). Field bug: one hidden slot made
  // every fit check on the page fail — adds all "No room", drops all bouncing —
  // while free space sat visibly on screen. The bar for any edit is "nobody who
  // places today loses their spot", never "the whole page is perfect". That bar
  // is about IDENTITY, not counts: a count comparison would accept trading a
  // visible widget for a previously hidden one (Codex, #38). So this answers it
  // by identity: the defs that currently get a spot on the page.
  function placedSet(defs) {
    const places = placeSlots(defs);
    const set = new Set();
    defs.forEach((def, i) => { if (places[i] !== null) set.add(def); });
    return set;
  }

  function pageFits(page, def) {
    const defs = (page.slots = page.slots || []);
    const places = placeSlots(defs);
    // Probe with every placed occupant PINNED where it currently renders: an
    // arrival must fit the free space as the user SEES it. Identity alone
    // still let an anchored arrival "fit" by shuffling occupants to new
    // columns (or trading a visible tile for a hidden one — counts balance).
    const probe = defs.map((d, i) => places[i]
      ? { size: d.size, col: places[i].col + 1 }
      : { size: d.size, col: d.col });
    probe.push({ size: def.size, col: def.col });
    const placed = placeSlots(probe);
    return placed[placed.length - 1] !== null &&
      probe.every((p, i) => i === probe.length - 1 || places[i] === null || placed[i] !== null);
  }

  // Freeze the CURRENT rendering: give every placed slot its rendered column
  // as an explicit pin. Drop gestures promise "nobody else moves" — without
  // this, unanchored peers first-fit into whatever footprint the gesture
  // vacates (two flowing quarters: dragging the first one right slid the
  // second one left into its old column).
  function pinPlacedSlots(page, except) {
    const defs = page.slots || [];
    const places = placeSlots(defs);
    defs.forEach((d, i) => {
      if (d === except || places[i] === null) return;
      d.col = places[i].col + 1;
    });
  }

  function beginDrag(record) {
    drag.active = true;
    const rect = record.el.getBoundingClientRect();
    const ghost = document.createElement('div');
    ghost.id = 'dragGhost';
    ghost.style.width = Math.min(280, Math.max(120, rect.width * 0.6)) + 'px';
    ghost.style.height = Math.min(140, Math.max(70, rect.height * 0.5)) + 'px';
    const widget = widgetsById.get(record.def.widgetId);
    ghost.textContent = widget ? (widget.displayName || widget.name) : record.def.widgetId;
    document.body.appendChild(ghost);
    record.el.classList.add('drag-src');
    document.body.classList.add('dragging'); // re-enables the edge zones as drop targets
    drag.ghost = ghost;
    const i = layoutData.pages.indexOf(record.page);
    drag.canLeft = i > 0 && pageFits(layoutData.pages[i - 1], record.def);
    drag.canRight = i >= 0 && i < layoutData.pages.length - 1 && pageFits(layoutData.pages[i + 1], record.def);
    // EVERY valid landing lights for the whole gesture (field report: "in some
    // situations it does not highlight all available locations"): free cells
    // that can take this widget glow, swap targets get a quiet ring, and page
    // edges that fit it stay lit while the rest dim. The spot under the
    // pointer keeps the strong hint on top (trackDrag). The page cannot change
    // mid-drag (one pointer, and a re-init cancels the drag), so once is enough.
    const pageEl = pageEls.get(record.page);
    drag.availEls = [];
    if (pageEl) {
      const avail = availableCells(record);
      for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++) {
        if (!avail[r][c]) continue;
        const cell = document.createElement('div');
        cell.className = 'cell-avail';
        cell.style.gridColumn = String(c + 1);
        cell.style.gridRow = String(r + 1);
        pageEl.appendChild(cell);
        drag.availEls.push(cell);
      }
    }
    drag.swapOk = new Set();
    for (const s of slots) {
      if (s.page !== record.page || s === record || s.el.style.display === 'none') continue;
      if (slotDropFits(record.page, record.def, s.def)) {
        drag.swapOk.add(s.def);
        s.el.classList.add('drop-ok');
      }
    }
    edgeLeft.classList.toggle('drop-page-ok', drag.canLeft);
    edgeRight.classList.toggle('drop-page-ok', drag.canRight);
  }

  function clearDropHighlights() {
    for (const s of slots) s.el.classList.remove('drop-target');
    edgeLeft.classList.remove('drop-page');
    edgeRight.classList.remove('drop-page');
    if (drag && drag.hint) drag.hint.style.display = 'none';
  }

  // Drop-feasibility state for the dragged widget's page, shared by the live
  // landing probe (cellTargetAt) and the whole-gesture availability lights.
  // The user aims at the hole they can SEE: a drop may only claim cells that
  // are currently free (the dragged tile's own footprint counts as free —
  // shrinking or sliding within it is fine). Probe feasibility alone is too
  // loose: a full-height candidate can "fit" by RELOCATING another visible
  // tile — the field video's 7-12s gesture kept the full-height CPU full on
  // the bottom-left hole and teleported the GPU across the screen instead of
  // shrinking into the hole the user pointed at. Probes run against peers
  // PINNED where they render — the commit pins them the same way, so the
  // probe and the landing agree, and a peer can never flow into the footprint
  // the drag vacates. Visible-before slots must keep placing; hidden legacy
  // slots never veto (and stay unpinned, so merely removing the dragged
  // widget can't hand them a visible tile's spot).
  function dropContext(rec) {
    const defs = rec.page.slots || [];
    const fullPlaces = placeSlots(defs);
    const othersOccupied = [new Array(4).fill(false), new Array(4).fill(false)];
    const rest = [];
    const restWasPlaced = [];
    defs.forEach((d, i) => {
      if (d === rec.def) return;
      const p = fullPlaces[i];
      if (p) {
        const rows = p.band === 'full' ? [0, 1] : p.band === 'upper' ? [0] : [1];
        for (const r of rows) for (let k = 0; k < p.w; k++) othersOccupied[r][p.col + k] = true;
      }
      rest.push(p ? { size: d.size, col: p.col + 1 } : { size: d.size, col: d.col });
      restWasPlaced.push(p !== null);
    });
    const cellsFree = (band, a, w) => {
      const rows = band === 'full' ? [0, 1] : band === 'upper' ? [0] : [1];
      for (const r of rows) for (let k = 0; k < w; k++) if (othersOccupied[r][a + k]) return false;
      return true;
    };
    // The dragged widget at `size` anchored at column `a`: its placement when it
    // lands exactly there and every visible peer keeps its spot, else null.
    const landingOk = (size, a) => {
      const probe = rest.slice();
      // placeSlots only reads .size/.col — never mutate the live def.
      probe.push({ size, col: a + 1 });
      const places = placeSlots(probe);
      const own = places[probe.length - 1];
      if (own === null || own.col !== a) return null; // anchor cell blocked
      if (!probe.every((d, k) => k === probe.length - 1 || !restWasPlaced[k] || places[k] !== null)) return null;
      return own;
    };
    return { cellsFree, landingOk };
  }

  // Widths a drag may land at: the current width, then narrower SUPPORTED ones
  // — a drop never grows a widget; only a genuinely tighter hole resizes it.
  // Narrower is judged by rank, not by the current width's position in
  // allowedWidths: a hand-edited size the widget never declared (e.g. a "full"
  // slot on a quarter-only widget) must still shrink through the widths it
  // does support instead of losing every candidate (Codex, PR #52).
  function narrowerWidths(width, widget) {
    const rank = WIDTH_ORDER.indexOf(width);
    return allowedWidths(widget).filter((w) => WIDTH_ORDER.indexOf(w) < rank).reverse();
  }

  function dragWidths(rec) {
    const parts = sizeParts(rec.def.size);
    const widget = widgetsById.get(rec.def.widgetId);
    return { parts, widthList: [parts.width].concat(narrowerWidths(parts.width, widget)) };
  }

  // Maps a pointer position over the dragged widget's own page to a landing spot in
  // FREE grid space. Empty cells are first-class drop targets (#40 — the field demo
  // showed drags ending on the "+" zone bouncing back): half-height widgets adopt the
  // band of the row under the pointer, and a widget pointed at a hole SMALLER than
  // itself shrinks into it instead of bouncing back (field report: "onto a smaller
  // space ... it should be the smaller size"). Landing where the user points wins;
  // at equal distance the largest size that fits wins — so a plain move into open
  // space keeps the size, and only a genuinely tighter hole resizes.
  // Returns { index, size, place, dist } or null when nothing fits anywhere near.
  function cellTargetAt(x, y) {
    const rec = drag.record;
    const pageEl = pageEls.get(rec.page);
    if (!pageEl) return null;
    const rect = pageEl.getBoundingClientRect();
    if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) return null;
    const col = Math.max(0, Math.min(3, Math.floor(((x - rect.left) / Math.max(1, rect.width)) * 4)));
    const row = (y - rect.top) < rect.height / 2 ? 0 : 1;
    const rowBand = row === 0 ? 'upper' : 'lower';
    const { parts, widthList } = dragWidths(rec);
    const bandList = parts.band === 'full' ? ['full', rowBand] : [rowBand];
    const candidates = [];
    for (const band of bandList) {
      for (const width of widthList) {
        candidates.push({ size: makeSize(width, band),
          area: (WIDTH_ORDER.indexOf(width) + 1) * (band === 'full' ? 2 : 1) });
      }
    }
    candidates.sort((a, b) => b.area - a.area); // biggest footprint first
    const ctx = dropContext(rec);
    let best = null;
    for (let c = 0; c < candidates.length; c++) {
      const cand = candidates[c];
      const { w, band } = parseSize(cand.size);
      // Anchor columns whose span would cover the pointed-at column, nearest
      // span-center first: the drop pins the widget WHERE THE USER POINTED —
      // probing insertion order instead let first-fit pack it back to the left,
      // which read as a bounce whenever the left column was free.
      const anchors = [];
      for (let a = Math.max(0, col - w + 1); a <= Math.min(col, 4 - w); a++) anchors.push(a);
      anchors.sort((a, b) =>
        Math.abs(a + (w - 1) / 2 - col) - Math.abs(b + (w - 1) / 2 - col) || a - b);
      for (const a of anchors) {
        if (!ctx.cellsFree(band, a, w)) continue; // claims another visible tile's cells
        const own = ctx.landingOk(cand.size, a);
        if (!own) continue;
        if (!best || c < best.rank) best = { size: cand.size, col: a + 1, place: own, rank: c };
        break; // nearest fitting anchor for this candidate size
      }
    }
    return best;
  }

  // Every cell that belongs to at least one valid landing of the dragged widget
  // (field report: "in some situations it does not highlight all available
  // locations for a widget"). Mirrors cellTargetAt exactly: a cell lights up
  // iff pointing at it would produce a landing hint.
  function availableCells(rec) {
    const ctx = dropContext(rec);
    const { parts, widthList } = dragWidths(rec);
    const avail = [new Array(4).fill(false), new Array(4).fill(false)];
    for (let row = 0; row < 2; row++) {
      const rowBand = row === 0 ? 'upper' : 'lower';
      const bandList = parts.band === 'full' ? ['full', rowBand] : [rowBand];
      for (const band of bandList) {
        const rows = band === 'full' ? [0, 1] : [row];
        for (const width of widthList) {
          const w = parseSize(makeSize(width, band)).w;
          for (let a = 0; a + w <= 4; a++) {
            if (!ctx.cellsFree(band, a, w)) continue;
            if (!ctx.landingOk(makeSize(width, band), a)) continue;
            for (const r of rows) for (let k = 0; k < w; k++) avail[r][a + k] = true;
          }
        }
      }
    }
    return avail;
  }

  // Would dropping `srcDef` ONTO `tgtDef` (the reorder-and-adopt-band gesture)
  // commit, or would finishDrag revert it? Mirrors the targetSlot commit: band
  // adoption across half-height rows, both pins dissolved, order re-spliced —
  // valid iff every def that places today still places after.
  function slotDropFits(page, srcDef, tgtDef) {
    const defs = page.slots || [];
    const srcIdx = defs.indexOf(srcDef);
    const tgtIdx = defs.indexOf(tgtDef);
    if (srcIdx < 0 || tgtIdx < 0 || srcDef === tgtDef) return false;
    const srcParts = sizeParts(srcDef.size);
    const tgtParts = sizeParts(tgtDef.size);
    const size = (srcParts.band !== 'full' && tgtParts.band !== 'full' && srcParts.band !== tgtParts.band)
      ? makeSize(srcParts.width, tgtParts.band) : srcDef.size;
    const beforePlaced = placedSet(defs);
    const probe = defs.map((d) => ({
      ref: d,
      size: d === srcDef ? size : d.size,
      col: (d === srcDef || d === tgtDef) ? undefined : d.col,
    }));
    const moved = probe.splice(srcIdx, 1)[0];
    probe.splice(probe.findIndex((p) => p.ref === tgtDef) + (srcIdx < tgtIdx ? 1 : 0), 0, moved);
    const places = placeSlots(probe);
    return probe.every((p, k) => !beforePlaced.has(p.ref) || places[k] !== null);
  }

  function showCellHint(place) {
    if (!drag.hint) {
      const el = document.createElement('div');
      el.className = 'cell-hint';
      pageEls.get(drag.record.page).appendChild(el);
      drag.hint = el;
    }
    drag.hint.style.display = '';
    drag.hint.style.gridColumn = (place.col + 1) + ' / span ' + place.w;
    drag.hint.style.gridRow = place.band === 'full' ? '1 / span 2' : place.band === 'upper' ? '1' : '2';
  }

  function trackDrag() {
    if (!drag || !drag.active || !drag.last) return;
    drag.raf = 0;
    const { x, y } = drag.last;
    drag.ghost.style.left = (x - parseFloat(drag.ghost.style.width) / 2) + 'px';
    drag.ghost.style.top = (y - parseFloat(drag.ghost.style.height) / 2) + 'px';

    let slotHit = null;
    let edgeHit = null;
    for (const el of document.elementsFromPoint(x, y)) {
      if (!slotHit && el.classList && el.classList.contains('slot') && el !== drag.record.el) slotHit = el;
      if (!edgeHit && el.classList && el.classList.contains('edge')) edgeHit = el;
    }
    // Only swaps that would actually COMMIT light up under the pointer — a
    // hover glow on a tile whose drop would revert reads as a broken promise
    // (the pre-validated set from beginDrag keeps hover and commit agreeing).
    const slotRec = slotHit && slots.find((s) => s.el === slotHit && s.page === drag.record.page &&
      drag.swapOk && drag.swapOk.has(s.def));
    const edgeOk = edgeHit && ((edgeHit === edgeLeft && drag.canLeft) || (edgeHit === edgeRight && drag.canRight));

    clearDropHighlights();
    drag.targetSlot = null;
    drag.targetEdge = null;
    drag.targetCell = null;
    if (edgeOk) {
      // Slots reach the screen edge, so a point over the edge zone usually also hits a
      // slot beneath it — the glowing edge is what the user is aiming at, so it wins.
      drag.targetEdge = edgeHit;
      edgeHit.classList.add('drop-page');
    } else if (slotRec) {
      drag.targetSlot = slotHit;
      drag.targetSlot.classList.add('drop-target');
    } else {
      // Free space (including the "+" zone and the widget's own footprint).
      const cell = cellTargetAt(x, y);
      if (cell) {
        drag.targetCell = cell;
        showCellHint(cell.place);
      }
    }
  }

  function finishDrag(commit) {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.raf) cancelAnimationFrame(d.raf);
    if (!d.active) {
      // A tap (never crossed the drag threshold): in the settings replica that is
      // the click-to-configure gesture — select this slot for the detail panel.
      if (commit && PREVIEW && editing) selectRecord(d.record);
      return;
    }
    d.ghost.remove();
    if (d.hint) d.hint.remove();
    if (d.availEls) for (const el of d.availEls) el.remove();
    for (const s of slots) s.el.classList.remove('drop-ok');
    edgeLeft.classList.remove('drop-page-ok');
    edgeRight.classList.remove('drop-page-ok');
    d.record.el.classList.remove('drag-src');
    document.body.classList.remove('dragging');
    clearDropHighlights();
    if (!commit) return;

    if (d.targetSlot) {
      const target = slots.find((s) => s.el === d.targetSlot);
      if (target && target.page === d.record.page) {
        mutate(() => {
          const defs = d.record.page.slots;
          const srcIdx = defs.indexOf(d.record.def);
          const tgtIdx = defs.indexOf(target.def);
          if (srcIdx < 0 || tgtIdx < 0) return; // either side removed while dragging
          // Dropping onto a tile in the OTHER half-height band adopts that band —
          // reorder alone would first-fit the widget straight back into its old
          // row, which reads as a bounce-back (#40).
          const srcParts = sizeParts(d.record.def.size);
          const tgtParts = sizeParts(target.def.size);
          const oldSize = d.record.def.size;
          const oldCol = d.record.def.col;
          const oldTgtCol = target.def.col;
          const beforeOrder = defs.slice();
          const beforePlaced = placedSet(defs);
          if (srcParts.band !== 'full' && tgtParts.band !== 'full' && srcParts.band !== tgtParts.band)
            d.record.def.size = makeSize(srcParts.width, tgtParts.band);
          // Dropping ONTO a tile means "next to that widget" — order semantics;
          // a column pin from an earlier cell drop would override the reorder.
          // The TARGET's pin dissolves too: with it in place, Pass A would claim
          // its column before order is consulted and the swap renders as a no-op.
          delete d.record.def.col;
          delete target.def.col;
          defs.splice(srcIdx, 1);
          // Dragging forward drops AFTER the target, dragging back drops BEFORE it —
          // insert-before alone would put a forward drag right back where it started.
          defs.splice(defs.indexOf(target.def) + (srcIdx < tgtIdx ? 1 : 0), 0, d.record.def);
          // If ANY slot that was visible before — the dragged one included — would
          // lose its spot, revert the WHOLE gesture: on legacy over-full pages the
          // reorder alone can hand a hidden slot the freed space and push visible
          // widgets off screen, so restoring just the size would keep the damage
          // (identity, not counts: totals can balance while widgets trade places).
          const adoptedPlaces = placeSlots(defs);
          if (!defs.every((dd, k) => !beforePlaced.has(dd) || adoptedPlaces[k] !== null)) {
            d.record.def.size = oldSize;
            if (oldCol !== undefined) d.record.def.col = oldCol;
            if (oldTgtCol !== undefined) target.def.col = oldTgtCol;
            defs.splice(0, defs.length, ...beforeOrder);
          }
          if (d.record.syncLabels) d.record.syncLabels();
          relayoutPage(d.record.page);
        });
      }
    } else if (d.targetCell) {
      const t = d.targetCell;
      mutate(() => {
        const defs = d.record.page.slots || [];
        if (defs.indexOf(d.record.def) < 0) return; // removed while dragging
        // targetCell was validated against the live page: pin the widget to the
        // column the user pointed at. Order stays put — the anchor, not the
        // index, decides where this widget renders from now on. Every OTHER
        // placed slot gets pinned where it renders too, or an unanchored peer
        // would first-fit into the footprint this drag just vacated.
        pinPlacedSlots(d.record.page, d.record.def);
        d.record.def.size = t.size;
        d.record.def.col = t.col;
        if (d.record.syncLabels) d.record.syncLabels();
        relayoutPage(d.record.page);
      });
    } else if (d.targetEdge) {
      const dir = d.targetEdge === edgeLeft ? -1 : 1;
      const from = d.record.page;
      const srcIdx = (from.slots || []).indexOf(d.record.def);
      const toIdx = layoutData.pages.indexOf(from) + dir;
      const to = layoutData.pages[toIdx];
      if (srcIdx >= 0 && to && pageFits(to, d.record.def)) {
        // The move touches ONLY the moved widget: pin both pages' occupants
        // where they render, or the remaining source tiles slide into the
        // vacated footprint and the arrival can shuffle the target page.
        pinPlacedSlots(from, d.record.def);
        pinPlacedSlots(to, null);
        from.slots.splice(srcIdx, 1);
        to.slots.push(d.record.def);
        d.record.page = to;
        // Moving the element between pages re-navigates the iframe; treat it as a
        // fresh load so the watchdog covers it.
        d.record.initialized = false;
        d.record.retries = 0;
        pageEls.get(to).appendChild(d.record.el);
        relayoutPage(from);
        relayoutPage(to);
        armWatchdog(generation);
        persistLayout();
        goToPage(toIdx);
      }
    }
  }

  // ---- go -------------------------------------------------------------------------

  postToHost({ type: 'ready' });
})();
