'use strict';
// #221 — the tap-surface paging-guard detector, shared by BOTH runners.
//
// #pages (one frame up) is a horizontal scroll-snap container, so a tap that drifts on a
// widget control with no local horizontal handling hands the pan to it and pages the panel
// out from under the finger (#206/#213). This module finds every place a finger can land
// and asserts each is guarded against that.
//
// It lives here, not inline in one runner, for two reasons the review named:
//   * widget-harness.js can only ever prove a widget's OFFLINE state — the render paths
//     that create controls from live data (streamdeck's #picker, home-assistant's tiles)
//     do not exist there. widget-datapath.js drives those populated states, so the audit
//     has to run in it too; sharing the code is what makes that a single source of truth.
//   * both runners mount the widget in an iframe and a widget may create further frames
//     (twitch, youtube, iframe, or its own srcdoc), so the audit aggregates across the
//     whole frame set, not just the root widget document.

// Installed with page.addInitScript BEFORE any widget script, in every frame. There is no
// static signal for "this element is tappable" that a later DOM scan can recover for the
// DYNAMIC-listener case: an addEventListener target may be a detached node at scan time, or
// document/window itself. So that one path is captured at REGISTRATION here; the inline
// on*-handler and native-activation paths ARE recoverable from the DOM and are found at
// audit time instead (see auditInFrame), which keeps this wrapper minimal.
function tapInitScript() {
  const marks = (window.__wwTapMarks = { els: [], doc: [] });
  // The whole down/up family, pointer AND touch: a control wired only on the RELEASE event
  // (pointerup, touchend) is as much a finger target as one wired on the press, and a touch
  // drag fires touchend on the element it started on while still paging — both were holes
  // the review hit. click covers the synthesized activation.
  const TAP = { click: 1, pointerdown: 1, pointerup: 1, touchstart: 1, touchend: 1 };
  const proto = EventTarget.prototype;
  const native = proto.addEventListener;
  proto.addEventListener = function (type, listener, opts) {
    try {
      if (TAP[type]) {
        // body/documentElement are Elements and carry an ancestor chain, so they are marked
        // as elements; only document and window have no element to mark.
        if (this instanceof Element) { if (marks.els.indexOf(this) < 0) marks.els.push(this); }
        else if (this === document || this === window) { if (marks.doc.indexOf(type) < 0) marks.doc.push(type); }
      }
    } catch (e) { /* instrumentation must never break registration */ }
    return native.call(this, type, listener, opts);
  };
}

