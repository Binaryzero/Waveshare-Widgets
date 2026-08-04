// Shared with panelsecret-run.js and secretfield-run.js — the two harnesses that assert
// guidance text is readable, on the two surfaces that render it.
//
// It exists because #215's review found the same defect twice in one PR and no harness
// could see it either time: `help` became a REQUIRED field on every secret, and both
// editors painted it in `--text-dim` — a token the settings window never defines (the
// palette pushes it onto the preview element, not the chrome) and the panel derives as
// its faintest. 3.14:1 in one, 3.40:1 in the other, on text the standard now insists a
// user must read. Every other check on those elements is structural: count, position,
// survives-a-value. All of them passed.
//
// So this measures the thing a screenshot would show and a DOM assertion cannot. It
// composites the way a browser does — walking ancestors until the backgrounds stop being
// translucent — because both surfaces stack `color-mix(... transparent)` panels, and a
// ratio taken against `backgroundColor` alone would be measuring rgba(0,0,0,0).
//
// It reports a BOUND, not a measurement, wherever a translucent layer is involved. An
// ancestor walk cannot see a fixed sibling painting between an element and its opaque
// parent, and the panel does exactly that: #bgRoot holds the user's wallpaper and is a
// sibling of #propSheet, whose own background is 94% opaque. The first version of this
// file composited the sheet over <body> and called the answer a measurement — so a
// palette tuned to exactly 4.50:1 would have passed here while rendering at 3.74:1 over
// a bright wallpaper. Bracketing the unknown backdrop between black and white and taking
// the worse ratio is a floor the rendered page cannot fall below, whatever is behind it.
'use strict';

/** Contrast ratio of an element's text against what is actually painted behind it.
 *  Returns { ratio, exact, bounds, fontPx, color } — `ratio` is the worst case over
 *  every possible backdrop when `exact` is false, and evaluated in the page, so pass a
 *  Locator. */
async function textContrast(locator) {
  return locator.evaluate((el) => {
    // `color-mix()` does NOT compute to rgba() — Chromium serialises it as
    // `color(srgb 0.066 0.078 0.094 / 0.94)`, on a 0..1 scale. An rgba-only regex
    // returned null for it, and a null layer was skipped, so the one translucent surface
    // in the whole chain silently vanished from the stack and the walk sailed past it to
    // <body>. Both sheets are built from color-mix, so this was the layer that mattered.
    const parse = (s) => {
      const str = String(s);
      let m = str.match(/rgba?\(([^)]+)\)/);
      if (m) {
        const n = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
        return { r: n[0], g: n[1], b: n[2], a: n.length > 3 ? n[3] : 1 };
      }
      m = str.match(/color\(\s*srgb\s+([^)]+)\)/);
      if (m) {
        const n = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
        return { r: n[0] * 255, g: n[1] * 255, b: n[2] * 255, a: n.length > 3 ? n[3] : 1 };
      }
      return null;
    };
    // Source-over: what stacking a translucent layer on an opaque one actually does.
    const over = (top, bottom) => ({
      r: top.r * top.a + bottom.r * (1 - top.a),
      g: top.g * top.a + bottom.g * (1 - top.a),
      b: top.b * top.a + bottom.b * (1 - top.a),
      a: 1,
    });
    const layers = (node) => {
      const stack = [];
      let unreadable = false;
      for (let n = node; n; n = n.parentElement) {
        const raw = getComputedStyle(n).backgroundColor;
        const bg = parse(raw);
        // A colour this cannot read is not a colour that is not there. Skipping one was
        // the whole failure above, so an unparseable non-transparent background poisons
        // the result into a worst-case bound instead of quietly leaving the stack short.
        if (!bg) { if (raw && !/^(transparent|rgba\(0, 0, 0, 0\))$/.test(raw)) unreadable = true; continue; }
        if (bg.a > 0) { stack.push(bg); if (bg.a === 1) break; }
      }
      return { stack, unreadable };
    };
    const lin = (c) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : (((c / 255) + 0.055) / 1.055) ** 2.4);
    const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    const cs = getComputedStyle(el);
    const { stack, unreadable } = layers(el);
    const fgRaw = parse(cs.color) || { r: 0, g: 0, b: 0, a: 1 };
    // The unknown sits directly beneath the DEEPEST translucent layer, not beneath the
    // whole stack: an opaque <body> under a 94% sheet tells us nothing, because the
    // wallpaper paints between them. So the opaque layer below the translucency is
    // dropped and the bracket is applied there. Bracketing under <body> instead makes
    // both bounds collapse to the same number — which is how the first attempt at this
    // reported a "bound" of 5.90/5.90 and looked like it had proven something.
    const lastSheer = stack.reduce((at, l, i) => (l.a < 1 ? i : at), -1);
    const painted = lastSheer >= 0 ? stack.slice(0, lastSheer + 1) : stack;
    const against = (base) => {
      let bg = base;
      for (let i = painted.length - 1; i >= 0; i--) bg = over(painted[i], bg);
      const fg = over(fgRaw, bg);   // text alpha counts against it too
      const a = lum(fg), b = lum(bg);
      return { ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), bg };
    };
    // An opaque ANCESTOR is not proof of the backdrop. A fixed or absolutely-positioned
    // sibling can paint between it and the element — which is exactly what #bgRoot does
    // on the panel: it is a sibling of #propSheet, not a parent, so a wallpaper is
    // visible through the sheet's 94% background while this walk sees only <body>.
    // Nothing an ancestor walk can reach will tell us what is under a translucent run.
    // So when one exists, do not assume — BOUND. Compositing over black and over white
    // brackets every possible backdrop, and the worse of the two is a ratio the rendered
    // page cannot fall below, whatever the user set as their wallpaper.
    const translucent = unreadable || !stack.length || stack.some((l) => l.a < 1);
    const black = against({ r: 0, g: 0, b: 0, a: 1 });
    const white = against({ r: 255, g: 255, b: 255, a: 1 });
    const worst = black.ratio <= white.ratio ? black : white;
    const exact = !translucent;
    return {
      ratio: worst.ratio,
      exact,                                 // false = worst-case bound, not a measurement
      bounds: exact ? undefined : { onBlack: black.ratio, onWhite: white.ratio },
      fontPx: parseFloat(cs.fontSize),
      color: cs.color,
    };
  });
}

// WCAG's normal-text floor. The 3:1 relaxation begins at 18.66px bold / 24px regular,
// and both help styles are 11px, so the floor is the one that applies — asserted rather
// than assumed, so a future restyle to 24px cannot quietly slip under the wrong bar.
const AA_NORMAL = 4.5;
const LARGE_TEXT_PX = 18.66;

module.exports = { textContrast, AA_NORMAL, LARGE_TEXT_PX };
