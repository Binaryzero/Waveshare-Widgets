# iCUE Widget API Reference (v1.6.0)

A consolidated reference for the Corsair/Elgato iCUE HTML widget runtime, compiled from
the official documentation (docs.elgato.com/icue/widgets) and extended with the contract
iCUE's **own stock widgets** are actually written against (observed from the iCUE 5.x
stock-widget set: undocumented plugins, environment calls, and runtime behaviors the
official docs omit — each marked *observed* below). This documents the **contract that
iCUE widgets are written against** — the same contract Plinth emulates so those widgets
run on the panel. For what *our* runtime supports of it, see the "Plinth compatibility"
callouts and [WIDGET-SPEC.md](WIDGET-SPEC.md).

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
  - [Notifications Provider](#notifications-provider)
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

**Plinth compatibility:** we install `.icuewidget` files directly, read the same
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

*Observed:* `icueEvents` and every `plugin<Name>Events` global are **predeclared** by
the runtime — stock widgets assign them as bare identifiers from
`<script type="module">` (strict mode), which throws ReferenceError unless the global
property already exists. Some stock widgets also register a third hook,
`icueEvents.onUpdateRequested` (a host-driven manual refresh).

`onDataUpdated` fires on **every** property change, with the new values already assigned
to the corresponding globals. No page reload occurs on a settings change.

Each plugin has a parallel lifecycle:

```js
plugin<Name>Events = { onInitialized: fn };   // e.g. pluginSensorsdataproviderEvents
// readiness flag: plugin<Name>_initialized   // e.g. pluginSensorsdataprovider_initialized
```

Where `<Name>` is the plugin module's last dotted segment with its first letter
capitalized (`sensorsdataprovider` → `Sensorsdataprovider`).

**Plinth compatibility:** all of the above are emulated (`icue-compat.js`). Property
globals are injected before widget scripts via the iframe URL fragment — a declared
property whose value we can't compute still gets its global, as `undefined`, since
widgets read them bare. `icueEvents` and every `plugin<Name>Events` global are
predeclared. `iCUE_initialized` and the `plugin<Name>_initialized` flags flip true
when the init events fire (not before — otherwise the documented late-load handshake
runs handlers twice). `onUpdateRequested` is never fired.

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

**Plinth compatibility:** parsed into our Settings UI. `slider`/`switch`/`textfield`/
`color`/`combobox`/`tab-buttons`/`sensors-factory` are fully supported; `sensors-combobox`
maps to our native sensor picker. `search-combobox` degrades to a text field (its options
come from widget ES-modules we don't execute), and `media-selector` shows a
"not supported yet" note. Expression values are literal-parsed, with three evaluated for
real (see [the `iCUE` global](#the-icue-and-device-globals)): `iCUE.allTimeZones()` as
`data-values`, `iCUE.defaultTimeZone()` / `iCUE.default24HourFormat()` as `data-default`.

*Observed meta names beyond the documented one:* `x-icue-info` (a settings-pane status
row, e.g. `data-type="app-status" application="stream-deck"` on the StreamDeck widget),
`x-icue-widget-group` (marketplace grouping, e.g. `tr('Clock Face')`), and
`x-icue-widget-preview` (a preview image path). Plinth ignores all three — they carry
no runtime behavior. Group entries may also carry an `info` (or `description`) field of
help text; Plinth drops it.

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

**Plinth compatibility:** parsed; group titles render as section headings in Settings.

---

## The `iCUE` and `device` globals

`iCUE` object:

| Member | Type | Description |
|---|---|---|
| `iCUELanguage` | string | Current UI language (`"en"`, `"de"`, …) |
| `fpsLimit` | number | Render FPS limit (default 30) |
| `isPreview` | boolean | True in preview/mimic mode, false on a real device |
| `defaultTemperatureUnit()` | → string | `"°C"` or `"°F"` per iCUE settings |
| `allTimeZones()` *(observed)* | → string[] | Timezone option keys for the stock clocks' comboboxes; keys are shaped `"Area/City ±HH:MM"` (widgets do `.split(' ')[0]`, so bare IANA ids satisfy them too) |
| `defaultTimeZone()` *(observed)* | → string | The machine's timezone in that same key shape |
| `default24HourFormat()` *(observed)* | → string | `"24h"` or `"12h"` — the tab-buttons KEY, not a boolean |
| `ipRegistryApiKey` *(observed)* | string | A Corsair-provisioned api.ipregistry.co key the weather widgets' settings modules use for geo-IP lookup |

`device` object: `deviceId` (string) — UUID without braces, identifies the displaying
device. Injected before widget scripts; pass to plugin methods that need a device id.

**Plinth compatibility:** both emulated. `iCUE.isPreview` is always false;
`defaultTemperatureUnit()` derives from the OS locale; `device.deviceId` is a stable
per-slot pseudo-UUID. The three observed timezone/format calls are provided (backed by
`Intl`), and the *reader* also evaluates them when they appear as meta expressions:
`iCUE.allTimeZones()` in `data-values` becomes the real option list,
`iCUE.defaultTimeZone()` / `iCUE.default24HourFormat()` in `data-default` become real
defaults — previously they parsed to null, so the stock clocks ReferenceError'd on a
fresh install with an option-less combobox no user could repair. `ipRegistryApiKey` is
NOT provided (we have no key to hand out; the modules that read it never execute on
Plinth anyway).

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

**Plinth compatibility:** fully implemented. Our sensor ids come from our own engine
(LibreHardwareMonitor + system counters + Corsair battery), so ids differ from iCUE's —
sensor selections are (re)made in our Settings UI. Types/kinds are mapped from our sensor
model to the vocabulary above.

### Media Data Provider

`widgetbuilder.mediadataprovider:Media:1.0` — `window.plugins.Mediadataprovider`

Properties: `songName` (string), `artist` (string).
Methods: `getSongName(rid)` → string, `getArtist(rid)` → string (async);
`triggerPlayPause()`, `triggerNextTrack()`, `triggerPreviousTrack()` (synchronous).
Signals: `asyncResponse(rid, value)`, plus *(observed)* the property-NOTIFY pair
`songNameChanged(value)` / `artistChanged(value)` — the stock Media widget polls once
at init and then refreshes ONLY from these. **No artwork is exposed by this plugin.**

**Plinth compatibility:** fully implemented, backed by the Windows media session (the
same source our Now Playing widget uses), NOTIFY signals included (emitted whenever
the mirrored values change). Transport controls work.

### Link Provider

`widgetbuilder.linkprovider:Url:1.0` — `window.plugins.Linkprovider`.
Method: `open(link)` — opens the URL in the system browser. Flag:
`pluginLinkprovider_initialized`.

**Plinth compatibility:** implemented; `open()` asks the host to launch the default
browser.

### FPS Data Provider

`widgetbuilder.fpsdataprovider:Fps:1.0` — `window.plugins.Fpsdataprovider`.
Properties: `currentFps` (int), `fpsAvailable` (bool), `currentProcess` (string).
Methods: `getCurrentFps(rid)`, `getFpsAvailable(rid)`, `getCurrentProcess(rid)` (async).
Signals: `asyncResponse`, `fpsUpdated(fps)`, `fpsAvailabilityChanged(available)`,
`processChanged(process)`.

**Plinth compatibility:** stub — reports `fpsAvailable=false`/0 (we don't yet run a
PresentMon-style FPS source), so FPS widgets show "unavailable" rather than hanging.

### Device Action Provider

`widgetbuilder.deviceactionprovider:DeviceAction:1.0` —
`window.plugins.Deviceactionprovider`.
Method: `initDevice(deviceId)` — subscribe to that device's dial/key events.
Signal: `dialTriggered(actionType, dialIndex)` where `actionType` ∈ {`"press"`,
`"long-press"`}. Emitted only on real hardware, never in preview.

**Plinth compatibility:** stub — the panel has no dials, so `initDevice` is a no-op and
`dialTriggered` never fires (matching documented preview behavior).

### Notifications Provider

*(observed — absent from the official docs; contract extracted from the stock
WindowsNotifications widget and the SDK's `SimpleNotificationsApiWrapper`)*

`widgetbuilder.notificationsprovider:Notifications:1.0` —
`window.plugins.Notificationsprovider`

Method (async via `requestId`): `getNotificationCount(rid)` → int.
Signals: `asyncResponse(rid, value)`, `notificationCountChanged()` (no arguments —
subscribers re-poll the count). Standard lifecycle pair:
`pluginNotificationsprovider_initialized` / `pluginNotificationsproviderEvents`.

**Plinth compatibility:** implemented, backed by the host's Windows notification
mirror (the same demand-gated source the stock Notifications widget uses). The count
is the number of currently mirrored toasts; when notification access is denied or
unavailable it reports 0. Polling starts only when a widget first touches the plugin.

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

**Plinth compatibility:** emulated, and **partially** — read the transport note first,
because it decides what works.

**iCUE's plugin is a network client, not a window mirror.** iCUE registers a virtual
device of model **`VSD2/WiFi`** with the Stream Deck app, pairs with it (that is what
the widget's "Go to the Stream Deck app and approve the iCUE connection" card is for),
then receives per-key faces pushed over that connection and sends presses back down it.
Corsair's end of that channel is authenticated and internal, and Plinth cannot speak it.

Plinth's **own** Stream Deck widget is a different mechanism entirely: it mirrors a
local `UI Stream Deck` — Elgato's on-screen Virtual Stream Deck — by capturing its Qt
window and clicking it. The two are not variants of one thing, and treating them as one
is the mistake this section exists to prevent.

So the emulation keeps the plugin's contract and backs it with whichever deck the host
can read, which yields different amounts depending on the kind:

| Device model | What Plinth can do |
|---|---|
| `UI Stream Deck` (Elgato's, local window) | Full mirror: profile faces, live capture sliced into per-key tiles, real key presses. |
| `VSD2/WiFi` (iCUE's, network) | **Read-only.** The profile is on disk, so grid, titles and static key images mirror. Live faces and key presses do **not** work — both need the paired network protocol. |

- `connectStreamDeck(widgetId, deviceId, cols, rows)` starts the mirror;
  `virtualDeviceCreated(widgetId, deviceId)` fires when a readable deck is found (the
  deviceId is the slot's stable pseudo-UUID). Requires the Elgato software, with a
  Virtual Stream Deck open and "Hide unused keys" OFF for the local case.
- A profile of any other model is skipped, and the host names the models it did find in
  `app.log` (`Stream Deck: no readable profile…`) so an unlisted one can be added.
- When the host answers with a network deck, the shim stops polling for capture and
  **refuses presses out loud** in `app.log` rather than posting clicks that go nowhere.
  A widget rendering that deck therefore shows accurate faces whose keys do nothing —
  stated here because the widget itself has no way to display the difference.
- `buttonIconUpdated(widgetId, index, iconDataUrl)` pushes per-key faces: for a local
  deck, slices of the live window capture (dynamic faces included) at ~2 Hz, falling
  back to the profile's key icons; for a network deck, the profile's key icons only. A
  titled key without an icon gets a generated title tile; empty cells push `""`. The
  deck's grid maps position-for-position into the requested `cols`×`rows` (extra keys
  fall off the edge).
- `sendKeyPress(widgetId, index, pressed)` lands as a REAL press/release on a local
  deck's window (press-and-hold works; a press with no release is safety-released after
  10 s). On a network deck it is refused and logged — there is no window to press.
- `updateVirtualDeviceSize` remaps; `streamdeckUnreachable` means "no mirrorable deck"
  — either no profile of a recognized model, or no deck window to capture and click
  (the two are independent, and `app.log` says which);
  `authenticationRequired` / `authenticationRejected` **never fire** (there is no
  pairing handshake in this backend), so widgets never show their pairing states.

The **Embed URL** approach (point an Embed widget at a localhost Stream Deck bridge
such as StreamDeckEmbeded's `http://localhost:28199`) remains as an alternative.

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

**Plinth compatibility:** `uniqueId` is a stable per-slot key, so persistence survives
reloads. Each widget runs on its own origin, so `localStorage` is naturally isolated.

---

## Translations & common tools

`tr('Text')` marks translatable strings (usable in `<title>`, `data-*`, group titles). If
used, a `translation.json` file must sit in the widget root. Current language:
`iCUE.iCUELanguage`.

*Observed:* in the **page** runtime `tr()` returns a **Promise** — stock widgets call
`tr('AM').then(…)` and `await tr(…)` (only meta expressions use it synchronously, in
iCUE's settings host). And the `translation.json` iCUE's own packages ship is
i18next-nested — `{"<lang>": {"translation": {key: text}}}` — not the flat map the
official docs imply.

iCUE ships a `common/` folder of helper JS/CSS (the plugin promise-wrappers, a
`MediaViewer` for `media-selector` output, `TickerTracker`, `DateFormatter`,
`ColorTools`). Marketplace guidance says widgets copy it into their package before
building — but iCUE's **stock** widgets reference it in place, outside their package
(`../common/…`; the StreamDeck widget `../../widgets/common/…`).

**Plinth compatibility:** `tr()` is implemented, backed by the package's
`translation.json` (flat map, per-language, or the nested i18next shape, selected by
UI language), and returns a thenable string — `.then()`/`await` and plain string use
both work. The out-of-package `common/` references are answered by DEFINING the helpers in the
injected shim (`Shell/icue-common.js` — Plinth-authored and API-compatible; the Corsair
originals are all-rights-reserved and are not shipped). The `<script src>` tags
themselves still 404 — nothing serves a path outside the package — but the classes
exist before the widget's first line runs, so that 404 changes nothing. Serving those
URLs was tried first and withdrawn: it failed on a real device while the code was
present, and a filter miss and a missing file are the same silent 404. Each helper is a
window property, so a vendored copy (served normally by the package's own folder
mapping) shadows ours rather than colliding with it. That includes a `MediaViewer` stand-in, so widgets construct
and degrade cleanly even though `media-selector` itself stays unsupported. Fonts
referenced over Qt's `qrc:/` scheme silently fall back to the CSS fallback stack.
