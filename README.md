# Waveshare Widgets

An [iCUE-widgets](https://marketplace.elgato.com/icue/widgets)-style dashboard for the
[Waveshare 7.9inch HDMI LCD](https://www.waveshare.com/wiki/7.9inch_HDMI_LCD) (1280×400 touch strip)
on Windows 10/11.

A single tray app pins a borderless, never-focused window to the panel and renders
swipeable pages of **widgets** — small HTML/JS apps showing CPU/GPU telemetry, clocks,
now-playing media, weather, or anything else. Widgets are plain web tech packaged as
`.wswidget` files, deliberately close to the iCUE widget model, so anyone can build one.

```
┌─────────────────────────────────────────────────────────────┐
│  ┌──────────────────────────┐  ┌──────────────────────────┐ │
│  │   CPU  ◔ 34%   62°C      │  │   GPU  ◔ 71%   68°C      │ │   ← page 1 (swipe →)
│  └──────────────────────────┘  └──────────────────────────┘ │
│                            ● ○ ○                            │
└─────────────────────────────────────────────────────────────┘
                    1280 × 400 (landscape)
```

## Features (v1)

- **Auto-detects the panel** by its unique 1280×400 / 400×1280 resolution signature
  (overridable from the tray menu), and survives the panel's ~10 s power-on delay and
  hotplug via display-change events.
- **Never steals focus** — the window uses `WS_EX_NOACTIVATE`, so touch taps don't
  interrupt your game.
- **Swipeable pages** of widgets in three slot sizes: `quarter` (320×400), `half`
  (640×400), `full` (1280×400).
- **Sensors** from [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor)
  (CPU/GPU/memory/storage/motherboard) plus zero-elevation fallbacks (performance
  counters, memory status), media now-playing + transport control via Windows
  (`GlobalSystemMediaTransportControls`), and anything a widget fetches itself
  (e.g. the weather widget calls Open-Meteo).
- **Widget packages**: a `.wswidget` file is a zip of `manifest.json` + `index.html`.
  Install via the tray menu, or drop a folder into the widgets directory —
  changes hot-reload. Each widget runs in a sandboxed iframe on its own origin.
- **Settings UI**: tray → **Settings…** opens a visual editor for pages, slots, and
  every widget's declared properties (colors, sliders, sensor pickers) — no JSON
  editing required.
- **Five stock widgets**: CPU, GPU, Clock, Now Playing, Weather.
- **iCUE widget compatibility**: many `.icuewidget` packages from the
  [Elgato Marketplace](https://marketplace.elgato.com/icue/widgets) install and run
  as-is — the runtime emulates the `Sensorsdataprovider` plugin API and reads
  `x-icue-property` settings (including sensor lists) into the Settings UI. Widgets
  wired to our sensor engine expose whatever your machine provides; iCUE-only data
  sources (Corsair device internals, background media) are not available.

## Hardware setup (do this first)

1. Connect the panel's **HDMI** port to your GPU and its **TOUCH** USB port to the PC.
   Both video and touch are driver-free. Allow ~10 seconds for the panel to display.
2. The panel's native scanout is **portrait 400×1280**. Go to **Settings → Display**,
   select the panel, set **Extend these displays**, and change **Display orientation**
   to **Landscape (flipped)** or **Landscape** so it becomes 1280×400.
3. **Fix touch mapping** (touch defaults to your *primary* monitor): search Windows
   settings for **"Calibrate the screen for pen and touch input"** → **Setup…**, press
   Enter until the "tap this screen" prompt appears on the Waveshare panel, then tap it.
4. **Power**: the TOUCH USB port powers the panel and needs ≥500 mA. If the panel is
   unstable (especially at high brightness), feed the separate power port with 5 V/2 A.
5. Brightness is hardware-only (long-press the panel's ON/OFF button); there is no
   DDC/CI software control.

## Install & run

Download the latest zip from the [Releases page](../../releases):

- `WaveshareWidgets-vX.Y.Z-win-x64.zip` — small; needs the
  [.NET 8 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/8.0)
- `WaveshareWidgets-vX.Y.Z-win-x64-self-contained.zip` — bigger; runs with nothing
  preinstalled

Unzip and run `WaveshareWidgets.exe`. Requirements: Windows 10 1809+ or Windows 11, and
the WebView2 Runtime (preinstalled on Windows 11 and current Windows 10). Development
builds of every commit are available as [Actions artifacts](../../actions).

The app lives in the system tray. Right-click it for: **Settings…** (the layout and
widget-property editor), reload, open widgets folder, install widget packages, pick
the display, and start-with-Windows.

### About CPU temperature

Windows has **no driver-free API for CPU core temperature** — every monitoring tool
(HWiNFO, AIDA64, Afterburner, Fan Control) ships a kernel driver for it. This app
handles that in tiers:

1. **Zero-install (default):** it reads Windows' built-in ACPI **thermal zone**
   counters. On many boards this tracks the CPU package well; on some desktops the
   zone is missing or coarse. No admin, no drivers.
2. **Accurate CPU cores/fans/voltages:** install [PawnIO](https://pawnio.eu/) (the
   Microsoft-attested, sandboxed driver also used by Fan Control, LibreHardwareMonitor
   and OpenRGB) and run the app **as administrator**.

Everything else — GPU stats, memory, network, media, clock, weather — works unelevated
with nothing extra installed.

### Corsair wireless battery levels (optional)

If you run iCUE, battery percentages for Corsair wireless keyboards/mice/headsets can
appear as sensors (`corsair:*:battery`): download the client DLL
(`iCUESDK.x64_2019.dll`) from the [cue-sdk releases](https://github.com/CorsairOfficial/cue-sdk/releases),
drop it next to `WaveshareWidgets.exe`, and enable the SDK toggle in iCUE's settings.
Note that Corsair's public SDK exposes no system temperatures or fan speeds — those
remain iCUE-internal, which is why the app reads hardware itself.

> **Defender note:** if an older build ever triggered a "Threats found" warning, that
> was the WinRing0 driver embedded in LibreHardwareMonitorLib ≤ 0.9.4. This app now
> uses 0.9.6+, which has no WinRing0; let Defender remove the quarantined file and
> delete any leftover `WinRing0x64.sys` next to the exe.

## Configuration

Everything lives in `%LocalAppData%\WaveshareWidgets\`:

| File | Purpose |
|---|---|
| `layout.json` | Pages and slots — which widget goes where, with per-instance settings |
| `config.json` | Display override, poll interval, dev tools toggle |
| `widgets\` | Installed widgets (one folder per widget) |
| `app.log` | Diagnostics |

Example `layout.json`:

```json
{
  "pages": [
    {
      "name": "System",
      "slots": [
        { "widgetId": "ws.stock.cpu", "size": "half" },
        { "widgetId": "ws.stock.gpu", "size": "half", "settings": { "accentColor": "#ff5577" } }
      ]
    },
    {
      "name": "Day",
      "slots": [
        { "widgetId": "ws.stock.clock", "size": "half", "settings": { "hour12": "on" } },
        { "widgetId": "ws.stock.weather", "size": "half",
          "settings": { "location": "Seattle", "units": "fahrenheit" } }
      ]
    }
  ]
}
```

The Settings window edits this file for you (and reloads the dashboard on save); the
JSON stays hand-editable for scripting or syncing between machines. The dashboard also
hot-reloads whenever widget files change on disk.

## Building widgets

A widget is a folder with a `manifest.json` and an `index.html`, zipped into a
`.wswidget`. Sensor data, settings, and media transport arrive through a tiny JS API
(`window.WW`). See **[docs/WIDGET-SPEC.md](docs/WIDGET-SPEC.md)** — the stock widgets in
[`widgets/`](widgets/) are working examples you can copy.

## Building from source

```powershell
dotnet publish src/WaveshareWidgets/WaveshareWidgets.csproj -c Release -r win-x64 --self-contained false -o publish
```

Requires the .NET 8 SDK on Windows (CI does exactly this; non-Windows SDKs can compile
with `EnableWindowsTargeting` but the app only runs on Windows).

## Releasing

Push a version tag and CI publishes the GitHub Release with both zips and generated
notes:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

Running the `release` workflow manually (workflow_dispatch) is a dry run: it builds the
same zips and uploads them as workflow artifacts without creating a release.

## Architecture

Single .NET 8 process: tray shell → borderless WebView2 window on the panel → widgets in
per-origin sandboxed iframes, fed by an in-process sensor hub (LibreHardwareMonitorLib +
Windows APIs) over a JSON `postMessage` bridge. Rationale, alternatives considered, and
security model: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.
