# LUME — ambient luminous glass

## Thesis

The strip is not a dashboard; it is a piece of light furniture that happens to know things.
One dark atmosphere, five frosted panes, and behind each pane a real light source whose bloom
refracts through the glass and leaks past the tile edges — so the panel reads as a single
backlit object, calm and expensive, not a grid of cards. Hierarchy is done with light, not
with boxes: in every tile the one number that matters is the brightest emitter.

**The memorable move (structural):** every tile is *backlit*. A colored light source sits in the
scene behind the glass, directly under that tile's hero value — cyan behind the clock, ember
behind the sun, teal behind the core gauge, lavender behind the album art. Because the panes use
`backdrop-filter`, the glass genuinely refracts its own backlight, and the bloom halos out into
the gutters. Eyes closed, the owner remembers: *the tiles glow from inside.*

## Type system

One family — **Outfit** — weight does all the work. No second face, no italics.

| Role | Size | Weight | Treatment |
|---|---|---|---|
| Hero numerals (14/37, 78°, 42%) | 150 / 58 / 54px | 300 | brightest ink (`--ice`), soft glow `text-shadow` in the tile's backlight hue; heroes only |
| Tile titles (song title) | 27px | 500 | bright, faint glow |
| Secondary values (H/L, temps, due dates, 62°C) | 13–19px | 400–500 | `--ice-dim` |
| Labels / captions (condition, artist, product) | 13–15px | 400 | `--ice-faint` |
| Kickers (CPU LOAD, CISA KEV, WED/THU/FRI, date) | 11–19px | 500 | uppercase, `.14–.22em` tracking, `--ice-ghost`/`--ice-faint` |
| All numerals | — | — | `font-variant-numeric: tabular-nums` globally |

Light replaces weight at the top of the hierarchy: heroes are *thin* (300) but *bright and
glowing*, which is what makes the panel feel lit rather than printed. Down the hierarchy,
weight goes up slightly (500) while brightness drops — small text stays crisp without shouting.

## Spacing & grid

- 1280×400, 8px outer margin, 8px gutters. Grid: `312px | 312px | 1fr(624px)`, two 184px rows,
  clock spans both.
- Pane radius 22px throughout. Inner padding 20–34px — generous; negative space is part of the
  luminous look. Tiles have almost no internal rules: the only hairlines are 1px
  `rgba(255,255,255,.05–.06)` separators (KEV rows, forecast dividers), used exactly twice.
- Glass recipe (one recipe, five uses): near-transparent white gradient fill (`.018–.06` alpha),
  `backdrop-filter: blur(26px) saturate(150%)`, 1px inner top light edge
  (`inset 0 1px 0 rgba(255,255,255,.13)`), soft ambient drop shadow, top-left gleam overlay.
- Touch: media buttons are 46px, play is 58px — all ≥ 44px hit size.

## Color roles

| Role | Value | Used for |
|---|---|---|
| Void | `#04070f` | base atmosphere |
| Ice | `#eaf6ff` (never pure white) | hero ink only |
| Ice-dim / faint / ghost | white-blue at .68 / .42 / .24 alpha | value → label → kicker ladder |
| Cyan `122,206,255` | key light | clock backlight, progress, live dots, play button |
| Lavender `158,138,255` | fill light | media backlight, art nebula |
| Teal `98,228,190` | gauge light | core bars + CPU backlight |
| **Ember `255,168,92`** | the one warm counterpoint | the sun orb, and the *soonest* KEV due date — warmth = attention |

Progress and gauges are drawn as light: a barely-there track, a luminous fill, a glowing head.
Imagery is luminous CSS (sun orb with a frosted-veil cloud; album art as a nebula-and-light-trails
gradient) — no icons, no emoji.

24/7 notes: no pure-white fields anywhere; the largest bright area is thin-stroke type at ~92%
white. All animation (aurora drift, breathing clock glow, pulsing play, EQ ticks) is low-alpha
ambience; the composition is complete at first paint.

## What adopting this means

Mapping onto the existing token system:

- **`--accent` / `--accent-rgb`** → becomes the *key light* (cyan here). It drives hero glows,
  live dots, progress fill/head, and the play button — i.e. `text-shadow`/`box-shadow` recipes
  keyed off `rgba(var(--accent-rgb), α)`. Nothing about LUME hard-codes cyan; re-seed the accent
  and every glow follows. The lavender/teal companions should be *derived* (e.g.
  `--accent-2`, `--accent-3` computed as hue rotations at theme time, or seeded alongside the
  accent), and **`--warm`** (`--warm-rgb`) is one genuinely new token — the counterpoint used
  only for the sun and nearest deadline.
- **`--surface-rgb` + `--panel-alpha` + bg tri-state** → the pane recipe replaces the current
  flat `rgba(var(--surface-rgb), --panel-alpha-eff)` fill with a low-alpha white gradient over
  `backdrop-filter`. The tri-state still works and gets *better*: `bg-glass` is the native LUME
  state; `bg-solid` composites the same pane color over the void (no backdrop-filter, for GPU-shy
  setups); `bg-transparent` drops the fill and keeps only the inner light edge. `--panel-alpha`
  becomes "frost density" (fill alpha + blur radius scale) rather than opacity.
- **`--text` / `--text-muted` (+ `--text-dim`)** → map directly onto ice / ice-faint / ice-ghost,
  but LUME needs one extra rung: **`--text-hero`** (the brightest ink, glow-bearing). Today's
  widgets put `--text` on everything; LUME's whole point is that only one element per tile gets
  the top rung.
- **`--card-surface`** → largely retired inside tiles. LUME has almost no nested cards; where the
  current CSS reaches for `--card-surface` (chips, pills), LUME uses the accent-tinted light chip
  (`rgba(accent,.12)` + glow dot), which the existing `.pill` already approximates.

Changes required in `widget-base.css`: (1) the pane recipe (gradient fill, backdrop-filter,
inner edge, gleam) replaces the flat panel background; (2) a `--glow()`-style set of shadow
recipes (`--glow-text-hero`, `--glow-dot`, `--glow-bar`) so widgets never hand-roll shadows;
(3) new tokens `--text-hero`, `--warm-rgb`, `--accent-2/3`; (4) the *wallpaper becomes the
shell's job* — aurora blobs + per-slot backlight are rendered by the shell behind the widget
iframes (widgets can't paint outside their own tile), with each widget's manifest declaring a
backlight hue/anchor. That last item is the real architectural cost of this direction — and
also the thing that makes it a system rather than a skin.

User theming survives: the user seeds accent, background (void hue), and text; LUME consumes
them as *light temperature* rather than paint. A red accent yields a crimson-lit instrument; a
green one, an aurora. The geometry, glass, and hierarchy-by-brightness are the design; the
palette is genuinely the user's.
