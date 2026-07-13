# Widget Specification (API v1)

A widget is a small web app rendered in a sandboxed iframe on the dashboard. This format
is deliberately close to Elgato/Corsair's iCUE widget model: a folder with a manifest and
an `index.html`, zipped for distribution.

## Package layout

```
my-widget/
├── manifest.json      required
├── index.html         required — the widget's entire UI
├── preview.png        optional
└── assets/…           optional (scripts, styles, images, fonts)
```

Zip the *contents* of the folder (manifest at the zip root) and rename to `.wswidget`:

```powershell
Compress-Archive -Path my-widget\* -DestinationPath my-widget.zip
Rename-Item my-widget.zip my-widget.wswidget
```

Install via tray → **Install widget…**, or unzip the folder directly into
`%LocalAppData%\WaveshareWidgets\widgets\`. File changes hot-reload the dashboard.

## manifest.json

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
  "properties": [
    { "name": "accentColor", "label": "Accent Color", "type": "color", "default": "#00d4ff" },
    { "name": "city", "label": "City", "type": "text", "default": "Berlin" },
    { "name": "scale", "label": "Scale", "type": "slider", "min": 0.5, "max": 2, "step": 0.1, "default": 1 },
    { "name": "mode", "label": "Mode", "type": "select", "options": ["simple", "detailed"], "default": "simple" },
    { "name": "tempSensorId", "label": "Sensor", "type": "sensor", "sensor_type": "Temperature", "default": "" }
  ]
}
```

- `id` — globally unique, reverse-DNS style. Also determines the install folder and the
  widget's browser origin.
- `supported_slots` — which of `quarter` (320×400), `half` (640×400), `full` (1280×400)
  the widget looks good in. Design fluidly; the iframe fills the slot.
- `properties` — user-configurable settings. The host merges `default`s with the
  per-instance `settings` from `layout.json` and injects the result. Types: `text`,
  `number`, `slider`, `color`, `select`, `sensor` (a sensor id string), and `location`
  (rendered as a city-search picker; the value is either a raw string the widget should
  best-match itself, or a picked `{label, latitude, longitude}` object — handle both,
  like the stock weather widget).

## The widget API (`window.WW`)

Include the API from the shell's origin:

```html
<script src="https://app.wsw/widget-api.js"></script>
```

```js
WW.onInit(({ settings, sensors, media, status }) => { /* first data delivery */ });
WW.onSensors((sensors) => { /* every ~2 s */ });
WW.onMedia((media) => { /* when now-playing changes */ });

WW.settings          // merged property values, e.g. WW.settings.accentColor
WW.sensors           // latest snapshot: [{id, name, device, deviceType, type, units, value}]
WW.media             // {available, title, artist, album, status, thumbnail}
WW.status            // {elevated, apiVersion}

WW.sensorById('lhm:/gpu-nvidia/0/temperature/0')
WW.findSensor({      // heuristic lookup
  type: 'Temperature',                  // sensor type filter
  deviceTypeIncludes: ['cpu'],          // substring match on deviceType
  preferredNames: ['CPU Package'],      // exact-name priority list
  nameIncludes: ['package'],            // substring fallback
})

WW.mediaControl('toggle' | 'next' | 'prev')   // transport control
WW.log('debug message')                        // writes to the host's app.log
WW.fetch(url, init)                            // fetch() with host-proxied CORS/bot-wall fallback
```

Sensor `type` values follow LibreHardwareMonitor: `Temperature` (°C), `Load` (%),
`Clock` (MHz), `Fan` (RPM), `Power` (W), `Data` (GB), `Throughput` (B/s), `Voltage` (V),
and more. Values can be `null` when a source is unavailable — always render a placeholder.

Zero-elevation sensors are always present: `sys:cpu:load`, `sys:mem:load`,
`sys:mem:used`, `sys:mem:total`, `sys:net:down`, `sys:net:up`, plus firmware-dependent
ACPI thermal zones as `sys:thermal:<zone>` (deviceType `System`, type `Temperature`).
Precise CPU core temperature and fan/motherboard sensors only exist when the host runs
elevated with PawnIO installed (`WW.status.elevated` tells you; degrade gracefully like
the stock CPU widget, which falls back to a thermal zone).

## iCUE widget compatibility

Packages built for iCUE (`.icuewidget`) can usually be installed directly. The host
provides a compatibility layer inside every widget iframe:

- `window.plugins.Sensorsdataprovider` with the Qt-style async contract
  (`method(requestId, …)` answered via the `asyncResponse` signal), plus
  `sensorValueChanged` / `sensorUnitsChanged` / `sensorAdded` / `sensorRemoved` signals.
- Lifecycle callbacks: `pluginSensorsdataproviderEvents.onInitialized()`,
  `pluginLinkproviderEvents.onInitialized()` and `icueEvents.onICUEInitialized()` after
  DOM-ready, `icueEvents.onDataUpdated()` when settings are re-delivered.
- `<meta name="x-icue-property">` declarations are parsed into the Settings UI
  (`switch`, `slider`, `color`, `textfield`, and `sensors-factory` — the add-sensors
  list). Values are injected as global variables before the lifecycle events fire.
- `tr()` backed by the package's `translation.json` (flat or per-language maps).
- `window.plugins.Linkprovider.open(url)` opens the URL in the default desktop browser.
- CORS relief: iCUE's embedded browser is CORS-relaxed, ours is not — so when a
  widget's `fetch()` fails at the network/CORS layer, the shim transparently retries it
  through the host process (GET/POST/HEAD, 5 MB cap, 15 s timeout). Reddit readers and
  similar API widgets work unmodified.

Not emulated: `media-selector` properties (background media), Corsair-device-specific
sensors, and the Virtual Stream Deck integration. Sensor ids differ from iCUE's, so
sensor selections must be (re)made in our Settings UI.

## Rules of the sandbox

- Each widget runs on its own origin (`https://<id-slug>.widgets.wsw`) in an iframe with
  `sandbox="allow-scripts allow-same-origin"`. You get `localStorage` scoped to your
  widget, and you can `fetch()` external HTTPS APIs (the stock weather widget does).
- You cannot touch the shell page, other widgets, or the host process. The only channel
  to the host is the `WW` message API.
- No Node/filesystem access. Bundle every asset — including fonts — in the package;
  never assume a font is installed.

## Design guidance for the 1280×400 strip

- The panel is ~170 PPI; keep touch targets ≥ 64 px and body text ≥ 12 px.
- Use viewport-relative sizes (`vh`/`clamp()`) so the widget scales across slot sizes.
- Dark backgrounds (`#0b0e14`-ish) match the stock widgets and the OLED-like bezel.
- Data updates arrive at the host's poll cadence (~2 s); animate transitions in CSS
  rather than polling faster. The panel's real refresh rate may be ~50 Hz — avoid
  hardcoded 16.6 ms frame budgets.
