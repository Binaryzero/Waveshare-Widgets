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
| `color` | – | string (hex) |
| `select` | `options: string[]` | string |
| `switch` | – | boolean |
| `sensor` | `sensor_type` (filter) | string (sensor id) |
| `location` | – | string (city name) **or** `{label, latitude, longitude}` (picked) |

```json
{ "name": "accentColor", "label": "Accent Color", "type": "color", "default": "#00d4ff" }
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

// State (current snapshots)
WW.settings          // merged property values, e.g. WW.settings.accentColor
WW.sensors           // SensorReading[] (see Sensor model)
WW.media             // MediaState | null
WW.status            // { elevated: boolean, apiVersion: number }

// Sensor lookup
WW.sensorById(id)                 // exact id -> SensorReading | null
WW.findSensor({                   // heuristic lookup -> SensorReading | null
  type,                           //   sensor type filter, e.g. 'Temperature'
  deviceTypeIncludes,             //   [] of substrings matched on deviceType
  preferredNames,                 //   [] exact-name priority list
  nameIncludes,                   //   [] substring fallback
})

// Actions
WW.mediaControl('toggle' | 'next' | 'prev')   // transport control
WW.log(message)                                // writes to the host app.log
```

`WW.onInit(cb)` fires immediately if data already arrived. All getters are live snapshots
(safe to read any time after init).

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
| `sys:thermal:<zone>` | ACPI thermal zones (firmware-dependent CPU-ish temp) |
| GPU temp/load/VRAM, storage | LibreHardwareMonitor (vendor user-mode DLLs) |
| `corsair:<id>:battery` | iCUE SDK, if `iCUESDK.x64_2019.dll` present + iCUE SDK enabled |

| Needs elevation + PawnIO | Source |
|---|---|
| CPU core temps, fan RPM, voltages, motherboard/SuperIO | LibreHardwareMonitor kernel driver |

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
| `ww-fetch` | `id, url, method, body, contentType` | host-proxied fetch (CORS/bot-wall relief) |

Shell → widget:

| type | payload | meaning |
|---|---|---|
| `ww-init` | `settings, sensors, media, status` | first delivery + on settings change |
| `ww-sensors` | `sensors` | per-tick sensor snapshot |
| `ww-media` | `media` | now-playing changed |
| `ww-fetch-result` | `id, status, contentType, bodyBase64, error` | proxied fetch reply |

**Fetch fallback:** `window.fetch` is wrapped so that a cross-origin request blocked by
CORS — or answered with a 403/429 bot wall — is transparently retried through the host
process (which is not subject to browser CORS, and escalates to a real hidden-browser
navigation for TLS-fingerprinting sites like Reddit). Widgets just call `fetch()`.

---

## Layout & slots

Slots have three widths on the 1280×400 canvas:

| Slot | Pixels |
|---|---|
| `quarter` | 320×400 |
| `half` | 640×400 |
| `full` | 1280×400 |

Layout lives in `%LocalAppData%\WaveshareWidgets\layout.json` (pages → slots → widget id,
size, per-instance settings) and is edited by the Settings window. Widgets should be
fluid across their `supported_slots`.

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
