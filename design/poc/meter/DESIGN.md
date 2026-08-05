# METER — precision instrument / avionics cluster

## Thesis

The strip is an instrument, not a webpage. One machined plate, near-black, divided into
numbered regions by hairline rules — no cards, no shadows, no rounded boxes floating on a
wallpaper. Structure is drawn in gray; color appears only where it carries information: one
phosphor for live values, one amber for alerts, and nothing else.

**The memorable move — one grammar, five rulers.** Every quantity on the panel lives on the
same machined scale: a hairline rail with minor ticks, labeled min/max majors, a phosphor
fill for the value and a hollow diamond for events. The clock's ruler is the day (00–24h,
filled to 14:37, diamond at the 15:00 standup); weather's is the ambient range (60–90°F with
L/H brackets); CPU's is the load gauge; media's is the track timeline; KEV's is the
remediation window (Aug 05 → Aug 19 with due-date diamonds and a "now" cursor). Close your
eyes and you remember it: *everything was a ruler.* It is structural — the same component,
the same anatomy, five different axes — not a decoration.

## Type system

Two faces, six files, no synthetic weights:

| Role | Face | Size / weight | Treatment |
|---|---|---|---|
| Master numeral (time) | Rajdhani 700 | 118px, lh 0.92 | tabular-nums, phosphor colon |
| Primary values (78°, 42%, track title) | Rajdhani 600 | 31–58px | tabular-nums |
| Secondary values (62°C, day temps) | Rajdhani 500–600 | 19–27px | tabular-nums |
| Region headers (`01 CHRONO`) | IBM Plex Mono 600 | 9.5px, ls .24em | uppercase, index dimmed |
| Data rows (CVE, dates, times) | IBM Plex Mono 400–500 | 11–13px | tabular-nums, uppercase via CSS |
| Micro-labels (LOAD, TEMP, NEXT) | IBM Plex Mono 600 | 8.5–9.5px, ls .2–.26em | uppercase |
| Axis labels (00/06/12/18/24) | IBM Plex Mono 500 | 8px, ls .12em | structure color, never data color |

Rule of thumb: **Rajdhani states, Plex Mono annotates.** Every number is either a display
numeral (Rajdhani) or data (mono); nothing numeric is ever set in a UI sans.

## Spacing / grid

- 1280×400; 8px bezel margin; plate = 1264×384. Columns 316 / 316 / 616, rows 188 / 188,
  8px gutters (sums exactly).
- Tiles are **regions, not cards**: 1px hairline rules drawn down the centers of the gutters,
  a 1px frame with 15px corner brackets, and 5px registration ticks where rules meet the frame.
- Tile padding 12–16px. Inside a region: header band at top, ruler at the bottom edge
  (`margin-top:auto`), value block between. The ruler baseline is the same distance from the
  region's bottom edge in all five tiles — the panel has a shared datum.
- One radius: 2px (art frame, buttons). Everything else is square. Media buttons are 46×46
  (≥44px touch).

## Color roles

| Role | Value | Used for |
|---|---|---|
| Bezel | `#040606` | outside the plate |
| Field | `#0a0f0d` (vignetted) | the plate itself + faint 26px dot grid |
| Structure | `rgba(151,180,168, .09/.17/.38)` | rules, ticks, brackets — three alphas, one hue |
| Text | `#dde6e0` | primary readouts (never pure white — burn-in and glare) |
| Muted / Dim | `#8da096` / `#57645d` | annotations / axis labels |
| **Phosphor** `--phos` | `#4de8a4` | *information that is live*: fills, cursors, elapsed time, playing dot, added-count |
| **Amber** `--amber` | `#ffae52` | *information that needs action*: core ≥70%, KEV due ≤5 days |

Discipline: gray builds the machine, phosphor is the signal, amber is the warning. No
gradients as decoration; the only glow is a small text/box shadow on phosphor elements,
plus a 3px-pitch scanline + corner vignette overlay at ≤9% opacity for the CRT read.

## What adopting this means

Honest mapping onto the existing token system:

- **`--accent` → `--phos`.** Direct rename-level mapping; the user's accent seed *is* the
  phosphor. The design survives re-seeding because phosphor is only ever used at full value
  on hairline-thin elements (fills, cursors, 5px dots) — an ugly accent stays a thin line.
  Amber is a **new token** (`--alert`) that widget-base.css must add and derive a fallback
  for (rotate accent hue toward 40° if the user doesn't set one).
- **`--surface-rgb` → field.** The seed still works, but METER wants a vignetted plate
  rendered by the *shell*, not per-tile backgrounds. The `bg-solid / bg-glass /
  bg-transparent` tri-state collapses: every tile effectively runs `bg-transparent`, and
  `--panel-alpha` stops meaning "card opacity" and becomes plate opacity (glass over a
  user wallpaper still works — the rules and scanlines just draw over it).
- **`--card-surface` is retired.** The biggest real change. Rows, pills and state-cards in
  widget-base.css currently lean on filled rounded rectangles; METER replaces them with
  hairline rules (`--line`, three alphas derived from text color, replacing
  `--panel-border-alpha`). `--radius-*` tokens drop to a single 2px.
- **`--text` / `--muted`** map cleanly (`--text-dim` → axis color). Add `--line` (derived
  from text at 3 alphas) and the ruler as a shared base-css component (`.scale` with
  `--pitch`), since it is the system's signature and every widget will need it.
- **Type tokens change.** Base css must ship Rajdhani + Plex Mono and expose
  `--font-display` / `--font-data`; the current single-family stack can remain as a
  user-overridable seed for `--font-display`, but data/labels should stay mono — that part
  is the design, not a preference.

**What stays user-themeable:** background seed (plate hue), text seed, accent seed
(phosphor), optional alert seed, wallpaper behind a glass plate, and panel opacity. What is
*not* themeable is the structure: hairlines instead of cards, mono for data, rulers at the
bottom datum. That trade — fewer knobs, one voice — is the point of this direction.
