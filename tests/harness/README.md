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
  `secretfield-run.js` (E35d).

## Suites

- `secretfield-run.js` — the settings-editor half of the `secret` property contract
  (issue #15): a credential renders masked, a stored one reads as
  "saved · encrypted (hidden)" with no value in the DOM, typing/clearing say what the
  next save will do, the saved layout carries the explicit clear marker for a cleared
  secret (an empty string means "keep it"), and a save the host could not protect
  warns instead of reading as success. The encryption pipeline itself is guarded in
  CI by `dotnet run --project tools/SecretRoundTrip`. Port used: 8951.
- `secretedit-run.js` — two editor bugs from #56. Typing a credential over a saved one
  marks the editor dirty, and a save the host refuses because layout.json changed under
  the editor (#281) keeps the unsaved token and holds Save (S3). After the widget picker
  swaps a slot's widget, a same-named secret the old widget saved this session reads
  "not set". Port used: 8953.
- `refusalbanner-run.js` — the settings window's refusal banner (#151). A refused widget
  with no working copy reads "not loaded". An older refused copy beside one that loaded
  gets its own block, naming the settings it withholds and the folder to remove. Which
  refusals the host sends is `tools/SecretRoundTrip` B1. Port used: 8958.
- `widgetupdates-run.js` — update indicators in the settings window (#227). A widget the
  host marks new carries "New" on the shelf until one is added. A tile the host flags
  reads "Updated" until opened, and opening it tells the host — from the chip strip, or by
  tapping the tile in the live preview (U5). Which widgets and tiles qualify is
  `tools/WidgetCatalog`. Port used: 8963.
- `themelayers-run.js` — which appearance layer a tile follows (#225). A tile that overrides
  the theme is marked in the strip. Its Appearance panel says per value whether it comes from
  the theme or the widget, and offers "Follow the theme again". The Theme editor lists the
  widgets its colours will not reach and can revert each. Checking or unchecking a key
  updates the revert and the strip mark at once (L6). Two copies of one widget get rows that
  say which tile (L7). A revert from the Theme editor after a live-preview edit still reaches
  the save (L8, driven through the real replica). Port used: 8962.
- `duplicate-run.js` — Duplicate copies the credential (#226). The host half, Seal
  filling a fresh copy's untouched blank from the tile named in `copiedFrom`, is
  `tools/SecretRoundTrip` E5; this is what the settings window sends, the only place a tile
  can be duplicated. It never holds a stored credential, so the copy names its source,
  reads "saved", carries a value typed into the source this session and a pending Clear,
  keeps `copiedFrom` across a preview capture, and drops it when swapped to another widget
  (S1-S6). Port used: 8965.
- `paletteparity-run.js` — the theme palette is derived twice, by `PaletteEngine.cs` for
  the panel and by `palette.js` for the settings preview. `tools/PaletteParity` writes the
  C# derivation of 411 themes (the stock one, hand-picked edges, and a fixed-seed battery);
  this derives the same themes in JS and compares every token (T1). Also that the tile is
  the Background colour itself (T2) and that state colours follow the theme: a vivid and a
  muted accent give different states, each state keeps its hue family, and a grey accent
  still gives coloured states (T3). Node only; CI runs it after the probe.
- `bgstyle-run.js` — a tile's Background and the Theme's Panel opacity. The default is
  `theme`: a tile that never chose, one set to `theme`, one saved with the old `glass`,
  and one with an unknown value all paint at the theme's opacity; `solid` stays opaque and
  `transparent` has no tile (B1-B5).
- `palettecontrast-run.js` — issue #217: muted text must stay legible on the GLASS
  settings sheets, not only on the opaque surface. The panel's old `#propSheet` /
  `#stylePanel` painted `--surface` at 94% over the wallpaper, so `--text-muted` rendered
  over surface COMPOSITED with whatever is behind the glass — and a role tuned to 4.5:1 on
  the opaque surface drops below it over a bright (or dark) wallpaper. The sheets went
  with on-panel editing; the repair stays, because it only ever strengthens muted text.
  Drives `WWPalette.derive` over a theme battery and asserts muted clears 4.5:1 against
  `--surface` composited over both pure white and pure black at the sheet alpha (the
  bracket the rendered page cannot fall outside). Pure Node — no browser, no port. Fails against the pre-fix engine, which
  repaired muted against the opaque surface only.
- `restvalue-run.js` — the REST Value widget's data path (issue #16), which the widget
  harness cannot reach because it aborts every network call. Drives the real widget
  against a rescriptable fixture endpoint: JSON Pointer and dotted-path resolution,
  threshold colouring in both directions, non-2xx / unreachable / non-JSON / null /
  pointer-miss states, the Stale path (a failure after a good read keeps the number),
  no stacked pollers across repeated inits, and that a configured auth header reaches
  the request while appearing nowhere in the DOM. RP (#59): a private endpoint, stored as
  a secret, is fetched instead of the plain one when set, is part of the tile's source
  identity, and falls back to the plain one when cleared. RL (beta.21, no header): the
  user's title sits over the value, nothing stands in for a missing one, and an error card
  with no reading behind it still names the reading. Also writes the populated
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
  the file notes is the check that keeps the suite from passing hollow. N4 taps Retry on the
  error card and holds the request in flight: the card must read Retrying, with a spinner,
  and nothing on the tile may call it Setup (the header pill once did).
- `widgetfit-run.js` — that widget text fits the SLOT rather than one axis of it
  (issue #76). A widget's iframe is sized to its slot, so `vh`/`vw` do measure the
  tile — but a rule written against one axis says nothing about the other, and the
  clock's `34vh` asked for 136px glyphs across a 320px quarter, clipping a digit off
  each end. Drives the real clock at every slot geometry including the half-height
  bands, with the longest and shortest strings its own settings can produce (12-hour
  plus seconds versus 24-hour without), and checks the opposite failure too: text
  that fits by being tiny is not a fit. Also covers re-fitting when the slot resizes
  with no settings change, and that the size sliders can only shrink. Mounted with a
  `#ww-slot` fragment so `--ts` is stamped as on the panel, it also takes the XENEON
  EDGE's tiles, holds the date to a fifth of the height and half the time's size (F4b),
  and checks the date's cap grows with the tile (F7b/F7c). Routes are fulfilled
  in-process — no ports.
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
- `redditpick-run.js` — which copy of an image Reddit Photos loads: the smallest resized
  copy that fills the tile at its real pixel size, else the original. It used to take
  the first copy at least 1280 wide, the Waveshare's width, which Reddit's copies (up to
  1080) never are. Cover crops, so a 3:2 photo in a 320x400 quarter needs a 640 copy,
  while contain needs only 320 (K1-K3); a tile wider than every copy takes the original
  (K4); the XENEON EDGE's quarter takes the 1080 and its full tile the widest there is
  (K5, K6); display scaling counts (K7); galleries pick the same way, an animated one
  keeping its original (K8); copies without a size or url are skipped, in any order (K9).
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
  the settings editor renders whatever is in `widget.properties`, so if normalisation ever
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

  **#257 moved the line T3 and T9 draw.** Both used to drag 160px sideways and require that
  nothing page — a full swipe, not the drift #206 was about, and exactly the gesture a user
  makes to change page. They now drift half the swipe threshold (read from `widget-api.js`)
  and require not only that the page stays put but that the browser never *began* a native
  pan: a short pan into a mandatory scroll-snap container snaps back on release, so the
  resting position alone passes with the `pan-y` guard deleted. S1-S3 swipe from inside the
  list, the other way, and from the eye (which pages and is not also pressed); S4 confirms
  the vertical drags posted no swipe; S5 swipes where the browser still pans natively and
  requires the page to change once with no swipe posted, so nothing pages twice. The stand-in
  shell records every `ww-swipe`, because a page change the detector caused and one the
  browser caused are identical in `scrollLeft`. Disabling the detector fails S1-S3; deleting
  the list's `pan-y` fails T9; deleting the eye's `.no-pan` fails T3.
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
- `pillquiet-run.js` — the pill reports exceptions, not health (issue #205). Every
  stock tile carried a permanent corner badge reading LIVE, ALL UP, CLEAR, QUIET, LOADED
  or SCHEDULED: true from the moment the widget worked until the moment it stopped, on
  every tile at once. A badge that is always there is furniture, and it teaches the reader
  to skip the one corner a widget has to speak from. The rule is now hidden-while-healthy,
  which means the check has to run BOTH ways or it is satisfied by deleting the pill
  outright — so two cases assert the nominal word (and, since beta.21, the exception words)
  is gone and two assert a degraded render still shows one. It drives `widget-datapath.js`
  rather than Playwright directly, and leans on `--reject` matching `innerText`, which
  omits hidden elements — so the cases follow the pill wherever it lives, which since the
  headers went (beta.21) is a footer shown only for an exception (endpoints' down count,
  ollama's Stale) or beside the data (ollama's Idle). `endpoints` and `ollama` carry it
  because their stock fixtures reach both a healthy and a degraded render without
  credentials; the other six widgets the rule changed are covered for rendering by the
  stock sweep but are **not** asserted here, which the file says out loud rather than
  implying coverage it does not have. Those four cases each launch their own
  `widget-datapath.js`, so the degraded ones never follow a healthy render — they prove the
  hiding and nothing about recovery. R1-R5 add the half they cannot reach: one mounted
  `ollama`, driven healthy (pill hidden) → address changed (R2: the state card replaces the
  data, and no pill repeats it — Loading and Error have had no pill since the header went,
  which is why R2 no longer asks for one) → new address answering (R3: data back, card
  gone) → a failed poll (R4: Stale comes back from hidden) → answering again (R5: Stale
  goes). R4 and R5 are what keep the pill-comes-back guarantee now that Stale is the only
  pill left.
- `widgetswipe-run.js` — a swipe that starts inside a widget pages the dashboard (#257), and
  a drift on the way to a tap still does not (#206). The two pull opposite ways and
  `touch-action` cannot serve both: #206 made scrolling lists `pan-y` and controls `.no-pan`
  so a few pixels of drift stopped changing page, which also turned any tile whose list
  fills it (notifications, jellyfin) into a dead zone for paging. `widget-api.js` now
  recognises a swipe by distance and posts `ww-swipe`. Runs in CI on plain Node: the rule is
  sliced out of the real source between `ww-swipe-rule` markers and executed, with the drift
  pinned at a FIXED 30px so retuning the threshold cannot reopen #206; the detector's wiring
  and the shell's gates (past the bridge's identity-and-origin check, never in edit mode,
  only from a widget on the page shown) are pinned as source guards. F1 runs the pre-fix
  behaviour and requires it to fail.
- `headerless-run.js` — where two widgets' header duties went once the header did
  (beta.21). GPU: a card with sensors shows its readouts and device name, a card whose only
  GPU reading is its memory load still shows it, and only a machine with no GPU sensor gets
  the empty state (G1-G3). Notifications: the privacy eye, now in the tile's corner, covers
  no app name, count, notification text, dismiss button or mute chip at 320, 640, 960 and
  1280 wide, with and without the mute bar (N1, N2). The app names are long on purpose: in
  two columns the right column's first header starts at the top beside the eye, and only a
  name long enough to reach it shows whether the list keeps its gutter (N1 at 960 fails
  without it). Mounted as the panel mounts a widget, with the sensor frame and the
  notifications following the init a beat later, as the host's pushes do.
- `tilescale-run.js` — text scales with the tile (beta.21: "everything is too TINY").
  `widget-api.js` stamps `--ts` on a widget document's root from the tile's size and
  `widget-base.css` multiplies its type by it. S1 runs the curve (sliced out between
  `ww-tile-scale` markers): 1.3 at 320x200, 1.97 at 1280x400, capped at 2.5, never shrinking
  as the tile grows. It runs in CI with `--curve`. Without the flag, S2-S5 run in Chromium:
  a widget frame gets the stamp and `WW.tileScale` agrees, body text is 13.5px times it, a
  resized frame re-stamps, and a page that is not a widget (no `#ww-slot=`) is left alone.
  S6 answers `ww-ready` with an init at once, as the panel does, so the init lands while the
  widget is still parsing: a widget measuring in `onInit` must see the scaled text. The
  injected shim runs before `<html>` exists, so only the init handler's stamp is in time.
  Each of those fails when its line is removed.
- `discover-run.js` — Find, a widget looking up its own setting values (#210 slice 2). Runs
  in CI on plain Node. The shell's `ww-discover-clean` block must reduce a widget's answer
  to bounded, plain `{value, label}` choices. The widget API's `ww-discover-answer` block
  must answer every question exactly once, in plain data, and say "unsupported" rather
  than stay silent. The settings window's `ww-discover-text` block must leave every dead
  end typeable. The wiring across the host is pinned as source guards. D5 runs a
  pass-through cleaner and requires D1 to fail. D6 is Find by query: the user's search
  reaches the widget as `query`, capped at 100 characters, a search with no match names
  it, and the settings window sends one only when the first answer was cut short. Find is
  offered in the settings window only: the panel only displays, and answers the host.
- `discoverroute-run.js` — the same, for real, in a browser. In the dashboard shell with a
  fake host, a question reaches only the widget it names. Another widget quoting the live
  id is ignored (R4). A question is answered once; one asked as the tile reloads is put to
  the new document once it is ready (R8); and a silent widget becomes a timeout after 20 s
  (so the run takes about 30 s). The settings window offers Find on a text setting and a
  list field, lists label over value, saves the picked value, and says so when there is no
  panel. Find by query (S5): with 600 choices, a search goes to the widget once typing
  pauses and its matches past the first 500 are listed, and a late answer for an older
  search does not replace the latest one.
- `hafind-run.js` — Home Assistant's Find (#210), asked the way the shell asks, against a
  stub server. The Entity ID field lists every entity sorted by id with its friendly name
  (F1), and it answers while the widget is still on its setup card (F2). Other settings
  get "unsupported". A rejected token and a missing address come back as the widget's own
  messages, and a server that never answers is reported by the widget at about 15 s,
  inside the shell's 20 s wait (F6). A search (Find by query) is answered with the
  entities whose id or friendly name contains it (F7).
- `retiredit-run.js` — removed widgets in the settings window (#226): Restore and Delete are
  edits applied by Save & apply, usable with unsaved changes (R1). Restore asks the host
  only to mask the def (R2), and the masked def lands on the page with its credential
  blank and marked saved (R3). A Delete takes the row out and is named in the save's
  `retainedDeleted`, once (R4, R5), and both light Save from a clean editor (R4d, R10). On
  a full page the reason Restore is greyed out is a visible sentence (R6). Stale — a save
  the host refused because layout.json changed under the editor — holds both (R7). An
  answer for a live identity (R8), or for a page that filled meanwhile (R9), seats
  nothing. A tile this editor removed comes back as it was, typed credential included
  (R12); a Delete whose write did not land stays named (R13); after a reload the attic is
  disk's and goes through the mask again (R14). The host half is `tools/SecretRoundTrip`
  D1-D5 (CI).
- `settingslayout-run.js` — the settings window's frame. The stale-layout banner is hidden
  when nothing is stale (L1); its `display:flex` used to outrank `[hidden]`, leaving an
  empty orange bar under the header. On a tall window the dock and its columns reach the
  bottom edge while the canvas keeps its fitted size (L2, L3), through a shorter window,
  a selected widget, a hidden preview and a form taller than the dock's cap (L4-L6, L9,
  L10), and at the 780x480 minimum the dock ends exactly at the edge (L7). The banner
  still shows when a save is refused because the layout changed on disk under unsaved
  work (L8). Where the
  window opens, and how big, is `tools/WindowPlacement` (CI).
- `panelpage-run.js` — the settings preview is drawn at the panel's page size, which the
  host sends with the init. With no panel it is the Waveshare's 1280x400 (E1); a Corsair
  XENEON EDGE is a 2560x720 page scaled to fit at its own shape, its half tile 1280x720 in
  the shell inside, and the size labels quote its tiles (E2-E4); 150% scaling is a
  1707x480 page (E5); a size that is not a sane one keeps 1280x400 (E6); the preview
  follows the dashboard to another display without reopening (E7). Which displays
  are panels, and the page size at a display's scale, are `tools/WindowPlacement` P1-P5
  (CI).
- `jellyfinfind-run.js` — Jellyfin's Find (#210), asked the way the shell asks, against a
  stub server. The username lists every user sorted by name, administrators and disabled
  accounts labelled, asked with the saved API key (J1). A Hidden libraries row lists the
  server's libraries sorted and labelled by kind, one per spelling (J2). Both answer before
  either setting is filled in. Other settings get "unsupported". A rejected key, a reply
  that is not a list and a missing address come back as the widget's own messages, and a
  server that never answers is reported at about 15 s, inside the shell's 20 s wait (J8,
  so the run takes about 20 s). A list of 600 users, some 600 KiB as real user records
  are, is read whole, and a search (Find by query) is answered with the names or labels
  that contain it, past the 500th (J9).
- `jellyfinlayout-run.js` — Jellyfin with no header and type that scales with the tile
  (beta.21), against the stub server in `tests/fixtures/widgets/jellyfin.json`, at every
  size it is offered, the XENEON EDGE's included: no header, label or healthy pill (L1);
  stream titles at 13.5px times the tile scale (L2); every stream row and the whole shelf
  inside the body, and no shelf beside streams on a 200px band (L3); streams the tile had
  no room for named as "+N more streaming", on a band too, where the footer otherwise
  shows only for an exception, with the rows laid out above it (L3b); no dead band — the
  shelf takes the height the rows leave, and the rows the rest once the posters are as
  tall as their art (L4); and laying the tile out again changes nothing (L5) — a first
  answer that beat DOMContentLoaded, where the tile scale lands, once sized a 1280x400
  tile for text half its height. Stale shows in the footer beside the data's age, on a
  band too, and in the Player's browse bar (L6); Retry is a spinner and "Retrying…", not
  a setup card (L7); the Player fetches the page its grid measures, once, and keeps the
  tab you are on in the row (L8); in a light theme the genre sheet is the theme's surface
  and its title and a poster's watched mark read at 4.5:1 or better (L9).
- `twitchtheme-run.js` — Twitch Chat follows the panel's appearance (beta.21: "most
  widgets do not respect the theme setting"). The embed's one switch, darkpopout, comes
  from the theme's --appearance: 'auto', the default, loads the light chat on a light
  panel (T1) and the dark one on a dark panel (T4), and a live theme push swaps it both
  ways (T2, T3). 'dark' and 'light' stay pinned through a push (T5, T6), and an unusable
  channel loads nothing, push or not (T7). Twitch itself is never fetched: the src the
  widget sets is the contract.
- `wowfind-run.js` — WoW Panel's Find (#210). The OAuth exchange is answered on the host-proxy
  tier as on the panel, and the realm index directly. The Realm setting lists the region's
  realms as slugs labelled with their names, sorted by name, from the dynamic namespace in
  the region's locale (F1, F4), and it answers while the widget is still on its setup card.
  The character gets "unsupported": listing a player's characters needs their own
  Battle.net sign-in. Rejected credentials and missing ones come back as the widget's own
  messages. A slow sign-in plus a slow read is reported at about 15 s (F7, so the run takes
  about 20 s), a list with no usable realms is an error (F8), and a realm typed by its name
  is looked up by Blizzard's slug, accents and brackets dropped (F9).
- `apppick-run.js` — Store apps in the app picker (#219). Runs in CI on plain Node: the
  settings window's `ww-app-pick` block (the "no match" line and the rule that a pick fills
  an EMPTY Name and never a typed one) is sliced out of `settings.js` and run; Deck's and
  Launcher's `ww-store-label` block, which gives a `shell:AppsFolder\<id>` target a
  readable fallback label, is run the same way. The wiring is pinned as source guards, and
  P6 runs the pre-#219 behaviour and requires it to fail. The browser half is E36f/E36g in
  `secretfield-run.js`; the host half (which ids are kept, how one starts) is
  `tools/AppIds`.
- `atticretire-run.js` — a removal made in the settings window's live PREVIEW retires the
  tile instead of discarding it (#226, and the scope cut withdrawn from PR #269). The
  preview is a replica shell handed every credential blanked, so anything it retired
  arrived empty and nothing could reunite it with the value the user typed — the bridge
  would be the "sole id-less slot of this widget" guess #68 forbids. The preview now NAMES
  the slot and the settings side retires it, on the one path that holds the unscrubbed
  copy. Runs in CI on plain Node: `onReplicaRemove` and `removeSlotAt` are sliced out of
  the real `settings.js` between `ww-replica-remove` markers and executed, so a regression
  in the shipped commit cannot leave it green, and the shell half is pinned by regex source
  guards (shell.js has no retire path of its own — no `removeSlot`, nothing that writes an
  attic — its ✕ calls `requestRemoveSlot` alone, and that contains no id generator at
  all). Covers the refusals as hard as the happy path — a stale generation, an armed
  replica timer, an identity mismatch, a replica-minted id on an id-less slot, and eight
  bad index shapes, of which `-1` matters most: `removeSlotAt` splices unconditionally, so
  `splice(-1, 1)` would silently discard the LAST tile on the page. A9 runs the pre-fix behaviour and asserts it fails.
- `previewretire-run.js` — the relay half of the same change, and browser-only for the
  reason `atticretire-run.js` is not: whether the ✕ tap actually crosses the postMessage
  seam needs two real documents. Boots the real `settings.html`, lets it drive the real
  replica, answers as the native host, types a credential into the settings form that the
  replica is never given, taps the preview's ✕ twice, then reads what reaches the host on
  save. E10 is the point: that typed value must be sitting in the attic entry. Two tiles,
  not one — with a single tile an off-by-one splice and a correct removal both leave the
  page empty, so the survivor's identity is the assertion.
- `addzone-run.js` — the add-zones and size chips of the settings window's live preview,
  the only place the layout is edited: the shell booted as the replica
  (`index.html?preview=1`) and switched on by `edit-mode`, the way `settings.js` drives it.
  The panel itself has no edit entry point, palette or editor sheet, ignores `edit-mode`
  and never saves (A0), and a panel whose pages hold no tile points at the settings window
  instead of sitting blank (A0e). Every free region gets a zone, not just the largest (A1, #84), the
  zones tile the free space (A2), a full page offers none (A4), and a region nothing fits
  says so (A5, #77). Tapping a zone hands the add to the settings window naming THAT
  region, never adding anything itself (A3, A6, #86 — the settings side sizes it). A stored
  size the widget no longer allows cycles to the next size up (N11, #77), and the notice a
  size tap raises is visible but not hit-testable (N7b). Port used: 8955.
- `listprims-run.js` — list settings whose entries may be bare values (issue #167). The
  settings editor filtered a list down to objects before rendering, so a widget's
  primitive shorthand — endpoints accepts `"nas.lan"` and expands it itself — got no row:
  invisible, uneditable, undeletable, and silently deleted on save because the editor
  writes back only what it rendered. The entry is now preserved as the primitive it was,
  NOT expanded into the field shape, because what a bare string means differs per widget
  and no manifest states the rule: endpoints reads it as both label and URL, while the
  neighbouring comma-string branch reads a bare token as `fields[0]` alone, which for
  endpoints leaves the URL empty and the widget drops it. Guessing picks one widget's
  meaning and corrupts the rest. Runs on plain Node against the real source text of
  `settings.js` rather than a copy, so an editor that loses the handling fails here. Covers the
  round trip, that the value keeps its TYPE (stringifying at read time made a numeric
  entry come back as its decimal spelling — the same silent rewrite, committed by the fix
  for it), editing, deleting, and that junk is still refused so no permanent blank row
  appears. Against the pre-fix files it reports 16 failures showing the entry simply
  absent from the saved array.
- `streamdeck-tap-run.js` — the Stream Deck widget's populated render, which the #221
  tap audit could not otherwise see (its keys arrive over the host bridge, not http, so
  a plain data-path run reached the "no deck" card and passed vacuously). Drives a
  multi-profile deck through the `--sd` fixture and asserts the picker and key grid are
  really on screen for the audit to walk. It also covers the closed-window case: a
  profile is read from DISK, so the keys render just as well when the deck's window is
  shut, and the tap must be refused — driven with live mode OFF, the mode that had no
  signal at all before, since the capture reply was what used to notice.
- `icue-emu-run.js` — the iCUE compatibility surface the Corsair stock-widget dump
  exposed as broken, driven end-to-end through the real shims via a probe widget in
  iCUE's own idioms (`tests/fixtures/widgets/icue-emu`): a strict-mode module assigning
  `icueEvents` bare (needs the predeclared global), the shared-`common/` helpers
  (MediaViewer, ColorTools, the promise wrappers) reached as injected globals —
  the probe's own `../common/…` script tags 404 here on purpose, because that is
  the device condition and the markers passing is what proves the globals carry it —
  the unloadable-font sweep (`@font-face` rules planted in the four places a sweep can
  miss — top level, inside an `@media` group, in a `<style>` appended 1.4 s after load,
  and in one nested inside a container appended 1.7 s after — crossed with the shapes
  it can mistake for loadable: `qrc:`, `file:` and `http:` sources that must be dropped,
  a relative 404 that must NOT be dropped but must get `font-display`, a loopback `http:`
  source that must survive, an ordered list whose good sibling must survive, and an
  author's own `font-display` that must not be overruled — plus a PAIR of nested frames
  loading one document, differing only in whether the src carries the shell's `#ww-slot=`
  marker, which pins the sweep's gate to widget identity rather than frame depth (depth
  broke the settings live preview, where the replica shell makes every previewed widget a
  grandchild); each asserts the shim ran there as well as what it did — every marker
  naming the survivors, so a regression says which case broke rather than just that one
  did),
  thenable `tr()` against the nested i18next `translation.json`, the
  Notificationsprovider requestId/asyncResponse round trip, and the Streamdeck plugin
  emulation against the `--sd` fixture (`virtualDeviceCreated`, per-key
  `buttonIconUpdated` title tiles, `sendKeyPress` down/up). Text-level: the click
  `phase` field crosses shim → shell → host → bridge, `Shell/icue-common.js` defines
  every helper as a window property (so a vendored copy shadows rather than
  collides), and every surface that injects the shims injects it. It also separates a readable
  profile from a pressable deck: against a `windowAvailable:false` fixture the probe must
  still announce the deck and paint its faces (they are real, read from disk) while
  posting ZERO clicks, rather than firing them at a window that is not there. The
  open-window run asserts the opposite direction, or a shim that refused everything would
  pass both. A network-attached deck (`VSD2/WiFi` — Stream Deck Mobile, or a
  bridge such as iCUE's) is in that state permanently — it has no window,
  ever — and is refused upstream rather than mirrored, which `tools/DeckManifest` drives.
