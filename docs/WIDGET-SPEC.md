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
    { "name": "city", "label": "City", "type": "text", "default": "Berlin" },
    { "name": "scale", "label": "Scale", "type": "slider", "min": 0.5, "max": 2, "step": 0.1, "default": 1 },
    { "name": "mode", "label": "Mode", "type": "select", "options": ["simple", "detailed"], "default": "simple" },
    { "name": "tempSensorId", "label": "Sensor", "type": "sensor", "sensor_type": "Temperature", "default": "" }
  ]
}
```

- `id` — globally unique, reverse-DNS style. Also determines the install folder and the
  widget's browser origin.
- `supported_slots` — which widths the widget looks good in: `quarter` (320px), `half`
  (640px), `full` (1280px). Widgets declaring `half` or `full` are also offered at
  `three-quarter` (960px), and every width can be placed full-height (400px) or in the
  top/bottom 200px band (`-upper`/`-lower`). The iframe fills the slot, so design
  fluidly — and size any dominant text with `WW.fitText` rather than viewport units,
  which measure only the axis you name (see the design guidance below). Declare only
  the widths the widget genuinely reads well in: an offered size the widget cannot use
  is a control the user taps and nothing happens.
- `properties` — user-configurable settings. The host merges `default`s with the
  per-instance `settings` from `layout.json` and injects the result. Types: `text`,
  `number`, `slider`, `color`, `select`, `secret` (below), `sensor` (a sensor id string),
  `sensors-factory` (an add/remove list of sensors, optionally filtered by
  `sensor_type`; the value is `[{sensorId, color}]`),
  `location`
  (rendered as a city-search picker; the value is either a raw string the widget should
  best-match itself, or a picked `{label, latitude, longitude}` object — handle both,
  like the stock weather widget), and `list` (below).

  **Credentials MUST use `type: "secret"`** — bearer tokens, PATs, client secrets, API
  keys, and credential-equivalent URLs (a private ICS or webhook link — the URL *is*
  the credential, since anyone holding it can read or post). The host
  encrypts those values with Windows DPAPI (CurrentUser scope) before `layout.json` is
  written, so the file carries no usable credential; the settings editor renders a
  masked field and never receives a stored value back (it shows only that one is saved).
  Your widget's side is unchanged: the decrypted string arrives in `WW.settings` /
  the injected global exactly like a `text` property, and an unset or unreadable secret
  arrives as `""` — render your "not configured" state for that, never a spinner.

  ```json
  { "name": "apiToken", "label": "API token", "type": "secret",
    "placeholder": "Paste the token from the service's settings page" }
  ```

  **This is enforced at install, not just at build.** The host applies the same rule
  when it installs a package and when it rescans the widgets folder: a manifest that
  declares a credential-looking property as anything but `secret` is **refused** — the
  widget does not load, and the settings window says which property and why. iCUE-style
  widgets are checked after their `index.html` meta tags are parsed, so declaring
  settings there is not a way around it. The rule lives twice (`tools/validate-widget.js`
  and `CredentialNames.cs`) and both are held to `tools/credential-names.json` in CI, so
  the validator and the host cannot disagree about what counts.

  A refusal does not abandon whatever the layout already holds for that widget. The host
  keeps the offending property names as redaction metadata, so the stored values stay on
  the secret pipeline: they are masked out of the settings window, and a save restores
  (and encrypts) them rather than writing the editor's blank over them. Repairing the
  manifest and letting the folder rescan is all that is needed to get the widget back.

  Declare no `default` for a secret. Two consequences of DPAPI worth knowing: the
  ciphertext is bound to **this Windows user on this machine**, so a `layout.json`
  copied elsewhere loses its secrets (they must be re-entered — everything else in the
  file still travels), and a widget previewed in the settings window sees an empty
  secret, so its unauthenticated state is what the preview shows. Widgets that used
  `text` for a credential should switch: the validator now fails
  credential-looking names on any other type (`prop-secret`), and an existing plaintext
  value is encrypted the first time it is saved after the switch. That check catches
  the obvious spellings — token, secret, password, api key, PAT — plus `webhook…` and a
  url/link/endpoint qualified as private, signed, or personal. It cannot judge a name
  like `icsUrl` or `feedUrl`, which may be a public feed or a secret address; if yours
  is secret, declare it `secret` regardless of what the validator says.

  **`color` properties are reserved for data colors** — colors that are *content*, such
  as a per-series line color, where two instances legitimately differ as data. Never
  declare color properties for appearance (text, labels, accents, backgrounds, state
  colors): appearance is single-sourced from the design tokens — the global theme plus
  the per-slot style override (the 🎨 editor / the slot's `style` in `layout.json`) —
  so style with `var(--token)` and it follows automatically. See
  [WIDGET-STANDARD.md](WIDGET-STANDARD.md).

  **Never ask the user to type structured data.** A property whose value is really a
  collection must use `type: "list"` — the settings window renders add/remove rows with
  one input per field, and the stored value is an array of plain objects:

  ```json
  { "name": "hosts", "label": "Hosts", "type": "list", "itemLabel": "host",
    "fields": [
      { "key": "label", "label": "Name", "type": "text", "placeholder": "Router" },
      { "key": "host",  "label": "Host / IP", "type": "text", "placeholder": "192.168.1.1" }
    ],
    "default": [ { "label": "Router", "host": "192.168.1.1" } ] }
  ```

  Text properties support a `placeholder` — the sanctioned place to show an expected
  format (e.g. `"2026-12-24 18:00"`); labels must never teach syntax.

  Text properties and list fields may also declare a `picker` to add a picker button
  next to the free-text input (typing always stays available):
  - `"picker": "emoji"` — an emoji grid for icon fields; the pick replaces the whole
    value (deck button icons).
  - `"picker": "emoji-prefix"` — the same grid for fields where a *leading* emoji is
    the icon and the rest is text (launcher shortcut names): the pick swaps only the
    leading emoji and keeps the text after it.
  - `"picker": "file"` — a native file browser that fills the field with the chosen
    path (desktop settings window only; the on-device editor keeps free text).

  Field types: `text` and `color`. A widget upgraded from an older text property should
  keep accepting its legacy string form from saved layouts (the editor converts
  `"A=B, C=D"` strings to rows on screen, but the saved value only becomes an array once
  the user edits it). Labels must never describe a syntax ("comma separated", "JSON") —
  if you need one, the property should have been a `list`.

  A `select` may declare `optionsSource` instead of a static `options` array; the
  settings window fills the dropdown from the host at edit time. Sources:
  `"sd-profiles"` (installed Virtual Stream Deck profile names; `""` still means
  "first available").

## The widget API (`window.WW`)

Include the API from the shell's origin:

```html
<script src="https://app.wsw/widget-api.js"></script>
```

```js
WW.onInit(({ settings, sensors, media, status }) => { /* first data delivery */ });
WW.onSensors((sensors) => { /* every ~2 s */ });
WW.onMedia((media) => { /* when now-playing changes */ });
WW.onTheme((theme) => { /* live token change (style edits); tokens are already on :root */ });

