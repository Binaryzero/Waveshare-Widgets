# Headless probe harness

Self-contained Playwright suites that boot the real shell (`src/Plinth/Shell`)
in a headless Chromium with a scripted host bridge, and assert end-to-end behavior
through the actual message envelopes. Each suite starts every server it needs
(static file serving plus scenario-specific counting/CORS/bot-wall origins) and
exits non-zero on any failing probe.

## Running

```
npm i playwright        # anywhere; only the library is needed
node tests/harness/icuefetch-run.js
```

If Chromium lives outside Playwright's default cache (e.g. a preinstalled build),
point at it explicitly:

```
CHROMIUM=/opt/pw-browsers/chromium node tests/harness/icuefetch-run.js
```

## Shared

- `contrast.js` — not a suite. `textContrast(locator)` returns the WCAG ratio of an
  element's text against what is *actually painted* behind it, compositing translucent
  ancestors the way a browser does. It exists because #215's review found the same
  defect on both surfaces and no harness could see it either time: `help` became a
  required field on every secret and both editors painted it in a token neither document
  defines, so the CSS fallback was the real colour — 3.14:1 and 3.40:1, under the 4.5:1
  floor for 11px text, while every structural check on those elements passed. Used by
  `secretfield-run.js` (E35d) and `panelsecret-run.js` (N13e).

## Suites

