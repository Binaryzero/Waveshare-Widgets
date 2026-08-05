# LEDGER — editorial broadsheet

## Thesis

The strip is the front page of a beautifully set newspaper about your machine, recomposed
every second. It borrows print discipline — a real typographic scale, column rules in the
gutters, double rules under section heads, agate figures — and inverts ink-on-paper to
ink-on-slate. There are no cards and no chrome: typography *is* the interface, and the
masthead is the clock.

## The memorable move

The left column is a masthead, not a widget: "The Plinth Ledger" nameplate over a double
rule, then the hours stacked over the minutes in Fraunces Black at 130px, separated by a
short letterpress rule, with the date set beneath as an edition line ("Tue, Aug 5 · Late
Edition"). It is structural — the whole page hangs off that column the way a front page
hangs off its nameplate — and it is the thing you can redraw with your eyes closed.

## Type system

Two faces, strict roles. `font-synthesis: none` everywhere — no faux weights.

| Role | Face | Size / weight | Notes |
|---|---|---|---|
| Masthead numerals | Fraunces 900 | 130px / 0.84 | tabular lining figures, −0.015em |
| Tile hero figures (78°, 42%) | Fraunces 900 | 44–58px | the "headline" of each tile |
| Secondary figures (62°C), day temps | Fraunces 600 | 19–28px | |
| Editorial texture (track title, condition, products, "Standup") | Fraunces italic 400 | 13–29px | the only italic; never for data |
| Nameplate | Fraunces 600 roman | 21px | italic 600 would be synthesized, so roman |
| Section heads (WEATHER, PROCESSOR, NOW PLAYING, ADVISORIES) | Archivo 600 | 11px, +0.22em, uppercase | small-caps furniture |
| Data & labels (times, H/L, CVE ids, due dates) | Archivo 500–700 | 11–15px | always `font-variant-numeric: tabular-nums lining-nums` |
| Agate (core %, table headers, LOAD/TEMP) | Archivo 500 | 9px, +0.14em, uppercase | the stock-listings register |

Hierarchy is size + face, never color variety: eye lands masthead → 78° → Midnight City
because those are the three biggest serif settings on the page.

## Spacing & grid

- Sheet: 1280×400, 8px outer margin, 8px gutters. Columns 316 / 316 / 616; rows 188 / 188;
  clock spans both rows. All internal spacing on a 4px step (padding 12–16, gaps 4/8).
- Rules are the layout: 1px hairlines (`rgba(ink, .22)`) run *in the gutters* as
  freestanding column/section rules — they are not borders on boxes, and there are no
  boxes. Every section head carries the same double rule (2px over 1px, 2px gap) at
  ~82% ink. Baseline rules under the core sparkbars and above the three-day strip
  complete the furniture.
- Tables set like tables: KEV is a three-column grid (158 / fluid / 96) with hanging
  tabular figures, the due column set right, hairlines between rows.

## Color roles

One paper, one ink, one spot color. That is the entire palette.

| Role | Value | Use |
|---|---|---|
| Paper | `#191613` → `#13110d` radial | the slate ground (its own backdrop; faint SVG grain at 5%) |
| Ink | `#e9e3d3` | all primary type, rules, bars, the pause block. Never pure white — this runs 24/7 |
| Ink muted | `#a89f8c` | secondary text, italic texture |
| Agate | `#6f6757` | 9px furniture, table headers |
| Spot (vermillion) | `#e65f2e` | **urgency only**: the Aug 9 due date (◆), the playing marker, the progress elapsed. Nothing else, ever |

Icons are inline SVG in currentColor; the play/pause block is inverted (solid ink, paper
glyph) like a print block. Controls are 46px squares — over the 44px touch minimum, zero
radius like everything else.

## What adopting this means

Honestly: Ledger keeps the *token contract* but rejects most of the current *values and
anatomy*. Mapping:

- `--accent` → the spot color. Survives re-seeding by role, not by value: user picks any
  accent seed and it is used **only** for urgent/live semantics (due-soon, playing,
  breach). The design reads correctly with a teal or gold spot; what it cannot survive is
  accent-as-decoration, so `.pill`/accent-tinted backgrounds (`rgba(--accent-rgb, .14)`)
  go away.
- `--surface-rgb` / `--panel-alpha` / bg-solid–glass–transparent → the sheet ground.
  bg-solid is the native mode (the paper *is* the wallpaper). bg-glass/transparent still
  work mechanically — rules and type float fine over a wallpaper — but the grain and
  vignette belong to the sheet, so glass demotes them. The tri-state survives; the idea
  of five separate translucent panels does not: one sheet, rules in gutters.
- `--card-surface` → largely retired. Ledger's nested structure is rules, not sub-cards.
  Keep the variable for third-party widgets; stock widgets stop using `.card`.
- `--text` / `--muted` → ink / ink-muted, derived from the user's text seed but clamped
  warm-ish and off-white (a #fff seed renders as ~#e9e3d3-equivalent lightness) for
  burn-in and eye comfort. Add one token: `--text-agate` (dim tier).
- `widget-base.css` changes: swap the font stack (Fraunces + Archivo shipped as panel
  assets); `--radius-card/control` → 0 (zero-radius is load-bearing); add `.sec`,
  `.rule2`, `.agate`, `.hairline` as standard anatomy; retire `.pill` in favor of
  spot-colored text markers; `.meter` becomes the 2px rule-with-spot-fill; `.btn`
  becomes the square bordered block. Status colors (`--ok/warn/err`) collapse toward the
  single spot for "needs attention" plus ink for everything else — the biggest
  philosophical change, and the one worth debating.

User-themeable: paper seed (background), ink seed (text), accent seed (spot). Everything
else — scale, rules, faces, spacing — is the design, not the theme.
