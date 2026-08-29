// Plinth-authored stand-ins for iCUE's shared widget helpers, INJECTED alongside
// widget-api.js and icue-compat.js rather than served over a URL.
//
// iCUE ships one common/ folder beside its stock widgets, and those widgets script-src
// it from outside their own package — <script src="../common/tools/…"> in the stock
// tree, "../../widgets/common/…" in the Stream Deck widget. On our per-widget origins
// those references clamp at the origin root and 404, and because every such widget
// constructs one of the helper classes at script top level, the 404 became a
// ReferenceError that killed the whole widget script.
//
// This was first solved by intercepting those URLs and serving files (IcueCommonAssets).
// That failed in the field — the classes were still undefined on a build that carried
// the hook — and the two candidate causes (a WebView2 filter wildcard in the HOST
// position, which nothing else in this app relies on, and the files reaching the output
// directory) both present as the SAME silent 404, on a machine the repo's CI cannot
// drive. Defining the globals here removes the question: the shim already reaches every
// widget document — that is how window.plugins gets there — so the helper classes exist
// before the widget's first line runs, and the 404 on its <script src> is harmless
// because nothing depends on that request ever succeeding.
//
// Everything is assigned as a window PROPERTY, never a bare `class X {}` declaration: a
// package that vendored its own copy of common/ still has that file served normally by
// its own folder mapping, and its top-level `class MediaViewer {}` would be a
// redeclaration SyntaxError against a lexical binding. A property assignment is shadowed
// cleanly instead, so a vendored copy keeps winning.
//
// No Corsair code appears here. The API surface is taken from the documented contract
// (docs/ICUE-API-REFERENCE.md) and from the call sites in the stock widgets; the
// originals are all-rights-reserved and are not shipped.
(function () {
  'use strict';
  // Same gate as icue-compat.js: widgets are framed, and the shell page needs none of
  // this. Idempotent — a second injection must not redefine live classes.
  if (window.top === window || window.__wwIcueCommon) return;
  window.__wwIcueCommon = true;

  // --- plugins/IcueWidgetApiWrapper.js -------------------------------------------
  // Universal promise wrapper over the documented plugin contract: async getters take a
  // caller-chosen integer requestId and answer through the plugin's Qt-style
  // asyncResponse(requestId, value) signal.
  window.IcueWidgetApiWrapper = class IcueWidgetApiWrapper {
    constructor(plugin, timeoutMs = 5000) {
      this.plugin = plugin || null;
      this.timeoutMs = timeoutMs;
      this._waiters = new Map();
      this._seq = 1;
      if (this.plugin && this.plugin.asyncResponse &&
          typeof this.plugin.asyncResponse.connect === 'function') {
        this.plugin.asyncResponse.connect((requestId, value) => this._settle(requestId, value));
      }
    }

    _settle(requestId, value) {
      const waiter = this._waiters.get(requestId);
      if (!waiter) return; // an answer for a request that already timed out
      this._waiters.delete(requestId);
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    }

    request(method, ...args) {
      return new Promise((resolve, reject) => {
        if (!this.plugin || typeof method !== 'function') {
          reject(new Error('plugin unavailable'));
          return;
        }
        const requestId = this._seq++;
        const timer = setTimeout(() => {
          if (this._waiters.delete(requestId)) reject(new Error('request timed out'));
        }, this.timeoutMs);
        this._waiters.set(requestId, { resolve, reject, timer });
        try {
          method.call(this.plugin, requestId, ...args);
        } catch (e) {
          if (this._waiters.delete(requestId)) {
            clearTimeout(timer);
            reject(e);
          }
        }
      });
    }
  };

  // --- plugins/Simple*ApiWrapper.js ----------------------------------------------

  window.SimpleSensorApiWrapper = class SimpleSensorApiWrapper extends window.IcueWidgetApiWrapper {
    getSensorValue(id) { return this.request(this.plugin.getSensorValue, id); }
    getSensorUnits(id) { return this.request(this.plugin.getSensorUnits, id); }
    getSensorName(id) { return this.request(this.plugin.getSensorName, id); }
    getSensorDeviceName(id) { return this.request(this.plugin.getSensorDeviceName, id); }
    getSensorType(id) { return this.request(this.plugin.getSensorType, id); }
    getSensorKind(id) { return this.request(this.plugin.getSensorKind, id); }
    getAllSensorIds() { return this.request(this.plugin.getAllSensorIds); }
    sensorIsConnected(id) { return this.request(this.plugin.sensorIsConnected, id); }
    getDefaultSensorId(type, kind) { return this.request(this.plugin.getDefaultSensorId, type, kind); }
  };

  window.SimpleMediaApiWrapper = class SimpleMediaApiWrapper extends window.IcueWidgetApiWrapper {
    getSongName() { return this.request(this.plugin.getSongName); }
    getArtist() { return this.request(this.plugin.getArtist); }
  };

  // Plinth's Fpsdataprovider is an honest no-data stub, so these resolve 0/false/'' and
  // the widget's own "unavailable" state is the designed outcome.
  window.SimpleFpsApiWrapper = class SimpleFpsApiWrapper extends window.IcueWidgetApiWrapper {
    getCurrentFps() { return this.request(this.plugin.getCurrentFps); }
    getFpsAvailable() { return this.request(this.plugin.getFpsAvailable); }
    getCurrentProcess() { return this.request(this.plugin.getCurrentProcess); }
  };

  window.SimpleNotificationsApiWrapper = class SimpleNotificationsApiWrapper extends window.IcueWidgetApiWrapper {
    getNotificationCount() { return this.request(this.plugin.getNotificationCount); }
  };

  // --- tools/ColorTools.js --------------------------------------------------------
  // Stock widgets feed the result into custom properties consumed as `rgb(var(--x))` /
  // `rgba(var(--x), a)`, so the contract is a bare "r, g, b" triple.
  window.hexToRGB = function hexToRGB(hex) {
    let h = String(hex == null ? '' : hex).trim().replace(/^#/, '');
    if (h.length === 3) h = h.replace(/./g, (c) => c + c);
    const n = parseInt(h.slice(0, 6), 16);
    if (h.length < 6 || !Number.isFinite(n)) return '255, 255, 255';
    return ((n >> 16) & 255) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255);
  };

  // --- tools/DateFormatter.js -----------------------------------------------------
  // The clock widgets construct it per render and call getDateText with the dateText
  // combobox KEY, the day-of-week they last rendered, and a force flag. It resolves to
  // the display string, or to undefined when nothing needs to change (same day, not
  // forced) so the caller can skip the DOM write. The format keys are the literal option
  // keys the stock clocks declare — each is 5 April 2020 written in the format it names.
  window.DateFormatter = class DateFormatter {
    constructor(languageCode, timeZone) {
      this.languageCode = languageCode || 'en';
      this.timeZone = timeZone || undefined;
    }

    _parts(options) {
      try {
        return new Intl.DateTimeFormat(this.languageCode,
          Object.assign({ timeZone: this.timeZone }, options)).formatToParts(new Date());
      } catch (e) {
        // An unresolvable time zone degrades to local time, never kills the clock.
        return new Intl.DateTimeFormat(this.languageCode, options).formatToParts(new Date());
      }
    }

    _get(options, type) {
      const part = this._parts(options).find((p) => p.type === type);
      return part ? part.value : '';
    }

    getDateText(formatKey, lastDay, forceUpdate) {
      // Callers track lastDay with the local Date#getDay, so the skip check matches
      // their bookkeeping rather than second-guessing the time zone.
      if (!forceUpdate && lastDay === new Date().getDay()) return Promise.resolve(undefined);

      const key = String(formatKey == null ? 'None' : formatKey);
      if (key === 'None') return Promise.resolve('');

      const two = (v) => String(v).padStart(2, '0');
      const day = this._get({ day: 'numeric' }, 'day');
      const monthNum = this._get({ month: 'numeric' }, 'month');
      const yearFull = this._get({ year: 'numeric' }, 'year');
      let text;
      switch (key) {
        case '04/05/2020': text = two(monthNum) + '/' + two(day) + '/' + yearFull; break;
        case '05/04/2020': text = two(day) + '/' + two(monthNum) + '/' + yearFull; break;
        case '05 Apr 20':
          text = two(day) + ' ' + this._get({ month: 'short' }, 'month') + ' ' + yearFull.slice(-2);
          break;
        case 'Sun 5 Apr':
          text = this._get({ weekday: 'short' }, 'weekday') + ' ' + day + ' ' +
            this._get({ month: 'short' }, 'month');
          break;
        case 'Sunday 5 April':
          text = this._get({ weekday: 'long' }, 'weekday') + ' ' + day + ' ' +
            this._get({ month: 'long' }, 'month');
          break;
        default: // 'System' and anything unrecognized: the locale's own short form.
          try { text = new Date().toLocaleDateString(this.languageCode, { timeZone: this.timeZone }); }
          catch (e) { text = new Date().toLocaleDateString(this.languageCode); }
          break;
      }
      return Promise.resolve(text);
    }
  };

  // --- tools/ticker-tracker.js ----------------------------------------------------
  // Stock widgets ship the markup themselves — .ticker > .ticker-track > .ticker-item —
  // call init() with those three element ids, then setText() on every data update. Text
  // that fits stays put; text that overflows sweeps so the whole string is readable.
  // Transform-only animation: this panel runs 24/7.
  window.TickerTracker = (() => {
    let ticker = null;
    let track = null;
    let item = null;

    function measure() {
      if (!ticker || !track || !item) return;
      const overflow = item.scrollWidth - ticker.clientWidth;
      if (overflow > 4) {
        track.style.setProperty('--ww-ticker-shift', -overflow + 'px');
        // Sweep speed scales with distance so long strings aren't a blur; the floor
        // keeps short overflows from twitching.
        track.style.setProperty('--ww-ticker-secs', Math.max(6, overflow / 24) + 's');
        track.classList.add('ww-ticker-scroll');
      } else {
        track.classList.remove('ww-ticker-scroll');
        track.style.removeProperty('--ww-ticker-shift');
        track.style.removeProperty('--ww-ticker-secs');
      }
    }

    return {
      init(tickerId, trackId, itemId) {
        ticker = document.getElementById(tickerId);
        track = document.getElementById(trackId);
        item = document.getElementById(itemId);
        if (ticker && 'ResizeObserver' in window) new ResizeObserver(measure).observe(ticker);
      },
      setText(text) {
        if (!item) return;
        const next = text == null ? '' : String(text);
        if (item.textContent !== next) item.textContent = next;
        measure();
      },
    };
  })();

  // --- tools/media_viewer/MediaViewer.js ------------------------------------------
  // Every stock widget constructs one at script top level for its backgroundMedia
  // setting — this class existing at all is most of its job. media-selector is not
  // supported on Plinth (the asset lives inside the user's iCUE install), so
  // backgroundMedia is normally undefined and widgets call clear(). loadMedia still
  // renders URL-shaped sources faithfully, and reports anything else through
  // onMediaError instead of throwing.
  window.MediaViewer = class MediaViewer {
    constructor(options) {
      const opts = options || {};
      this.container = opts.container || null;
      this.onMediaLoaded = typeof opts.onMediaLoaded === 'function' ? opts.onMediaLoaded : null;
      this.onMediaError = typeof opts.onMediaError === 'function' ? opts.onMediaError : null;
      this._media = null;
    }

    clear() {
      if (this._media) {
        this._media.remove();
        this._media = null;
      }
    }

    loadMedia(descriptor) {
      const desc = descriptor || {};
      this.clear();
      const src = String(desc.path == null ? '' : desc.path);
      if (!this.container || !src) return;
      if (!/^(https?:|data:|blob:)/i.test(src)) {
        // An iCUE-machine file path: unreachable from this renderer, by design.
        this._fail(new Error('media-selector assets are not available on Plinth'));
        return;
      }

      const isVideo = /\.(webm|mp4|mkv)(\?|#|$)/i.test(src);
      const el = document.createElement(isVideo ? 'video' : 'img');
      if (isVideo) {
        el.muted = true;
        el.autoplay = true;
        el.loop = true;
        el.playsInline = true;
      }
      el.className = 'ww-media-view';
      const scale = Number(desc.scale) || 1;
      const angle = Number(desc.angle) || 0;
      const x = Number(desc.positionX) || 0;
      const y = Number(desc.positionY) || 0;
      el.style.transform = 'translate(-50%, -50%) translate(' + x + 'px, ' + y + 'px) ' +
        'rotate(' + angle + 'deg) scale(' + scale + ')';
      el.addEventListener(isVideo ? 'loadeddata' : 'load', () => {
        if (this.onMediaLoaded) {
          try { this.onMediaLoaded(el); } catch (e) { /* widget's handler, widget's problem */ }
        }
      });
      el.addEventListener('error', () => this._fail(new Error('media failed to load')));
      el.src = src;
      this.container.appendChild(el);
      this._media = el;
    }

    _fail(error) {
      if (this.onMediaError) {
        try { this.onMediaError(error); } catch (e) { /* widget's handler, widget's problem */ }
      }
    }
  };

  // --- the stylesheets those two tools came with ----------------------------------
  // Their <link> tags 404 for the same reason the scripts did. Injected FIRST in the
  // document so the widget's own stylesheets still win on equal specificity.
  const CSS = [
    '.ticker { overflow: hidden; white-space: nowrap; }',
    '.ticker-track { display: inline-block; white-space: nowrap; will-change: transform; }',
    '.ticker-item { display: inline-block; white-space: nowrap; }',
    '@keyframes ww-ticker-scroll {',
    '  0%, 12% { transform: translateX(0); }',
    '  44%, 56% { transform: translateX(var(--ww-ticker-shift, 0px)); }',
    '  88%, 100% { transform: translateX(0); }',
    '}',
    '.ww-ticker-scroll { animation: ww-ticker-scroll var(--ww-ticker-secs, 8s) linear infinite; }',
    '.ww-media-view { position: absolute; left: 50%; top: 50%; max-width: none; max-height: none; }',
  ].join('\n');

  function injectStyles() {
    if (document.getElementById('ww-icue-common-css')) return;
    const style = document.createElement('style');
    style.id = 'ww-icue-common-css';
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }
  // This script runs at document creation, so <head> may not exist yet.
  if (document.head || document.documentElement) injectStyles();
  else document.addEventListener('DOMContentLoaded', injectStyles);

  // --- qrc: fonts ------------------------------------------------------------------
  //
  // iCUE stylesheets load their faces from Qt's resource scheme
  // (@font-face { src: url("qrc:/fonts/OpenSans-Regular.ttf") }). That scheme exists
  // only inside Qt: Chromium refuses it as a cross-origin request, the face never
  // arrives, and — the part that actually hurts — Chromium logs a "Slow network is
  // detected … Fallback font will be used" intervention for EVERY element waiting on
  // it. One widget produced hundreds of lines, which buries real errors in the console.
  //
  // The face was never going to load, so point it at local() instead: no request, no
  // intervention, and the text lands on a real installed font rather than whatever the
  // fallback chain reaches last. Rules are found by INSPECTING each sheet rather than
  // guessing family names, which differ per widget (OpenSansRegular, Saira-Medium,
  // Bebas Neue Pro, …) and would go stale the moment a package used a new one.
  const FONT_SUBSTITUTE = 'local("Segoe UI"), local("Tahoma"), local("Arial"), local("Helvetica")';

  // `src` is an ORDERED fallback list, so dropping the whole descriptor because one
  // entry is unusable would discard a perfectly good sibling — a package-relative
  // .woff2, or an installed branded face the widget would otherwise have got. Split the
  // list, remove only the qrc: entries, and fall back to local() ONLY when nothing else
  // is left. Commas inside url(…)/format(…) are not separators, hence the paren guard.
  function stripQrcSources(src) {
    const parts = String(src).split(/,(?![^(]*\))/);
    const kept = parts.map((s) => s.trim()).filter((s) => s && s.indexOf('qrc:') === -1);
    return kept.length ? kept.join(', ') : FONT_SUBSTITUTE;
  }

  // Walks a rule LIST rather than a sheet, because @font-face does not only appear at
  // the top level: `@media`, `@supports`, `@layer` and `@container` each carry their own
  // cssRules, and a face nested in one is invisible to a scan that only tests the
  // outermost rule's type. iCUE packages do this (a @media block for the panel's
  // aspect), so the sweep reported success while those faces went on flooding.
  function defuseRules(rules, seen) {
    let patched = 0;
    for (const rule of Array.from(rules)) {
      if (!rule) continue;
      // An @import's sheet is reached through the rule, never as its own
      // document.styleSheets entry, so a widget that imports its font sheet kept
      // flooding the console while this reported success.
      if (rule.type === 3 /* CSSRule.IMPORT_RULE */) {
        try { if (rule.styleSheet) patched += defuseSheet(rule.styleSheet, seen); }
        catch (e) { /* cross-origin import */ }
        continue;
      }
      if (rule.type === 5 /* CSSRule.FONT_FACE_RULE */) {
        let value;
        try { value = rule.style.getPropertyValue('src'); } catch (e) { continue; }
        if (!value || value.indexOf('qrc:') === -1) continue;
        try { rule.style.setProperty('src', stripQrcSources(value)); patched++; }
        catch (e) { /* read-only sheet: leave it */ }
        continue;
      }
      // Anything else that carries rules of its own. Tested by CAPABILITY, not by an
      // enumerated list of group types — the list would go stale the next time CSS grows
      // one, and this is exactly the failure being fixed. Keyframes and nested style
      // rules also answer here; walking them finds nothing and costs nothing.
      let nested;
      try { nested = rule.cssRules; } catch (e) { nested = null; }
      if (nested && nested.length) patched += defuseRules(nested, seen);
    }
    return patched;
  }

  function defuseSheet(sheet, seen) {
    // A cross-origin sheet throws on .cssRules; widgets' own sheets are same-origin.
    let rules;
    try { rules = sheet.cssRules; } catch (e) { return 0; }
    if (!rules || seen.has(sheet)) return 0;
    seen.add(sheet);
    return defuseRules(rules, seen);
  }

  function defuseQrcFonts() {
    let sheets;
    try { sheets = Array.from(document.styleSheets); } catch (e) { return 0; }
    const seen = new Set();
    let patched = 0;
    for (const sheet of sheets) patched += defuseSheet(sheet, seen);
    return patched;
  }

  // Sheets arrive over the document's lifetime, so sweep at both readiness points —
  // and once more shortly after load for anything a script appended.
  function sweepFonts() {
    const n = defuseQrcFonts();
    if (n > 0) {
      try {
        parent.postMessage({ type: 'ww-log',
          message: 'icue-common: redirected ' + n + ' qrc: @font-face rule(s) to local fonts' }, '*');
      } catch (e) { /* frame gone */ }
    }
  }

  // A fixed set of sweeps only covers sheets that exist by the last one. A widget that
  // appends a <link> or <style> later — switching views, loading a skin, lazy-loading a
  // panel — brings its qrc: faces with it and resumes the flood this exists to stop.
  // More timeouts would just move the deadline, so watch for the sheets instead.
  let sweepPending = false;
  function scheduleSweep() {
    if (sweepPending) return;
    sweepPending = true;
    // Coalesced: a widget that appends a dozen nodes in one turn gets ONE sweep, and a
    // sweep is a walk of every sheet. Patched rules no longer match, so a re-sweep is
    // idempotent and silent.
    setTimeout(() => { sweepPending = false; sweepFonts(); }, 0);
  }

  function isSheetNode(node) {
    if (!node || node.nodeType !== 1) return false;
    const tag = node.tagName;
    return tag === 'STYLE' || (tag === 'LINK' && /(^|\s)stylesheet(\s|$)/i.test(node.rel || ''));
  }

  let watching = false;
  function watchForSheets() {
    // The shim runs at document-created, before <html> exists; called again at each
    // readiness point, so the first call that has a root wins and the rest no-op.
    if (watching || typeof MutationObserver !== 'function') return;
    const root = document.documentElement;
    if (!root) return;
    watching = true;
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!isSheetNode(node)) continue;
          // A <link>'s sheet is not parsed at insertion — .sheet is null until it
          // loads, and sweeping now would find nothing. Sweep on both: the immediate
          // one catches <style>, the load event catches <link>.
          if (node.tagName === 'LINK') {
            try { node.addEventListener('load', scheduleSweep, { once: true }); }
            catch (e) { /* older listener signature: the sweep below still runs */ }
          }
          scheduleSweep();
          return;
        }
      }
    }).observe(root, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { watchForSheets(); sweepFonts(); });
  } else {
    watchForSheets();
    sweepFonts();
  }
  window.addEventListener('load', () => { watchForSheets(); sweepFonts(); setTimeout(sweepFonts, 1000); });
})();