- `secretfield-run.js` — the settings-editor half of the `secret` property contract
  (issue #15): a credential renders masked, a stored one reads as
  "saved · encrypted (hidden)" with no value in the DOM, typing/clearing say what the
  next save will do, the saved layout carries the explicit clear marker for a cleared
  secret (an empty string means "keep it"), and a save the host could not protect
  warns instead of reading as success. The encryption pipeline itself is guarded in
  CI by `dotnet run --project tools/SecretRoundTrip`. Port used: 8951.
- `panelsecret-run.js` — the ON-PANEL half of the same contract. The dashboard is
  handed decrypted values, so the field really holds the credential and "the user
  emptied it" is ambiguous unless the shell says which it meant: both the ✕ Clear and
  hand-deleting the characters must reach the host as a removal, while a never-set
  secret still sends `""`. Also covers the failed-protection banner, which is the
  panel's only way to contradict its own optimistic re-render, and (N13f, #217) pushes a
  floor-tuned CUSTOM palette through the same measurement — the case N13e's default theme
  could not exercise. Port used: 8952.
- `palettecontrast-run.js` — issue #217: muted text must stay legible on the GLASS
  settings sheets, not only on the opaque surface. `#propSheet` / `#stylePanel` paint
  `--surface` at 94% over the wallpaper, so `--text-muted` renders over surface
  COMPOSITED with whatever is behind the glass — and a role tuned to 4.5:1 on the opaque
  surface drops below it over a bright (or dark) wallpaper. Drives `WWPalette.derive`
  over a theme battery and asserts muted clears 4.5:1 against `--surface` composited over
  both pure white and pure black at the sheet alpha (the bracket the rendered page cannot
  fall outside). Pure Node — no browser, no port. Fails against the pre-fix engine, which
  repaired muted against the opaque surface only.
- `restvalue-run.js` — the REST Value widget's data path (issue #16), which the widget
  harness cannot reach because it aborts every network call. Drives the real widget
  against a rescriptable fixture endpoint: JSON Pointer and dotted-path resolution,
  threshold colouring in both directions, non-2xx / unreachable / non-JSON / null /
  pointer-miss states, the Stale path (a failure after a good read keeps the number),
  no stacked pollers across repeated inits, and that a configured auth header reaches
  the request while appearing nowhere in the DOM. Also writes the populated
  `restvalue-*.png` screenshots. Routes are fulfilled in-process — no ports.
- `nextfetch-run.js` — three scheduling/rendering follow-ups on the Next Event widget
  (issue #180). All three are timing bugs the real-time probes on that PR could not place
  inside a fix window minutes wide, so this drives the widget under Playwright's fake clock
  (`page.clock`): the refresh timer, the 1 Hz repaint, and `Date.now()` all advance on
  command, so the moment a scheduled fetch has to land is set exactly rather than guessed.
  N1 changes the calendar while the panel is paused and asserts the resume path fetches the
  NEW one at once rather than re-arming the old calendar's deadline (`dueAt` was not reset on
  a source change). N2 fails a refresh on an empty-but-valid calendar and asserts the error
  card and its Retry survive the 1 Hz repaint instead of being overwritten by "Nothing
  scheduled", then that a good refresh clears it back (so the guard is not sticky). N3
  reproduces the review's own example — a success, a later failure, then a cadence edit — and
  asserts the edit does NOT fire an immediate fetch, because the backoff anchors on the last
  ATTEMPT, not the last success. Each of N1b/N2b/N3b fails against the pre-fix widget, which
  the file notes is the check that keeps the suite from passing hollow.
- `widgetfit-run.js` — that widget text fits the SLOT rather than one axis of it
  (issue #76). A widget's iframe is sized to its slot, so `vh`/`vw` do measure the
  tile — but a rule written against one axis says nothing about the other, and the
  clock's `34vh` asked for 136px glyphs across a 320px quarter, clipping a digit off
  each end. Drives the real clock at every slot geometry including the half-height
  bands, with the longest and shortest strings its own settings can produce (12-hour
  plus seconds versus 24-hour without), and checks the opposite failure too: text
  that fits by being tiny is not a fit. Also covers re-fitting when the slot resizes
  with no settings change, and that the size sliders can only shrink. Routes are
  fulfilled in-process — no ports.
- `bridgeorigin-run.js` — sender authorization on the widget bridge. `postMessage`
  reaches `window.top` from ANY descendant, so a page framed INSIDE a widget could
  drive the native host: `ww-action` reaching `Process.Start`, `ww-fetch` used as an
  SSRF hop with the reply routed back to the sender, plus hotkeys, audio and Stream
  Deck. Reachable through stock widgets — `twitch` and `youtube` frame third-party
  origins and `iframe` frames whatever URL the user types, so "the remote page turns
  hostile" is the entire prerequisite. Mounts a widget that frames a remote document
  and has that document attack `window.top`: the legitimate widget frame must still
  reach the host (a fix that silences everyone would pass every other check here), the
  nested frame's messages must not, and the routing tables must not be armed for a
  refused sender. Then the other half of the same boundary, which frame identity alone
  does not cover: a slot frame that NAVIGATES away keeps its WindowProxy, so it still
  looks like the registered widget while being someone else — it must not drive the
  host, must not be answered with the widget's settings, and must not receive the
  broadcasts still aimed at that slot (a second, untouched widget proves the broadcast
  really happened). The shim is injected into every document too, so a nested page runs
  it: its uncaught errors must not be reported to the widget framing it, while a real
  widget's own errors must still reach the host log, including one raised before init —
  held until the shell answers, not dropped. Ports used: 8956.
- `routing-run.js` — demand-scoped delivery: a widget receives what it ASKED for, not
  what the panel got. Three host channels answered every initialized widget rather than
  the subscriber — mirrored Windows toasts (app name, title, body), the Stream Deck's
  configured keys, and a live screenshot of those keys — so a widget needed no
  notification code at all to read the user's notifications, and none at all to watch
  their Stream Deck. Every probe asserts BOTH halves, a subscriber that still receives
  and a bystander that does not, because "nobody received it" is what a broken delivery
  path looks like too. Also covers the second delivery path (a re-init used to carry the
  latest payload to whoever reloaded), that dismissal is scoped to ids the slot was
  actually shown, and that unsubscribing really stops delivery. Port used: 8957.

  R12 adds the demand GENERATION (#132). Every earlier check asks whether anyone is
  watching; R12 asks whether the payload was made for the watching happening now, which
  comes apart in one message-queue hop. It is staged by posting with an explicitly old
  generation, because that is the only thing about the queued payload that differs — same
  shape, same data — so no check that inspects the payload could separate them. R12b
  guards the direction that matters more: a staleness check that refuses *everything*
  passes R12 perfectly.

  Note the split with `tools/PushGeneration`: this harness fakes the host, so it drives
  the shell's CHECKING while only imitating the host's STAMPING. Delete the stamp from
  `PostToShell` and every probe here still passes — verified by mutation. That half is
  covered by the C# probe, which also runs in CI, where this one does not.
- `deckpreview-run.js` — the settings LIVE PREVIEW, which nothing else here reaches
  (issue #78, the third time the Control Deck has come back empty after #43 and #49).
  Every other suite drives the shell directly with a stubbed `chrome.webview`; the
  preview replica is a second shell instance inside an iframe of the settings page,
  relaying over `window.parent.postMessage`. This one boots the real `settings.html`,
  lets it drive the real replica, and serves each widget from its own virtual host —
  cross-origin to the shell, as the WebView2 mapping does — so a widget that fails
  only in the preview is visible. The deck is the probe subject because it paints
  ONLY from `ww-init`: the clock paints on a 250 ms timer regardless, so a preview
  full of clock says nothing about whether delivery works. Covers every supported
  size with and without a persisted `instanceId`, and pins the waiting stamp
  (`html[data-ww-waiting]` → "waiting for panel data…"), which is the only thing
  keeping a delivery failure from presenting as a blank tile. Port used: 8954.
- `icuefetch-run.js` — the fetch-escalation contract shared by `widget-api.js`
  (`WW.fetch`) and the iCUE compat shim (issue #37): headers of every
  `HeadersInit` shape surviving the proxy hop (repeats combining like native
  `Headers`, Content-Type on the dedicated field), binary body integrity,
  proxy-first session memoization with its replayability and abort guards,
  auth-shaped proxy answers retrying the native path, and `Request`-object
  inputs keeping their method/headers. Ports used: 8931-8934 (scenario
  origins), 8941 (shell), 8942 (fixtures).
- `bodycap-run.js` — the 5 MiB body ceiling (issues #106/#117), on plain Node so it
  runs in CI beside the C# probes. It drives the in-page script `FetchLimits`
  generates AND the `WW.fetch` wrapper, lifted out of `widget-api.js` by marker so
  the probe cannot diverge from what ships. The witness is the SERVER's outcome
  (`aborted` vs `completed`), because a cap that refuses only after reading
  everything looks identical from the client. Two properties are deliberately NOT
  checked here — that the wrapper survives the Web IDL brand check, and that its
  body takes a BYOB reader — because Node disagrees with Chromium on both and
  probes here would pass for the bug; they live in `restvalue-run.js` (R24/R25).
  Port used: 8961.
- `redditcap-run.js` — Reddit Photos' OWN ceilings (issue #116), which sit far below
  the shared one because the panel is 1280x400 and the paths that run to megabytes
  are the ones the widget least wants. The oversized fixture is sized deliberately
  BETWEEN the two ceilings, so only the widget's own number can refuse it — at
  5 MiB the probe would prove nothing the shared cap does not already. Also that a
  refusal skips the post rather than breaking the tile, and that "too large" and
  "could not load" stay distinguishable in both directions. Serves real decodable
  PNGs padded to exact byte counts, since the widget rejects anything that does not
  decode and a buffer of zeroes would fail for the wrong reason.
- `huemode-run.js` — the Hue tile's API-generation choice (issue #112). v1 is plain http
  and carries the bridge `username` in the path, and on this bridge that username IS the
  CLIP v2 application key — so any route from v2 to v1 discloses it. Both routes were
  openable by a `TypeError`, which is what interfering with TLS produces. The witness is
  the REQUEST LOG rather than the render: what matters is which URLs the tile was willing
  to send the key to. Covers both demotion routes separately (H6 isolates the probe, H7
  the polling path — H2-H4 cannot tell them apart, because a probe that demotes never
  lets polling reach v2) and, in the other direction, that a genuinely v1-only bridge
  still works. Bridge traffic is proxy-only, so the fixture answers `ww-fetch` messages
  rather than routing network requests.
- `securepreview-run.js` — the protected store as reached from the SETTINGS PREVIEW
  (issue #175). The preview is a real `shell.js?preview` hosting real widget iframes, and
  it must never touch a live credential — but the shell still forwarded `secure-*` up to
  `settings.js`, which relays only fetch / ping / media-list / audio-get and drops the
  rest with no reply. The request vanished and settled only when `secureCall`'s
  ten-second timeout fired, so an OAuth widget that awaits `secureGet` before its first
  paint sat blank for ten seconds on every preview reload, on the surface the user edits
  in. Answering in the shell is the fix, and every check here needs its other half:
  "nothing was posted to the host" is also what a branch that never runs looks like, so
  the same widget code is driven a second time in a real panel shell, where the call must
  reach the host carrying the widget id the SHELL stamped. The parent models the settings
  relay by DROPPING everything outside that allow-list — a friendlier stand-in would hide
  the whole defect — and a fetch is pushed through first to prove the relay works at all.
  The timings are the witness: 10001 ms before, single-digit ms after. Port used: 8964.
- `appearance-run.js` — the appearance properties the SHELL owns. `bgStyle` was declared in
  all 31 stock manifests and applied by hand in all 31 widget scripts; the panel supplies it
  now (`Shell/appearance.js` splices the declaration into every widget's property list, and
  `widget-api.js` applies the class inside the frame). The failure this guards is silent:
  both settings editors render whatever is in `widget.properties`, so if normalisation ever
  stops running nothing throws — the Background control just disappears from every widget
  and every tile quietly renders solid. Loads the real module with `vm` rather than
  transcribing it, so a change to the shipped file cannot leave these assertions green. A3
  is the one with teeth: a widget that declares its OWN `bgStyle` — a third-party package or
  an iCUE port with different options — must have it dropped rather than merged, or there
  are two definitions of one setting and no way to know which a tile obeys. A5 mutates one
  widget's returned declaration and checks the next widget's is unaffected, because the
  editors write to what they are handed and a shared options array would let one tile's edit
  rewrite every other tile's. A6 reads the SHIPPED manifests rather than a fixture, which is
  what would have caught this change going in half-done. No browser needed.
- `kevretry-run.js` — pressing Retry while the panel is hidden (issue #164). Polling is
  suspended for a hidden document because the tile parses a multi-megabyte catalog, and
  Retry did not account for it: it painted a spinner and called the poll, which returned
  through the gate without recording that a retry had been asked for, so the tile could
  spin for a day at the maximum interval while the deadline it was waiting on stayed an
  untouched interval from the last attempt. Drives the real sequence — the feed fails, the
  panel goes away, Retry is pressed, the panel comes back — and counts feed REQUESTS
  rather than reading what was drawn. `document.hidden` and `visibilityState` are backed by
  a flag installed in every frame, because Playwright cannot hide a frame on demand; the
  flag is flipped before the event, which is the order a browser uses and the order the
  widget's handler depends on. Half its checks must fail before the fix and pass after; the
  other half must pass in BOTH, and those are the load-bearing ones: the plain visible
  Retry still fetches at once, the gate still refuses while the panel is hidden, and a
  panel returning with nothing pending still does not poll early. Without that last one,
  "the retry runs when the panel comes back" would be satisfied just as well by deleting
  the gate. The loading assertion holds the stubbed request open, because a refused fetch
  resolves in microseconds and the in-flight state is gone before it can be observed. No
  static server — every origin is route-fulfilled.
- `hueconnect-run.js` — a late bridge discovery must not redirect the credential. `connect()`
  runs concurrently with itself: a settings change starts a second one while the first is
  still in the cloud round trip at discovery.meethue.com, and `v1api`/`v2fetch` interpolate
  `cfg.ip` at REQUEST time rather than at connect time — so a discovery that wrote the
  widget-global `cfg.ip` before the generation check silently redirected the connection that
  had already validated the configured bridge and loaded its application key. The witness is
  the ww-fetch LOG, not page requests: hue speaks to its bridge exclusively through the host
  proxy, so none of its traffic is a page request at all, and every request is recorded
  before it is answered — an address the widget should never have spoken to still has to
  show up. J5 is what keeps J3 honest: "never spoke to the wrong bridge" is also true of a
  widget that stopped talking to anything. Extracted from the deleted `gameresume-run.js`,
  where it lived because the pause gates sat beside the generation check; the scenario
  itself never involved one.
- `touchpan-run.js` — a tap on a widget control paged the panel instead of acting
  (issue #206). The report points at a scrollbar next to the notifications eye; there is
  none — `#list` hides its scrollbar and the eye sits in `<header>`, outside the list. What
  is actually next to it is the **shell**: `#pages` is a horizontal `scroll-snap` container,
  widget documents are `overflow: hidden`, and `touch-action` intersects up the ancestor
  chain across the iframe boundary — so a gesture on a control with nothing local to pan was
  handed to the panel's pager, and a finger drifting a few pixels on the way to a tap changed
  page. `widget-base.css` declared no `touch-action` at all and five widgets had each patched
  it locally, which is what a missing shared rule looks like from outside. Runs with
  `hasTouch: true` (without it every gesture is a mouse drag, which `touch-action` does not
  govern, and the whole file would pass regardless) and dispatches real touch drags over CDP,
  because Playwright's touchscreen only taps and it is the *drag* that turns a tap into a pan.
  Against the unfixed build T3 reports `pages scrollLeft 0 -> 628` — a full page stolen by a
  tap. T2 drags inside the list and T4 taps the control, so the fix cannot be bought by
  forbidding panning everywhere or by killing the button. T5-T7 are the review's doing and
  are the interesting half: a third-party document's own scroller, cross-origin content in a
  nested iframe, and a drag starting *on a control inside* a list. All three were predicted
  to break under a document-wide `touch-action: none` and none of them does — the
  intersection stops at the nearest scrolling ancestor, so the rule never reaches a region
  that scrolls. They are kept because that is the invariant worth pinning, and because T3
  responding to the CSS while T5-T7 do not is what shows the gesture pipeline is really
  evaluating `touch-action` rather than the harness measuring nothing.
- `edgerail-run.js` — proof that the #206 edge-reservation audit (`auditEdgeReservation` in
  `tools/tap-audit.js`) discriminates, so its all-clear across the sweep means something.
  `touchpan-run.js` proves the *shell* behaves and pins a hand-list of the controls known to
  sit near a screen edge; this proves the *general tool* that now guards every widget in
  `tools/widget-harness.js` (offline states) and `tools/widget-datapath.js` (populated states).
  The `.edge` swipe strips are fixed overlays *above* the iframes that page on a tap, so a
  control whose box pokes into the outer 8px rail is unreachable in an edge column no matter how
  its `touch-action` is set — the geometric twin of the pan-chaining #221 catches. A synthetic
  widget mounts controls flush to each inline edge by *every* route a control becomes tappable
  (native tag, `[role=button]`, inline `on*`, `addEventListener`) and the audit flags each on the
  correct side (G1); a control reserving exactly the rail is allowed while one a pixel inside is
  flagged, so the boundary tracks `EDGE_W` read from `shell.css` rather than a hardcoded number
  (G2/G3); a hidden control and a sub-4px sliver are not flagged, the visible-content threshold
  stated on the record rather than left as a silent gap (G4/G5); a control flush to a *nested
  child frame's* edge is not reported, because only the immediate widget frame maps 1:1 to the
  slot (G7), while the `<iframe>` embed HOST itself — which carries an iframe/twitch/youtube
  embed and declares itself through none of the discovery routes — IS measured, so dropping its
  inset would be caught (G8); and the real notifications eye — the control #206 named — clears
  the rail at the 320px quarter slot through the exact aggregator the sweep uses. G6 drives that
  fixture from the *parent* frame over the real `ww-ready` handshake (widget-api rejects a
  self-posted message) and asserts the eye actually rendered (G6a) before reading its clearance
  (G6b), so the check cannot pass by measuring a widget that never drew. Without this file the
  sweep's "all clear" could mean "measured nothing" and no test on this head would tell the
  difference.
- `pillquiet-run.js` — the header pill reports exceptions, not health (issue #205). Every
  stock tile carried a permanent corner badge reading LIVE, ALL UP, CLEAR, QUIET, LOADED
  or SCHEDULED: true from the moment the widget worked until the moment it stopped, on
  every tile at once. A badge that is always there is furniture, and it teaches the reader
  to skip the one corner a widget has to speak from. The rule is now hidden-while-healthy,
  which means the check has to run BOTH ways or it is satisfied by deleting the pill
  outright — so two cases assert the nominal word is gone and two assert a degraded render
  still shows one. It drives `widget-datapath.js` rather than Playwright directly, and
  leans on `--reject` matching `innerText`, which omits hidden elements. `endpoints` and
  `ollama` carry it because their stock fixtures reach both a healthy and a degraded render
  without credentials; the other six widgets the rule changed are covered for rendering by
  the stock sweep but are **not** asserted here, which the file says out loud rather than
  implying coverage it does not have. Those four cases each launch their own
  `widget-datapath.js`, so the degraded ones start from a pill that was never hidden — they
  prove the hiding and nothing about recovery. R1-R3 add the half they cannot reach: one
  mounted `ollama`, driven healthy (pill hidden) → address changed (pill must return) →
  new address answering (pill quiet again), so R2 cannot be satisfied by a badge that is
  simply stuck on. `reset()` calls `showLoading()` and then fails into `showError()`, which
  makes those two `pill.hidden = false` assignments redundant with each other — deleting
  either alone leaves R2 green and deleting both fails it with `{"hidden":true,
  "text":"Error"}`, an error card with an empty corner. R2 falsifies the pair, not either
  member, and the file says so because the obvious single-line revert does not turn it red.
- `listprims-run.js` — list settings whose entries may be bare values (issue #167). Both
  settings editors filtered a list down to objects before rendering, so a widget's
  primitive shorthand — endpoints accepts `"nas.lan"` and expands it itself — got no row:
  invisible, uneditable, undeletable, and silently deleted on save because each editor
  writes back only what it rendered. The entry is now preserved as the primitive it was,
  NOT expanded into the field shape, because what a bare string means differs per widget
  and no manifest states the rule: endpoints reads it as both label and URL, while the
  neighbouring comma-string branch reads a bare token as `fields[0]` alone, which for
  endpoints leaves the URL empty and the widget drops it. Guessing picks one widget's
  meaning and corrupts the rest. Runs on plain Node against the real source text of both
  files rather than a copy, so an editor that loses the handling fails here. Covers the
  round trip, that the value keeps its TYPE (stringifying at read time made a numeric
  entry come back as its decimal spelling — the same silent rewrite, committed by the fix
  for it), editing, deleting, and that junk is still refused so no permanent blank row
  appears. Against the pre-fix files it reports 16 failures showing the entry simply
  absent from the saved array.
- `icue-emu-run.js` — the iCUE compatibility surface the Corsair stock-widget dump
  exposed as broken, driven end-to-end through the real shims via a probe widget in
  iCUE's own idioms (`tests/fixtures/widgets/icue-emu`): a strict-mode module assigning
  `icueEvents` bare (needs the predeclared global), the shared-`common/` escapes served
  as Plinth's stand-ins (MediaViewer, ColorTools, the promise wrappers), thenable
  `tr()` against the nested i18next `translation.json`, the Notificationsprovider
  requestId/asyncResponse round trip, and the Streamdeck plugin emulation against the
  `--sd` fixture (`virtualDeviceCreated`, per-key `buttonIconUpdated` title tiles,
  `sendKeyPress` down/up). Text-level: the click `phase` field crosses shim → shell →
  host → bridge, and every whitelisted compat asset in `IcueCommonAssets.cs` actually
  ships in `Shell/icue-common/`.
