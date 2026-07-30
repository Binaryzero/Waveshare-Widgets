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
- `icuefetch-run.js` — the fetch-escalation contract shared by `widget-api.js`
  (`WW.fetch`) and the iCUE compat shim (issue #37): headers of every
  `HeadersInit` shape surviving the proxy hop (repeats combining like native
  `Headers`, Content-Type on the dedicated field), binary body integrity,
  proxy-first session memoization with its replayability and abort guards,
  auth-shaped proxy answers retrying the native path, and `Request`-object
  inputs keeping their method/headers. Ports used: 8931-8934 (scenario
  origins), 8941 (shell), 8942 (fixtures).
