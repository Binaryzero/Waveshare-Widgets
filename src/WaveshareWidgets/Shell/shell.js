// Dashboard shell: receives host messages over the WebView2 bridge, lays out the
// configured pages/slots as per-widget iframes, and relays sensor/media data to them.
(function () {
  'use strict';

  const pagesEl = document.getElementById('pages');
  const dotsEl = document.getElementById('dots');
  const emptyEl = document.getElementById('empty');

  // Host protocol: "the user cleared this secret", as distinct from "" which means the
  // masked field came back untouched and the stored credential must survive the save.
  // Must match SecretStore.ClearMarker.
  /** Names the properties the user asked to REMOVE, per slot, as a projection the host
   * reads off the raw save payload (SecretPolicy.ClearedMarkerKey). Replaced a sentinel
   * written into the value: "the user cleared this" is a statement ABOUT a value, and an
   * untouched field echoing that exact text was indistinguishable from a real clear.
   *
   * This is also the channel the on-panel editor never had. Reveal cannot carry a
   * projection into the model, so before this the panel could not say a demoted
   * credential had been cleared at all (#153). */
  // Whether a value the user just set CONTRADICTS a pending removal. "" does not: it is
  // the exact shape the host reads as untouched, so a control with a legitimately empty
  // choice would otherwise cancel a clear and have Seal restore the envelope the user
  // asked to delete. `false` and `0` ARE values — a switch turned off and a number set to
  // zero are choices, not absences. Mirrors settings.js.
  function contradictsRemoval(value) {
    return !(value === '' || value === null || value === undefined);
  }

  function markCleared(def, name, on) {
    const list = Array.isArray(def.secretsCleared) ? def.secretsCleared.slice() : [];
    const at = list.indexOf(name);
    if (on && at < 0) list.push(name);
    else if (!on && at >= 0) list.splice(at, 1);
    if (list.length) def.secretsCleared = list;
    else delete def.secretsCleared;
  }

  /** @type {{frame: HTMLIFrameElement, el: HTMLElement, settings: object, initialized: boolean, retries: number}[]} */
  let slots = [];
  let latestSensors = [];
  let latestMedia = null;
  let latestTheme = null;
  let latestNotifications = null;   // last projected payload from the host
  let gameState = { active: false, process: '' };
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

  let backgroundHost = 'backgrounds.wsw';
  let bgGlobal = null;         // dashboard-wide background spec
  let bgPages = [];            // per-page background specs (null = inherit global)
  const bg = createBackgroundController();

  // Live layout model (mutated by the on-panel editor, persisted via save-layout).
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
    else if (msg.type === 'open-palette') {
      // Settings "+ Add widget" fallback: open the shell's own add-widget palette.
      if (PREVIEW && editing && layoutData.pages.length) {
        const p = layoutData.pages[Math.max(0, Math.min(layoutData.pages.length - 1, msg.index | 0))];
        if (p) openPalette(p);
      }
    }
    else if (msg.type === 'minted-ids') {
      // The host stamps a stable instanceId on any credentialed slot that arrived
      // without one — but on ITS copy of the layout, so this shell still holds the
      // id-less def it sent. Adopt the identities, or host and shell disagree about
      // which slot is which for every subsequent save (#70).
      //
      // Addressed by the position WE submitted, with a widgetId guard so an ack that
      // arrives after the user has replaced that tile cannot brand the newcomer. A
      // def that has since acquired an id of its own is left alone: persistLayout
      // adopts the tag the iframe is already running under, and overwriting that
      // would move the widget's local-storage keys out from under it.
      for (const m of (Array.isArray(msg.data) ? msg.data : [])) {
        const page = (layoutData.pages || [])[m.page];
        const def = page && (page.slots || [])[m.slot];
        if (!def || def.instanceId || def.widgetId !== m.widgetId) continue;
        // Only the persisted identity. The running iframe keeps the `tag` it was
        // initialised under, because that tag is its widget-local storage namespace
        // and swapping it here would orphan the widget's own state — the hazard
        // recorded as #56 item 3, which is a separate decision from this one.
        def.instanceId = m.instanceId;
      }
    }
    else if (msg.type === 'secrets-failed') {
      // The panel already re-rendered as if the save were clean, but the host could not
      // protect a credential and refuses to write one in the clear. Say so on glass —
      // silence here means the user walks away thinking the token is stored.
      const items = Array.isArray(msg.data) ? msg.data : [];
      showPanelNotice(items.length === 1
        ? 'Could not save the credential — Windows protection unavailable. Try again.'
        : `Could not save ${items.length} credentials — Windows protection unavailable.`);
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
      //   `game-mode` must NOT be gated. GameModeWatcher.Poll returns early when the state
      //   is unchanged and raises Changed only on a transition, so the host never re-sends
      //   the current state. Dropping one push leaves the shell believing the wrong game
      //   state until the next real transition — possibly hours — hiding or showing every
      //   hideInGame widget wrongly for the duration. That is a worse bug than the one
      //   being fixed, manufactured by fixing it.
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
    else if (msg.type === 'game-mode') {
      gameState = { active: !!(msg.data && msg.data.active), process: (msg.data && msg.data.process) || '' };
      applyGameMode();
      broadcast({ type: 'ww-game', game: gameState });
    }
    else if (msg.type === 'fetch-result') {
      routeReply(fetchRoutes, msg, 'ww-fetch-result');
    } else if (msg.type === 'sd-profiles-result') {
      // Discovered VSD profile list for the settings sheet's host-backed selects.
      const waiters = psProfileWaiters.splice(0);
      const profiles = ((msg.data && msg.data.profiles) || []).filter((p) => typeof p === 'string');
      waiters.forEach((cb) => { try { cb(profiles); } catch (e) { /* row rebuilt */ } });
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
    } else if (msg.type === 'ww-open-url' && typeof msg.url === 'string') {
      postToHost({ type: 'open-url', url: msg.url });
    } else if (msg.type === 'ww-action' && typeof msg.kind === 'string') {
      postToHost({ type: 'action', kind: msg.kind, target: String(msg.target || '') });
    } else if (msg.type === 'ww-sd-profile') {
      const id = armSdRoute(msg, ev);
      postToHost({ type: 'sd-profile', id, profileName: msg.profileName || '', hideWindow: msg.hideWindow !== false, live: msg.live === true });
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
      postToHost({ type: 'sd-click', row: msg.row | 0, col: msg.col | 0, rows: msg.rows | 0, cols: msg.cols | 0 });
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
      theme: slotTheme(slot),
      // Only for a slot that asked. A re-init used to hand the latest toasts — app
      // name, title, body — to every widget on the panel, subscriber or not, so a
      // widget needed no notification code at all to read the user's notifications.
      notifications: slot.notifWatch ? noteDelivered(slot, latestNotifications) : null,
      game: gameState,
      status,
    };
  }

  /// Records which notification ids a slot has been shown, so a later dismiss can be
  /// checked against them. Returns the payload unchanged, for use at the delivery point.
  function noteDelivered(slot, payload) {
    const items = (payload && payload.items) || [];
    slot.notifSeen = slot.notifSeen || new Set();
    for (const n of items) if (n && n.id != null) slot.notifSeen.add(String(n.id));
    return payload;
  }

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

  // Game mode: pause the shell's own chrome cost and hide slots the user marked
  // hide-in-game (their grid cell is kept, so they come back exactly where they were).
  function applyGameMode() {
    document.documentElement.dataset.game = gameState.active ? 'on' : 'off';
    for (const slot of slots) {
      if (slot.def && slot.def.hideInGame)
        slot.el.style.visibility = (gameState.active && !editing) ? 'hidden' : '';
    }
  }

  let panelNoticeTimer = null;

  /** Transient banner for host-side failures the panel can't otherwise show. The strip
   * has no dialogs and no room for one, so this rides above everything and clears
   * itself; it is deliberately the only such surface. */
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
   * `{slug}.widgets.wsw` mapping and for the harness fixtures alike. A URL that will
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
    status = data.status || status;
    // Game state rides init: a game already fullscreen when the shell loads fired
    // its transition before shell-ready, and the host's poll dedups it forever.
    if (data.game) gameState = { active: !!data.game.active, process: data.game.process || '' };
    applyThemeTokens(data.theme);

    layoutData = (data.layout && Array.isArray(data.layout.pages)) ? data.layout : { pages: [] };
    widgetLib = data.widgets || [];
    widgetsById = new Map(widgetLib.map((w) => [w.id, w]));
    backgroundHost = data.backgroundHost || backgroundHost;

    // Instance identity must be unique: layouts from older builds can carry
    // DUPLICATE instanceIds (positional freezes colliding with earlier
    // adoptions), and two look-alike widgets sharing one id share widget-local
    // storage — settings and state on one tile visibly bleed into the other
    // (field report: "editing settings on the top one directly impacts the one
    // below it"). Collisions are checked against each slot's EFFECTIVE tag —
    // a slot with no instanceId runs under its derived positional tag
    // ("p0s0"), which an explicit id elsewhere can collide with just as hard.
    // Re-mint duplicates here; the panel persists the healed ids.
    const seenIds = new Set();
    let reMinted = 0;
    layoutData.pages.forEach((page, pi) => {
      (page.slots || []).forEach((def, si) => {
        let effective = def.instanceId || ('p' + pi + 's' + si);
        if (seenIds.has(effective)) {
          def.instanceId = 'i' + Date.now().toString(36) + '-' + (++instanceSeq) + 'd';
          effective = def.instanceId;
          reMinted++;
        }
        seenIds.add(effective);
      });
    });

    renderAll();

    if (reMinted && !PREVIEW) {
      // Heal the stored layout so the dupes never come back. The replica skips
      // this: its capture stream must never dirty a freshly opened editor.
      postToHost({ type: 'log', message: 'healed ' + reMinted + ' duplicate widget instanceId(s)' });
      persistLayout();
    }
  }

  function renderAll() {
    cancelDrag();   // a re-init mid-drag must not orphan the ghost / dragging state
    closePalette(); // palette entries capture page objects this rebuild replaces
    closeStyleEditor(false); // its record is about to be replaced
    closePropSheet(false);   // ditto for the settings sheet
    const keepPage = (PREVIEW && previewPage != null) ? previewPage
      : currentPage(); // a re-init (hot reload, replica refresh) keeps the page
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
    applyGameMode();
    syncNotificationDemand(); // fresh records carry no demand; rebuilt widgets re-watch
    if (editing) updateEditBar();
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
      // A persisted instanceId (assigned on first on-panel edit) is the permanent
      // identity; never-edited layouts keep the positional tag, exactly as before.
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
      chip.textContent = widget ? widget.name : def.widgetId;
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
  function freeRegions(page, placements) {
    const occupied = [new Array(4).fill(false), new Array(4).fill(false)];
    for (const place of placements || placeSlots(page.slots || [])) {
      if (!place) continue;
      const rows = place.band === 'full' ? [0, 1] : place.band === 'upper' ? [0] : [1];
      for (const r of rows) for (let i = 0; i < place.w; i++) occupied[r][place.col + i] = true;
    }
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

  /** The size a widget would take in THIS region: widest supported width that fits
   *  the region's columns, banded to the region's rows. Null when the widget cannot
   *  fit at all, which is what makes a zone able to say why it is unavailable (#77). */
  function sizeInRegion(widget, region) {
    const band = region.h === 2 ? 'full' : (region.r === 0 ? 'upper' : 'lower');
    const widths = allowedWidths(widget).slice().reverse();   // widest first
    // Column count comes from parseSize rather than a second width table — the two
    // drifting apart would place widgets a column wider or narrower than the hole.
    for (const w of widths) if (parseSize(w).w <= region.w) return makeSize(w, band);
    return null;
  }

  function positionAddZone(page, placements) {
    const pageEl = pageEls.get(page);
    if (!pageEl) return;
    const regions = freeRegions(page, placements);
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
      const fits = widgetLib.some((w) => sizeInRegion(w, region));
      z.disabled = !fits;
      z.classList.toggle('full', !fits);
      z.querySelector('.az-plus').textContent = fits ? '+' : '·';
      z.querySelector('.az-label').textContent = fits ? 'Add widget' : 'Nothing fits here';
      z.title = fits ? 'Add a widget here' : 'No installed widget fits this space';
      z.onclick = fits ? () => openPalette(page, region) : null;
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
    if (editing) disarmPageDelete(); // an armed delete must not carry over to another page
    // WYSIWYG: page moves initiated inside the editing replica (add page, edge-drop,
    // capsule arrows) must steer the settings window too, or its rail/detail panel
    // keeps operating on the page the preview no longer shows. HOST-steered moves
    // are silent: echoing them back turns the settings' own stale-navigation
    // re-steer into a message ping-pong until its debounce clears.
    if (PREVIEW && editing && !silent) postToHost({ type: 'page-changed', index: clamped, gen: previewGen });
    pagesEl.scrollTo({ left, behavior: 'smooth' });
    wakeChrome();
  }

  function wakeChrome() {
    for (const el of [dotsEl, edgeLeft, edgeRight, editBtn]) el.classList.remove('idle');
    clearTimeout(dotsIdleTimer);
    if (editing) return; // chrome stays awake for the whole edit session
    dotsIdleTimer = setTimeout(() => {
      for (const el of [dotsEl, edgeLeft, edgeRight, editBtn]) el.classList.add('idle');
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
    if (editing) updateEditBar();
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

  // ---- on-panel edit mode ----------------------------------------------------------
  // Everything is edited in place on the live dashboard: transparent overlays above the
  // widget iframes capture gestures (widgets never see them), every mutation re-lays the
  // affected page out and persists immediately, and "Done" only exits.

  const editBtn = document.getElementById('editBtn');
  const editBar = document.getElementById('editBar');
  if (PREVIEW) {
    // In the settings replica the HOST owns edit mode (its "Edit layout" toggle):
    // hide the pencil and Done so the replica can't fall out of sync with it.
    editBtn.style.display = 'none';
    // Nothing floats over the canvas in the replica (field report: the capsule
    // and style panel covered — and BLOCKED — the very tiles being edited). The
    // settings window around this frame owns page management, navigation (pages
    // strip + the dots) and appearance; the preview shows only widgets.
    editBar.style.display = 'none';
    document.body.classList.add('preview'); // CSS scoping for replica-only styling
  }
  const paletteEl = document.getElementById('palette');
  const paletteGrid = document.getElementById('paletteGrid');
  const pageDeleteBtn = document.getElementById('pageDelete');

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
    const save = { type: 'save-layout', layout: layoutData };
    if (PREVIEW) save.gen = previewGen; // stale-capture detection in the settings window
    postToHost(save);
    // Mutations shift indices; keep the settings window's detail panel pointed at
    // the same slot it was showing (it captures the layout above, then this).
    if (PREVIEW && selected) postSelection();
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
    // Game-mode visibility depends on `editing`, and no game-mode EVENT arrives at
    // edit enter/exit (the host only posts on change): re-apply here, or a game
    // running right now leaves hide-in-game slots invisible while editing — and
    // visible after Done until the game next flips state.
    applyGameMode();
    editBar.hidden = !on;
    // On-device, entering edit on an empty panel needs a page to drop widgets on.
    // NEVER in the replica: the settings window owns page management there, and
    // auto-creating one after the user deleted their last page silently undid the
    // deletion (the capture stream adopted the unsolicited page right back).
    if (on && !PREVIEW && layoutData.pages.length === 0) {
      const page = { name: 'Page 1', slots: [] };
      layoutData.pages.push(page);
      buildPage(page);
      syncPageOrder(); rebuildDots(); refreshBgSpecs();
      persistLayout();
    }
    if (on) {
      emptyEl.hidden = true;
      for (const page of layoutData.pages) positionAddZone(page);
      updateEditBar();
    } else {
      emptyEl.hidden = slots.length > 0 || layoutData.pages.length > 0;
      closePalette();
      cancelDrag();
      closeStyleEditor(); // flushes any trailing style edit
      closePropSheet();   // same flush-on-close contract for settings edits
      if (PREVIEW) selectRecord(null, false); // highlight off; the host keeps its own selection
      // Armed confirms must not survive the session: re-entering edit within the
      // 2.5s window would otherwise turn the first tap into an instant delete.
      disarmPageDelete();
      for (const btn of document.querySelectorAll('.edit-overlay .remove.confirm')) resetConfirm(btn, '✕');
    }
    wakeChrome();
  }
  editBtn.addEventListener('click', () => setEditing(true));
  document.getElementById('editDone').addEventListener('click', () => setEditing(false));

  function updateEditBar() {
    const i = editIndex();
    document.getElementById('pageMoveLeft').disabled = i <= 0;
    document.getElementById('pageMoveRight').disabled = i >= layoutData.pages.length - 1;
    pageDeleteBtn.disabled = layoutData.pages.length <= 1;
  }

  // Two-tap confirm for destructive buttons (no native dialogs on the panel).
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

  function disarmPageDelete() {
    resetConfirm(pageDeleteBtn, '✕ Page');
  }

  // ---- page management -------------------------------------------------------------

  document.getElementById('pageAdd').addEventListener('click', () => {
    const page = { name: 'Page ' + (layoutData.pages.length + 1), slots: [] };
    layoutData.pages.push(page);
    buildPage(page);
    syncPageOrder(); rebuildDots(); refreshBgSpecs();
    persistLayout();
    goToPage(layoutData.pages.length - 1);
    updateEditBar();
  });

  pageDeleteBtn.addEventListener('click', () => {
    const i = editIndex();
    const page = layoutData.pages[i];
    if (!page || layoutData.pages.length <= 1) return;
    confirmThen(pageDeleteBtn, '✕ Page', (page.slots || []).length > 0, () => {
      if (styleTarget && styleTarget.page === page) closeStyleEditor(false); // its tile goes away with the page
      if (propTarget && propTarget.page === page) closePropSheet(false);
      if (selected && selected.page === page) selectRecord(null); // the detail target's page is going away
      for (const rec of slots.filter((s) => s.page === page)) rec.el.remove();
      slots = slots.filter((s) => s.page !== page);
      syncNotificationDemand();
      const el = pageEls.get(page);
      if (el) el.remove();
      pageEls.delete(page);
      layoutData.pages.splice(i, 1);
      syncPageOrder(); rebuildDots(); refreshBgSpecs();
      persistLayout();
      goToPage(Math.min(i, layoutData.pages.length - 1));
      bg.applyForPage(currentPage());
      updateEditBar();
    });
  });

  // The capsule arrows NAVIGATE. They used to reorder the current page — which
  // moved the dot indicator without changing the visible content (the viewed page
  // travels with the reorder), reading as a dead control and silently rearranging
  // the page order (#39). Reordering lives in the settings window's pages strip.
  document.getElementById('pageMoveLeft').addEventListener('click', () => goToPage(editIndex() - 1));
  document.getElementById('pageMoveRight').addEventListener('click', () => goToPage(editIndex() + 1));

  // ---- per-slot controls -----------------------------------------------------------

  function buildOverlay(record, widget) {
    const ov = document.createElement('div');
    ov.className = 'edit-overlay';

    const grip = document.createElement('span');
    grip.className = 'grip';
    grip.textContent = widget ? widget.name : record.def.widgetId;
    ov.appendChild(grip);

    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.textContent = '✕';
    remove.title = 'Remove this widget (tap twice)';
    remove.addEventListener('click', (ev) => {
      ev.stopPropagation();
      confirmThen(remove, '✕', true, () => removeSlot(record));
    });
    ov.appendChild(remove);

    const size = document.createElement('button');
    size.className = 'size';
    const band = document.createElement('button');
    band.className = 'band';
    // Field report: the bottom-right chips were unexplained glyphs. The tooltip
    // names the CURRENT value and what tapping does (hover on the desktop
    // replica; on-glass they at least read right to assistive tech).
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

    // 🎨 on every surface — but ONE editor per surface: on-device it opens the
    // on-panel style editor; in the settings replica it hands off to the
    // settings inspector (field report: "the palette button is still missing").
    // The ⚙ sheet stays device-only: the inspector owns properties on desktop.
    if (widget) {
      const style = document.createElement('button');
      style.className = 'style';
      style.textContent = '🎨';
      style.title = PREVIEW ? 'Style this widget (opens the inspector)' : 'Style this widget';
      style.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (PREVIEW) {
          selectRecord(record); // selection + inspector open ride the same handoff
          postToHost({ type: 'style-widget', gen: previewGen });
        } else {
          openStyleEditor(record);
        }
      });
      ov.appendChild(style);
    }
    if (widget && !PREVIEW) {
      // On-device access to the widget's OWN settings (#48): the pencil could
      // move and restyle tiles but never configure them.
      if ((widget.properties || []).length) {
        const gear = document.createElement('button');
        gear.className = 'gear';
        gear.textContent = '⚙';
        gear.title = 'Widget settings';
        gear.addEventListener('click', (ev) => { ev.stopPropagation(); openPropSheet(record); });
        ov.appendChild(gear);
      }
    }

    bindDrag(ov, record);
    return ov;
  }

  function removeSlot(record) {
    if (drag && drag.record === record) cancelDrag(); // removed out from under a drag
    if (styleTarget === record) closeStyleEditor(false);
    if (propTarget === record) closePropSheet(false);
    if (selected === record) selectRecord(null); // tell the host its detail target is gone
    mutate(() => {
      const defs = record.page.slots || [];
      const i = defs.indexOf(record.def);
      if (i >= 0) defs.splice(i, 1);
      record.el.remove();
      slots = slots.filter((s) => s !== record);
      relayoutPage(record.page);
      syncNotificationDemand();
    });
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
    const name = (widget && widget.name) || 'This widget';
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

  // ---- per-widget style editor -----------------------------------------------------
  // A right-docked panel over the live tile: checked rows re-specify theme seeds for
  // this instance only; the full palette is re-derived (contrast repair included) and
  // pushed live via ww-theme, then persisted debounced.

  const stylePanel = document.getElementById('stylePanel');
  const spRows = document.getElementById('spRows');
  const spTitle = document.getElementById('spTitle');
  const STOCK_SEEDS = { accent: '#4cc2ff', background: '#05070b', text: '#e8ecf2', panelAlpha: 0.92 };
  let styleTarget = null;
  let stylePersistTimer = null;

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

  function pushSlotTheme(record) {
    sendToSlot(record, { type: 'ww-theme', theme: slotTheme(record) || window.WWPalette.derive(themeSeeds()) });
  }

  function openStyleEditor(record) {
    if (PREVIEW) return; // the settings window's Appearance section owns styling there
    closePropSheet();    // one right-docked editor at a time
    styleTarget = record;
    const widget = widgetsById.get(record.def.widgetId);
    spTitle.textContent = widget ? widget.name : record.def.widgetId;
    for (const s of slots) s.el.classList.toggle('style-editing', s === record);
    buildStyleRows();
    stylePanel.hidden = false;
  }

  function closeStyleEditor(flush) {
    if (flush !== false && stylePersistTimer) {
      clearTimeout(stylePersistTimer);
      stylePersistTimer = null;
      persistLayout(); // flush-on-close: never lose a trailing edit
    }
    styleTarget = null;
    stylePanel.hidden = true;
    for (const s of slots) s.el.classList.remove('style-editing');
  }

  function styleChanged() {
    if (!styleTarget) return;
    const style = styleTarget.def.style;
    if (style && !Object.keys(style).length) delete styleTarget.def.style;
    pushSlotTheme(styleTarget);
    clearTimeout(stylePersistTimer);
    stylePersistTimer = setTimeout(() => { stylePersistTimer = null; persistLayout(); }, 300);
  }

  function buildStyleRows() {
    spRows.textContent = '';
    const def = styleTarget.def;
    const seeds = themeSeeds();
    const hex = (v, fallback) => (/^#[0-9a-f]{6}$/i.test(v || '') ? v : fallback);

    for (const r of [{ key: 'accent', label: 'Accent' }, { key: 'background', label: 'Background' }, { key: 'text', label: 'Text' }]) {
      const row = document.createElement('div');
      row.className = 'sp-row';
      const check = document.createElement('input');
      check.type = 'checkbox';
      const label = document.createElement('label');
      label.textContent = r.label;
      const color = document.createElement('input');
      color.type = 'color';
      const cur = def.style && def.style[r.key];
      check.checked = cur != null;
      color.disabled = !check.checked;
      color.value = hex(cur, hex(seeds[r.key], '#4cc2ff'));
      check.addEventListener('change', () => {
        color.disabled = !check.checked;
        const style = def.style || (def.style = {});
        if (check.checked) style[r.key] = color.value; else delete style[r.key];
        styleChanged();
      });
      color.addEventListener('input', () => {
        (def.style || (def.style = {}))[r.key] = color.value;
        styleChanged();
      });
      row.append(check, label, color);
      spRows.appendChild(row);
    }

    const row = document.createElement('div');
    row.className = 'sp-row';
    const check = document.createElement('input');
    check.type = 'checkbox';
    const label = document.createElement('label');
    label.textContent = 'Panel opacity';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = 15; range.max = 100; range.step = 1;
    const out = document.createElement('output');
    const cur = def.style && def.style.panelAlpha;
    check.checked = cur != null;
    range.disabled = !check.checked;
    range.value = String(Math.round((cur != null ? cur : seeds.panelAlpha) * 100));
    out.value = range.value + '%';
    check.addEventListener('change', () => {
      range.disabled = !check.checked;
      const style = def.style || (def.style = {});
      if (check.checked) style.panelAlpha = Number(range.value) / 100; else delete style.panelAlpha;
      styleChanged();
    });
    range.addEventListener('input', () => {
      out.value = range.value + '%';
      (def.style || (def.style = {})).panelAlpha = Number(range.value) / 100;
      styleChanged();
    });
    row.append(check, label, range, out);
    spRows.appendChild(row);
  }

  document.getElementById('spClose').addEventListener('click', () => closeStyleEditor());
  document.getElementById('spReset').addEventListener('click', () => {
    if (!styleTarget) return;
    delete styleTarget.def.style;
    pushSlotTheme(styleTarget);
    buildStyleRows();
    persistLayout();
  });

  // ---- per-widget settings editor (#48) ---------------------------------------------
  // On-device counterpart of the settings window's Widget tab: a right-docked sheet
  // of touch-first controls generated from the widget's manifest properties. Every
  // change applies to the live tile immediately (the tile IS the preview) and
  // persists debounced, flushing on close — same contract as the style editor.

  const propSheet = document.getElementById('propSheet');
  const psRows = document.getElementById('psRows');
  const psTitle = document.getElementById('psTitle');
  let propTarget = null;
  let propPersistTimer = null;
  let psProfileWaiters = []; // callbacks awaiting an sd-profiles-result
  let propReloadSeq = 0;     // cache-busting nonce: fragment-only src changes don't navigate

  const PS_EMOJI = [
    '🧮', '🌐', '📁', '📷', '🎨', '📝', '📊', '💻', '🖥️', '⌨️', '🖱️', '🎧',
    '🎮', '🕹️', '🎬', '🎵', '📺', '📻', '🔊', '🔇', '⏯️', '⏭️', '⏮️', '⏹️',
    '🚀', '⚡', '🔥', '⭐', '❤️', '🏠', '🔧', '⚙️', '🔒', '🔑', '🛡️', '📦',
    '💬', '📧', '📅', '⏰', '🌙', '☀️', '☁️', '💡', '🔋', '📶', '🧭', '🗺️',
  ];

  // Leading emoji plus trailing whitespace — what a picker:'emoji-prefix' pick
  // swaps out so the text after the icon survives (launcher labels: "🎮 Steam"
  // → "🚀 Steam"). Covers regional-indicator flags (🇺🇸) and keycaps (1️⃣) as
  // well as pictographic VS16/skin-tone/ZWJ/tag sequences — mirror of the
  // launcher widget's own leading-icon matcher.
  const PS_LEAD_EMOJI = /^(?:[\u{1F1E6}-\u{1F1FF}]{2}|[0-9#*]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}\uFE0F?|\p{Emoji_Modifier}|[\u{E0020}-\u{E007F}])*)\s*/u;

  function closeEmojiPop() {
    const pop = document.querySelector('.emoji-pop');
    if (pop) pop.remove();
    document.removeEventListener('pointerdown', onEmojiOutside, true);
  }
  function onEmojiOutside(ev) {
    if (!ev.target.closest('.emoji-pop')) closeEmojiPop();
  }
  function openEmojiPop(anchor, onPick) {
    if (document.querySelector('.emoji-pop')) { closeEmojiPop(); return; }
    const pop = document.createElement('div');
    pop.className = 'emoji-pop';
    for (const e of PS_EMOJI) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = e;
      b.addEventListener('click', () => { onPick(e); closeEmojiPop(); });
      pop.appendChild(b);
    }
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left - pop.offsetWidth + r.width, window.innerWidth - pop.offsetWidth - 8)) + 'px';
    pop.style.top = Math.max(8, Math.min(r.bottom + 4, window.innerHeight - pop.offsetHeight - 8)) + 'px';
    document.addEventListener('pointerdown', onEmojiOutside, true);
  }

  function openPropSheet(record) {
    if (PREVIEW) return; // the settings window's Widget tab owns properties there
    closePropSheet();    // flush the PREVIOUS target's pending apply/persist first —
                         // retargeting mid-debounce must not strand its edit or
                         // apply it to the newly opened widget
    closeStyleEditor();  // one right-docked editor at a time
    propTarget = record;
    const widget = widgetsById.get(record.def.widgetId);
    psTitle.textContent = widget ? widget.name : record.def.widgetId;
    for (const s of slots) s.el.classList.toggle('style-editing', s === record);
    buildPropRows(record, widget);
    propSheet.hidden = false;
  }

  function closePropSheet(flush) {
    if (!propTarget) return; // never wipe the style editor's highlight
    if (flush !== false) {
      // Flush-on-close: the live tile must show the trailing edit and the
      // layout must carry it — never lose either to a still-armed debounce.
      if (propApplyTimer) {
        clearTimeout(propApplyTimer);
        propApplyTimer = null;
        applyPropNow(propTarget);
      }
      if (propPersistTimer) {
        clearTimeout(propPersistTimer);
        propPersistTimer = null;
        persistLayout();
      }
    }
    closeEmojiPop();
    propTarget = null;
    propSheet.hidden = true;
    for (const s of slots) s.el.classList.remove('style-editing');
  }

  /** Apply the edited stored settings by RELOADING the tile, never by re-initing
   * the live document: widgets treat ww-init as boot, and a second one can stack
   * what boot started (the stock Reddit widget's refresh interval, for one).
   * A fresh document is the one path every widget already handles. The record's
   * settings snapshot is re-merged (defaults + stored) so the reload boots
   * exactly like a cold load would. */
  function applyPropNow(record) {
    const widget = widgetsById.get(record.def.widgetId);
    record.settings = mergedSettings(widget, record.def);
    if (!record.frame) return;
    let hash = '#ww-slot=' + record.tag;
    try {
      hash += '&ww-settings=' + encodeURIComponent(JSON.stringify(record.settings));
    } catch (e) { /* unserializable settings: init delivery still applies them */ }
    record.hash = hash;
    record.initialized = false; // the fresh document's ww-ready gets a full init

    // The document that registered any notification demand is being destroyed —
    // carrying its flag forward would keep the host polling toasts forever if
    // the fresh document (new settings) never re-opts or the reload fails. The same
    // reasoning covers every subscription: the demand belonged to that document, and
    // the one replacing it has asked for nothing yet.
    record.notifWatch = false;
    record.notifSeen = null;
    // No Stream Deck state to reset: a route is per REQUEST and expires on its own, so a
    // destroyed document leaves nothing behind that a later one could inherit.
    syncNotificationDemand();
    record.frame.src = record.url + '?r=' + (++propReloadSeq) + hash;
    // This navigation can flake exactly like an initial load (virtual-host races,
    // heavy first paints) — and the boot watchdog chain has long since finished.
    // Fresh retry budget, fresh watchdog, or a failed reload would sit silent
    // forever: no ww-ready, no retries, no failure overlay.
    record.retries = 0;
    armWatchdog(generation);
  }

  let propApplyTimer = null;
  function applyPropChange() {
    if (!propTarget) return;
    // Debounced: a keystroke stream must not reload the iframe per key.
    const target = propTarget;
    clearTimeout(propApplyTimer);
    propApplyTimer = setTimeout(() => {
      propApplyTimer = null;
      if (propTarget === target) applyPropNow(target);
    }, 400);
    clearTimeout(propPersistTimer);
    propPersistTimer = setTimeout(() => { propPersistTimer = null; persistLayout(); }, 600);
  }

  function buildPropRows(record, widget) {
    psRows.textContent = '';
    if (!widget) return;
    const stored = () => (record.def.settings = record.def.settings || {});
    const cur = (prop) => {
      const s = record.def.settings || {};
      return s[prop.name] !== undefined ? s[prop.name] : prop.default;
    };
    // The third argument states INTENT, not value: pass true when the user asked to
    // remove this property. psControl runs outside this closure, so it cannot reach the
    // slot def to name the address itself.
    // The third argument states INTENT; omitting it means "the user set a value", which
    // CANCELS any pending removal. Without that default the name latched: clear a demoted
    // property, pick a replacement in the same session, and the save deleted the property
    // instead of storing what was just chosen.
    // Only a real value cancels — see contradictsRemoval. Cancelling on "" put the latch
    // back for any control whose empty choice is a legitimate selection.
    const set = (prop, v, clearedFlag) => {
      stored()[prop.name] = v;
      if (clearedFlag === true) markCleared(record.def, prop.name, true);
      else if (contradictsRemoval(v)) markCleared(record.def, prop.name, false);
      applyPropChange();
    };

    // Names the host BLANKED on the way here — a demoted property whose stored value is
    // still an envelope. Reveal reports them and DashboardWindow stamps them onto the init
    // payload, which is the channel the panel never had: without it an emptied field and
    // one the host emptied are the same bytes, so the panel could not offer a Clear and a
    // demoted credential was undeletable here (#153).
    const restorable = Array.isArray(record.def.secretsRestorable) ? record.def.secretsRestorable : [];

    for (const prop of widget.properties || []) {
      const field = document.createElement('div');
      field.className = 'ps-field';
      const label = document.createElement('label');
      label.textContent = prop.label || prop.name;
      field.appendChild(label);
      field.appendChild(psControl(prop, cur, set));
      // Keyed on the LIST, so it reaches every property type rather than only the one
      // control that happens to render text. The secret control brings its own.
      if (prop.type !== 'secret' && restorable.includes(prop.name)) {
        const wipe = document.createElement('button');
        wipe.type = 'button';
        wipe.className = 'ps-eye ps-clear ps-field-clear';
        wipe.textContent = '✕';
        wipe.title = 'Remove the stored value on save';
        wipe.addEventListener('click', () => {
          set(prop, '', true);
          // Rebuild so each control shows its own "no value" state — a colour input has
          // no way to render empty, which is exactly why the affordance cannot live
          // inside the controls.
          buildPropRows(record, widget);
        });
        field.appendChild(wipe);
      }
      psRows.appendChild(field);
    }
  }

  /** Segmented button group for short static option lists: every choice visible
   * and tappable, the current one lit — same control the desktop editor renders. */
  function psSegmented(options, current, commit) {
    const seg = document.createElement('div');
    seg.className = 'seg';
    const valueOf = (o) => String((o && typeof o === 'object') ? o.value : o);
    const textOf = (o) => (o && typeof o === 'object') ? (o.label || o.value) : o;
    const light = (chosen) => {
      for (const b of seg.querySelectorAll('button')) b.classList.toggle('active', b.dataset.v === chosen);
    };
    for (const o of options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg-btn';
      b.dataset.v = valueOf(o);
      b.textContent = textOf(o);
      b.addEventListener('click', () => { commit(valueOf(o)); light(valueOf(o)); });
      seg.appendChild(b);
    }
    light(current != null ? String(current) : '');
    return seg;
  }

  function psControl(prop, cur, set) {
    const current = cur(prop);
    switch (prop.type) {
      case 'secret': {
        // On-device the value IS the real credential (the host decrypts for the
        // dashboard), so mask it on glass — shoulder-surfing a desk-height strip
        // is trivial — with a tap-to-show for typo checking. The host re-encrypts
        // on save; plaintext never reaches layout.json.
        const wrap = document.createElement('div');
        wrap.className = 'ps-secret';
        const input = document.createElement('input');
        input.type = 'password';
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.placeholder = prop.placeholder || 'Paste the token or key';
        // Whatever is stored IS what the user typed — no transport form to undo.
        const stored = typeof current === 'string' ? current : '';
        input.value = stored;
        // Whether a credential EXISTS on disk for this field — which changes while the
        // sheet is open, since edits persist on a debounce. A snapshot taken at render
        // time goes stale the moment the user types into an empty field: deleting it
        // again would send "", the host would read that as "the masked desktop field
        // came back untouched", and it would restore the credential it had just saved —
        // leaving a field that looks empty over a token that is still live.
        let exists = stored.length > 0;
        const commit = () => {
          const typed = input.value.length > 0;
          if (typed) exists = true;   // this keystroke is on its way to disk
          // A credential is arbitrary text and needs no escaping: the intent travels as a
          // name, so any string at all round-trips as itself.
          set(prop, input.value, !typed && exists);
          clear.hidden = !exists;
        };
        input.addEventListener('input', commit);
        const eye = document.createElement('button');
        eye.type = 'button';
        eye.className = 'ps-eye';
        eye.textContent = '👁';
        eye.title = 'Show/hide';
        eye.addEventListener('click', () => {
          input.type = input.type === 'password' ? 'text' : 'password';
        });
        // Removal needs to be one deliberate tap on glass, not "select all, delete".
        // Built unconditionally and revealed by `commit`, so it appears as soon as a
        // credential exists — including one typed during this same sheet session.
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'ps-eye ps-clear';
        clear.textContent = '✕';
        clear.title = 'Remove the stored credential on save';
        clear.hidden = !exists;
        clear.addEventListener('click', () => { input.value = ''; commit(); });
        wrap.append(input, eye, clear);
        return wrap;
      }
      case 'select': {
        // Short static lists show every choice as a tappable segment (dropdowns
        // are miserable on the strip anyway); dynamic lists keep the dropdown.
        const staticOpts = prop.options || [];
        if (!prop.optionsSource && staticOpts.length >= 2 && staticOpts.length <= 5) {
          return psSegmented(staticOpts, current, (v) => set(prop, v));
        }
        const select = document.createElement('select');
        for (const o of prop.options || []) {
          const value = (o && typeof o === 'object') ? o.value : o;
          const text = (o && typeof o === 'object') ? (o.label || o.value) : o;
          select.add(new Option(text, value, false, String(value) === String(current)));
        }
        if (prop.optionsSource === 'sd-profiles') {
          // Host-backed options (discovered Virtual Stream Deck profiles) — same
          // flow as the desktop editor; without it this dropdown would be empty.
          select.add(new Option('First available (default)', '', false, !current));
          if (current) select.add(new Option(current, current, false, true));
          psProfileWaiters.push((profiles) => {
            const chosen = select.value;
            while (select.options.length) select.remove(0);
            select.add(new Option('First available (default)', '', false, !chosen));
            for (const p of profiles) select.add(new Option(p, p, false, p === chosen));
            if (chosen && !profiles.includes(chosen)) {
              select.add(new Option(chosen + '  (not found right now)', chosen, false, true));
            }
          });
          postToHost({ type: 'sd-profiles' });
        }
        select.onchange = () => set(prop, select.value);
        return select;
      }
      case 'location': {
        // Location values are STRUCTURED (label + coordinates picked via the
        // desktop search) — a text box would show "[object Object]" and one
        // keystroke would replace precise coordinates with garbage. Show the
        // label, keep the value untouched; picking needs the desktop's search.
        const wrap = document.createElement('div');
        wrap.className = 'ps-field';
        const shown = document.createElement('input');
        shown.type = 'text';
        shown.readOnly = true;
        shown.value = (current && typeof current === 'object')
          ? String(current.label || current.name || 'Picked location')
          : (current != null ? String(current) : '');
        const hint = document.createElement('p');
        hint.className = 'ps-cap';
        hint.textContent = 'Pick the location in the desktop settings window (it has the city search).';
        wrap.append(shown, hint);
        return wrap;
      }
      case 'slider': {
        const wrap = document.createElement('div');
        wrap.className = 'ps-inline';
        const range = document.createElement('input');
        range.type = 'range';
        range.min = prop.min != null ? prop.min : 0;
        range.max = prop.max != null ? prop.max : 100;
        range.step = prop.step != null ? prop.step : 1;
        range.value = Number(current) || 0;
        const out = document.createElement('output');
        out.value = String(range.value);
        // Track live, commit on release — a re-init per dragged pixel is thrash.
        range.oninput = () => { out.value = String(range.value); };
        range.onchange = () => set(prop, Number(range.value));
        wrap.append(range, out);
        return wrap;
      }
      case 'number': {
        const input = document.createElement('input');
        input.type = 'number';
        if (prop.min != null) input.min = prop.min;
        if (prop.max != null) input.max = prop.max;
        // Without a declared step the HTML default of 1 would fail validity on
        // fractional values the manifest never prohibited (e.g. 1.5).
        input.step = prop.step != null ? prop.step : 'any';
        input.value = current != null ? String(current) : '';
        input.oninput = () => {
          // A cleared/half-typed field commits nothing (Number('') is 0), and
          // neither does a value outside the manifest's min/max/step — HTML
          // constraint validation doesn't block input events, so validity is
          // checked here before anything persists out-of-contract.
          const parsed = parseFloat(input.value);
          if (!Number.isNaN(parsed) && input.validity.valid) set(prop, parsed);
        };
        return input;
      }
      case 'media-selector': {
        // iCUE background media picker: the value is a structured object the
        // desktop editor already declares unsupported — never a text box, which
        // would show "[object Object]" and corrupt it on the first keystroke.
        const note = document.createElement('p');
        note.className = 'ps-cap';
        note.textContent = 'Background media is not supported yet.';
        return note;
      }
      case 'switch': {
        // Boolean toggle (iCUE + native), rendered as a real switch. Falling
        // through to text would show "true" and store the string "false" —
        // which is truthy downstream.
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'toggle-check';
        input.checked = current === true || current === 'true';
        input.onchange = () => set(prop, input.checked);
        return input;
      }
      case 'color': {
        const input = document.createElement('input');
        input.type = 'color';
        input.value = /^#[0-9a-f]{6}$/i.test(String(current)) ? current : '#4cc2ff';
        input.oninput = () => set(prop, input.value);
        return input;
      }
      case 'sensor': {
        const select = document.createElement('select');
        select.add(new Option('Auto (recommended)', '', false, !current));
        const pool = (latestSensors || []).filter((s) =>
          !prop.sensor_type || s.type === prop.sensor_type);
        for (const s of pool) {
          select.add(new Option(s.device + ' — ' + s.name, s.id, false, s.id === current));
        }
        if (current && !pool.some((s) => s.id === current)) {
          select.add(new Option(current + '  (missing)', current, false, true));
        }
        select.onchange = () => set(prop, select.value);
        return select;
      }
      case 'sensors-factory': return psSensorsFactory(prop, cur, set);
      case 'list': return psList(prop, cur, set);
      default: { // text
        const input = document.createElement('input');
        input.type = 'text';
        if (prop.placeholder) input.placeholder = String(prop.placeholder);
        input.value = current != null ? String(current) : '';
        input.oninput = () => set(prop, input.value);
        if (prop.picker === 'emoji' || prop.picker === 'emoji-prefix') {
          const wrap = document.createElement('div');
          wrap.className = 'ps-inline';
          wrap.appendChild(input);
          wrap.appendChild(psEmojiBtn(input, prop.picker === 'emoji-prefix'));
          return wrap;
        }
        return input; // picker:'file' stays free-text on-device (no dialog host here)
      }
    }
  }

  function psEmojiBtn(input, prefix) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ps-pick';
    btn.textContent = '😀';
    btn.title = 'Pick an icon';
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openEmojiPop(btn, (e) => {
        // prefix mode keeps the text and swaps only the leading icon.
        input.value = prefix ? (e + ' ' + input.value.replace(PS_LEAD_EMOJI, '')).trimEnd() : e;
        input.dispatchEvent(new Event('input'));
      });
    });
    return btn;
  }

  /** Structured list (deck buttons, launcher shortcuts): one card per item with
   * labeled fields; the same legacy migrations as the settings window (JSON-array
   * string, "A=B" pairs) so old layouts edit cleanly here too. */
  /** Is this list entry a bare value a widget accepts as shorthand? (#167)
   *
   * Strings and finite numbers only. null, undefined, booleans, NaN and arrays are NOT
   * shorthand — they are junk in a settings file, and preserving junk as an editable row
   * would invite someone to keep it. An empty or all-whitespace string is dropped for the
   * same reason: it renders as a blank row that does nothing and cannot be told apart from
   * one the user is midway through typing.
   */
  function isListPrimitive(x) {
    if (typeof x === 'string') return x.trim() !== '';
    return typeof x === 'number' && Number.isFinite(x);
  }

  function psList(prop, cur, set) {
    const wrap = document.createElement('div');
    wrap.className = 'ps-field';
    const fields = (prop.fields && prop.fields.length) ? prop.fields
      : [{ key: 'label', label: 'Label', type: 'text' }, { key: 'value', label: 'Value', type: 'text' }];
    const current = cur(prop);
    let items;
    let legacyJson = null;
    if (typeof current === 'string' && current.trim().startsWith('[')) {
      try { legacyJson = JSON.parse(current); } catch (e) { legacyJson = null; }
      if (!Array.isArray(legacyJson)) legacyJson = null;
    }
    if (Array.isArray(current) || legacyJson) {
      // A PRIMITIVE entry is kept, not discarded (#167). Several widgets accept a bare
      // string as shorthand in a list — endpoints takes "nas.lan" and expands it itself —
      // and filtering those away meant they got no row, so the editor wrote back only
      // what it had rendered and silently deleted every one of them the moment anyone
      // opened the panel and saved.
      //
      // Kept AS a primitive rather than expanded into the field shape, deliberately. What
      // a bare string means is the widget's business and differs between them: endpoints
      // reads it as both the label and the URL, while the comma-string branch just below
      // reads a bare token as fields[0] alone — which for endpoints would leave the URL
      // empty and the entry would be dropped by the widget instead of by the editor. With
      // no rule the manifest can state, guessing picks one widget's meaning and corrupts
      // the rest, so this preserves the value verbatim and leaves the reading where it
      // already works.
      items = (legacyJson || current)
        .filter((x) => (x && typeof x === 'object') || isListPrimitive(x))
        .map((x) => (isListPrimitive(x) ? { __raw: x } : Object.assign({}, x)));
    } else if (typeof current === 'string' && current.trim()) {
      items = current.split(',').map((pair) => {
        const eq = pair.indexOf('=');
        const item = {};
        item[fields[0].key] = (eq < 0 ? pair : pair.slice(0, eq)).trim();
        if (fields[1]) item[fields[1].key] = eq < 0 ? '' : pair.slice(eq + 1).trim();
        return item;
      }).filter((x) => Object.values(x).some((v) => v));
    } else {
      items = [];
    }
    // A row carrying __raw goes back out as the primitive it came in as, so a shorthand
    // entry survives an edit unchanged instead of being rewritten into a shape its widget
    // never asked for.
    const commit = () => set(prop, items.map((x) =>
      (x && x.__raw !== undefined) ? x.__raw : Object.assign({}, x)));
    const renderItems = () => {
      wrap.textContent = '';
      items.forEach((item, i) => {
        const card = document.createElement('div');
        card.className = 'ps-item';
        const head = document.createElement('div');
        head.className = 'ps-item-head';
        const tag = document.createElement('span');
        tag.textContent = (prop.itemLabel || 'item') + ' ' + (i + 1);
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'ps-remove';
        del.textContent = '✕';
        del.title = 'Remove this ' + (prop.itemLabel || 'item');
        del.addEventListener('click', () => { items.splice(i, 1); commit(); renderItems(); });
        head.append(tag, del);
        card.appendChild(head);
        if (item.__raw !== undefined) {
          // One input, because the value genuinely is one value. Rendering the field pair
          // here would ask which half of it to put where, which is the question this
          // deliberately does not answer — and it stays editable and removable, which is
          // the whole complaint: the entry was invisible, so it could not be corrected or
          // deleted either.
          const input = document.createElement('input');
          input.type = 'text';
          // String() for DISPLAY only. The stored value keeps the type it arrived with —
          // a numeric entry that nobody touches must go back out as a number, not as its
          // decimal spelling, which is the same silent rewriting this set out to stop.
          input.value = String(item.__raw);
          input.setAttribute('aria-label', (prop.itemLabel || 'item') + ' ' + (i + 1));
          input.oninput = () => { item.__raw = input.value; commit(); };
          card.appendChild(input);
          wrap.appendChild(card);
          return;
        }
        for (const f of fields) {
          const input = document.createElement('input');
          if (f.type === 'color') {
            input.type = 'color';
            input.value = /^#[0-9a-f]{6}$/i.test(item[f.key]) ? item[f.key] : '#4cc2ff';
          } else {
            input.type = 'text';
            input.placeholder = f.placeholder || f.label || '';
            input.value = item[f.key] != null ? String(item[f.key]) : '';
          }
          input.setAttribute('aria-label', f.label || f.key);
          input.oninput = () => { item[f.key] = input.value; commit(); };
          if (f.picker === 'emoji' || f.picker === 'emoji-prefix') {
            const row = document.createElement('div');
            row.className = 'ps-inline';
            row.appendChild(input);
            row.appendChild(psEmojiBtn(input, f.picker === 'emoji-prefix'));
            card.appendChild(row);
          } else {
            card.appendChild(input);
          }
        }
        wrap.appendChild(card);
      });
      const cap = Math.max(0, Math.round(Number(prop.maxItems) || 0));
      if (cap && items.length >= cap) {
        const full = document.createElement('p');
        full.className = 'ps-cap';
        full.textContent = 'Limit reached — this widget shows at most ' + cap + ' ' +
          (prop.itemLabel || 'item') + 's.';
        wrap.appendChild(full);
      } else {
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'ps-add';
        add.textContent = '+ Add ' + (prop.itemLabel || 'item');
        add.addEventListener('click', () => {
          const item = {};
          for (const f of fields) item[f.key] = f.type === 'color' ? '#4cc2ff' : '';
          items.push(item);
          commit();
          renderItems();
        });
        wrap.appendChild(add);
      }
    };
    renderItems();
    return wrap;
  }

  /** Sensor picker rows (fans): sensor select + per-row color, add/remove; the
   * pool honors the property's sensor_type filter, matching the settings window. */
  function psSensorsFactory(prop, cur, set) {
    const wrap = document.createElement('div');
    wrap.className = 'ps-field';
    const pool = (latestSensors || []).filter((s) =>
      !prop.sensor_type || s.type === prop.sensor_type);
    const current = cur(prop);
    const items = (Array.isArray(current) ? current : [])
      .filter((x) => x && typeof x === 'object').map((x) => Object.assign({}, x));
    const commit = () => set(prop, items.map((x) => Object.assign({}, x)));
    const renderItems = () => {
      wrap.textContent = '';
      items.forEach((item, i) => {
        const row = document.createElement('div');
        row.className = 'ps-inline';
        const select = document.createElement('select');
        for (const s of pool) {
          select.add(new Option(s.device + ' — ' + s.name, s.id, false, s.id === item.sensorId));
        }
        if (item.sensorId && !pool.some((s) => s.id === item.sensorId)) {
          select.add(new Option(item.sensorId + '  (missing)', item.sensorId, false, true));
        }
        select.onchange = () => { item.sensorId = select.value; commit(); };
        const color = document.createElement('input');
        color.type = 'color';
        color.value = /^#[0-9a-f]{6}$/i.test(item.color) ? item.color : '#4cc2ff';
        color.oninput = () => { item.color = color.value; commit(); };
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'ps-remove';
        del.textContent = '✕';
        del.title = 'Remove sensor';
        del.addEventListener('click', () => { items.splice(i, 1); commit(); renderItems(); });
        row.append(select, color, del);
        wrap.appendChild(row);
      });
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'ps-add';
      add.textContent = '+ Add sensor';
      add.disabled = !pool.length;
      add.addEventListener('click', () => {
        // Seed from the FILTERED pool — the first sensor of any type would be a
        // temperature on most systems and could never resolve (Codex round 5).
        items.push({ sensorId: pool[0].id, color: '#4cc2ff' });
        commit();
        renderItems();
      });
      wrap.appendChild(add);
    };
    renderItems();
    return wrap;
  }

  document.getElementById('psClose').addEventListener('click', () => closePropSheet());

  // ---- add widget (palette) --------------------------------------------------------

  function defaultSizeFor(page, widget) {
    const widths = allowedWidths(widget).slice().reverse(); // widest first, shrink into the hole
    const probe = { widgetId: widget.id, size: 'quarter', settings: {} };
    const defs = (page.slots = page.slots || []);
    const before = unplacedCount(defs);
    defs.push(probe);
    let found = null;
    outer:
    for (const band of ['full', 'upper', 'lower']) {
      for (const w of widths) {
        probe.size = makeSize(w, band);
        if (unplacedCount(defs) === before) { found = probe.size; break outer; }
      }
    }
    defs.pop();
    return found;
  }

  function openPalette(page, region) {
    cancelDrag(); // a second finger can reach the add-zone while a drag holds
    // Toggle: pressing "+" again dismisses instead of stacking a re-open (#46).
    if (!paletteEl.hidden) { closePalette(); return; }
    if (PREVIEW && editing) {
      // The replica is a small scaled strip inside the settings window — a modal
      // palette here covers the very layout being edited (#46). Hand off to the
      // settings window's widget gallery instead. The region travels with the
      // request so the settings side can fill the hole that was actually tapped.
      postToHost({ type: 'add-widget', index: Math.max(0, layoutData.pages.indexOf(page)),
        target: region ? { col: region.c, row: region.r, w: region.w, h: region.h } : null,
        gen: previewGen });
      return;
    }
    paletteGrid.textContent = '';
    for (const widget of widgetLib) {
      const btn = document.createElement('button');
      const name = document.createElement('span');
      name.className = 'p-name';
      name.textContent = widget.name;
      const by = document.createElement('span');
      by.className = 'p-by';
      // Sized against the REGION the user tapped, not the page. Answering "does this
      // fit somewhere?" while the tap said "put it HERE" is how a zone over a small
      // hole ends up filling a different one.
      const size = region ? sizeInRegion(widget, region) : defaultSizeFor(page, widget);
      by.textContent = size ? (widget.author || '')
        : (region ? 'Does not fit here' : 'No room on this page');
      btn.append(name, by);
      btn.disabled = !size;
      btn.addEventListener('click', () => addWidget(page, widget, region));
      paletteGrid.appendChild(btn);
    }
    // A wall of disabled entries reads as "broken", not "full" — say it plainly.
    if (![...paletteGrid.children].some((b) => !b.disabled)) {
      const note = document.createElement('p');
      note.className = 'p-full';
      note.textContent = 'This page is full — remove a widget or add a page.';
      paletteGrid.prepend(note);
    }
    paletteEl.hidden = false;
  }
  function closePalette() { paletteEl.hidden = true; }
  document.getElementById('paletteBackdrop').addEventListener('click', closePalette);

  function addWidget(page, widget, region) {
    closePalette();
    mutate(() => {
      // Region-targeted when the add came from a zone: the size is what fits THERE and
      // `col` anchors it to that column, so the widget lands in the hole that was
      // tapped rather than wherever first-fit would have flowed it. Without the
      // anchor, tapping the small hole could fill the large one.
      const size = region ? sizeInRegion(widget, region) : defaultSizeFor(page, widget);
      if (!size) return;
      // instanceId minted upfront: a positional tag here could collide with an
      // identity another slot froze earlier (e.g. a previously adopted "p0s1").
      const def = {
        widgetId: widget.id, size, settings: {},
        instanceId: 'i' + Date.now().toString(36) + '-' + (++instanceSeq),
      };
      if (region) def.col = region.c + 1;   // 1-based anchor, as placeSlots reads it
      (page.slots = page.slots || []).push(def);
      const rec = buildSlot(page, def);
      relayoutPage(page);
      armWatchdog(generation);
      // The just-added widget is what the user configures next: select it so the
      // settings detail panel binds to it (#41). Announced by persistLayout right
      // after this mutation — the layout lands before the selection referencing it.
      if (PREVIEW) selectRecord(rec, false);
    });
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
  // visible widget for a previously hidden one (Codex, #38).
  function unplacedCount(defs) {
    return placeSlots(defs).reduce((n, p) => n + (p === null ? 1 : 0), 0);
  }

  // The defs (by object identity) that currently get a spot on the page.
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
    ghost.textContent = widget ? widget.name : record.def.widgetId;
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
        updateEditBar();
      }
    }
  }

  // ---- go -------------------------------------------------------------------------

  postToHost({ type: 'ready' });
})();
