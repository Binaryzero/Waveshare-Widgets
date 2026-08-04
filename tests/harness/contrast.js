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
'use strict';

/** Contrast ratio of an element's text against what is actually painted behind it.
 *  Returns { ratio, fontPx, color } — evaluated in the page, so pass a Locator. */
async function textContrast(locator) {
  return locator.evaluate((el) => {
    const parse = (s) => {
      const m = String(s).match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const n = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      return { r: n[0], g: n[1], b: n[2], a: n.length > 3 ? n[3] : 1 };
    };
    // Source-over: what stacking a translucent layer on an opaque one actually does.
    const over = (top, bottom) => ({
      r: top.r * top.a + bottom.r * (1 - top.a),
      g: top.g * top.a + bottom.g * (1 - top.a),
      b: top.b * top.a + bottom.b * (1 - top.a),
      a: 1,
    });
    const behind = (node) => {
      const stack = [];
      for (let n = node; n; n = n.parentElement) {
        const bg = parse(getComputedStyle(n).backgroundColor);
        if (bg && bg.a > 0) { stack.push(bg); if (bg.a === 1) break; }
      }
      // White under everything: if no opaque layer was found the page is showing the
      // canvas, and assuming black there would flatter a light theme into passing.
      let out = { r: 255, g: 255, b: 255, a: 1 };
      for (let i = stack.length - 1; i >= 0; i--) out = over(stack[i], out);
      return out;
    };
    const lin = (c) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : (((c / 255) + 0.055) / 1.055) ** 2.4);
    const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    const cs = getComputedStyle(el);
    const bg = behind(el);
    const fg = over(parse(cs.color) || { r: 0, g: 0, b: 0, a: 1 }, bg); // text alpha counts too
    const a = lum(fg), b = lum(bg);
    return {
      ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
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
