// Shared palette derivation — the JS port of App/PaletteEngine.cs, kept in lockstep
// with the C# engine (the harness property-tests both token-for-token over 208 seed
// themes). Loaded by the settings window (theme preview + live replica) and by the
// dashboard shell (per-widget style overrides).
(function () {
  'use strict';

  // ---- palette derivation (JS port of App/PaletteEngine.cs) ----------------------------
  // Drives the live theme preview. Kept in lockstep with the C# engine — the harness
  // property-tests both implementations token-for-token over 208 seed themes.

  function derive(spec) {
    const mixc = (a, b, t) => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
    const lum = (c) => {
      const ch = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
      return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
    };
    const contrastc = (a, b) => {
      const la = lum(a), lb = lum(b);
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };
    const parse = (hex, def) => {
      if (typeof hex !== 'string' || hex.trim() === '') return def;
      let h = hex.trim().replace(/^#*/, '');
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      if (!/^[0-9a-fA-F]{6}$/.test(h)) return def;
      const v = parseInt(h, 16);
      return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
    };
    const WHITE = [0xff, 0xff, 0xff], BLACK = [0, 0, 0];
    const ensure = (color, surfaces, target) => {
      const minC = (c) => Math.min.apply(null, surfaces.map((s) => contrastc(c, s)));
      if (minC(color) >= target) return color;
      let pole = lum(surfaces[0]) < 0.5 ? WHITE : BLACK;
      if (minC(pole) < target) {
        const opp = pole === WHITE ? BLACK : WHITE;
        if (minC(opp) > minC(pole)) pole = opp;
        if (minC(pole) < target) return pole;
      }
      let lo = 0, hi = 1;
      for (let i = 0; i < 18; i++) {
        const mid = (lo + hi) / 2;
        if (minC(mixc(color, pole, mid)) >= target) hi = mid; else lo = mid;
      }
      return mixc(color, pole, hi);
    };
    const ensureState = (seed, surface, surfaceAlt) => {
      const ownMin = (c) => Math.min(
        contrastc(c, surface), contrastc(c, surfaceAlt),
        contrastc(c, mixc(surface, c, 0.14)), contrastc(c, mixc(surfaceAlt, c, 0.14)));
      let c = ensure(seed, [surface, surfaceAlt], 4.5);
      for (let i = 0; i < 6; i++) {
        const next = ensure(c, [surface, surfaceAlt, mixc(surface, c, 0.14), mixc(surfaceAlt, c, 0.14)], 4.5);
        if (next[0] === c[0] && next[1] === c[1] && next[2] === c[2]) break;
        c = next;
      }
      if (ownMin(c) < 4.5) {
        const pole = ownMin(WHITE) >= ownMin(BLACK) ? WHITE : BLACK;
        if (ownMin(pole) > ownMin(c)) c = pole;
      }
      return c;
    };
    // A background used only for MEASURING contrast, kept in floating point (#217): the
    // browser composites the glass settings sheet with fractional channels, so rounding a
    // synthetic composite to bytes before measuring could accept a muted colour that
    // renders just under 4.5:1 on the real sheet. `mixc` still rounds every EMITTED colour;
    // only these measurement backgrounds stay unrounded.
    const mixf = (a, b, t) => [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t);
    const minCon = (c, surfaces) => Math.min.apply(null, surfaces.map((s) => contrastc(c, s)));

    const hexOf = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
    const rgbOf = (c) => c[0] + ', ' + c[1] + ', ' + c[2];
    const tintOf = (c) => 'rgba(' + c[0] + ', ' + c[1] + ', ' + c[2] + ', 0.14)';

    const accent = parse(spec.accent, [0x4d, 0xd4, 0xe8]);
    const background = parse(spec.background, [0x07, 0x0b, 0x12]);
    let text = parse(spec.text, [0xdd, 0xe2, 0xe8]);
    const panelAlpha = Math.min(1.0, Math.max(0.15, spec.panelAlpha == null ? 0.92 : spec.panelAlpha));
    const dark = lum(background) < 0.35;
    const surface = mixc(background, text, dark ? 0.055 : 0.035);
    const surfaceAlt = mixc(background, text, dark ? 0.10 : 0.07);
    const control = mixc(background, text, dark ? 0.15 : 0.11);
    let muted = mixc(text, surface, 0.42);
    let dim = mixc(text, surface, 0.60);
    const line = mixc(text, surface, 0.78);
    text = ensure(text, [surface], 7.0);
    // #217 — the settings sheets (#propSheet / #stylePanel in shell.css) paint --surface at
    // ~94% opacity over the user's wallpaper, a SIBLING behind the glass, not an ancestor.
    // So muted text there renders over surface COMPOSITED with the wallpaper, not the opaque
    // surface, and a role that clears 4.5:1 on the opaque surface can fall below it once a
    // bright (or dark) wallpaper bleeds through the 6% that is not surface. Repair against
    // the surface composited over BOTH extremes (in float, so the emitted byte muted clears
    // the ratio as actually rendered), bracketing any wallpaper. (0.94 is the sheet opacity;
    // more opaque surfaces bleed less and are covered a fortiori. The 70–88% chrome carries
    // --text, the 7:1 tier, not muted. Keep SHEET_ALPHA in lockstep with PaletteEngine.cs.)
    //
    // Muted is painted on the OPAQUE surfaces of widgets far more than on the sheet, so the
    // glass repair must never REGRESS that. When the added glass constraints are jointly
    // unreachable, ensure's fallback can pick a pole that satisfies the sheet while dropping
    // muted below 4.5 on an opaque surface — an accessibility loss everywhere, to fix one
    // sheet. Keep the glass repair only when it holds the opaque contrast at least as high
    // as the opaque-only repair; otherwise fall back to the opaque guarantee.
    const SHEET_ALPHA = 0.94;
    const opaqueSurf = [surface, surfaceAlt];
    const glassSurf = [surface, surfaceAlt,
      mixf(surface, WHITE, 1 - SHEET_ALPHA), mixf(surface, BLACK, 1 - SHEET_ALPHA)];
    const mutedOpaque = ensure(muted, opaqueSurf, 4.5);
    const mutedGlass = ensure(muted, glassSurf, 4.5);
    muted = minCon(mutedGlass, opaqueSurf) >= minCon(mutedOpaque, opaqueSurf) ? mutedGlass : mutedOpaque;
    dim = ensure(dim, [surface], 3.0);
    const ok = ensureState([0x45, 0xd4, 0x83], surface, surfaceAlt);
    const warn = ensureState([0xff, 0xae, 0x52], surface, surfaceAlt);
    const err = ensureState([0xff, 0x62, 0x68], surface, surfaceAlt);
    const info = ensureState([0x62, 0xcb, 0xea], surface, surfaceAlt);
    const NEAR_BLACK = [0x0a, 0x0a, 0x0a];
    const onAccent = contrastc(accent, NEAR_BLACK) >= contrastc(accent, WHITE) ? NEAR_BLACK : WHITE;
    // Accent as a FOREGROUND: the seed itself is never repaired (it is the user's
    // exact pick, used for fills and glows), but outlined controls draw text and
    // borders in it directly, and an accent near the background disappears there.
    const accentFg = ensure(accent, [surface, surfaceAlt], 4.5);
    const hover = mixc(surface, text, 0.08);
    return {
      '--bg': hexOf(background), '--surface': hexOf(surface), '--surface-rgb': rgbOf(surface),
      '--surface-alt': hexOf(surfaceAlt), '--surface-alt-rgb': rgbOf(surfaceAlt),
      '--control-bg': hexOf(control), '--text': hexOf(text), '--text-muted': hexOf(muted),
      '--text-dim': hexOf(dim), '--line': hexOf(line), '--accent': hexOf(accent),
      '--accent-rgb': rgbOf(accent), '--accent-fg': hexOf(accentFg), '--on-accent': hexOf(onAccent),
      '--ok': hexOf(ok), '--warn': hexOf(warn), '--err': hexOf(err), '--info': hexOf(info),
      '--ok-bg': tintOf(ok), '--warn-bg': tintOf(warn), '--err-bg': tintOf(err), '--info-bg': tintOf(info),
      '--hover-bg': hexOf(hover), '--panel-alpha': String(panelAlpha),
      '--appearance': dark ? 'dark' : 'light',
    };
  }

  window.WWPalette = { derive };
})();
