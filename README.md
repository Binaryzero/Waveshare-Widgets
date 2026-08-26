# Plinth

An [iCUE-widgets](https://marketplace.elgato.com/icue/widgets)-style dashboard for the
[Waveshare 7.9inch HDMI LCD](https://www.waveshare.com/wiki/7.9inch_HDMI_LCD) (1280×400 touch strip)
on Windows 10/11.

A single tray app pins a borderless, never-focused window to the panel and renders
swipeable pages of **widgets** — small HTML/JS apps showing CPU/GPU telemetry, clocks,
now-playing media, weather, or anything else. Widgets are plain web tech packaged as
`.plinthwidget` files, deliberately close to the iCUE widget model, so anyone can build one.

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
- **Swipeable pages** of widgets on a 4×2 slot grid: widths `quarter` (320px),
  `half` (640px), `three-quarter` (960px), `full` (1280px), each at full height
  or subdivided into an upper/lower band (200px). Per-page and global wallpaper
  (image/video/gradient, AVIF included) shows through widgets' transparent
  background style.
- **Sensors** from [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor)
  (CPU/GPU/memory/storage/motherboard, plus USB fan/AIO controllers and digital
  PSUs) plus zero-elevation fallbacks (performance
  counters, memory status), Bluetooth/laptop battery levels via Windows PnP,
  media now-playing + transport control via Windows
  (`GlobalSystemMediaTransportControls`), and anything a widget fetches itself
  (e.g. the weather widget calls Open-Meteo).
- **Widget packages**: a `.plinthwidget` file is a zip of `manifest.json` + `index.html`.
  Install via the tray menu, or drop a folder into the widgets directory —
  changes hot-reload. Each widget runs in a sandboxed iframe on its own origin.
- **Edit on the screen itself**: tap the pencil in the panel's corner to rearrange
  the dashboard in place — drag tiles to reorder, tap the width/band buttons to
  resize through sizes that fit, drop a tile on a glowing edge to move it to the
  next page, tap the dashed **+** to add widgets from a palette, and manage pages
  from the floating bar. While a tile is in flight, every place it could land
  stays lit — free cells, swap targets, page edges — and a widget that has no
  room to render is named on an "Off screen" shelf (tap it to flow it back in).
  Everything saves as you go; **Done** just exits.
- **Settings UI**: tray → **Settings…** opens a visual editor for pages, slots, and
  every widget's declared properties (colors, sliders, sensor pickers, structured
  lists) — no JSON editing required — plus the Theme panel with a live preview.
- **Thirty-two stock widgets**: CPU, GPU, Clock, Countdown, Now Playing, Weather,
  7-Day Forecast, Weather Radar, Reddit Photos, Ping Monitor, iFrame, Stream Deck
  mirror (live Virtual Stream Deck with clickable keys), Control Deck (a touch
  button grid — launch apps, open URLs, send hotkeys, control media; no Stream
  Deck or iCUE required), Philips Hue (CLIP v2 + v1),
  Battery, Gallery, YouTube, Twitch Chat, Launch App, Sensor Chart, Volume mixer,
  Notifications (Windows toast mirror with per-app mute and a privacy blur —
  note Windows only grants notification access to packaged (MSIX) installs, so on
  the portable zip the widget explains itself instead of mirroring), Vitals (a
  self-care HUD whose water/eyes/posture/stretch meters drain over desk time,
  tended alongside a pixel pet), REST Value (any JSON endpoint, one number on
  the panel — give it a URL and a path, set warn/crit thresholds, and
  authenticate with either a static header or an OAuth2 client-credentials
  exchange; the header value and the client secret are both stored encrypted,
  and the tile tells a sign-in failure apart from an API that refused the
  request), CISA KEV (the Known Exploited
  Vulnerabilities catalog as a glance tile: how many landed this week and the
  newest entries by vendor and product, filterable to the vendors you run —
  public feed, no key needed), Ollama (what your local instance actually has
  resident on the GPU right now: each loaded model, the VRAM it holds, and how
  long until it unloads — pairs with the GPU widget), Endpoint Health
  (red/green tiles for self-hosted and LAN services, each checked on its own
  timer so one hung box never freezes the rest of the grid), GitHub Queue
  (the merge board: every open pull request across your repositories with its
  title, age, CI verdict and review chatter, sorted worst first so red and
  conflicted land on top — conditional requests keep it well inside the
  token's rate limit), Home Assistant (entity states with touch control for lights and
  switches; locks and covers stay display-only until you arm them in settings,
  and then need a deliberate long press, because a desk-height touch strip is
  the wrong place for a stray brush to open a garage door), Next Event (the
  next thing on your calendar and a live countdown to it, read straight from a
  private ICS link — no OAuth and no account to connect; daily and weekly repeats
  are expanded, and any repeat it cannot read is counted on screen rather than
  quietly dropped, so the tile never looks emptier than the calendar is), Jellyfin
  (who's streaming what from your server and what just landed in the library:
  active sessions with live progress, transcode and paused flags, a
  recently-added poster shelf, and library counts — or flip a tile to Player
  view and the tile becomes a little theater: browse your movie and TV
  libraries by tab, sort and filter by genre, step into a series' seasons and
  episodes, and tap a title to stream it straight to the panel, direct play
  first with a server transcode fallback and episodes rolling into the next
  one; name a Jellyfin user and a Next up tab queues each series' next
  unwatched episode, finished titles marked watched so the queue advances,
  while a hide list keeps chosen libraries off the tabs and the shelf;
  read from Jellyfin's own API either way, because its web app
  refuses to render inside a frame), and WoW
  Panel (your character on the panel: portrait, level, spec and guild, your
  professions with skill progress, the reputations you've pushed lately, mount
  and pet counts, your latest achievement, and the ones only a step or two from
  done — each section degrades independently, so one slow API cannot blank the
  card).
- **iCUE widget compatibility**: many `.icuewidget` packages from the
  [Elgato Marketplace](https://marketplace.elgato.com/icue/widgets) — and iCUE's own
  stock widgets — install and run as-is. The runtime emulates the iCUE plugin APIs
  (sensors, media with change signals, notifications count, link opening, and the
  Stream Deck plugin backed by our Virtual Stream Deck mirror), serves stand-ins for
  the shared `common/` helpers stock widgets reference from outside their package,
  and reads `x-icue-property` settings (including sensor lists) into the Settings UI.
  Widgets wired to our sensor engine expose whatever your machine provides; iCUE-only
  data sources (Corsair device internals, background media) are not available.

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

- `Plinth-vX.Y.Z-win-x64.zip` — small; needs the
  [.NET 8 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/8.0)
- `Plinth-vX.Y.Z-win-x64-self-contained.zip` — bigger; runs with nothing
  preinstalled

Unzip and run `Plinth.exe`. Requirements: Windows 10 1809+ or Windows 11, and
the WebView2 Runtime (preinstalled on Windows 11 and current Windows 10). Development
builds of every commit are available as [Actions artifacts](../../actions).

The app lives in the system tray. Right-click it for: **Settings…** (the layout and
widget-property editor), reload, open widgets folder, install widget packages,
**Check for updates…**, pick the display, and start-with-Windows.

Updating is one click: **Check for updates…** finds the latest release, downloads
the zip matching your install (framework-dependent or self-contained), swaps the
files in place, and restarts itself. A quiet daily check shows a tray notification
when a new version exists — it never downloads or installs anything on its own.
Your layout, theme, and widgets live under `%LocalAppData%\Plinth` and are never
touched by an update.

### About CPU temperature and fan RPM

Windows has **no driver-free API for CPU core temperature or motherboard fan headers** —
every monitoring tool (HWiNFO, AIDA64, Afterburner, Fan Control) ships a kernel driver
for them. This app handles that in tiers:

1. **Zero-install (default):** CPU temperature comes from Windows' built-in ACPI
   **thermal zone** counters (on many boards this tracks the CPU package well; on some
   desktops the zone is missing or coarse). Fan RPMs appear for GPU fans and for USB
   fan/AIO controllers (NZXT, Aquacomputer, Corsair Commander/Hydro, digital PSUs, …).
   No admin, no drivers.
2. **CPU core temps, motherboard fan headers and voltages require elevation the
   app never asks for.** Reading them takes a kernel sensor driver (PawnIO) plus
   an elevated process, and this app deliberately never requests or recommends
   running as administrator: it renders remote web content, and elevating that
   is not an acceptable risk. Launched normally (unelevated) those sensors are
   simply absent and everything else works.

Everything else — GPU stats, memory, network, media, clock, weather — works unelevated
with nothing extra installed.

### Corsair wireless battery levels (optional)

If you run iCUE, battery percentages for Corsair wireless keyboards/mice/headsets can
appear as sensors (`corsair:*:battery`): download the client DLL
(`iCUESDK.x64_2019.dll`) from the [cue-sdk releases](https://github.com/CorsairOfficial/cue-sdk/releases),
drop it next to `Plinth.exe`, and enable the SDK toggle in iCUE's settings.
Next to the exe or an iCUE install directory are the only places it is looked for —
loading a native DLL runs its startup code before anything checks that it is really the
Corsair SDK, so the app does not go looking in the per-user data directory. Note that
if you run the app portably (unzipped to Downloads or the desktop), the folder holding
the exe is itself writable by anything running as you, so treat it the way you would
any other folder you execute from.
Note that Corsair's public SDK exposes no system temperatures or fan speeds — those
remain iCUE-internal, which is why the app reads hardware itself.

> **Defender note:** if an older build ever triggered a "Threats found" warning, that
> was the WinRing0 driver embedded in LibreHardwareMonitorLib ≤ 0.9.4. This app now
> uses 0.9.6+, which has no WinRing0; let Defender remove the quarantined file and
> delete any leftover `WinRing0x64.sys` next to the exe.

## Configuration

Everything lives in `%LocalAppData%\Plinth\`:

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
        { "widgetId": "ws.stock.gpu", "size": "half", "style": { "accent": "#ff5577" } }
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

The Settings window edits this file for you (and reloads the dashboard on save), and
the on-panel edit mode writes it continuously as you rearrange things on the screen;
the JSON stays hand-editable for scripting or syncing between machines. The dashboard
also hot-reloads whenever widget files change on disk.

**Credentials are encrypted, not synced.** A widget setting declared `type: "secret"`
(API tokens, PATs, client secrets, private calendar URLs) is encrypted with Windows
DPAPI under your user account before it is written, so `layout.json` never holds a
usable credential and the Settings window can't read one back — it shows a masked field
and a "saved" marker, and typing replaces the stored value. Because DPAPI keys belong to
one Windows user on one machine, copying `layout.json` to another PC carries everything
*except* secrets: re-enter those there. Widget authors: see
[docs/WIDGET-SPEC.md](docs/WIDGET-SPEC.md) — credentials must use `secret`, and the
widget validator fails a credential-looking property declared as plain text.

## Building widgets

A widget is a folder with a `manifest.json` and an `index.html`, zipped into a
`.plinthwidget`. Sensor data, settings, and media transport arrive through a tiny JS API
(`window.WW`). Start with **[docs/WIDGET-SPEC.md](docs/WIDGET-SPEC.md)** for the quick
start; the stock widgets in [`widgets/`](widgets/) are working examples you can copy.

Full references:
- **[docs/PLINTH-API-REFERENCE.md](docs/PLINTH-API-REFERENCE.md)** — the complete
  `window.WW` API, sensor/media models, property types, and the host bridge protocol.
- **[docs/ICUE-API-REFERENCE.md](docs/ICUE-API-REFERENCE.md)** — the iCUE Widget API
  (v1.5.0) this runtime emulates, with per-feature notes on what's supported. Most
  Elgato Marketplace `.icuewidget` files — and iCUE's own stock widgets — run as-is.

## Building from source

```powershell
dotnet publish src/Plinth/Plinth.csproj -c Release -r win-x64 --self-contained false -o publish
```

Requires the .NET 8 SDK on Windows (CI does exactly this; non-Windows SDKs can compile
with `EnableWindowsTargeting` but the app only runs on Windows).

## Releasing

Push a version tag and CI publishes the GitHub Release with both zips and generated
notes:

```bash
git tag v0.3.0 && git push origin v0.3.0
```

Or run the `release` workflow manually (Actions → release → Run workflow) with a bare
version like `0.3.0` — it publishes the same release from the chosen branch head and
creates the tag itself. Leaving the version empty makes the manual run a dry run: it
builds the same zips and uploads them as workflow artifacts without creating a release.

## Architecture

Single .NET 8 process: tray shell → borderless WebView2 window on the panel → widgets in
per-origin sandboxed iframes, fed by an in-process sensor hub (LibreHardwareMonitorLib +
Windows APIs) over a JSON `postMessage` bridge. Rationale, alternatives considered, and
security model: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.
