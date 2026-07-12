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
    private Rectangle _targetBounds;
    private BrowserFetcher? _browserFetcher;
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

        // Crossing into a monitor with different DPI makes Windows rescale the window
        // mid-move, leaving it the wrong size on the panel; re-assert our exact bounds.
        DpiChanged += (_, _) => BeginInvoke(ApplyTargetBounds);
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
        MoveToScreen(screen);

        var environment = await WebViewEnvironment.GetAsync();
        await _webView.EnsureCoreWebView2Async(environment);

        var core = _webView.CoreWebView2;
        core.Settings.AreDefaultContextMenusEnabled = _config.EnableDevTools;
        core.Settings.AreDevToolsEnabled = _config.EnableDevTools;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsZoomControlEnabled = false;

        core.WebMessageReceived += OnWebMessageReceived;

        // Renderer/browser process failures (most likely under cold-start pressure)
        // would otherwise leave a dead or half-initialized dashboard behind.
        core.ProcessFailed += (_, e) =>
        {
            Log.Warn($"WebView2 process failed ({e.ProcessFailedKind}); reloading dashboard");
            try { BeginInvoke(ReloadDashboard); } catch (ObjectDisposedException) { }
        };

        // Inject the widget API + iCUE compatibility shim into every widget iframe, so
        // packages (including .icuewidget imports) work without including any script tag.
        var shim = File.ReadAllText(Path.Combine(AppPaths.ShellDir, "widget-api.js")) + "\n" +
                   File.ReadAllText(Path.Combine(AppPaths.ShellDir, "icue-compat.js"));
        await core.AddScriptToExecuteOnDocumentCreatedAsync(shim);

        MapVirtualHosts();
        core.Navigate($"https://{ShellHost}/index.html");
        ApplyTargetBounds(); // WebView2 startup can race the DPI-change rescale
    }

    /// <summary>Re-place the window when the panel (re)appears or moves.</summary>
    public void MoveToScreen(Screen screen)
    {
        _targetBounds = screen.Bounds;
        ApplyTargetBounds();
    }

    /// <summary>True when the window matches where it is supposed to be.</summary>
    public bool IsPlacedCorrectly => !_targetBounds.IsEmpty && Bounds == _targetBounds;

    private void ApplyTargetBounds()
    {
        if (_targetBounds.IsEmpty || IsDisposed)
            return;
        // Each assignment can trigger a WM_DPICHANGED rescale that alters the result;
        // apply until it sticks (bounded, in case of a pathological DPI ping-pong).
        for (var i = 0; i < 4 && Bounds != _targetBounds; i++)
            Bounds = _targetBounds;
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

                case "open-url":
                    OpenExternalUrl(message["url"]?.GetValue<string>());
                    break;

                case "fetch":
                    _ = HandleProxyFetchAsync(message);
                    break;
            }
        }
        catch (Exception ex)
        {
            Log.Warn($"Bad web message: {ex.Message}");
        }
    }

    private static void OpenExternalUrl(string? url)
    {
        if (Uri.TryCreate(url, UriKind.Absolute, out var uri) &&
            (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps))
        {
            try
            {
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(uri.ToString()) { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                Log.Warn($"Failed to open URL: {ex.Message}");
            }
        }
    }

    private static readonly HttpClient ProxyClient = new(new SocketsHttpHandler
    {
        AutomaticDecompression = System.Net.DecompressionMethods.All,
    })
    { Timeout = TimeSpan.FromSeconds(15) };

    // Several services widgets rely on (Reddit in particular) refuse non-browser
    // user agents, and iCUE's embedded browser sends a Chrome UA; match that behavior.
    private const string ProxyUserAgent =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
    private const int ProxyMaxBodyBytes = 5 * 1024 * 1024;

    /// <summary>
    /// CORS-relief proxy for widget fetches (iCUE's runtime is CORS-relaxed; ours is not).
    /// The widget shim only calls this after a normal fetch failed at the network layer.
    /// </summary>
    private async Task HandleProxyFetchAsync(JsonNode message)
    {
        var id = message["id"]?.GetValue<string>() ?? "";
        var result = new JsonObject { ["id"] = id };
        try
        {
            var url = message["url"]?.GetValue<string>();
            var method = message["method"]?.GetValue<string>()?.ToUpperInvariant() ?? "GET";
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) ||
                (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
                throw new InvalidOperationException("only absolute http(s) URLs are allowed");
            if (method is not ("GET" or "POST" or "HEAD"))
                throw new InvalidOperationException($"method {method} not allowed");

            using var request = new HttpRequestMessage(new HttpMethod(method), uri)
            {
                // Browsers speak HTTP/2 to these services; sticking to 1.1 is a bot tell.
                Version = System.Net.HttpVersion.Version20,
                VersionPolicy = HttpVersionPolicy.RequestVersionOrLower,
            };
            var body = message["body"]?.GetValue<string>();
            if (body is not null && method == "POST")
            {
                var contentType = message["contentType"]?.GetValue<string>() ?? "text/plain";
                request.Content = new StringContent(body, System.Text.Encoding.UTF8, contentType);
            }
            request.Headers.TryAddWithoutValidation("User-Agent", ProxyUserAgent);
            request.Headers.TryAddWithoutValidation("Accept",
                "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8");
            request.Headers.TryAddWithoutValidation("Accept-Language", "en-US,en;q=0.9");
            request.Headers.TryAddWithoutValidation("Sec-Fetch-Mode", "cors");
            request.Headers.TryAddWithoutValidation("Sec-Fetch-Site", "cross-site");
            request.Headers.TryAddWithoutValidation("Sec-Fetch-Dest", "empty");

            using var response = await ProxyClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
            var bytes = await ReadCappedAsync(response, ProxyMaxBodyBytes);

            result["status"] = (int)response.StatusCode;
            result["statusText"] = response.ReasonPhrase ?? "";
            result["contentType"] = response.Content.Headers.ContentType?.ToString();
            result["bodyBase64"] = Convert.ToBase64String(bytes);
            Log.Info($"proxy fetch {uri.Host} -> {(int)response.StatusCode} ({bytes.Length} bytes)");

            // TLS-fingerprinting bot walls (Reddit) 403 every .NET client; retry those
            // through a real Chromium navigation, which they do trust.
            if ((int)response.StatusCode is 403 or 429 && method == "GET")
            {
                _browserFetcher ??= new BrowserFetcher();
                var alt = await _browserFetcher.FetchAsync(uri.ToString());
                if (alt is { } browser && browser.Status < 400)
                {
                    result["status"] = browser.Status;
                    result["statusText"] = "";
                    result["contentType"] = browser.ContentType;
                    result["bodyBase64"] = Convert.ToBase64String(browser.Body);
                    Log.Info($"browser fetch {uri.Host} -> {browser.Status} ({browser.Body.Length} bytes)");
                }
            }
        }
        catch (Exception ex)
        {
            result["error"] = ex.Message;
            Log.Warn($"proxy fetch failed ({message["url"]?.GetValue<string>()}): {ex.Message}");
        }

        try
        {
            BeginInvoke(() => PostToShell("fetch-result", result));
        }
        catch (ObjectDisposedException)
        {
            // window closed mid-request
        }
    }

    private static async Task<byte[]> ReadCappedAsync(HttpResponseMessage response, int maxBytes)
    {
        if (response.Content.Headers.ContentLength is > 0 and var length && length > maxBytes)
            throw new InvalidOperationException("response too large");

        await using var stream = await response.Content.ReadAsStreamAsync();
        using var buffer = new MemoryStream();
        var chunk = new byte[81920];
        int read;
        while ((read = await stream.ReadAsync(chunk)) > 0)
        {
            if (buffer.Length + read > maxBytes)
                throw new InvalidOperationException("response too large");
            buffer.Write(chunk, 0, read);
        }
        return buffer.ToArray();
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
            _browserFetcher?.Dispose();
            _webView.Dispose();
        }
        base.Dispose(disposing);
    }
}
