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
    private const string BackgroundHost = "backgrounds.wsw";
    private const string MediaHost = "media.wsw";

    private static readonly string[] MediaImageExts = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif", ".ico"];
    private static readonly string[] MediaVideoExts = [".mp4", ".webm", ".mov", ".m4v", ".avi", ".mpeg"];

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
    private StreamDeckBridge? _streamDeck;
    private readonly AudioMixer _audio = new();
    private readonly NotificationCenter _notifications = new();
    private readonly GameModeWatcher _gameMode = new();
    private bool _shellReady;

    /// <summary>Lists the user's media library folder for the Gallery widget.</summary>
    /// <summary>Media library listing; static so the settings preview can serve it
    /// even when no dashboard window exists (panel not detected).</summary>
    internal static JsonObject BuildMediaList(string id)
    {
        var files = new JsonArray();
        try
        {
            foreach (var path in Directory.EnumerateFiles(AppPaths.MediaDir).OrderBy(p => p, StringComparer.OrdinalIgnoreCase))
            {
                var ext = Path.GetExtension(path).ToLowerInvariant();
                var kind = MediaImageExts.Contains(ext) ? "image" : MediaVideoExts.Contains(ext) ? "video" : null;
                if (kind is null)
                    continue;
                var name = Path.GetFileName(path);
                files.Add(new JsonObject
                {
                    ["name"] = name,
                    ["url"] = $"https://{MediaHost}/{Uri.EscapeDataString(name)}",
                    ["kind"] = kind,
                });
            }
        }
        catch (Exception ex)
        {
            Log.Warn($"Media list failed: {ex.Message}");
        }
        return new JsonObject { ["id"] = id, ["files"] = files };
    }

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
        _notifications.Updated += (data) => PostToShellThreadSafe("notifications", data);
        _gameMode.Changed += (data) => PostToShellThreadSafe("game-mode", data);
        _gameMode.Start();

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

        // User background images/videos, referenced by file name as https://backgrounds.wsw/<file>.
        if (_mappedHosts.Add(BackgroundHost))
            core.SetVirtualHostNameToFolderMapping(BackgroundHost, AppPaths.BackgroundsDir, CoreWebView2HostResourceAccessKind.Allow);

        // User media library (Gallery widget): drop files in, they serve as https://media.wsw/<file>.
        if (_mappedHosts.Add(MediaHost))
            core.SetVirtualHostNameToFolderMapping(MediaHost, AppPaths.MediaDir, CoreWebView2HostResourceAccessKind.Allow);

        var wanted = _library.Widgets.ToDictionary(w => w.VirtualHost, w => w.Folder);
        foreach (var stale in _mappedHosts.Where(h => h != ShellHost && h != BackgroundHost && h != MediaHost && !wanted.ContainsKey(h)).ToList())
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

    /// <summary>Origins already reported as rejected, so an unbounded identical warning
    /// cannot bury the one line that explains the problem in the log a user attaches to a
    /// bug report. Keyed on the REDACTED form — the same string the warning prints —
    /// because that is the only key that makes a duplicate line impossible. Keying on the
    /// raw source looked equivalent and was not: a document can vary its own path or query
    /// between posts (`history.replaceState`), which produces a fresh key and a fresh
    /// warning every time while the logged text stays identical, growing both the set and
    /// the log without bound.</summary>
    private readonly HashSet<string> _rejectedOrigins = new(StringComparer.OrdinalIgnoreCase);

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        // Who sent this, before what it says (#72). Everything below acts on the payload:
        // save-layout writes layout.json, open-url launches a browser, action runs a
        // configured action.
        if (!MessageOrigin.IsShell(e.Source, ShellHost))
        {
            var origin = SafeUrl.Describe(e.Source);
            if (_rejectedOrigins.Add(origin))
                Log.Warn($"Ignored a dashboard message from an unexpected origin: {origin}");
            return;
        }
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

                case "save-layout":
                    // On-panel editor persistence: the shell has already re-rendered
                    // itself, so save quietly — no dashboard reload.
                    try
                    {
                        var edited = message["layout"].Deserialize<DashboardLayout>();
                        if (edited?.Pages is null)
                            throw new InvalidDataException("Layout has no pages.");
                        foreach (var page in edited.Pages)
                            page.Slots.RemoveAll(s => string.IsNullOrWhiteSpace(s.WidgetId));
                        // The shell round-trips the DECRYPTED layout it was given, so
                        // seal before writing: plaintext credentials never hit disk.
                        // Seal with the manifests that REVEALED this shell's layout. The
                        // shell is holding decrypted values; if a manifest went missing or
                        // unparsable since then, a live lookup would stop calling the
                        // property a secret, Seal would skip it, and the plaintext the
                        // shell is round-tripping would be written straight to disk.
                        var secrets = SecretPolicy.Seal(edited, LayoutStore.Load(), ManifestRevealedWith);
                        var secretFailures = secrets.Failures;
                        LayoutStore.Save(edited);
                        Log.Info("layout saved from on-panel editor");
                        if (secrets.Minted.Count > 0)
                        {
                            // Ids were stamped onto the host's copy; the shell still holds
                            // the id-less slots it sent. SettingsWindow has handed these
                            // back since #15 and this handler did not, so host and shell
                            // disagreed about identity for every on-panel save (#70). It
                            // has not bitten because the shell round-trips DECRYPTED
                            // values, so a missed carry-over merely re-encrypts what it
                            // already had — but that is the shell holding the credential,
                            // not the identity being right.
                            var ids = new JsonArray();
                            foreach (var m in secrets.Minted)
                                ids.Add(new JsonObject
                                {
                                    ["page"] = m.Page,
                                    ["slot"] = m.Slot,
                                    ["widgetId"] = m.WidgetId,
                                    ["instanceId"] = m.InstanceId,
                                });
                            PostToShell("minted-ids", ids);
                        }
                        if (secretFailures.Count > 0)
                        {
                            // The panel re-rendered itself as if the save were clean. Tell
                            // it otherwise, or the user walks away believing a credential
                            // is stored when protection refused it.
                            var names = new JsonArray();
                            foreach (var f in secretFailures)
                            {
                                names.Add($"{f.WidgetId}.{f.Property}");
                                Log.Warn($"Secret not saved (protection unavailable): {f.WidgetId}.{f.Property}");
                            }
                            PostToShell("secrets-failed", names);
                        }
                    }
                    catch (Exception ex)
                    {
                        Log.Warn($"On-panel layout save failed: {ex.Message}");
                    }
                    break;

                case "log":
                    Log.Info($"[shell] {message["message"]?.GetValue<string>()}");
                    break;

                case "open-url":
                    OpenExternalUrl(message["url"]?.GetValue<string>());
                    break;

                case "action":
                    DeckAction.Execute(
                        message["kind"]?.GetValue<string>(),
                        message["target"]?.GetValue<string>(),
                        a => _ = _hub.ControlMediaAsync(a));
                    break;

                case "sd-profile":
                    _streamDeck ??= new StreamDeckBridge();
                    _streamDeck.HideVsdWindow(message["hideWindow"]?.GetValue<bool>() ?? true);
                    var sdResult = BuildStreamDeckProfile(message["profileName"]?.GetValue<string>());
                    // Live mode: also ship the VSD window's current pixels so dynamic key
                    // faces (weather, statuses) mirror in real time; null capture (window
                    // missing / GPU refused PrintWindow) leaves the icon grid as fallback.
                    if (message["live"]?.GetValue<bool>() ?? false)
                    {
                        if (_streamDeck.CaptureVsdWindow() is { } capture)
                            sdResult["capture"] = new JsonObject
                            {
                                ["image"] = capture.DataUri,
                                ["w"] = capture.W,
                                ["h"] = capture.H,
                            };
                    }
                    // Echoed so the shell can hand the reply to the frame that asked,
                    // the way fetch/ping/media/audio already do (#127).
                    sdResult["id"] = message["id"]?.GetValue<string>() ?? "";
                    PostToShell("sd-profile-result", sdResult);
                    break;

                case "sd-capture":
                    _streamDeck ??= new StreamDeckBridge();
                    HandleSdCapture(message["id"]?.GetValue<string>() ?? "");
                    break;

                case "sd-click":
                    _streamDeck ??= new StreamDeckBridge();
                    _streamDeck.ClickCell(
                        message["row"]?.GetValue<int>() ?? 0,
                        message["col"]?.GetValue<int>() ?? 0,
                        message["rows"]?.GetValue<int>() ?? 3,
                        message["cols"]?.GetValue<int>() ?? 5);
                    break;

                case "fetch":
                    _ = HandleProxyFetchAsync(message);
                    break;

                case "ping":
                    _ = HandlePingAsync(message);
                    break;

                case "media-list":
                    PostToShell("media-list-result", BuildMediaList(message["id"]?.GetValue<string>() ?? ""));
                    break;

                case "audio-get":
                    HandleAudioGet(message);
                    break;

                case "sd-profiles":
                    // The on-device settings sheet (#48) needs the same discovered
                    // Virtual Stream Deck profile list the desktop editor gets.
                    PostToShell("sd-profiles-result", new JsonObject
                    {
                        ["profiles"] = JsonSerializer.SerializeToNode(StreamDeckBridge.ListProfileNames()),
                    });
                    break;

                case "notifications-watch":
                    _notifications.SetWatching(message["on"]?.GetValue<bool>() == true);
                    break;

                case "notification-dismiss":
                    if (message["id"] is JsonValue idv && idv.TryGetValue<double>(out var nid))
                        _ = Task.Run(() => _notifications.Dismiss((uint)nid));
                    break;

                case "audio-set":
                    {
                        var target = message["target"]?.GetValue<string>() ?? "master";
                        float? level = message["level"] is JsonValue lv && lv.TryGetValue<double>(out var ld) ? (float)ld : null;
                        bool? muted = message["muted"] is JsonValue mv && mv.TryGetValue<bool>(out var mb) ? mb : null;
                        var ackId = message["id"]?.GetValue<string>();
                        _ = Task.Run(() =>
                        {
                            // Acked so the volume widget can fail-flash and revert its
                            // optimistic UI on a real Core Audio failure (session gone,
                            // endpoint changed) instead of silently disagreeing.
                            var ok = _audio.Apply(target, level, muted);
                            if (!string.IsNullOrEmpty(ackId))
                                PostToShellThreadSafe("audio-result", new JsonObject { ["id"] = ackId, ["ok"] = ok });
                        });
                    }
                    break;
            }
        }
        catch (Exception ex)
        {
            Log.Warn($"Bad web message: {ex.Message}");
        }
    }

    private void HandleAudioGet(JsonNode message, Action<string, JsonNode?>? reply = null)
    {
        _ = Task.Run(() =>
        {
            var snapshot = _audio.Read();
            var data = new JsonObject { ["id"] = message["id"]?.GetValue<string>() ?? "" };
            if (snapshot is null)
            {
                data["available"] = false;
            }
            else
            {
                data["available"] = true;
                data["master"] = new JsonObject { ["level"] = snapshot.MasterLevel, ["muted"] = snapshot.MasterMuted };
                var sessions = new JsonArray();
                foreach (var s in snapshot.Sessions)
                    sessions.Add(new JsonObject { ["pid"] = s.Pid, ["name"] = s.Name, ["level"] = s.Level, ["muted"] = s.Muted });
                data["sessions"] = sessions;
            }
            if (reply is not null)
            {
                reply("audio-result", data);
                return;
            }
            try { BeginInvoke(() => PostToShell("audio-result", data)); }
            catch (ObjectDisposedException) { }
        });
    }

    /// <summary>
    /// Routes a settings-window replica's widget data request (fetch / ping /
    /// media-list / audio-get) through the same handlers the live dashboard uses,
    /// sending results to <paramref name="reply"/> instead of the dashboard shell.
    /// Side-effecting channels (audio-set, media-control, actions, Stream Deck) are
    /// deliberately not routed — a preview must never change system state.
    /// </summary>
    public void HandlePreviewRequest(JsonNode? message, Action<string, JsonNode?> reply)
    {
        switch (message?["type"]?.GetValue<string>())
        {
            case "fetch": _ = HandleProxyFetchAsync(message, reply); break;
            case "ping": _ = HandlePingAsync(message, reply); break;
            case "media-list": reply("media-list-result", BuildMediaList(message["id"]?.GetValue<string>() ?? "")); break;
            case "audio-get": HandleAudioGet(message, reply); break;
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

    // LAN IoT devices (Hue Bridge CLIP v2, Nanoleaf, ...) speak HTTPS with self-signed
    // certificates. This client skips certificate validation and is ONLY ever used for
    // hosts that IsPrivateHost approves — never for internet targets.
    private static readonly HttpClient ProxyClientInsecure = new(new SocketsHttpHandler
    {
        AutomaticDecompression = System.Net.DecompressionMethods.All,
        // Embedded TLS servers on LAN devices mishandle parallel handshakes, so
        // requests to a device are serialized through one pooled connection.
        // TLS protocol versions stay at system defaults — the documented contract
        // of init.insecure is only "skip certificate validation".
        MaxConnectionsPerServer = 1,
        SslOptions = new System.Net.Security.SslClientAuthenticationOptions
        {
            RemoteCertificateValidationCallback = (_, _, _, _) => true,
        },
    })
    { Timeout = TimeSpan.FromSeconds(15) };

    /// <summary>Loopback or RFC1918/link-local private addresses only (no DNS lookups —
    /// a hostname that isn't a literal private IP or localhost doesn't qualify).</summary>
    private static bool IsPrivateHost(Uri uri)
    {
        if (uri.IsLoopback)
            return true;
        if (!System.Net.IPAddress.TryParse(uri.Host, out var ip))
            return false;
        var b = ip.GetAddressBytes();
        if (b.Length != 4)
            return false;
        return b[0] == 10
            || (b[0] == 172 && b[1] >= 16 && b[1] <= 31)
            || (b[0] == 192 && b[1] == 168)
            || (b[0] == 169 && b[1] == 254);
    }

    // Several services widgets rely on (Reddit in particular) refuse non-browser
    // user agents, and iCUE's embedded browser sends a Chrome UA; match that behavior.
    private const string ProxyUserAgent =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
    private const int ProxyMaxBodyBytes = 5 * 1024 * 1024;

    /// <summary>
    /// CORS-relief proxy for widget fetches (iCUE's runtime is CORS-relaxed; ours is not).
    /// The widget shim only calls this after a normal fetch failed at the network layer.
    /// </summary>
    private async Task HandleProxyFetchAsync(JsonNode message, Action<string, JsonNode?>? reply = null)
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
            if (method is not ("GET" or "POST" or "PUT" or "HEAD"))
                throw new InvalidOperationException($"method {method} not allowed");

            var insecureRequested = message["insecure"]?.GetValue<bool>() ?? false;
            var lanDevice = insecureRequested && IsPrivateHost(uri);

            using var request = new HttpRequestMessage(new HttpMethod(method), uri)
            {
                // Browsers speak HTTP/2 to internet services; sticking to 1.1 is a bot
                // tell. LAN IoT devices are the opposite — their embedded TLS stacks
                // (Hue's mbedTLS) mishandle h2/ALPN offers — so those get plain 1.1.
                Version = lanDevice ? System.Net.HttpVersion.Version11 : System.Net.HttpVersion.Version20,
                VersionPolicy = HttpVersionPolicy.RequestVersionOrLower,
            };
            var body = message["body"]?.GetValue<string>();
            if (body is not null && method is "POST" or "PUT")
            {
                // The StringContent media-type overload rejects parameterized values
                // ("application/json; charset=utf-8" throws FormatException) — parse
                // the full header instead, keeping utf-8 as the charset when the
                // caller named none (the body was encoded as UTF-8 either way).
                var contentType = message["contentType"]?.GetValue<string>() ?? "text/plain";
                var content = new StringContent(body, System.Text.Encoding.UTF8);
                if (System.Net.Http.Headers.MediaTypeHeaderValue.TryParse(contentType, out var mediaType))
                {
                    mediaType.CharSet ??= "utf-8";
                    content.Headers.ContentType = mediaType;
                }
                request.Content = content;
            }
            // Widget-supplied extra headers (e.g. Hue CLIP v2's hue-application-key).
            // Hop-by-hop and body-framing headers stay under HttpClient's control.
            // Headers safe to replay from a page-context fetch also feed the
            // hidden-browser tier below — an Authorization header must survive
            // EVERY tier of the ladder, or a private feed keeps answering 403
            // right when the bot wall forces the escalation (#37).
            Dictionary<string, string>? browserHeaders = null;
            if (message["headers"] is JsonObject extraHeaders)
            {
                foreach (var (headerName, headerValue) in extraHeaders)
                {
                    if (string.IsNullOrWhiteSpace(headerName) || headerValue is null)
                        continue;
                    // Which names the widget may choose, and which the host keeps, is
                    // decided in ProxyHeaderRules — a pure predicate so it can be
                    // covered exhaustively (tools/ProxyHeaders), the same reason
                    // MessageOrigin lives apart from its two call sites.
                    if (!ProxyHeaderRules.IsWidgetSuppliable(headerName))
                        continue;
                    var value = headerValue.GetValue<string>();
                    if (!request.Headers.TryAddWithoutValidation(headerName, value))
                        request.Content?.Headers.TryAddWithoutValidation(headerName, value);
                    if (ProxyHeaderRules.IsBrowserForwardable(headerName))
                        (browserHeaders ??= new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase))[headerName] = value;
                }
            }

            // Browser-grade defaults fill GAPS only: a forwarded header owns its
            // name outright — appending the broad Accept default to a caller's
            // "application/json" would hand content negotiation text/html at full
            // preference, a representation the native request never accepted.
            if (!request.Headers.Contains("User-Agent"))
                request.Headers.TryAddWithoutValidation("User-Agent", ProxyUserAgent);
            if (!request.Headers.Contains("Accept"))
                request.Headers.TryAddWithoutValidation("Accept",
                    "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,image/avif,image/webp,*/*;q=0.8");
            if (!request.Headers.Contains("Accept-Language"))
                request.Headers.TryAddWithoutValidation("Accept-Language", "en-US,en;q=0.9");
            if (!request.Headers.Contains("Sec-Fetch-Mode"))
                request.Headers.TryAddWithoutValidation("Sec-Fetch-Mode", "cors");
            if (!request.Headers.Contains("Sec-Fetch-Site"))
                request.Headers.TryAddWithoutValidation("Sec-Fetch-Site", "cross-site");
            if (!request.Headers.Contains("Sec-Fetch-Dest"))
                request.Headers.TryAddWithoutValidation("Sec-Fetch-Dest", "empty");
            // Reddit's image CDNs (preview.redd.it, i.redd.it, external-preview.redd.it)
            // serve a fixed ~8 KB anti-hotlink placeholder unless the referer is Reddit.
            if (uri.Host.EndsWith(".redd.it", StringComparison.OrdinalIgnoreCase) ||
                uri.Host.EndsWith("redditmedia.com", StringComparison.OrdinalIgnoreCase))
                request.Headers.TryAddWithoutValidation("Referer", "https://www.reddit.com/");

            var client = lanDevice ? ProxyClientInsecure : ProxyClient;
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
            var bytes = await ReadCappedAsync(response, ProxyMaxBodyBytes);

            result["status"] = (int)response.StatusCode;
            result["statusText"] = response.ReasonPhrase ?? "";
            result["contentType"] = response.Content.Headers.ContentType?.ToString();
            result["bodyBase64"] = Convert.ToBase64String(bytes);
            Log.Info($"proxy fetch {SafeUrl.Describe(uri)} -> {(int)response.StatusCode} ({bytes.Length} bytes)");

            // TLS-fingerprinting bot walls (Reddit) 403 every .NET client; retry those
            // through a real Chromium navigation, which they do trust.
            if ((int)response.StatusCode is 403 or 429 && method == "GET")
            {
                _browserFetcher ??= new BrowserFetcher();
                var alt = await _browserFetcher.FetchAsync(uri.ToString(), browserHeaders);
                if (alt is { } browser && browser.Status < 400)
                {
                    result["status"] = browser.Status;
                    result["statusText"] = "";
                    result["contentType"] = browser.ContentType;
                    result["bodyBase64"] = Convert.ToBase64String(browser.Body);
                    Log.Info($"browser fetch {SafeUrl.Describe(uri)} -> {browser.Status} ({browser.Body.Length} bytes)");
                }
                else if (alt is { } blocked)
                {
                    // A real Chromium was refused too, which rules out TLS
                    // fingerprinting — but only auth-shaped statuses suggest an
                    // authorization problem; a 404/429/5xx is just the site's
                    // ordinary answer and must not misdirect the field.
                    var hint = blocked.Status is 401 or 403
                        ? "likely authorization (missing credentials or a private resource), not TLS fingerprinting"
                        : "the site's own answer, not TLS fingerprinting";
                    Log.Warn($"browser fetch {SafeUrl.Describe(uri)} -> {blocked.Status}; {hint}");
                }
            }
        }
        catch (Exception ex)
        {
            result["error"] = ex.Message;
            Log.Warn($"proxy fetch failed ({SafeUrl.Describe(message["url"]?.GetValue<string>())}): {ex.Message}");
        }

        if (reply is not null)
        {
            reply("fetch-result", result);
            return;
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

    /// <summary>
    /// Real ICMP pings for the Ping Monitor widget (a browser can only fake latency with
    /// HTTP requests, which fails for routers/NAS boxes and measures the wrong thing).
    /// message: { id, hosts: ["1.1.1.1", "router.local", ...] } — capped, pinged in
    /// parallel, one reply: ping-result { id, results: [{host, ok, rttMs}] }.
    /// </summary>
    private async Task HandlePingAsync(JsonNode message, Action<string, JsonNode?>? reply = null)
    {
        var id = message["id"]?.GetValue<string>() ?? "";
        var hosts = new List<string>();
        if (message["hosts"] is JsonArray arr)
            foreach (var h in arr)
            {
                var host = h?.GetValue<string>()?.Trim();
                if (!string.IsNullOrEmpty(host) && hosts.Count < 16)
                    hosts.Add(host);
            }

        var results = new JsonArray();
        var tasks = hosts.Select(async host =>
        {
            var entry = new JsonObject { ["host"] = host };
            try
            {
                using var ping = new System.Net.NetworkInformation.Ping();
                var reply = await ping.SendPingAsync(host, 2000);
                if (reply.Status == System.Net.NetworkInformation.IPStatus.Success)
                {
                    entry["ok"] = true;
                    entry["rttMs"] = reply.RoundtripTime;
                }
                else
                {
                    entry["ok"] = false;
                    entry["error"] = reply.Status.ToString();
                }
            }
            catch (Exception ex)
            {
                entry["ok"] = false;
                entry["error"] = ex.InnerException?.Message ?? ex.Message;
            }
            return entry;
        }).ToList();

        foreach (var entry in await Task.WhenAll(tasks))
            results.Add(entry);

        var pingResult = new JsonObject { ["id"] = id, ["results"] = results };
        if (reply is not null)
        {
            reply("ping-result", pingResult);
            return;
        }
        try
        {
            BeginInvoke(() => PostToShell("ping-result", pingResult));
        }
        catch (ObjectDisposedException)
        {
            // window closed mid-ping
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

    /// <summary>Manifest lookup for the secret pipeline (which properties are credentials).</summary>
    /// <summary>ORDINAL, the library's own notion of widget identity: Rescan resolves
    /// duplicates with an ordinal compare, so 'Foo' and 'foo' are two distinct widgets that
    /// both load. A case-insensitive lookup answers a question the library never asked and
    /// hands one widget the other's secret classification. The settings window was fixed in
    /// #61 round six; this is the same pair in the second window, which I missed then —
    /// leaving the two disagreeing about identity is the drift those fixes exist to stop.</summary>
    private WidgetManifest? ManifestFor(string widgetId) =>
        _library.Widgets.FirstOrDefault(w => string.Equals(w.Manifest.Id, widgetId, StringComparison.Ordinal))?.Manifest;

    private JsonObject BuildInitPayload()
    {
        var layout = LayoutStore.Load();
        // The dashboard's widget iframes need real credentials, so secrets are decrypted
        // for THIS payload only — layout.json keeps the DPAPI ciphertext.
        SnapshotManifests();
        SecretPolicy.Reveal(layout, ManifestRevealedWith);
        var widgets = _library.Widgets.Select(w => new
        {
            id = w.Manifest.Id,
            name = w.Manifest.Name,
            url = $"https://{w.VirtualHost}/index.html",
            supportedSlots = w.Manifest.SupportedSlots,
            properties = w.Manifest.Properties,
        });

        var tokens = new JsonObject();
        foreach (var (name, value) in PaletteEngine.Derive(layout.Theme))
            tokens[name] = value;

        return new JsonObject
        {
            ["layout"] = JsonSerializer.SerializeToNode(layout),
            ["widgets"] = JsonSerializer.SerializeToNode(widgets, BridgeJson),
            ["sensors"] = JsonSerializer.SerializeToNode(_hub.LatestSensors, BridgeJson),
            ["media"] = JsonSerializer.SerializeToNode(_hub.LatestMedia, BridgeJson),
            ["backgroundHost"] = BackgroundHost,
            ["theme"] = tokens,
            ["game"] = _gameMode.Current,
            ["status"] = new JsonObject { ["elevated"] = _hub.IsElevated, ["apiVersion"] = 1 },
        };
    }

    private string? _lastCaptureHash;
    private long _lastCaptureTicks;
    private JsonObject? _lastCaptureResult;

    /// <summary>
    /// Capture-only fast path for the live Stream Deck mirror: no profile re-parse, JPEG
    /// frame only when the pixels actually changed ({unchanged:true} otherwise), and a
    /// short throttle so several polling widgets share one PrintWindow per interval.
    /// </summary>
    private void HandleSdCapture(string requestId)
    {
        var now = Environment.TickCount64;
        if (now - _lastCaptureTicks < 100 && _lastCaptureResult is { } recent)
        {
            // The cached frame is shared between pollers, so the id is stamped on the
            // COPY — caching it would send the previous asker's id to this one.
            var replay = (JsonObject)recent.DeepClone();
            replay["id"] = requestId;
            PostToShell("sd-capture-result", replay);
            return;
        }
        _lastCaptureTicks = now;

        JsonObject result;
        if (_streamDeck!.CaptureVsdWindow() is { } capture)
        {
            if (capture.Hash == _lastCaptureHash)
            {
                result = new JsonObject { ["unchanged"] = true };
            }
            else
            {
                _lastCaptureHash = capture.Hash;
                result = new JsonObject
                {
                    ["image"] = capture.DataUri,
                    ["w"] = capture.W,
                    ["h"] = capture.H,
                };
            }
        }
        else
        {
            result = new JsonObject { ["available"] = false };
        }
        // Cached WITHOUT the id, for the same reason as the replay path above.
        _lastCaptureResult = (JsonObject)result.DeepClone();
        result["id"] = requestId;
        PostToShell("sd-capture-result", result);
    }

    private JsonObject BuildStreamDeckProfile(string? preferredName)
    {
        _streamDeck ??= new StreamDeckBridge();
        var profile = _streamDeck.ReadProfile(preferredName);
        if (profile is null)
            return new JsonObject { ["available"] = false };

        var buttons = new JsonArray();
        foreach (var b in profile.Buttons)
        {
            buttons.Add(new JsonObject
            {
                ["row"] = b.Row,
                ["col"] = b.Col,
                ["title"] = b.Title,
                ["image"] = b.Image,
            });
        }
        var available = new JsonArray();
        foreach (var name in profile.AvailableProfiles)
            available.Add(name);

        return new JsonObject
        {
            ["available"] = true,
            ["name"] = profile.Name,
            ["rows"] = profile.Rows,
            ["cols"] = profile.Cols,
            ["buttons"] = buttons,
            ["profiles"] = available,
        };
    }

    private void OnSensorsUpdated(IReadOnlyList<SensorReading> sensors) =>
        PostToShellThreadSafe("sensors", JsonSerializer.SerializeToNode(sensors, BridgeJson));

    private void OnMediaUpdated(MediaState media) =>
        PostToShellThreadSafe("media", JsonSerializer.SerializeToNode(media, BridgeJson));

    /// <summary>The manifests that produced the shell's REVEALED layout. That shell holds
    /// decrypted credentials, so its saves must be classified by the same manifests that
    /// decided what to decrypt — not by a library that may have changed since.</summary>
    private Dictionary<string, WidgetManifest>? _revealedManifests;

    private WidgetManifest? ManifestRevealedWith(string widgetId)
    {
        if (_revealedManifests is not null && _revealedManifests.TryGetValue(widgetId, out var snapshot))
            return snapshot;
        return ManifestFor(widgetId);
    }

    private void SnapshotManifests()
    {
        // Ordinal — see ManifestFor. Collapsing case here would let one widget's manifest
        // decide what to decrypt for another.
        var snapshot = new Dictionary<string, WidgetManifest>(StringComparer.Ordinal);
        foreach (var w in _library.Widgets)
            snapshot[w.Manifest.Id] = w.Manifest;
        _revealedManifests = snapshot;
    }

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
            _notifications.Dispose();
            _gameMode.Dispose();
            _browserFetcher?.Dispose();
            _webView.Dispose();
        }
        base.Dispose(disposing);
    }
}
