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

- `icuefetch-run.js` — the fetch-escalation contract shared by `widget-api.js`
  (`WW.fetch`) and the iCUE compat shim (issue #37): headers of every
  `HeadersInit` shape surviving the proxy hop (repeats combining like native
  `Headers`, Content-Type on the dedicated field), binary body integrity,
  proxy-first session memoization with its replayability and abort guards,
  auth-shaped proxy answers retrying the native path, and `Request`-object
  inputs keeping their method/headers. Ports used: 8931-8934 (scenario
  origins), 8941 (shell), 8942 (fixtures).
