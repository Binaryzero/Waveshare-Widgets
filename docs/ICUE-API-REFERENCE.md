# iCUE Widget API Reference (v1.4.0)

A consolidated reference for the Corsair/Elgato iCUE HTML widget runtime, compiled from
the official documentation (docs.elgato.com/icue/widgets). This documents the **contract
that iCUE widgets are written against** — the same contract Waveshare Widgets emulates so
those widgets run on the panel. For what *our* runtime supports of it, see the
"Waveshare compatibility" callouts and [WIDGET-SPEC.md](WIDGET-SPEC.md).

> Runtime engine in iCUE: QtWebEngine 6.9.3 (Chromium 130). Minimum iCUE: 5.47.
> A widget is plain HTML/JS/CSS; iCUE injects globals and plugin objects at load.

## Contents

- [Package & manifest](#package--manifest)
- [Lifecycle & injected globals](#lifecycle--injected-globals)
- [Widget controls (`x-icue-property`)](#widget-controls-x-icue-property)
- [Property groups](#property-groups)
- [The `iCUE` and `device` globals](#the-icue-and-device-globals)
- [Plugins](#plugins)
  - [Sensors Data Provider](#sensors-data-provider)
  - [Media Data Provider](#media-data-provider)
  - [Link Provider](#link-provider)
  - [FPS Data Provider](#fps-data-provider)
  - [Device Action Provider](#device-action-provider)
  - [Stream Deck](#stream-deck)
- [Storage](#storage)
- [Translations & common tools](#translations--common-tools)

---

## Package & manifest

A widget is a folder packaged into a `.icuewidget` file (a zip). Minimum contents:
`index.html`, `manifest.json`, and an icon (`icon.svg`/`icon.png`). Optional folders:
`modules/`, `scripts/`, `styles/`, `resources/`, `translation.json`.

`manifest.json` fields:

| Field | Req | Type | Notes |
|---|---|---|---|
| `author` | ✓ | string | Author name |
| `id` | ✓ | string | Reverse-DNS, lowercase `a-z 0-9 - .` only |
| `name` | ✓ | string | Display name |
| `description` | ✓ | string | Marketplace description |
| `version` | ✓ | string | Semver |
| `preview_icon` | ✓ | string | Path to icon, relative to manifest |
| `min_framework_version` | ✓ | string | Min Widget API version, e.g. `"1.0.0"` |
| `os` | ✓ | object[] | Each `{"platform": "windows"}` (only windows currently) |
| `supported_devices` | ✓ | object[] | See below |
| `min_app_version` | – | string | Min iCUE version, e.g. `"5.47"` |
| `interactive` | – | boolean | Enable click/touch handling (default false) |
| `required_plugins` | – | string[] | `"<module>:<Name>:<version>"` entries |
| `modules` | – | string[] | ES-module paths for control expressions |

`supported_devices` entry: `{"type": <deviceType>, "features": [<feature>]}`.
- Device types: `dashboard_lcd` (XENEON EDGE, 2560×720), `keyboard_lcd` (VANGUARD),
  `pump_lcd` (AIO pump caps, ~480×480).
- Only documented feature: `"sensor-screen"` (device can display sensor data).

**Waveshare compatibility:** we install `.icuewidget` files directly, read the same
manifest, and additionally parse `x-icue-property` meta tags (below) as settings. We
ignore `supported_devices` (the panel is a generic 1280×400 surface) and `min_app_version`.

---

## Lifecycle & injected globals

iCUE injects script **before the widget's own scripts run**, making these available at
parse time:

- A global variable per widget control (named by its `content` attribute).
- `iCUE` — utility object (see below).
- `device` — the displaying device (see below).
- `iCUE_initialized` — boolean; true once the API is ready.
- `window.plugins.<Name>` — one object per declared plugin.
- `uniqueId` — this widget instance's storage key (see [Storage](#storage)).

Widgets register handlers on a global `icueEvents` object:

```js
icueEvents = {
    onICUEInitialized: init,   // called once when iCUE + all data are ready
    onDataUpdated: update,     // called on every settings/property change
};

// Late-load handshake: if iCUE already initialized before this script ran,
// call the handlers yourself.
if (iCUE_initialized) { init(); }
```

`onDataUpdated` fires on **every** property change, with the new values already assigned
to the corresponding globals. No page reload occurs on a settings change.

Each plugin has a parallel lifecycle:

```js
plugin<Name>Events = { onInitialized: fn };   // e.g. pluginSensorsdataproviderEvents
// readiness flag: plugin<Name>_initialized   // e.g. pluginSensorsdataprovider_initialized
```

Where `<Name>` is the plugin module's last dotted segment with its first letter
capitalized (`sensorsdataprovider` → `Sensorsdataprovider`).

**Waveshare compatibility:** all of the above are emulated (`icue-compat.js`). Property
globals are injected before widget scripts via the iframe URL fragment; `iCUE_initialized`
flips true when the init events fire; every `plugin<Name>_initialized` flag and
`onInitialized` callback fires.

---

## Widget controls (`x-icue-property`)

User settings are declared as `<meta name="x-icue-property">` tags in `<head>`. Each
becomes a **global variable** named by `content`.

Common attributes: `content` (variable name), `data-label` (UI label), `data-type`
(control type), `data-default`. **Every `data-*` value except `data-type` is a JS
expression** — string literals must be quoted (`data-default="'#FFF'"`), numbers bare
(`data-default="100"`), `tr('…')` usable anywhere.

| `data-type` | Extra attributes | Injected value |
|---|---|---|
| `slider` | `data-min`, `data-max`, `data-step`, `data-unit-label` | `number` |
| `switch` | – | `boolean` |
| `textfield` | – | `string` |
| `color` | – | `string` (hex, e.g. `"#FFFFFF"`) |
| `combobox` | `data-values` (`['a','b']` or `[{'key','value'}]`) | `string` (selected key) |
| `tab-buttons` | `data-values` (2–4 options) | `string` (selected key) |
| `search-combobox` | `data-values` / `data-default` as module functions, `data-placeholder` | `string` (id) |
| `sensors-combobox` | `data-default` (often `plugins.Sensorsdataprovider.getDefaultSensorIdBlock('temperature')`) | `string` (sensor id) |
| `sensors-factory` | `data-default` (default sensor id for new rows) | `[{sensorId, color}]` |
| `media-selector` | `data-filters` (`['*.png','*.jpg']`) | `{pathToAsset, scale, positionX, positionY, baseWidth, baseHeight, angle}` or `undefined` |

Example:

```html
<meta name="x-icue-property" content="opacity" data-label="tr('Opacity')"
      data-type="slider" data-default="100" data-min="0" data-max="100"
      data-step="1" data-unit-label="'%'">
```

**Waveshare compatibility:** parsed into our Settings UI. `slider`/`switch`/`textfield`/
`color`/`combobox`/`tab-buttons`/`sensors-factory` are fully supported; `sensors-combobox`
maps to our native sensor picker. `search-combobox` degrades to a text field (its options
come from widget ES-modules we don't execute), and `media-selector` shows a
"not supported yet" note.

---

## Property groups

Controls are organized into settings sections via a JSON block:

```html
<script type="application/json" id="x-icue-groups">
  [{ "title": "tr('Settings')", "properties": ["opacity"], "info": "tr('Help text')" }]
</script>
```

`title` and `info` support JS expressions (incl. `tr()`). On XENEON EDGE, groups
containing `textColor`/`accentColor`/`backgroundColor` get an automatic "Custom Style"
toggle.

**Waveshare compatibility:** parsed; group titles render as section headings in Settings.

---

## The `iCUE` and `device` globals

`iCUE` object:

| Member | Type | Description |
|---|---|---|
| `iCUELanguage` | string | Current UI language (`"en"`, `"de"`, …) |
| `fpsLimit` | number | Render FPS limit (default 30) |
| `isPreview` | boolean | True in preview/mimic mode, false on a real device |
| `defaultTemperatureUnit()` | → string | `"°C"` or `"°F"` per iCUE settings |

`device` object: `deviceId` (string) — UUID without braces, identifies the displaying
device. Injected before widget scripts; pass to plugin methods that need a device id.

**Waveshare compatibility:** both emulated. `iCUE.isPreview` is always false;
`defaultTemperatureUnit()` derives from the OS locale; `device.deviceId` is a stable
per-slot pseudo-UUID.

---

## Plugins

Declared in `required_plugins` as `"<module>:<Name>:<version>"`. Async getters use a
caller-supplied `requestId` (int) and reply through the plugin's `asyncResponse(requestId,
value)` Qt signal. Signals are subscribed via `.connect(cb)`. iCUE ships promise-based
wrappers (`SimpleSensorApiWrapper`, etc.) that widgets copy locally from `common/plugins/`.

### Sensors Data Provider

`widgetbuilder.sensorsdataprovider:Sensors:1.0` — `window.plugins.Sensorsdataprovider`

Methods (async via `requestId` unless noted):
`getSensorValue(rid, id)` → string · `getSensorUnits(rid, id)` → string ·
`getSensorName(rid, id)` → string · `getSensorDeviceName(rid, id)` → string ·
`getSensorType(rid, id)` → string · `getSensorKind(rid, id)` → string ·
`getAllSensorIds(rid)` → string[] · `sensorIsConnected(rid, id)` → bool ·
`getDefaultSensorId(rid, type, preferredKind)` → string ·
**`getDefaultSensorIdBlock(type, preferredKind)` → string (synchronous/blocking)**.

Default-sensor lookup priority: (1) first sensor matching both type+kind, (2) first
matching type, (3) first available sensor. Empty `preferredKind` = don't filter by kind.

Signals: `asyncResponse(rid, value)`, `sensorValueChanged(id, value)`,
`sensorUnitsChanged(id, units)`, `sensorDataChanged(id)`, `sensorAdded(id)`,
`sensorRemoved(id)`.

Sensor **types**: `temperature`, `pump`, `fan`, `voltage`, `load`, `cas-latency`,
`command-rate`, `cycle-time`, `dram-frequency`, `ras-precharge`, `ras-to-cas-delay`,
`current`, `power`, `battery-charge`, `battery-status`, `efficiency`, `fps`, `pin-protect`.

Sensor **kinds** (subcategory, used for the default-lookup tiebreaker): `default`, `core`,
`package`, `cpu-temp`, `gpu-temp`, `cpu-pump`, `gpu-pump`, `gpu-load`, `memory-load`,
`frame-buffer-load`, `video-engine-load`, `bus-interface-load`, the `power-*`/`voltage-*`/
`current-*` rail kinds, and `invalid`.

**Waveshare compatibility:** fully implemented. Our sensor ids come from our own engine
(LibreHardwareMonitor + system counters + Corsair battery), so ids differ from iCUE's —
sensor selections are (re)made in our Settings UI. Types/kinds are mapped from our sensor
model to the vocabulary above.

### Media Data Provider

`widgetbuilder.mediadataprovider:Media:1.0` — `window.plugins.Mediadataprovider`

Properties: `songName` (string), `artist` (string).
Methods: `getSongName(rid)` → string, `getArtist(rid)` → string (async);
`triggerPlayPause()`, `triggerNextTrack()`, `triggerPreviousTrack()` (synchronous).
Signal: `asyncResponse(rid, value)`. **No artwork is exposed by this plugin.**

**Waveshare compatibility:** fully implemented, backed by the Windows media session (the
same source our Now Playing widget uses). Transport controls work.

### Link Provider

`widgetbuilder.linkprovider:Url:1.0` — `window.plugins.Linkprovider`.
Method: `open(link)` — opens the URL in the system browser. Flag:
`pluginLinkprovider_initialized`.

**Waveshare compatibility:** implemented; `open()` asks the host to launch the default
browser.

### FPS Data Provider

`widgetbuilder.fpsdataprovider:Fps:1.0` — `window.plugins.Fpsdataprovider`.
Properties: `currentFps` (int), `fpsAvailable` (bool), `currentProcess` (string).
Methods: `getCurrentFps(rid)`, `getFpsAvailable(rid)`, `getCurrentProcess(rid)` (async).
Signals: `asyncResponse`, `fpsUpdated(fps)`, `fpsAvailabilityChanged(available)`,
`processChanged(process)`.

**Waveshare compatibility:** stub — reports `fpsAvailable=false`/0 (we don't yet run a
PresentMon-style FPS source), so FPS widgets show "unavailable" rather than hanging.

### Device Action Provider

`widgetbuilder.deviceactionprovider:DeviceAction:1.0` —
`window.plugins.Deviceactionprovider`.
Method: `initDevice(deviceId)` — subscribe to that device's dial/key events.
Signal: `dialTriggered(actionType, dialIndex)` where `actionType` ∈ {`"press"`,
`"long-press"`}. Emitted only on real hardware, never in preview.

**Waveshare compatibility:** stub — the panel has no dials, so `initDevice` is a no-op and
`dialTriggered` never fires (matching documented preview behavior).

### Stream Deck

`widgetbuilder.streamdeck:StreamDeck:1.0` — `window.plugins.Streamdeck`.
Methods: `connectStreamDeck(widgetId, deviceId, columns, rows)`,
`reconnectStreamDeck(widgetId)`, `disconnectStreamDeck(widgetId)`,
`updateVirtualDeviceSize(widgetId, columns, rows)`,
`sendKeyPress(widgetId, buttonIndex, pressed)` (row-major: `index = row*columns + col`).
Signals: `virtualDeviceCreated(widgetId, deviceId)`,
`buttonIconUpdated(widgetId, buttonIndex, iconDataUrl)` (icon as a `data:` URL),
`streamdeckUnreachable`, `authenticationRequired`, `authenticationRejected`.
Uses `iCUE.widgetId` and `iCUE.streamDeckDeviceId`.

**Waveshare compatibility:** not implemented — this plugin bridges to Corsair's internal
Stream Deck provider, which we can't reach. See [WIDGET-SPEC.md](WIDGET-SPEC.md) and the
README for the **Embed URL** approach (point it at a localhost Stream Deck bridge such as
StreamDeckEmbeded's `http://localhost:28199`) to get a touch Stream Deck without this
plugin.

---

## Storage

Standard Web Storage. Each widget **instance** has a unique id exposed as the global
`uniqueId`; widgets store a single JSON blob under `localStorage[uniqueId]`:

```js
const state = JSON.parse(localStorage.getItem(uniqueId) || "{}");
state.foo = 1;
localStorage.setItem(uniqueId, JSON.stringify(state));
```

Widgets may also listen for the `storage` event on their own key to react to changes from
another live context (settings preview vs on-device). Limit is the browser's ~5–10 MB.

**Waveshare compatibility:** `uniqueId` is a stable per-slot key, so persistence survives
reloads. Each widget runs on its own origin, so `localStorage` is naturally isolated.

---

## Translations & common tools

`tr('Text')` marks translatable strings (usable in `<title>`, `data-*`, group titles). If
used, a `translation.json` file must sit in the widget root. Current language:
`iCUE.iCUELanguage`.

iCUE ships a `common/` folder of helper JS/CSS (the plugin promise-wrappers, a
`MediaViewer` for `media-selector` output) that widgets copy into their package before
building.

**Waveshare compatibility:** `tr()` is implemented, backed by the package's
`translation.json` (flat map or per-language). The promise-wrappers work because the
underlying plugin objects match the documented API. `MediaViewer` isn't provided (no
`media-selector` support yet).
