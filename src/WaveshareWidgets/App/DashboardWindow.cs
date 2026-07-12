using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using WaveshareWidgets.Sensors;
using WaveshareWidgets.Widgets;

namespace WaveshareWidgets.App;

/// <summary>
/// The borderless full-screen window pinned to the panel. Hosts a single WebView2 that
/// renders the dashboard shell page; widgets run inside per-origin iframes within it.
/// The window never activates (WS_EX_NOACTIVATE) so touch taps on the panel don't steal
/// keyboard focus from whatever is running on the main display.
/// </summary>
public sealed class DashboardWindow : Form
{
    private const string ShellHost = "app.wsw";

    private static readonly JsonSerializerOptions BridgeJson = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private readonly AppConfig _config;
    private readonly SensorHub _hub;
    private readonly WidgetLibrary _library;
    private readonly WebView2 _webView = new();
    private readonly HashSet<string> _mappedHosts = [];
    private bool _shellReady;

    public DashboardWindow(AppConfig config, SensorHub hub, WidgetLibrary library)
    {
        _config = config;
        _hub = hub;
        _library = library;

        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = false;
        BackColor = Color.Black;
        Text = "Waveshare Widgets";

        _webView.Dock = DockStyle.Fill;
        _webView.DefaultBackgroundColor = Color.Black;
        Controls.Add(_webView);

        _hub.SensorsUpdated += OnSensorsUpdated;
        _hub.MediaUpdated += OnMediaUpdated;
    }

    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get
        {
            const int WS_EX_NOACTIVATE = 0x08000000;
            const int WS_EX_TOOLWINDOW = 0x00000080; // keep it out of Alt-Tab
            var cp = base.CreateParams;
            cp.ExStyle |= WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
            return cp;
        }
    }

    public async Task InitializeAsync(Screen screen)
    {
        Bounds = screen.Bounds;

        var environment = await WebViewEnvironment.GetAsync();
        await _webView.EnsureCoreWebView2Async(environment);

        var core = _webView.CoreWebView2;
        core.Settings.AreDefaultContextMenusEnabled = _config.EnableDevTools;
        core.Settings.AreDevToolsEnabled = _config.EnableDevTools;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsZoomControlEnabled = false;

        core.WebMessageReceived += OnWebMessageReceived;

        MapVirtualHosts();
        core.Navigate($"https://{ShellHost}/index.html");
    }

    /// <summary>Re-place the window when the panel (re)appears or moves.</summary>
    public void MoveToScreen(Screen screen)
    {
        Bounds = screen.Bounds;
    }

    private void MapVirtualHosts()
    {
        var core = _webView.CoreWebView2;

        if (_mappedHosts.Add(ShellHost))
            core.SetVirtualHostNameToFolderMapping(ShellHost, AppPaths.ShellDir, CoreWebView2HostResourceAccessKind.Allow);

        var wanted = _library.Widgets.ToDictionary(w => w.VirtualHost, w => w.Folder);
        foreach (var stale in _mappedHosts.Where(h => h != ShellHost && !wanted.ContainsKey(h)).ToList())
        {
            core.ClearVirtualHostNameToFolderMapping(stale);
            _mappedHosts.Remove(stale);
        }
        foreach (var (host, folder) in wanted)
        {
            // Re-mapping an existing host updates its folder, so no separate clear is needed.
            core.SetVirtualHostNameToFolderMapping(host, folder, CoreWebView2HostResourceAccessKind.Allow);
            _mappedHosts.Add(host);
        }
    }

    /// <summary>Rescan-safe reload: refreshes host mappings and reloads the shell page.</summary>
    public void ReloadDashboard()
    {
        if (InvokeRequired)
        {
            BeginInvoke(ReloadDashboard);
            return;
        }
        if (_webView.CoreWebView2 is null)
            return;

        _shellReady = false;
        MapVirtualHosts();
        _webView.CoreWebView2.Reload();
    }

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            var message = JsonNode.Parse(e.WebMessageAsJson);
            switch (message?["type"]?.GetValue<string>())
            {
                case "ready":
                    _shellReady = true;
                    PostToShell("init", BuildInitPayload());
                    break;

                case "media-control":
                    var action = message["action"]?.GetValue<string>();
                    if (!string.IsNullOrEmpty(action))
                        _ = _hub.ControlMediaAsync(action);
                    break;

                case "log":
                    Log.Info($"[shell] {message["message"]?.GetValue<string>()}");
                    break;
            }
        }
        catch (Exception ex)
        {
            Log.Warn($"Bad web message: {ex.Message}");
        }
    }

    private JsonObject BuildInitPayload()
    {
        var layout = LayoutStore.Load();
        var widgets = _library.Widgets.Select(w => new
        {
            id = w.Manifest.Id,
            name = w.Manifest.Name,
            url = $"https://{w.VirtualHost}/index.html",
            supportedSlots = w.Manifest.SupportedSlots,
            properties = w.Manifest.Properties,
        });

        return new JsonObject
        {
            ["layout"] = JsonSerializer.SerializeToNode(layout),
            ["widgets"] = JsonSerializer.SerializeToNode(widgets, BridgeJson),
            ["sensors"] = JsonSerializer.SerializeToNode(_hub.LatestSensors, BridgeJson),
            ["media"] = JsonSerializer.SerializeToNode(_hub.LatestMedia, BridgeJson),
            ["status"] = new JsonObject { ["elevated"] = _hub.IsElevated, ["apiVersion"] = 1 },
        };
    }

    private void OnSensorsUpdated(IReadOnlyList<SensorReading> sensors) =>
        PostToShellThreadSafe("sensors", JsonSerializer.SerializeToNode(sensors, BridgeJson));

    private void OnMediaUpdated(MediaState media) =>
        PostToShellThreadSafe("media", JsonSerializer.SerializeToNode(media, BridgeJson));

    private void PostToShellThreadSafe(string type, JsonNode? data)
    {
        if (!_shellReady || !IsHandleCreated || IsDisposed)
            return;
        try
        {
            BeginInvoke(() => PostToShell(type, data));
        }
        catch (ObjectDisposedException)
        {
            // Window torn down between the check and the invoke; nothing to do.
        }
    }

    private void PostToShell(string type, JsonNode? data)
    {
        if (_webView.CoreWebView2 is null)
            return;
        var envelope = new JsonObject { ["type"] = type, ["data"] = data };
        _webView.CoreWebView2.PostWebMessageAsJson(envelope.ToJsonString());
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _hub.SensorsUpdated -= OnSensorsUpdated;
            _hub.MediaUpdated -= OnMediaUpdated;
            _webView.Dispose();
        }
        base.Dispose(disposing);
    }
}
