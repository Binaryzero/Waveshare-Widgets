# Headless probe harness

Self-contained Playwright suites that boot the real shell (`src/WaveshareWidgets/Shell`)
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
  panel's only way to contradict its own optimistic re-render. Port used: 8952.
- `restvalue-run.js` — the REST Value widget's data path (issue #16), which the widget
  harness cannot reach because it aborts every network call. Drives the real widget
  against a rescriptable fixture endpoint: JSON Pointer and dotted-path resolution,
  threshold colouring in both directions, non-2xx / unreachable / non-JSON / null /
  pointer-miss states, the Stale path (a failure after a good read keeps the number),
  no stacked pollers across repeated inits, and that a configured auth header reaches
  the request while appearing nowhere in the DOM. Also writes the populated
  `restvalue-*.png` screenshots. Routes are fulfilled in-process — no ports.
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
  passes R12 perfectly. R12d asserts that `game-mode` is NOT gated, since it is
  edge-triggered and a dropped push would strand the shell on the wrong state until the
  next real transition.

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
- `kevretry-run.js` — pressing Retry while a game is running (issue #164). The game-mode
  gate suspends polling because the tile parses a multi-megabyte catalog on a machine
  whose frame budget is spoken for, and Retry did not account for it: it painted a
  spinner and called the poll, which returned through the gate without recording that a
  retry had been asked for, so the tile could spin for a day at the maximum interval
  while the deadline it was waiting on stayed an untouched interval from the last
  attempt. Drives the real sequence — the feed fails, a game starts, Retry is pressed,
  the game ends — and counts feed REQUESTS rather than reading what was drawn. Half its
  checks must fail before the fix and pass after; the other half must pass in BOTH, and
  those are the load-bearing ones: the plain no-game Retry still fetches at once, the
  gate still refuses while a game runs, and a game ending with nothing pending still
  does not poll early. Without that last one, "the retry runs when the game ends" would
  be satisfied just as well by deleting the gate. The loading assertion holds the
  stubbed request open, because a refused fetch resolves in microseconds and the
  in-flight state is gone before it can be observed. `KEV_SHOT=<path>` captures the
  queued card. No static server — every origin is route-fulfilled.
- `gameresume-run.js` — resuming from game mode when the SETUP, not a poll, is what was
  paused (issue #201). Most gated widgets pause a poll and resume by fetching again;
  `radar` geocodes its configured location inside `onInit` before it can draw anything,
  and `hue` hunts for a bridge the same way, so gating only the refresh left both
  reaching out through a game. Holding the setup is the easy half — resuming it is where
  this went wrong. The run drives a SUCCESSFUL session first so the refresh interval is
  armed, then starts a game, then changes the location mid-pause, then ends the game, and
  asserts on which NAME was geocoded rather than on request counts. Both details are
  load-bearing and were learned the hard way: the first version paused at init, so no
  interval was ever armed and the check passed against the buggy logic too; and a
  count-based assertion passes while the resume fetches diligently for the wrong city.
  R6 — a flip with nothing held makes no request — keeps R4 from being satisfied by a
  gate that simply reopens. Scenario B mounts with the game ALREADY running, because
  scenario A only ever sets the flag through a transition and would pass with the
  `state.game` seeding deleted. Scenario C holds the geocoder open so the request FAILS
  while the game runs: a rejection jumps straight to `catch`, skipping the gates that sit
  after each await, so nothing was recorded as owed and the error card outlived the game
  (issue #208). D is the same question one request later, at `refreshRadar`'s own catch,
  which the fix for C did not reach — recoverable at the next five-minute tick, but on a
  first load the tile has no frames at all until then. G and J move to `hue`, mounted with
  its own ww-fetch responder because it speaks to the bridge exclusively through the host
  proxy, so none of its traffic is a page request and the request LOG is the only witness.
  G is C's question against the cloud bridge hunt — its terminal "No Hue Bridge found"
  card sat above the gate, so a discovery that failed during a game was a verdict recorded
  in neither flag. J needs no game at all: two `connect()` calls overlap when settings
  change mid-hunt, and discovery was committing to the widget-global `cfg.ip` before the
  generation check, so the abandoned connection redirected the live one — which had
  already validated the configured bridge and loaded its key. J asserts on the bridge
  address the application key was sent to. No static server; every origin is
  route-fulfilled.
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
  implying coverage it does not have.
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
