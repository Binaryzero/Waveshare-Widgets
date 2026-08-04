# Widget Design Standard

The design system every stock widget follows, and the bar third-party widgets should aim
for. It is implemented in two files: `widget-base.css` (the tokens and component classes,
linked from the shell origin) and the theme push (`PaletteEngine` on the host deriving the
token palette that lands on every widget's `:root` at init). For the packaging format and
the `WW` API see [WIDGET-SPEC.md](WIDGET-SPEC.md) and
[WAVESHARE-API-REFERENCE.md](WAVESHARE-API-REFERENCE.md).

Link the foundation first in `<head>`, before any widget CSS:

```html
<link rel="stylesheet" href="https://app.wsw/widget-base.css" />
```

Widget CSS is then *layout only* — colors, background, the `bgStyle` handling and the
typography base all come from the foundation. The stock clock and CPU widgets are the
reference implementations.

## Contents

- [1 · Design tokens](#1--design-tokens)
- [2 · How theming works](#2--how-theming-works)
- [3 · Transparency system](#3--transparency-system)
- [4 · Widget anatomy](#4--widget-anatomy)
- [5 · Required states](#5--required-states)
- [6 · Typography](#6--typography)
- [7 · Motion](#7--motion)
- [8 · Touch](#8--touch)
- [9 · Performance on a 24/7 panel](#9--performance-on-a-247-panel)
- [10 · Compliance checklist](#10--compliance-checklist)

---

## 1 · Design tokens

**The rule: tokens, never literal colors.** Every color in a widget is a `var(--token)`
reference. The host overwrites the tokens on `:root` from the user's theme at init, so a
hardcoded `#0b0e14` or `#00d4ff` is a bug — it will look wrong the moment the user picks a
light theme or a different accent. The values below are the stock-dark defaults baked into
`widget-base.css` as fallbacks (so a widget renders sensibly in a standalone browser
during development); at runtime the theme push replaces them.

### Color roles

| Token | Purpose | Stock value |
|---|---|---|
| `--bg` | Theme background seed (the wallpaper-level color) | `#05070b` |
| `--surface` | Widget tile background (`body` paints this via the panel-alpha system) | `#111418` |
| `--surface-rgb` | `--surface` as `r, g, b` for `rgba()` composition | `17, 20, 24` |
| `--surface-alt` | Raised surface one step above the tile | `#1c1e22` |
| `--surface-alt-rgb` | `--surface-alt` as `r, g, b` | `28, 30, 34` |
| `--control-bg` | Interactive control fill (buttons, meter tracks, ring tracks) | `#27292e` |
| `--text` | Primary text and values | `#e8ecf2` |
| `--text-muted` | Secondary text: labels, kickers, units | `#8e9196` |
| `--text-dim` | Tertiary text: hints, footer meta | `#676a6f` |
| `--line` | Hairline borders and separators | `#404448` |
| `--accent` | The user's accent: highlights, active fills, focus rings | `#4cc2ff` |
| `--accent-rgb` | `--accent` as `r, g, b` for tints like `rgba(var(--accent-rgb), 0.14)` | `76, 194, 255` |
| `--on-accent` | Text/icon color on accent-filled surfaces (`.btn.primary`) | `#0a0a0a` |
| `--hover-bg` | Hover/pressed row background | `#222529` |
| `--panel-alpha` | The theme's glass opacity level (see [§3](#3--transparency-system)) | `0.92` |
| `--appearance` | `dark` \| `light`; also stamped as `data-appearance` on `<html>` | `dark` |

### State colors

Fixed hues, contrast-repaired per theme by the host (see §2). Use the `-bg` tints for
fills behind state-colored text.

| Token | Purpose | Stock value |
|---|---|---|
| `--ok` / `--ok-bg` | Healthy, connected, in-range | `#45d483` / `rgba(69, 212, 131, 0.14)` |
| `--warn` / `--warn-bg` | Degraded, near a limit | `#f0b84f` / `rgba(240, 184, 79, 0.14)` |
| `--err` / `--err-bg` | Failed, unreachable, over limit | `#ff6268` / `rgba(255, 98, 104, 0.14)` |
| `--info` / `--info-bg` | Neutral information | `#62cbea` / `rgba(98, 203, 234, 0.14)` |

### Geometry & motion

| Token | Purpose | Value |
|---|---|---|
| `--radius-card` | Cards and nested surfaces | `14px` |
| `--radius-control` | Buttons and inputs | `10px` |
| `--radius-pill` | Pills and badges | `999px` |
| `--space-1` … `--space-5` | Spacing scale | `4 / 8 / 12 / 16 / 24 px` |
| `--dur-fast` | Feedback transitions (press, hover) | `150ms` |
| `--dur-mid` | State transitions | `240ms` |
| `--ease` | The house easing curve | `cubic-bezier(0.2, 0.7, 0.3, 1)` |

### Derived (computed in `widget-base.css`, not pushed)

| Token | Purpose | Formula |
|---|---|---|
| `--panel-alpha-eff` | Effective panel opacity after the `bgStyle` class | `var(--panel-alpha)`, overridden by `body.bg-*` |
| `--panel-border-alpha` | Border strength that tracks panel opacity | `0.06 + eff × 0.10` |
| `--panel-shadow-alpha` | Shadow strength that tracks panel opacity | `0.05 + eff × 0.18` |
| `--card-surface` | Background of nested cards (`.card`, `.pill.muted`) | `rgba(--surface-alt-rgb, max(0, eff − 0.02))` |

**Appearance is single-sourced.** The theme tokens — the global theme plus the per-slot
style override (the 🎨 editor in edit mode / the slot's `style` in `layout.json`, see §2)
— are the *only* appearance system. Do **not** declare manifest `color` properties for
chrome (text, labels, values, accents, backgrounds, state colors): they would duplicate
the tokens, and three overlapping knobs for the same pixel is exactly the confusion the
token system exists to remove. Manifest `color` properties are reserved for **data
colors** — colors that are content, like a per-series line color in a `sensors-factory`
list, where two instances legitimately differ as data. Widgets that used to ship
appearance color properties simply ignore those keys when they linger in old saved
layouts.

---

## 2 · How theming works

The user picks exactly three colors and one opacity — accent, background, text, and
`panelAlpha` — stored as the `theme` object in `layout.json` (`ThemeSpec`; null means
stock dark). `PaletteEngine.Derive` on the host turns those seeds into the full token
palette:

1. **Tone detection.** Dark vs. light is decided by the *derived surface's* luminance
   (`< 0.35` = dark), not by any label — an imported light theme automatically gets
   light-appropriate mixing ratios.
2. **Surfaces** are the background pulled slightly toward the text color (`--surface`,
   `--surface-alt`, `--control-bg` at increasing mix ratios). Mixing toward text lightens
   dark themes and darkens light ones with the same formula.
3. **Text tiers and hairlines** are the text pulled toward the surface: `--text-muted`
   (42%), `--text-dim` (60%), `--line` (78%).
4. **WCAG contrast repair.** Every role is checked against the surfaces it renders on and
   repaired if it fails: `--text` to 7.0:1, `--text-muted` to 4.5:1 (against both
   `--surface` and `--surface-alt`), `--text-dim` to 3.0:1, and the four state hues to
   4.5:1 — on both surfaces *and* on their own 14% tints composited over each, since
   that is what `.pill` and state icons actually render on. Repair binary-searches a mix
   toward black or white — whichever direction helps — so any theme the user invents
   stays legible in every widget. Colors that already pass are untouched.
5. **`--on-accent`** is near-black or white, whichever contrasts more with the accent.

**When it applies.** Theme edits preview live — in the Theme panel's sample tile and in
the settings window's full panel replica — and land on the panel when you hit
**Save & apply**. On the panel itself, the per-widget style editor (the 🎨 button in
edit mode) can re-specify any of the four seeds for a single widget; the palette is
re-derived from the merged seeds (contrast repair included), pushed live via `ww-theme`,
and persisted as the slot's `style`. Every stock widget consumes the tokens — a widget that hardcodes colors is
out of compliance (§10), because it silently ignores the user's theme.

**Delivery.** The token map rides the shell init payload; the shell applies it to its own
`:root` and forwards it to every widget iframe as the `theme` field of the `ww-init`
message. `widget-api.js` applies it to the widget's `:root` *before* `onInit` callbacks
fire, so the first paint is already themed, and stamps `data-appearance="dark|light"` on
`<html>` for appearance-conditional CSS. The map is readable any time as `WW.theme`
(`{'--surface': '#111418', …}`). Today a Save & apply reloads the dashboard, so widgets
see the new theme as a fresh page load; the shim also supports re-delivered `ww-init`
without a reload (the harness uses this, and future live editing will) — handle repeat
inits idempotently: no timer stacking, no state resets. Widgets that use tokens for
everything need **zero code** to be themeable; the CSS custom-property chain does all
the work.

---

## 3 · Transparency system

The dashboard renders a wallpaper behind the pages; the transparency system decides how
much of it shows through each widget tile — coherently, at any level.

- The theme's `panelAlpha` (0.15–1.0, default 0.92) arrives as `--panel-alpha`.
- `body` paints `rgba(var(--surface-rgb), var(--panel-alpha-eff))` — the tile is the
  surface color at the effective opacity.
- Border and shadow strength are *formulas* of the effective opacity
  (`--panel-border-alpha`, `--panel-shadow-alpha`, §1), so edges soften as the tile grows
  more transparent instead of floating at full strength over the wallpaper.
- `--card-surface` — the background of every nested card — follows the same opacity
  (`eff − 0.02`), so wallpaper shows through inner cards exactly as much as through the
  tile itself. Always use `var(--card-surface)` (or the `.card` class) for nested
  surfaces; an opaque `--surface-alt` card on a glass tile looks like a sticker.

### The `bgStyle` facade

Widgets expose the opacity system to users as a **Background** select property
(`bgStyle`) and toggle one class on `<body>`:

| Class | `--panel-alpha-eff` | Meaning |
|---|---|---|
| `body.bg-solid` | `1` | Opaque tile; the wallpaper stops at the widget edge |
| `body.bg-glass` | `var(--panel-alpha)` | Translucent tint at the theme's chosen level |
| `body.bg-transparent` | `0` | No tile at all — content floats directly on the wallpaper; the base adds a text-shadow for legibility |

```js
const bg = (s.bgStyle === 'glass' || s.bgStyle === 'transparent') ? s.bgStyle : 'solid';
document.body.classList.toggle('bg-solid', bg === 'solid');
document.body.classList.toggle('bg-glass', bg === 'glass');
document.body.classList.toggle('bg-transparent', bg === 'transparent');
```

Treat unset and out-of-spec values as `solid` (the stock default). Note the derived
values are re-declared on `body` in the base — the `bg-*` classes land on `<body>`, so
values left only on `:root` would ignore the override; if you re-derive any of them
yourself, do it at `body` scope or below.

---

## 4 · Widget anatomy

A standard widget has five layers. Not every widget needs all five visible at once, but
each one that exists uses the standard classes so widgets read as one family.

1. **Header** — identity, and an exception if there is one: a `.kicker` (uppercase section
   label) on the left, a `.pill` (status badge: default accent, or `.ok` / `.warn` /
   `.err` / `.muted`) on the right.

   **The pill reports exceptions, not health — it is hidden whenever the widget is
   working.** It appears only for something the reader would act on or would otherwise be
   misled by: data that has gone stale, a degraded count, an error, a setup that is not
   finished. A pill reading "Live" or "All up" whenever nothing is wrong is a permanent
   decoration; it says the same thing on every tile forever, so the reader stops seeing
   the one place a widget has to speak up. Absence is the healthy signal, and that is
   what makes an appearance worth a glance.

   This rule replaced an earlier one that specified a `Live` pill in the nominal state.
   A panel of eight tiles all reading LIVE was the result, and it read as noise from
   across the room.
2. **Body** — the data: `.value` (+ `.hero` for the headline number) with its `.unit` on
   the same baseline, `.card` for nested rows and sub-surfaces, `.meter` for compact
   horizontal gauges (`.ok` / `.warn` / `.err` variants recolor the fill).
3. **Footer meta** — provenance and hints in `--text-dim`: last-updated, data source,
   the elevation hint (see the stock CPU widget's PawnIO note).
4. **State layer** — a `.state-card` (or bare `.spinner`) that replaces the body while
   the widget is loading, unconfigured, or broken. See [§5](#5--required-states).
5. **Touch affordances** — `.btn` (and `.btn.primary`) for anything tappable. See
   [§8](#8--touch).

Annotated skeleton:

```html
<body>
  <!-- 1 · Header: what is this + how is it doing -->
  <header class="row">
    <span class="kicker">Network</span>
    <!-- Hidden while healthy; shown only to report stale/degraded/error. -->
    <span class="pill" id="pill" hidden></span>
  </header>

  <!-- 2 · Body: the data -->
  <main id="data" hidden>
    <div>
      <span class="value hero" id="rtt">--</span> <span class="unit">ms</span>
    </div>
    <div class="card">
      <span class="kicker">Packet loss</span>
      <div class="meter ok"><i id="loss" style="width: 3%"></i></div>
    </div>
  </main>

  <!-- 3 · Footer meta: provenance, dim -->
  <footer id="meta" style="color: var(--text-dim)"></footer>

  <!-- 4 · State layer: shown instead of #data while loading / empty / broken -->
  <div class="state-card" id="state">
    <div class="spinner"></div>
  </div>
</body>
```

Toggle between the body and the state layer with the `hidden` attribute — the base ships
`[hidden] { display: none !important; }` so it always wins.

---

## 5 · Required states

**Every widget must implement each state that can occur for it.** A widget that only
handles the happy path shows a frozen skeleton or dead `--` rows on half the machines
it's installed on. Fully-offline widgets have no Stale state; a Retry button belongs
only where retrying can succeed (a network call — not a settings parse error, whose
error state should instead name the setting to fix).

| State | When | Standard rendering |
|---|---|---|
| **Loading** | Between first paint and first data | `.spinner` (centered in a `.state-card`). Freezes automatically under reduced motion. |
| **Empty / setup** | Widget needs configuration (no API key, no sensor picked, no city set) | `.state-card` with `.state-icon`, `.state-title`, `.state-body` explaining *what to do*, plus a `.btn` CTA where an action exists |
| **Error** | Fetch failed, device unreachable, API rejected | `.state-card.err` (the icon recolors to `--err`) with a plain-language `.state-body` and a **Retry** `.btn` |
| **Stale** | Data was fine but stopped updating (source paused, network dropped) | **Keep the last data visible**, dimmed (reduce opacity), and swap the header pill to `.pill.muted` (e.g. "Stale") — old data beats no data on a glanceable panel |
| **Healthy** | Data is current and nothing is degraded | **No pill.** This is the state the reader spends almost all of their time in, so it is the one that must add nothing. Hide the pill rather than filling it with "Live" |

```html
<div class="state-card err">
  <div class="state-icon">!</div>
  <div class="state-title">Bridge unreachable</div>
  <div class="state-body">Couldn't reach the Hue bridge at 192.168.1.12.</div>
  <button class="btn" id="retry">Retry</button>
</div>
```

Related: sensor `value` can be `null` at any tick — always render a placeholder (`--`),
never `NaN` or `undefined`, and degrade to fallback sensors where they exist (the stock
CPU widget falls back from the kernel-driver CPU temp to an ACPI thermal zone).

### Action feedback ("state theater")

**No tap may be a silent no-op.** Every interactive element must answer the finger:

- **Pressed physicality** — interactive tiles that aren't `.btn` get `.pressable`
  (scale + brightness on `:active`; `.btn` already has it). The user should *feel*
  the press even when the action takes a moment.
- **Optimistic flip + reconcile** — toggles that hit a device or API flip the UI
  immediately, then reconcile with the next poll/response; on failure, revert the
  flip **and** fail-flash.
- **`.fail-flash`** — a failed or refused action flashes the element red. Never
  swallow an error into the console while the panel looks like nothing happened.
- **`.confirm-flash`** — an action whose success has no other visible effect (launch
  an app, copy, fire-and-forget) pulses the element with `--ok` once.

Flashes are **restartable**: remove the class, force a reflow, re-add — otherwise a
second failure on the same element shows nothing.

```js
function flash(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;   // restart the animation even mid-run
  el.classList.add(cls);
}
```

Under reduced motion the flash utilities keep their (color-only) animation — feedback
is not motion; in game mode all animation pauses panel-wide, which is acceptable
because the user is in the game, not on the panel.

---

## 6 · Typography

The base sets the family (`"Segoe UI Variable Display", "Segoe UI", system-ui,
sans-serif` — bundle any other font in your package, never assume one is installed) and a
13.5px body size. The component classes carry the scale:

| Role | Class | Size / weight |
|---|---|---|
| Status pill | `.pill` | 10px / 800, uppercase, 0.4px tracking |
| Section label | `.kicker` | 11px / 800, uppercase, 0.5px tracking |
| State body text | `.state-body` | 11px, muted |
| Unit | `.unit` | 13px / 700, muted |
| State title | `.state-title` | 13px / 750 |
| Value | `.value` | 22px / 800 |
| Hero value | `.value.hero` | 30px / 800, −0.02em tracking |

- **`tabular-nums` is mandatory on every live number** (`.value` carries it already; add
  `font-variant-numeric: tabular-nums` to any custom readout, as the stock clock does for
  its time and date). Proportional digits make an updating value jitter horizontally —
  on a panel that is glanced at, that reads as noise.
- Body text never below 12px (~170 PPI panel); the 10–11px tiers are for uppercase
  labels only.
- Size fluidly across slots with `clamp()` / `vh` (see WIDGET-SPEC's slot table); scale
  *from* the standard sizes rather than inventing new ones.

---

## 7 · Motion

- **Animate `transform` and `opacity` only.** They composite without layout or paint
  work — the difference between a widget that sips power for months and one that keeps a
  core warm. The sanctioned exceptions live in the base (`.meter` fill width, 0.35s) and
  in cheap SVG properties like the CPU ring's `stroke-dashoffset`.
- Use the tokens: `--dur-fast` (150ms) for touch feedback, `--dur-mid` (240ms) for state
  transitions, `--ease` for everything. No transition longer than ~600ms — this is a
  glanceable instrument, not a website.
- Data transitions beat data jumps: let CSS transitions smooth the ~2s sensor cadence
  (the meter and ring do this) instead of polling faster.
- **Reduced motion is handled globally**: the base freezes the spinner and zeroes all
  transition/animation durations under `prefers-reduced-motion: reduce`. Don't fight it
  with `!important`, and gate any JS-driven animation (rAF loops, canvas) on
  `matchMedia('(prefers-reduced-motion: reduce)')` yourself.

---

## 8 · Touch

The panel is touch-only: no cursor, no hover, no tooltips.

- **Interactive targets are at least 40×40px** — `.btn` enforces the floor with
  `min-width/min-height: 40px`. For primary controls prefer ~64px (the comfortable size
  at ~170 PPI, per WIDGET-SPEC).
- Every tap gives feedback: `.btn:active` scales to `0.97` over `--dur-fast`. The base
  disables the webkit tap highlight, so custom tappables must provide their own `:active`
  state — a target that does nothing visible on touch feels broken.
- **No hover-only affordances.** If a control or a piece of information only appears on
  `:hover`, it does not exist on this device. Everything important is visible at rest.
- Use real `<button class="btn">` elements — you get focus, `:disabled` (0.45 opacity)
  and the `:focus-visible` accent outline for free.
- Don't fight the shell: page swiping is handled by edge zones; the widget owns the rest
  of its slot for its own touch interactions.

---

## 9 · Performance on a 24/7 panel

Widgets run continuously, unattended, for weeks. The failure modes are silent freezes and
slow burn, not crashes.

- **Loops must not be able to die silently.** An uncaught exception inside a timer
  callback kills a `setTimeout` chain and the widget freezes with stale data on screen —
  this is exactly why `widget-api.js` forwards every uncaught error and unhandled
  rejection to the host's `app.log`. Prefer self-scheduling chains that schedule the next
  tick in a `finally`, so one bad response never stops the loop:

  ```js
  async function tick() {
    try { render(await WW.fetch(url).then(r => r.json())); }
    catch (e) { showStale(); }
    finally { setTimeout(tick, 60_000); }
  }
  ```

- **Pause when hidden.** Browsers throttle timers in hidden documents — the API logs
  every `visibilitychange` transition to `app.log` for exactly this diagnosis ("document
  loaded hidden — timers will be throttled"). Cooperate instead of fighting the
  throttle: skip work while `document.hidden` and refresh immediately on becoming
  visible.
- **Clocks tick at ~1Hz.** A time display never needs rAF; a short `setInterval` (the
  stock clock uses 250ms to keep the seconds flip tight) is the ceiling, and a clock
  without seconds can tick far slower.
- **Never poll faster than the data.** Sensors arrive every ~2s via `onSensors`; media
  on change. Render on delivery, don't add your own faster timer on top.
- **Batch DOM writes.** Build nodes, then append once per update (the stock CPU widget
  clears `#stats` and appends the built rows in one pass); don't interleave reads and
  writes, and don't rebuild what didn't change — write `textContent` on the node that
  holds the number.
- The panel may refresh at ~50Hz — never hardcode a 16.6ms frame budget.
- Bound every network operation: `WW.fetch`/`WW.ping` time out on their own (25s / 12s),
  but retries are yours — back off on failure rather than hammering a dead endpoint all
  night.

---

## 10 · Compliance checklist

Copy this into your widget's PR / release notes and check every line:

```markdown
## WIDGET-STANDARD compliance

### Tokens & theming
- [ ] Links `https://app.wsw/widget-base.css` before widget CSS
- [ ] Zero literal colors in CSS/JS — every color is a `var(--token)`
- [ ] No manifest `color` properties for appearance — chrome comes from the tokens
      (global theme + per-slot style override); `color` properties only for data colors
- [ ] Looks right on a light theme (`data-appearance="light"`) — verified

### Transparency
- [ ] Exposes a `bgStyle` property; toggles `bg-solid` / `bg-glass` / `bg-transparent` on `<body>`
- [ ] Unset/unknown `bgStyle` renders solid
- [ ] Nested surfaces use `.card` / `var(--card-surface)` — no opaque cards on a glass tile

### Anatomy & states
- [ ] Uses the standard classes (`.kicker`, `.pill`, `.value`/`.unit`, `.card`, `.meter`, `.btn`)
- [ ] Loading: `.spinner` until first data
- [ ] Empty/setup: `.state-card` explaining what to do, with a CTA where possible
- [ ] Error: `.state-card.err` with a Retry button
- [ ] Stale: keeps last data visible, dimmed, with `.pill.muted`
- [ ] Healthy: the header pill is **hidden** — it reports exceptions, never "Live"
- [ ] `null` sensor values render a placeholder, with fallback sensors where applicable
- [ ] No silent no-op: actions give pressed feedback, failures `.fail-flash` (with
      optimistic flips reverted), invisible successes `.confirm-flash`

### Typography, motion, touch
- [ ] `tabular-nums` on every live number
- [ ] Body text ≥ 12px; fluid sizing via `clamp()`/`vh` across all supported slots
- [ ] Animates `transform`/`opacity` only, using `--dur-*` / `--ease`
- [ ] JS-driven animation gated on `prefers-reduced-motion`
- [ ] All touch targets ≥ 40px with visible `:active` feedback; nothing hover-only

### 24/7 performance
- [ ] Update loops survive exceptions (self-scheduling with `finally`, or equivalent)
- [ ] Skips work while `document.hidden`; refreshes on visibility
- [ ] No polling faster than the data cadence; clocks ≤ 4 Hz
- [ ] DOM writes batched; unchanged nodes not rebuilt
- [ ] Network retries back off; no unbounded re-fetch loops
```