WW.settings          // merged property values, e.g. WW.settings.city
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
WW.ping(hosts)                                 // real ICMP pings via the host process
WW.listMedia()                                 // list the user's media folder -> [{name, url, kind}]
WW.getAudio()                                  // Windows volume mixer snapshot (master + sessions)
WW.setAudio(target, {level?, muted?})          // set master ('master') or per-app volume/mute; resolves {ok}

WW.watchNotifications(true)                    // start the host's notification mirror (demand-gated)
WW.notifications                               // {state: 'allowed'|'denied'|'unavailable', items:[{id, app, appId, title, body, time}]}
WW.onNotifications((n) => { ... })             // fires when the mirrored list changes
WW.dismissNotification(id)                     // dismiss one toast by id

WW.game                                        // {active, process} — a fullscreen game is foreground
WW.onGame((g) => { ... })                      // fires on TRANSITIONS only — seed from WW.game at init
```

Game mode also stamps `html[data-game="on"|"off"]` in every widget, and
`widget-base.css` pauses ALL CSS animation while on — JS work is yours to gate via
`WW.onGame`. Seed your paused flag from `WW.game.active` (or `state.game`, which
`ww-init` carries) inside `onInit`: `onGame` reports later flips, not the state you
started in, so a widget that only listens polls straight through a game that was
already running when it loaded. Notification strings are untrusted external text: render them with
`textContent`, never `innerHTML`. Windows only grants the notification listener to
apps with **package identity** (MSIX-installed); on the portable zip install expect
`state` to come back `denied` or `unavailable`, and design for it — the stock
notifications widget shows an explanatory card instead of an empty list. A slot can also opt out of game time entirely with
the "hide during games" checkbox in Settings (`hideInGame` in layout.json) — the shell
hides it and returns it to the same grid cell afterwards.

`WW.fetch` extras: `init.headers` (plain object, `Headers` instance, or `[[k,v]]`
pairs — all shapes survive the host proxy hop, so authenticated APIs keep their
`Authorization` header when the request escalates), and
`init.insecure: true` skips certificate validation — honored only for private/loopback
literal IPs (for self-signed devices like the Hue bridge). Insecure LAN requests go
over HTTP/1.1 on a single serialized connection per device, since embedded TLS
servers mishandle h2 offers and parallel handshakes. `WW.listMedia()` URLs are on
`https://media.wsw/`, mapped to the media folder ("Open media folder" in Settings).

