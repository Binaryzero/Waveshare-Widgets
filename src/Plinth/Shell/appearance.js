// Appearance settings the SHELL owns on every widget's behalf.
//
// These are the settings that are true of EVERY tile and have nothing to do with what a
// given widget does. A widget author should no more declare "can this tile be
// transparent" than they should declare what the accent colour is — it is a property of
// the panel, not of the thing being displayed.
//
// Before this existed, `bgStyle` was declared in all 31 stock manifests as byte-identical
// eight-line blocks, and applied by hand in all 31 widget scripts. The hand-written half
// had already drifted into two spellings (a ternary in `clock`, three separate toggles in
// `cpu` and `hue`) which is what copy-paste boilerplate does given time. The declared half
// had drifted too: the control landed at a different position in every widget's settings
// list — twelve had it last, others had it FIRST, interleaved between an API token and a
// refresh interval.
//
// Ownership is total, deliberately. A widget that still declares one of these names has
// its declaration DROPPED rather than honoured, so there is exactly one definition and no
// question about which one a given tile is obeying. That matters most for the widgets
// nobody in this repo wrote: an iCUE port or a third-party package carrying its own
// `bgStyle` gets the panel's behaviour, not its own.
//
// Loaded by both shells (index.html and settings.html) and by nothing else. The widget
// side of this contract lives in widget-api.js, which applies the class inside the frame.
(function () {
  'use strict';

  /// The canonical declarations. Shaped exactly like a manifest property, because they are
  /// spliced into the same list the settings editors already render — no renderer needs to
  /// know these are special, which is what keeps the two editors from drifting apart on
  /// them the way the widgets did.
  /// `group` is load-bearing, not decoration. The settings window opens a heading whenever
  /// a property declares a group and never closes one, so an UNGROUPED property appended
  /// after a grouped one renders underneath whatever heading was last emitted. Eighteen of
  /// the thirty-one stock widgets end on a `group: "Text"` property, so without this the
  /// panel-owned Background control would have been filed as a Text setting on most of the
  /// catalog. Giving it its own group is also the honest label: it is not the widget's
  /// setting, and it should not sit inside the widget's own sections.
  const UNIVERSAL = [
    {
      name: 'bgStyle',
      label: 'Background',
      type: 'select',
      default: 'solid',
      options: ['solid', 'glass', 'transparent'],
      group: 'Appearance',
    },
  ];

  const OWNED = new Set(UNIVERSAL.map((p) => p.name));

  /// Fresh copies every call. The catalog is rebuilt on every reload and the editors mutate
  /// what they are handed; sharing one object across widgets would let an edit to one tile's
  /// row silently rewrite the declaration every other tile is rendered from.
  function universalProperties() {
    return UNIVERSAL.map((p) => Object.assign({}, p, { options: p.options.slice() }));
  }

  /// Appended LAST rather than kept at whatever index a widget happened to use. There was no
  /// consistent position to preserve — appearance sat wherever each author dropped it — so a
  /// fixed place at the end is the only answer that is the same on every tile.
  function withUniversal(widget) {
    if (!widget || typeof widget !== 'object') return widget;
    const declared = (widget.properties || []).filter((p) => !p || !OWNED.has(p.name));
    return Object.assign({}, widget, { properties: declared.concat(universalProperties()) });
  }

  function normalizeCatalog(list) {
    return (Array.isArray(list) ? list : []).map(withUniversal);
  }

  /// Whether a name belongs to the shell. Used by the validator's sibling rule and by any
  /// caller that needs to tell "the author wrote this" from "the panel supplies this".
  function isOwned(name) {
    return OWNED.has(name);
  }

  window.WWAppearance = { universalProperties, withUniversal, normalizeCatalog, isOwned };
})();
