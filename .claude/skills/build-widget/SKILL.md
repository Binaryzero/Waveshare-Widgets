---
name: build-widget
description: Build a new Waveshare Widgets dashboard widget to the house standard, or port a Xenon share-code preset into one. Use when asked to create, scaffold, or port a widget for the 1280×400 panel. Covers manifest + index.html authoring, design-token compliance, settings design, validation, and headless verification.
---

# Build a Waveshare widget

You are building a widget for a 1280×400 touch panel that runs 24/7. Every widget is a
folder with `manifest.json` + `index.html`, rendered in a sandboxed iframe, themed by
design tokens the host pushes. Two modes:

- **BUILD** — from an idea or spec ("make a countdown widget").
- **PORT** — from a Xenon share code (a base64url JSON preset the user pastes). See
  [Port mode](#port-mode) — it has a hard licensing rule.

Read these first, in order (they are the authority; this skill is the workflow):

1. `docs/WIDGET-STANDARD.md` — tokens, transparency, anatomy, states, motion, touch,
   performance, compliance checklist.
2. `docs/WIDGET-SPEC.md` — package format, manifest schema, property types, the `WW` API.
3. Reference implementations: `widgets/clock` (simplest), `widgets/cpu` (sensors +
   canvas-free gauges), `widgets/ping` (list-type setting + host data channel),
   `widgets/weather` (external API + location picker + state cards).

## Workflow (BUILD)

1. **Pin down the spec before writing code.**
   - One-sentence purpose → name, description, and the *minimum* data it needs.
   - Data sources: prefer `WW.sensors` / `WW.media` / `WW.getAudio` (host-pushed) over
     polling. External APIs: exact hostnames, no keys embedded — user keys/addresses are
     settings. LAN devices: `WW.fetch(url, {insecure:true})` (private IPs only).
   - Which slots it supports (`quarter` 320px is the hardest — design for it first if
     you claim it), and what the empty / loading / error states say.
   - Settings: every color setting must follow the theme until the user changes it;
     collections are `type: "list"` (never delimited text); finite choices are selects;
     see the property-type rules in WIDGET-SPEC.

2. **Scaffold.** Folder under `widgets/` named after the id tail. Manifest: reverse-DNS
   id, semver `version`, `min_api_version: 1`, honest `supported_slots`, a `bgStyle`
   select (solid/glass/transparent, default solid) unless the widget is inherently
   full-bleed media.

3. **Author `index.html` to the standard.** Non-negotiables:
   - `<link rel="stylesheet" href="https://app.wsw/widget-base.css" />` first in head;
     widget CSS is layout only. Tokens, never literal colors — including canvas/SVG
     (read via `getComputedStyle(document.documentElement).getPropertyValue('--token')`,
     re-read inside `WW.onTheme`).
   - bgStyle mapping with solid fallback, exactly like the stock clock.
   - Per-widget color settings use the changed-vs-default pattern (clock's
     `DEF`/`norm`/`changed`/`setVar` helpers).
   - Standard anatomy classes for equivalent parts: `.card .kicker .value .unit .pill
     .state-card .spinner .meter .btn`.
   - Handle repeated `ww-init` idempotently: no timer stacking, no state resets
     (guard `start()` behind a `started` flag like the gallery).
   - Empty/loading/error are designed states (`.state-card`) that name the fix, never
     a blank tile. Null-guard every value before `toFixed`/math. States apply *where
     they can occur* — offline widgets have no stale state, and a Retry button belongs
     only where retrying can succeed.
   - Text settings that expect a format teach it via the property's `placeholder`,
     never the label. If you need metadata the host doesn't store (e.g. "when was this
     configured"), self-record it in `localStorage` keyed by the setting's value.
   - `textContent` for anything external; no `innerHTML` with fetched data; no
     `eval`; no external `<script src>`; links via `WW.openUrl` if you need one.
   - 24/7 rules: animate transform/opacity only, timers ≥ 1s unless justified, stop
     work when `document.hidden`, tabular-nums for live numbers.

4. **Validate — machine-checkable standards:**
   ```
   node tools/validate-widget.js widgets/<folder>
   ```
   Fix every ERROR (rule ids are stable; the messages say what to change). Warnings
   need a reason if left.

5. **Verify in the harness — behavior:**
   ```
   export CHROMIUM=/opt/pw-browsers/chromium   # or wherever chromium lives
   node tools/widget-harness.js widgets/<folder> --slot half --shot half.png
   node tools/widget-harness.js widgets/<folder> --slot quarter --theme light --shot quarter-light.png
   node tools/widget-harness.js widgets/<folder> --settings '{"bgStyle":"transparent"}'
   ```
   All checks must pass for every slot you claim in `supported_slots`, dark and light —
   plus `three-quarter` if you claim half or full (the editor offers it automatically)
   and at least one `-upper` band size (200px tall). Screenshot the POPULATED state
   (pass settings that give the widget real content), not just the setup state.
   The harness merges manifest defaults under `--settings` exactly like the host, and
   aborts real network calls — your widget must settle into its designed offline
   state, not a blank tile or console errors. Data-path behavior (stubbed API
   responses, stale/retry flows) needs a purpose-built runner: copy the route-fulfill
   pattern from `tools/widget-harness.js` and stub your API's responses. LOOK at the
   screenshots: the harness proves the contract, your eyes prove the design.

6. **Iterate on failures.** Both tools emit `--json` with stable rule/check names —
   fix, re-run, repeat until clean. Then bump nothing else: version stays at `1.0.0`
   for a new widget; ports and edits bump patch/minor per semver.

## Port mode

Input: a Xenon share code — `base64url(JSON)` with `{xenonPreset:1, kind, name, data}`;
`kind:"widget"` carries `{id, files: {name: base64}}` with the widget's own manifest,
HTML, JS inside.

**Licensing rule, non-negotiable: Xenon's source is custom-licensed non-commercial.
Never copy, transplant, adapt, or minify-launder any code, markup, or CSS from the
preset's files into the port.** What you may use from the decoded preset:

- Its *intent*: what the widget displays, which data source it reads, its update cadence.
- Its *configuration surface*: setting names, labels, defaults, ranges — re-expressed
  as our property types (structured `list`s, selects, colors).
- Its *look as configuration*: colors become theme-relatable choices (does this map to
  `--accent`? a state color? a user color setting?), sizes/layout become a fresh design
  in our grid.

Workflow: decode (`node -e` with `Buffer.from(code, 'base64url')` — or, if the user
pastes already-decoded JSON, the per-file payloads are still base64 inside
`data.files`), read the manifest
and files to UNDERSTAND them, write an intent summary (data in → display out →
settings), then close the preset and follow the BUILD workflow from step 1 with that
summary as the spec. Credit the original: the manifest `description` should say
"Inspired by <name> from the Xenon gallery" — inspiration is honest; code reuse is not
allowed. If the original depends on Xenon-only capabilities we lack (their integrations,
ambient engine), say so and either degrade the feature or park the port.

## Packaging & handoff

```powershell
Compress-Archive -Path widgets/<folder>/* -DestinationPath <folder>.zip   # Windows
Rename-Item <folder>.zip <folder>.wswidget
```
```bash
(cd widgets/<folder> && zip -r ../../<folder>.wswidget .)                  # Linux/mac
```

For stock widgets: leave the folder in `widgets/` (the repo is the source of truth) and
update the README stock-widget bullet (both the spelled-out count and the list).
If verification exposed a defect in the tools themselves, fixing the tool is in
bounds — prove the fix against a stock widget, and say so in your report. Always end by reporting: what it shows,
its settings, validator + harness results (all green), and the screenshots.
