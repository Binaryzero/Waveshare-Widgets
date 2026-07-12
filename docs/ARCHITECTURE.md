# Architecture

## Overview

```
┌────────────────────────────── WaveshareWidgets.exe (.NET 8, tray app) ─────────────────────────────┐
│                                                                                                    │
│  TrayApplicationContext ── panel detection (1280x400 signature), hotplug, tray menu, autostart     │
│         │                                                                                          │
│         ▼                                                                                          │
│  DashboardWindow (borderless, WS_EX_NOACTIVATE, pinned to panel)                                   │
│         │                                                                                          │
│         ▼                                                                                          │
│  WebView2 ──► https://app.wsw/index.html  (shell: pages, slots, dots, bridge relay)                │
│                  │ iframe (sandboxed, per-widget origin)                                           │
│                  ├─► https://ws-stock-cpu.widgets.wsw/index.html                                   │
│                  ├─► https://ws-stock-media.widgets.wsw/index.html                                 │
│                  └─► … one origin per installed widget                                             │
│                                                                                                    │
│  SensorHub (background thread, ~2 s tick)                                                          │
│    ├─ LibreHardwareMonitorLib  — CPU/GPU/memory/storage/motherboard (full set needs elevation)     │
│    ├─ SystemCountersProvider   — CPU load, network, memory via PDH/Win32 (never needs elevation)   │
│    └─ MediaSessionProvider     — now-playing + transport via GlobalSystemMediaTransportControls    │
│                                                                                                    │
│  WidgetLibrary — scans/installs %LocalAppData%\WaveshareWidgets\widgets, hot-reload watcher        │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Data flows one way as JSON: `SensorHub → PostWebMessageAsJson → shell → postMessage →
widget iframes`. Commands flow back the same way (`widget → shell → WebMessageReceived →
host`). No host objects are ever exposed to web content (`AddHostObjectToScript` is
deliberately unused) — the JSON bridge *is* the security boundary.

## Why this stack

Decided after comparing Electron, Tauri v2, WPF, WinUI 3, Avalonia, Flutter, and kiosk
browsers for this exact use case:

1. **Widgets are HTML/JS** because that is the proven iCUE model (a `.icuewidget` is a
   zip of `manifest.json` + `index.html`), it is the lowest barrier for third-party and
   AI-generated widgets, and Chromium's sandbox is the only real security boundary
   available for running untrusted widget code. .NET plugin DLLs would run fully trusted
   (`AssemblyLoadContext` is explicitly not a security boundary).
2. **WebView2 hosted from .NET** rather than Electron/Tauri: all three pay the same
   Chromium memory floor on Windows, but WebView2 is preinstalled on Windows 10/11, needs
   no bundled browser or update treadmill, and lets the sensor engine live in-process.
3. **LibreHardwareMonitorLib in-process** because it is the de-facto open sensor engine,
   MPL-2.0 licensed (HWiNFO's shared memory requires closed-source freeware and cuts off
   after 12 h on the free tier), and it is a .NET library — a C# host deletes the sidecar
   service + IPC layer that every JS-first analogue (MoBro, oae/sensorpanel) needed.
4. **The panel needs no transport layer** — it is a plain EDID-detected HDMI monitor with
   driver-free USB HID touch. A borderless window pinned to it is the entire "driver".

Runner-ups, if requirements change: Electron + C# sensor sidecar (if the codebase should
be JS-first), or Avalonia with declarative JSON widgets (if the ~200-400 MB WebView2
process tree is unacceptable — at the cost of arbitrary HTML widgets).

## Panel-specific handling

| Quirk | Handling |
|---|---|
| Native scanout is portrait 400×1280 | Detect both orientations; README walks through Windows landscape rotation |
| Panel appears ~10 s after connect / absent at logon | `SystemEvents.DisplaySettingsChanged` re-runs placement; window hides when panel is gone |
| Touch maps to the primary monitor by default | Not fixable programmatically; documented Tablet PC Settings walkthrough |
| Taps must not steal focus from games | `WS_EX_NOACTIVATE` + `WS_EX_TOOLWINDOW`, `ShowWithoutActivation` |
| Chromium throttles unfocused windows | `--disable-background-timer-throttling --disable-renderer-backgrounding --disable-features=CalculateNativeWinOcclusion` |
| No DDC/CI brightness | Hardware button only (documented); a software dimming overlay is a natural v2 feature |
| Real refresh may be ~50 Hz | Widgets are told to animate via CSS/vsync, not fixed frame budgets |

## Privilege tiers

| Tier | Source | Needs |
|---|---|---|
| Always | Clock (JS), performance counters (`sys:*`), memory, media, weather | nothing |
| Unelevated LHM | GPU temps/load/VRAM (vendor user-mode DLLs), storage, memory | nothing |
| Elevated LHM | CPU core temps, fans, voltages, motherboard/SuperIO | admin + (new LHM builds) PawnIO driver |

Widgets can check `WW.status.elevated` and degrade (the stock CPU widget shows a hint
instead of a blank temperature).

## Widget security model

- One virtual host per widget (`SetVirtualHostNameToFolderMapping`), so each widget is a
  distinct browser origin: no shell DOM access, no cross-widget access, per-widget
  `localStorage`.
- `sandbox="allow-scripts allow-same-origin"` — safe *because* of the per-origin split;
  the sandbox attribute prevents popups/top-navigation/downloads.
- The bridge is JSON-only `postMessage`. Widget-originated message types are `ww-ready`,
  `ww-media-control`, `ww-log` — each validated in the shell and again in the host.
- Outbound network from widgets is allowed by design (weather, RSS, localhost bridges),
  matching iCUE's model. A manifest-declared permission system is the v2 hardening path.

## Repo layout

```
src/WaveshareWidgets/        the app (C# + Shell/ web assets)
widgets/                     stock widgets, copied to output and seeded on first run
docs/                        this file + the widget spec
.github/workflows/build.yml  Windows CI build producing the distributable artifact
```

## v2 candidates (explicitly out of v1 scope)

Touch-driven layout editor, settings UI for widget properties (the schema is already in
the manifest), software night-dimming overlay, widget marketplace/gallery, a `wswidget`
scaffold/pack CLI, an AI "skill file" for LLM-generated widgets, .icuewidget import shim,
manifest-declared capability permissions, WebView2 nightly recycle for multi-week uptime.
