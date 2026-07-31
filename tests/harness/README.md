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