// Runs INSIDE a frame (handed to frame.evaluate). Returns { unguarded, docUnguarded } —
// human-readable descriptors of every tap surface that could page the panel.
function tapAuditInFrame() {
  const marks = window.__wwTapMarks || { els: [], doc: [] };
  const desc = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else if (typeof el.className === 'string' && el.className.trim())
      s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
    return s;
  };
  // touch-action that still allows a horizontal pan: 'auto', 'manipulation', or any value
  // naming an x-axis pan. Everything else ('none', 'pan-y', 'pan-y pinch-zoom', …) blocks
  // horizontal and therefore guards.
  const permitsX = (ta) => ta === 'auto' || ta === 'manipulation'
    || /pan-x|pan-left|pan-right/.test(ta);
  // touch-action does not apply to every box. The Pointer Events spec excludes non-replaced
  // inline elements and the table-internal display types, so a `touch-action: none` on a bare
  // <span> is inert — the pan chains through it as if the declaration were not there (measured:
  // an inline span paged #pages to 626 while the equivalent block stayed at 0). Only honour a
  // touch-action guard where it actually takes effect. Replaced elements DO get it even when
  // inline, so an inline <img>/<button>/form control is not excluded.
  // https://www.w3.org/TR/pointerevents/#the-touch-action-css-property
  const INERT_DISPLAY = new Set(['inline', 'table-row', 'table-row-group', 'table-header-group',
    'table-footer-group', 'table-column', 'table-column-group']);
  const REPLACED = new Set(['IMG', 'VIDEO', 'AUDIO', 'CANVAS', 'IFRAME', 'EMBED', 'OBJECT',
    'INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'PROGRESS', 'METER', 'SVG']);
  const taApplies = (el, cs) => {
    if (!INERT_DISPLAY.has(cs.display)) return true;
    return cs.display === 'inline' && REPLACED.has(el.tagName);   // replaced inline still gets it
  };
  // Actually scrollable in an axis: the overflow keyword must ALLOW user scrolling
  // (scroll/auto/overlay — not visible, and not the clip/hidden that overflow content past
  // a box the finger cannot move) AND the content must really overflow. Testing scrollWidth
  // alone is too loose — a <button> whose label overruns its box has scrollWidth > clientWidth
  // yet scrolls nothing — and the overflow keyword alone is too tight, since a vertical list
  // normalizes its computed overflow-x up to 'auto' while never overflowing on that axis.
  const scrollsX = (el, cs) => (cs.overflowX === 'auto' || cs.overflowX === 'scroll' || cs.overflowX === 'overlay')
    && el.scrollWidth - el.clientWidth > 1;
  const scrollsY = (el, cs) => (cs.overflowY === 'auto' || cs.overflowY === 'scroll' || cs.overflowY === 'overlay')
    && el.scrollHeight - el.clientHeight > 1;
  // The horizontal pan a drifting tap starts chains to the nearest ancestor that can take
  // it. touch-action is intersected from the target UP TO AND INCLUDING the nearest scroll
  // container, and NO FURTHER: a rule above that container is outside the intersection, so a
  // body/root guard does not protect a control that sits inside a vertical scroller
  // (tests/harness/touchpan-run.js T9, lines 191-197 — measured scrollLeft 0 -> 612/626).
  // A surface is therefore guarded only if an x-block — or a real horizontal scroller, which
  // consumes the pan itself — is found AT or BELOW its nearest scroll container.
  const guarded = (start) => {
    for (let el = start; el; el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (taApplies(el, cs) && !permitsX(cs.touchAction)) return true;   // an EFFECTIVE x-block guards
      if (scrollsX(el, cs)) return true;    // a real horizontal scroller takes the pan itself
      if (scrollsY(el, cs)) return false;   // nearest scroller is vertical-only, no x-guard at/below → unguarded
    }
    return false;
  };
  // Discovery is the union of three routes a control becomes tappable by. The review proved
  // each of the last two bypassed a listener-only detector on this head:
  //   * addEventListener — caught at registration (marks.els).
  //   * inline onclick and property .onclick — both surface as a non-null on* IDL attribute.
  //   * native activation — button, a[href], form controls, summary, a for-label: these
  //     fire on tap with no listener at all, and a finger still lands and drifts on them.
  const ON = ['onclick', 'onpointerdown', 'onpointerup', 'ontouchstart', 'ontouchend'];
  const NATIVE = 'a[href],button,input,select,textarea,summary,label[for],[role="button"]';
  const surfaces = new Set();
  for (const el of marks.els) if (el.isConnected) surfaces.add(el);
  for (const el of document.querySelectorAll('*')) if (ON.some((k) => el[k])) surfaces.add(el);
  for (const el of document.querySelectorAll(NATIVE)) surfaces.add(el);
  const unguarded = [];
  for (const el of surfaces) if (!guarded(el)) unguarded.push(desc(el));
  // A document/window listener — or an on* handler on window, the document, or the root/body
  // — covers the whole frame; its only possible guard is the root's or body's own
  // touch-action, since there is no smaller element inside it to carry one. window carries the
  // same property-assigned handlers (window.onclick = …) as window.addEventListener, so it is
  // scanned alongside document.
  const docUnguarded = [];
  const docOn = ON.some((k) => window[k] || document[k] || (document.body && document.body[k]));
  if (marks.doc.length || docOn) {
    const rootTa = getComputedStyle(document.documentElement).touchAction;
    const bodyTa = document.body ? getComputedStyle(document.body).touchAction : 'auto';
    if (permitsX(rootTa) && permitsX(bodyTa)) docUnguarded.push('document(' + (marks.doc.join(',') || 'on*') + ')');
  }
  return { unguarded: [...new Set(unguarded)], docUnguarded };
}

// Aggregate the audit across every WIDGET frame — the root widget document plus any frame
// the widget created — the same way peerApis reads __wwRtc from every frame. The top frame
// is the runner's own shell scaffolding, never a widget: it holds no widget control, and it
// carries harness/engine-level document listeners that are not a widget concern, so it is
// excluded (a frame with no parent is the top frame). A frame that cannot be evaluated (a
// cross-origin third-party embed) contributes nothing rather than failing the run. Returns
// the de-duplicated list of unguarded surface descriptors.
async function auditTapSurfaces(frames) {
  const widgetFrames = frames.filter((f) => f.parentFrame && f.parentFrame() !== null);
  const perFrame = await Promise.all(widgetFrames.map((f) =>
    f.evaluate(tapAuditInFrame).catch(() => ({ unguarded: [], docUnguarded: [] }))));
  const all = [];
  for (const r of perFrame) all.push(...r.unguarded, ...r.docUnguarded);
  return [...new Set(all)];
}

module.exports = { tapInitScript, tapAuditInFrame, auditTapSurfaces };