Sensor `type` values follow LibreHardwareMonitor: `Temperature` (°C), `Load` (%),
`Clock` (MHz), `Fan` (RPM), `Power` (W), `Data` (GB), `Throughput` (B/s), `Voltage` (V),
and more. Values can be `null` when a source is unavailable — always render a placeholder.

Zero-elevation sensors are always present: `sys:cpu:load`, `sys:mem:load`,
`sys:mem:used`, `sys:mem:total`, `sys:net:down`, `sys:net:up`,
`sys:idle:seconds` (seconds since the last keyboard/mouse input, type `Idle`,
units `s` — for "is the user at the PC" logic like the vitals widget's
away-freeze), plus firmware-dependent
ACPI thermal zones as `sys:thermal:<zone>` (deviceType `System`, type `Temperature`).
Bluetooth device and laptop batteries appear as `battery:<slug>` (type `Battery`,
units `%`); devices on a 2.4 GHz dongle (Slipstream/Unifying) don't expose battery here.
Precise CPU core temperature and motherboard/SuperIO sensors (fan headers, voltages)
only exist when the host runs elevated **and** PawnIO is installed — both, either alone
yields nothing (`WW.status.elevated` tells you; degrade gracefully like the stock CPU
widget, which falls back to a thermal zone). Fan RPMs from GPUs and from USB fan/AIO
controllers appear without elevation.

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

## Design tokens & theming

Stock widgets share a design system. `widget-base.css` (linked from
`https://app.wsw/widget-base.css`) carries the design tokens (`--surface`, `--text`,
`--accent`, …), the `bgStyle` panel-opacity classes and the standard component classes;
the host derives a token palette from the user's theme and pushes it into every widget at
init (readable as `WW.theme`, applied to `:root` automatically). Style with the tokens —
never literal colors — and your widget follows any theme with zero code. The full
standard — token table, required states, motion/touch/performance rules and the
compliance checklist — is [WIDGET-STANDARD.md](WIDGET-STANDARD.md).

## Design guidance for the 1280×400 strip

- The panel is ~170 PPI; keep touch targets ≥ 64 px and body text ≥ 12 px.
- **Fit dominant text with `WW.fitText`, not viewport units.** `vh`/`vw` do measure the
  slot — the iframe is the tile — but a rule written against one axis says nothing about
  the other, and that is a clipping bug rather than a cosmetic one. The stock clock sized
  its time on `34vh` alone: correct at full width, and in a 320×400 quarter it asked for
  136px glyphs across 320px of tile, so `09:11:52` rendered as `9:11:5` with a digit lost
  at each end (#76). A `vw` term instead is no better when the string length depends on a
  setting. Viewport units remain fine for padding, gaps and secondary chrome.
- Prefer a `min()` of both axes over a single-axis `clamp()` where you do size in
  viewport units, so a narrow slot cannot be sized purely by height.
- Dark backgrounds (`#0b0e14`-ish) match the stock widgets and the OLED-like bezel.
- Data updates arrive at the host's poll cadence (~2 s); animate transitions in CSS
  rather than polling faster. The panel's real refresh rate may be ~50 Hz — avoid
  hardcoded 16.6 ms frame budgets.
