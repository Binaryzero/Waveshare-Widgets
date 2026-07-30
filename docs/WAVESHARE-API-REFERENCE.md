# Waveshare Widgets API Reference

The complete contract for building widgets that run on the Waveshare Widgets dashboard.
Two authoring paths are supported:

1. **Native widgets** — use the `window.WW` API (this document). Simplest, first-class.
2. **iCUE-compatible widgets** — use the emulated `window.plugins.*` API. See
   [ICUE-API-REFERENCE.md](ICUE-API-REFERENCE.md); most `.icuewidget` packages run as-is.

Both run in the same sandbox and can be mixed in one widget. For a quick start and the
packaging format, see [WIDGET-SPEC.md](WIDGET-SPEC.md); for how the runtime is built, see
[ARCHITECTURE.md](ARCHITECTURE.md).

## Contents

- [Runtime model](#runtime-model)
- [Package & manifest](#package--manifest)
- [Property types](#property-types)
- [The `window.WW` API](#the-windowww-api)
- [Sensor model](#sensor-model)
- [Media model](#media-model)
- [Host bridge message protocol](#host-bridge-message-protocol)
- [Layout & slots](#layout--slots)
- [Design constraints](#design-constraints)

---

## Runtime model

- The dashboard is a WebView2 page pinned full-screen to the 1280×400 panel. It renders
  swipeable **pages**, each holding **slots**, each slot an `<iframe>` hosting one widget.
- Each widget is served from its **own virtual host** (`https://<id-slug>.widgets.wsw`), so
  it's a distinct browser origin: no access to the shell or other widgets, its own
  `localStorage`, and it may `fetch()` external HTTPS.
- The iframe sandbox is `allow-scripts allow-same-origin`. Widgets talk to the host only
  through the message API surfaced as `window.WW` (and the emulated `window.plugins.*`).
- `widget-api.js` and the iCUE shim are **injected automatically** into every widget; the
  `<script src="https://app.wsw/widget-api.js">` include is optional (kept for
  standalone-browser development).

---

## Package & manifest

A widget is a folder with `manifest.json` + `index.html` (+ assets), zipped as a
`.wswidget` file. Install via tray → Install widget, the Settings window, or by dropping
the folder into `%LocalAppData%\WaveshareWidgets\widgets\`. Files hot-reload.

```json
{
  "id": "com.example.my-widget",
  "name": "My Widget",
  "author": "You",
  "version": "1.0.0",
  "description": "What it shows.",
  "min_api_version": 1,
  "preview_icon": "preview.png",
  "supported_slots": ["quarter", "half", "full"],
  "properties": [ /* see Property types */ ]
}
```

| Field | Req | Notes |
|---|---|---|
| `id` | ✓ | Unique, reverse-DNS. Determines install folder and origin. |
| `name` | ✓ | Display name. |
| `author`, `version`, `description` | – | Metadata. `version` enables stock-widget in-place upgrades. |
| `min_api_version` | – | Currently `1`. |
| `preview_icon` | – | Path relative to the widget folder. |
| `supported_slots` | – | Subset of `quarter`, `half`, `full`. Defaults to all three. |
| `properties` | – | User settings (below). Also read from iCUE `x-icue-property` meta tags if empty. |

---

## Property types

Each property is rendered by the Settings UI and its merged value injected before your
scripts run. Common fields: `name`, `label`, `type`, `default`, and `group` (settings
section heading).

| `type` | Extra fields | Value in `WW.settings` |
|---|---|---|
| `text` | – | string |
| `number` | `min`, `max`, `step` | number |
| `slider` | `min`, `max`, `step` | number |
| `color` | – | string (hex) — **data colors only** (content, e.g. a pen or series color); appearance (text/accent/background/state colors) comes from the design tokens + per-slot style override, never from manifest properties |
| `select` | `options: string[]` | string |
| `switch` | – | boolean |
| `sensor` | `sensor_type` (filter) | string (sensor id) |
| `sensors-factory` | `sensor_type` (filter) | `[{sensorId, color}]` — an add/remove list of sensors, each with a per-sensor data color (see the stock Fans widget) |
| `location` | – | string (city name) **or** `{label, latitude, longitude}` (picked) |

```json
{ "name": "units", "label": "Units", "type": "select", "options": ["celsius", "fahrenheit"], "default": "celsius" }
```

The `location` type renders a city-search picker (disambiguates duplicate place names);
handle both value shapes — see the stock weather widget.

---

## The `window.WW` API

```js
// Lifecycle
WW.onInit(({ settings, sensors, media, status }) => { /* first data delivery */ });
WW.onSensors((sensors) => { /* every poll tick, ~2 s */ });
WW.onMedia((media) => { /* when now-playing changes */ });
WW.onTheme((theme) => { /* live token change (style edits); tokens are already on :root */ });

// State (current snapshots)
WW.settings          // merged property values, e.g. WW.settings.units
WW.sensors           // SensorReading[] (see Sensor model)
WW.media             // MediaState | null
WW.status            // { elevated: boolean, apiVersion: number }
WW.theme             // design-token map ({'--surface': '#111314', ...}) — applied to
                     // :root automatically before onInit; see WIDGET-STANDARD.md

// Sensor lookup
WW.sensorById(id)                 // exact id -> SensorReading | null
WW.findSensor({                   // heuristic lookup -> SensorReading | null
  type,                           //   sensor type filter, e.g. 'Temperature'
  deviceTypeIncludes,             //   [] of substrings matched on deviceType
  preferredNames,                 //   [] exact-name priority list
  nameIncludes,                   //   [] substring fallback
})

// Layout
WW.fitText(el, { width, height, scale?, min?, max? })  // -> px size applied
// Scales el's font-size so its text fits a box in BOTH axes. Viewport units size on
// the axis you name and clip on the other: the stock clock's `34vh` asked for 136px
// glyphs across a 320px quarter slot, losing a digit at each end (#76). Text scales
// linearly with font-size, so one measured pass gives the exact ratio.
//   width/height  the box to fit, in px — the CALLER supplies it, because only the
//                 widget knows its own layout (the clock leaves room for the date).
//   scale         optional fraction of the fitted size, for a user "size" setting.
//                 Applied AFTER max, so the control still works where the raw fit
//                 exceeds the cap. Values above 1 are honoured but will overflow.
//   min/max       px bounds on the result (default 6 / 400).
// `el` must be shrink-to-fit: a block that stretches measures the container, not the
// text, and every ratio comes out 1. A flex item under `align-items: center` works.
// Call it whenever the text or the slot changes — a ResizeObserver on document.body
// covers a slot resized under a running widget, which no settings change reports.

// Actions
WW.mediaControl('toggle' | 'next' | 'prev')   // transport control
WW.log(message)                                // writes to the host app.log

// Network
WW.fetch(url, init)  // -> Promise<Response>; fetch with bot-wall/CORS relief
WW.ping(hosts)       // -> Promise<[{host, ok, rttMs?, error?}]>; real ICMP via the host

// Local media library (the user's media folder; "Open media folder" in Settings)
WW.listMedia()       // -> Promise<[{name, url, kind: 'image'|'video'}]>; served from https://media.wsw/

// System audio (Windows volume mixer)
WW.getAudio()        // -> Promise<{available, master: {level, muted}, sessions: [{pid, name, level, muted}]}>
WW.setAudio(target, { level?, muted? })  // target: 'master' | pid (string); level 0..1.
                                         // A pid fans out to all same-name sessions of that app.
                                         // Resolves {ok}; ok:false = the host couldn't apply it
                                         // (session gone) — revert your optimistic UI and flash.

// Windows toast mirror (notifications widget)
WW.watchNotifications(true)     // start the host's toast mirror (demand-gated polling)
WW.notifications                // {state: 'allowed'|'denied'|'unavailable', items:[{id, app, appId, title, body, time}]}
WW.onNotifications((n) => {})   // fires when the mirrored list changes; strings are untrusted — textContent only
WW.dismissNotification(id)      // dismiss one toast by id
// Windows only grants the UserNotificationListener to apps with package identity
// (MSIX-installed). On the portable zip install expect 'denied'/'unavailable' and
// render an explanatory state card — never an empty list.

// Game mode
WW.game                         // {active, process} — a fullscreen game is foreground
WW.onGame((g) => {})            // gate your JS timers/streams; CSS animation pauses automatically via html[data-game]
// onGame fires on TRANSITIONS only. Seed your paused flag from WW.game.active (or
// state.game, carried by ww-init) inside onInit, or a widget that loads DURING a
// game never learns about it and keeps polling.
```

`WW.onInit(cb)` fires immediately if data already arrived. All getters are live snapshots
(safe to read any time after init).

`WW.fetch` tries the browser's `fetch` first and, on a network/CORS failure or a
403/429 (bot walls often serve their block page *with* CORS headers), retries through
the host proxy — browser-grade headers, `Referer` for `*.redd.it`, and a hidden-browser
fetch for TLS-fingerprinting sites like Reddit. Only GET/POST with string bodies ride
the proxy path; the stock Reddit Photos widget is the reference consumer.

`WW.fetch` init extras beyond standard fetch: `init.headers` (plain object) is forwarded
on the proxy path too, and `init.insecure: true` skips TLS certificate validation — but
only for private/loopback literal IPs (RFC 1918, link-local, 127.x), for devices with
self-signed certs like the Philips Hue bridge. Public hostnames always validate.
Insecure LAN requests use HTTP/1.1 and are serialized through one connection per
device — embedded TLS servers mishandle h2 offers and parallel handshakes.

---

## Sensor model

A `SensorReading` is:

```ts
{
  id: string,          // stable id, e.g. "lhm:/gpu-nvidia/0/temperature/0" or "sys:cpu:load"
  name: string,        // e.g. "GPU Core"
  device: string,      // e.g. "NVIDIA GeForce RTX 5060 Ti"
  deviceType: string,  // e.g. "GpuNvidia", "Cpu", "System", "Corsair"
  type: string,        // "Temperature" | "Load" | "Clock" | "Fan" | "Power" | "Data" | "Throughput" | ...
  units: string,       // "°C" | "%" | "MHz" | "RPM" | "W" | "GB" | "B/s" | ...
  value: number | null // null when the source is momentarily unavailable
}
```

Sensor tiers (what exists depends on the machine and elevation):

| Always present (no elevation) | Source |
|---|---|
| `sys:cpu:load`, `sys:mem:load`, `sys:mem:used`, `sys:mem:total`, `sys:net:down`, `sys:net:up` | performance counters + memory status |
| `sys:idle:seconds` (type `Idle`, units `s`) | `GetLastInputInfo` — seconds since the last keyboard/mouse input, for "at the PC" logic (vitals away-freeze) |
| `sys:thermal:<zone>` | ACPI thermal zones (firmware-dependent CPU-ish temp) |
| GPU temp/load/VRAM, storage | LibreHardwareMonitor (vendor user-mode DLLs) |
| Fan/pump RPM from USB fan hubs, AIO coolers and digital PSUs | LibreHardwareMonitor (user-mode HID — no elevation) |
| `corsair:<id>:battery` | iCUE SDK, if `iCUESDK.x64_2019.dll` present + iCUE SDK enabled |
| `battery:<slug>` (type `Battery`, units `%`) | Bluetooth device battery via Windows PnP (`DEVPKEY_Bluetooth_Battery`) + laptop batteries via `Win32_Battery`; charging shown as `Name (charging)`. 2.4 GHz-dongle devices (Slipstream/Unifying) expose nothing here. |

| Needs elevation **and** PawnIO (both — either alone yields nothing) | Source |
|---|---|
| CPU core temps, motherboard/SuperIO fan headers, voltages | LibreHardwareMonitor via the PawnIO driver (its device is admin-only) |

Always render a placeholder for `value === null`, and degrade when a sensor is absent —
check `WW.status.elevated` and pick fallbacks (the stock CPU widget does this).

---

## Media model

```ts
MediaState {
  available: boolean,
  title, artist, album, status: string | null,   // status: "Playing" | "Paused" | ...
  thumbnail: string | null,                        // data: URL of album art
  positionSeconds, durationSeconds: number | null  // playback timeline
}
```

From the Windows media session (whatever app is playing). `WW.mediaControl(...)` drives
the same session. iCUE media widgets get `songName`/`artist`/transport via the emulated
`Mediadataprovider`.

---

## Host bridge message protocol

Advanced/reference: what `widget-api.js` speaks under the hood (`window.postMessage` to
the shell, relayed to the host). Native widgets should use `WW.*`; this documents the
wire format for the curious or for custom shims.

Widget → shell:

| type | payload | meaning |
|---|---|---|
| `ww-ready` | – | widget loaded; request init |
| `ww-media-control` | `action` | transport command |
| `ww-log` | `message` | write to app.log |
| `ww-open-url` | `url` | open in system browser |
| `ww-fetch` | `id, url, method, body, contentType, headers?, insecure?` | host-proxied fetch (CORS/bot-wall relief; GET/POST/PUT/HEAD; `insecure` honored only for private-IP hosts) |
| `ww-ping` | `id, hosts` | real ICMP pings via the host (≤16 hosts) |
| `ww-media-list` | `id` | list the user's media folder (images + videos) |
| `ww-audio-get` | `id` | snapshot the Windows volume mixer (master + per-app sessions) |
| `ww-audio-set` | `target, level?, muted?` | set master or per-session volume/mute |
| `ww-sd-profile` | `profileName, hideWindow, live` | request the Virtual Stream Deck mirror; `live` adds a window screenshot |
| `ww-sd-capture` | – | capture-only fast path (no profile re-parse; host dedups unchanged frames) |
| `ww-sd-click` | `row, col, rows, cols` | trigger the VSD key at that grid cell |

Shell → widget:

| type | payload | meaning |
|---|---|---|
| `ww-init` | `settings, sensors, media, status, theme` | first delivery + on settings change; `theme` is the design-token map (`--surface`, `--accent`, …) the API applies to `:root` and stamps as `data-appearance` |
| `ww-sensors` | `sensors` | per-tick sensor snapshot |
| `ww-media` | `media` | now-playing changed |
| `ww-fetch-result` | `id, status, contentType, bodyBase64, error` | proxied fetch reply |
| `ww-ping-result` | `id, results: [{host, ok, rttMs?, error?}]` | ping reply (routed to the requesting widget) |
| `ww-media-list-result` | `id, files: [{name, url, kind}]` | media folder listing; `url` is on `https://media.wsw/` |
| `ww-audio-result` | `id, available, master, sessions` | volume mixer snapshot reply |
| `ww-sd-profile` | `profile: {available, name, rows, cols, buttons, profiles, capture?}` | VSD mirror; `capture` = `{image, w, h}` live window screenshot (only when requested with `live` and capturable) |
| `ww-sd-capture-result` | `data: {image,w,h} \| {unchanged:true} \| {available:false}` | fast-path capture reply (JPEG data URI) |

**Fetch fallback:** `window.fetch` is wrapped so that a cross-origin request blocked by
CORS — or answered with a 403/429 bot wall — is transparently retried through the host
process (which is not subject to browser CORS, and escalates to a real hidden-browser
navigation for TLS-fingerprinting sites like Reddit). Widgets just call `fetch()`.

---

## Layout & slots

Each page is a 4-column × 2-row grid on the 1280×400 canvas. A slot's `size` is a
width — optionally suffixed `-upper` or `-lower` to take only the top or bottom half:

| Width | Full height | `-upper` / `-lower` band |
|---|---|---|
| `quarter` | 320×400 | 320×200 |
| `half` | 640×400 | 640×200 |
| `three-quarter` | 960×400 | 960×200 |
| `full` | 1280×400 | 1280×200 |

Slots are placed first-fit in declaration order (e.g. `quarter-upper` then
`quarter-lower` stack in the same column; a full-height slot occupies both rows).
A page holds 8 half-height cells; anything beyond that is dropped with a log line.

Layout lives in `%LocalAppData%\WaveshareWidgets\layout.json` (pages → slots → widget id,
size, per-instance settings) and is edited by the Settings window. Widgets should be
fluid across their `supported_slots`.

---

## Backgrounds (wallpaper)

The dashboard renders a wallpaper layer behind the pages, iCUE-style. It's set in the
Settings window (a dashboard-wide default, plus an optional per-page override) and stored
in `layout.json` as a `background` object on the layout root and/or on any page:

```jsonc
{
  "background": { "type": "gradient", "color": "#101418", "color2": "#0b0e14", "angle": 135 },
  "pages": [
    { "name": "Home", "background": { "type": "image", "source": "a1b2….png",
        "fit": "cover", "dim": 30, "blur": 8 }, "slots": [ /* … */ ] },
    { "name": "Media", "slots": [ /* inherits the dashboard background */ ] }
  ]
}
```

| Field | Applies to | Value |
|---|---|---|
| `type` | all | `none` \| `color` \| `gradient` \| `image` \| `video` |
| `color` | color, gradient | hex; solid fill or first gradient stop |
| `color2` | gradient | hex; second gradient stop |
| `angle` | gradient | degrees (0–360) |
| `source` | image, video | file name in the backgrounds folder (below) |
| `fit` | image, video | `cover` \| `contain` \| `stretch` \| `tile` \| `center` |
| `dim` | image, video | 0–100 % dark overlay over the wallpaper (not the widgets) |
| `blur` | image, video | 0–40 px gaussian blur |

- **Static** = `image` (PNG/JPG/WebP/AVIF/BMP, plus animated GIF/WebP/AVIF which animate
  on their own). **Animated** = `video` (MP4/WebM/MOV, played muted + looped).
- A page with no `background` inherits the dashboard default; per-page backgrounds
  **crossfade** as you swipe between pages.
- The dim overlay sits above the wallpaper but below the widgets, so widgets stay at full
  brightness while the wallpaper is darkened for legibility.
- Image/video files chosen in Settings are copied into
  `%LocalAppData%\WaveshareWidgets\backgrounds\` under a content-hashed name and served to
  the shell from the `https://backgrounds.wsw/<file>` virtual host. `source` is just the
  file name.
- Widgets paint on top of the wallpaper; it shows through page margins and any widget that
  is itself transparent. A page with zero slots becomes a pure wallpaper screen.
- Stock widgets (clock, CPU, GPU, weather, media, Stream Deck) have a **Background**
  setting — `solid` (default), `glass` (translucent tint), or `transparent` — so they can
  float directly on the wallpaper. Widget authors: paint your base background on `body`
  and honor a `bgStyle` property the same way to fit in.

---

## Design constraints

- The panel is ~170 PPI; keep touch targets ≥ 64 px and body text ≥ 12 px.
- Use viewport-relative units (`vh`, `clamp()`) so a widget scales across slot sizes.
- The panel's real refresh may be ~50 Hz — animate via CSS transitions/vsync, never a
  hardcoded 16.6 ms frame budget.
- Sensor/media updates arrive at the host cadence (~2 s); interpolate in the widget rather
  than polling faster.
- Bundle every asset (including fonts) in the package; never assume a system font.
- Page switching is handled by the shell (edge zones + dots); design widgets to use the
  whole slot for their own content and touch interactions.
