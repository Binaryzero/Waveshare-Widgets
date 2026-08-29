using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Plinth.Sensors;
using Plinth.Widgets;

namespace Plinth.App;

/// <summary>
/// The borderless full-screen window pinned to the panel. Hosts a single WebView2 that
/// renders the dashboard shell page; widgets run inside per-origin iframes within it.
/// The window never activates (WS_EX_NOACTIVATE) so touch taps on the panel don't steal
/// keyboard focus from whatever is running on the main display.
/// </summary>
public sealed class DashboardWindow : Form
{
    private const string ShellHost = "app.plinth";
    private const string BackgroundHost = "backgrounds.plinth";
    private const string MediaHost = "media.plinth";

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
    private readonly VirtualHostMap _hosts = new();
    private Rectangle _targetBounds;
    private BrowserFetcher? _browserFetcher;
    private StreamDeckBridge? _streamDeck;
    private readonly AudioMixer _audio = new();
    private readonly NotificationCenter _notifications = new();
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
        Text = "Plinth";

        _webView.Dock = DockStyle.Fill;
        _webView.DefaultBackgroundColor = Color.Black;
        Controls.Add(_webView);

        _hub.SensorsUpdated += OnSensorsUpdated;
        _hub.MediaUpdated += OnMediaUpdated;
        // The generation arrives WITH the payload, captured under NotificationCenter's lock
        // at the moment the push was authorised. Reading it here instead would reintroduce
        // the window this exists to close.
        _notifications.Updated += (data, gen) => PostToShellThreadSafe("notifications", data, gen);

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

        // Widget media (Jellyfin playback) streams from LAN servers through the host —
        // the renderer's network gates each killed direct playback in the field.
        MediaRelay.Attach(core);
        // And if a renderer gate ever blocks anything again, the engine says so in
        // its console, which now lands in app.log instead of nowhere.
        WebViewEnvironment.MirrorRendererConsole(core);

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
                   File.ReadAllText(Path.Combine(AppPaths.ShellDir, "icue-compat.js")) +
                   "\n" + File.ReadAllText(Path.Combine(AppPaths.ShellDir, "icue-common.js"));
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
        _hosts.MapFixed(core, ShellHost, AppPaths.ShellDir);
        // User background images/videos, referenced by file name as https://backgrounds.plinth/<file>.
        _hosts.MapFixed(core, BackgroundHost, AppPaths.BackgroundsDir);
        // User media library (Gallery widget): drop files in, they serve as https://media.plinth/<file>.
        _hosts.MapFixed(core, MediaHost, AppPaths.MediaDir);
        _hosts.Sync(core, _library.Widgets);
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
                    // A NEW document, so its generation counter starts over. Ours must too,
                    // or the two are compared across a reload that reset only one of them:
                    // notifGen is document-local and restarts at 0, while this survives, and
                    // polling continues uninterrupted because the dead document never posted
                    // watch(false). With a single notifications widget the old document ends
                    // at 1 and the new one's first watch is also 1 — a poll in flight across
                    // the reload would carry a matching stamp and be accepted.
                    //
                    // Reset to 0 rather than to any live value: the shell only ever sends a
                    // generation on a demand TRANSITION, so it never sends 0, and 0 therefore
                    // means "this document has not declared demand yet" — which nothing can
                    // match.
                    _documentSeq++;
                    // ...and the AUTHORITATIVE copy, under the lock that guards it. The line
                    // above resets the field used for the informational envelope stamp; the
                    // value actually placed on a notifications payload lives in
                    // NotificationCenter and is captured there. Resetting only this one left
                    // the collision it was written to close wide open — a poll in flight from
                    // the old document would still be authorised and stamped with the old
                    // generation, which the new document's first watch can equal.
                    //
                    // Before init, so nothing produced for the previous document can be
                    // authorised while the new one is still being set up.
                    _notifications.BeginNewDocument();
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
                        var disk = LayoutStore.Load();
                        // The attic reconcile (#226), before Seal so unioned-in entries
                        // ride the same pipeline: a save from the OTHER window carries the
                        // attic as it last saw it, and taking that list verbatim would
                        // silently drop retained tiles (their sealed credentials with
                        // them) that only the disk still knows about.
                        LayoutStore.MergeRetainedFromDisk(edited, disk);
                        // The shell round-trips the DECRYPTED layout it was given, so
                        // seal before writing: plaintext credentials never hit disk.
                        // Seal with the manifests that REVEALED this shell's layout. The
                        // shell is holding decrypted values; if a manifest went missing or
                        // unparsable since then, a live lookup would stop calling the
                        // property a secret, Seal would skip it, and the plaintext the
                        // shell is round-tripping would be written straight to disk.
                        // Read off the RAW node — the model carries no extension data.
                        // This is also the channel the on-panel editor never had: it can
                        // now say what the user cleared instead of having to infer it from
                        // a value, which is what Reveal could not express (#153).
                        var secrets = SecretPolicy.Seal(edited, disk, RevealPlan(),
                            SecretPolicy.ReadClearedMarkers(message["layout"]),
                            SecretPolicy.ReadRetainedClearedMarkers(message["layout"]));
                        var secretFailures = secrets.Failures;
                        // Cap the attic and destroy what fell off (#226): the evicted
                        // entries' bytes leave layout.json with this save, and their
                        // derived ww-secure buckets go with them — guarded by liveness,
                        // so an id a surviving tile still uses is never purged (#188).
                        // Destroy-before-Save on purpose: a failed save then leaves a
                        // retained tile without a bucket (it re-authenticates), never a
                        // destroyed tile with a live credential.
                        var evicted = LayoutStore.CapRetained(edited);
                        var forget = LayoutStore.InstancesToForget(evicted, edited, disk);
                        if (forget.Count > 0)
                        {
                            try
                            {
                                SecureStoreHost.Mutate(doc =>
                                {
                                    var changed = false;
                                    foreach (var (w, inst) in forget)
                                        changed |= WidgetSecrets.ForgetInstance(doc, w, inst);
                                    return changed;
                                });
                                Log.Info($"Purged derived credentials for {forget.Count} evicted retained tile(s)");
                            }
                            catch (Exception ex)
                            {
                                // Never the ids: they scope credentials.
                                Log.Warn($"Could not purge evicted retained credentials: {ex.GetType().Name}");
                            }
                        }
                        LayoutStore.Save(edited);
                        Log.Info("layout saved from on-panel editor");
                        if (evicted.Count > 0)
                        {
                            // Tell the shell which attic entries the cap dropped, or its
                            // in-memory copy re-ships them on every subsequent save and
                            // the attic never converges. Correctness doesn't depend on
                            // this — the union+cap above make the disk authoritative —
                            // it stops the re-shipping loop.
                            var gone = new JsonArray();
                            foreach (var ev in evicted)
                                gone.Add(new JsonObject
                                {
                                    ["widgetId"] = ev.Def?.WidgetId,
                                    ["instanceId"] = ev.Def?.InstanceId,
                                });
                            PostToShell("evicted-ids", gone);
                        }
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
                    // Deliberately NOT rate-limited here — see the issue filed from this PR.
                    // A shipping bound on this route was tried and reverted: the widget falls
                    // back to the icon grid whenever `capture` is absent, so every version of
                    // the gate turned a cost bound into a visible flicker. Gating on the
                    // bridge's stamp flickered one widget against its own capture timer;
                    // gating on a dashboard-wide stamp flickered a SECOND widget against the
                    // first, worst at startup when both poll at once and neither has a frame
                    // to preserve. Fixing that needs either per-requester state (which this
                    // file rejects elsewhere, for reasons that apply here too) or a "throttled,
                    // keep what you have" reply the widget understands — a protocol change,
                    // not a limit.
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
                    HandleSdCapture(
                        message["id"]?.GetValue<string>() ?? "",
                        message["have"]?.GetValue<string>() ?? "");
                    break;

                case "sd-click":
                    _streamDeck ??= new StreamDeckBridge();
                    // phase: "down"/"up" from callers with real pointer state (the iCUE
                    // Streamdeck emulation), anything else the original atomic tap.
                    var sdPhase = message["phase"]?.GetValue<string>();
                    _streamDeck.ClickCell(
                        message["row"]?.GetValue<int>() ?? 0,
                        message["col"]?.GetValue<int>() ?? 0,
                        message["rows"]?.GetValue<int>() ?? 3,
                        message["cols"]?.GetValue<int>() ?? 5,
                        message["fx"]?.GetValue<double>(),
                        message["fy"]?.GetValue<double>(),
                        sdPhase is "down" or "up" ? sdPhase : null);
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

                case "secure-get":
                case "secure-set":
                case "secure-delete":
                    HandleSecureStore(message);
                    break;

                case "sd-profiles":
                    // The on-device settings sheet (#48) needs the same discovered
                    // Virtual Stream Deck profile list the desktop editor gets.
                    PostToShell("sd-profiles-result", new JsonObject
                    {
                        ["profiles"] = JsonSerializer.SerializeToNode(StreamDeckBridge.ListProfileNames()),
                    });
                    break;

                case "list-apps":
                    // The on-device sheet's half of #210. It matters more here than on the
                    // desktop: the file dialog needs a Win32 owner window, so picker:'file'
                    // had no picker at all on the panel and the path had to be typed on a
                    // touch strip.
                    PostToShell("apps-result", InstalledApps.ToJson());
                    break;

                case "notifications-watch":
                    // The demand interval this instruction belongs to, echoed back on every
                    // push so the shell can tell a payload produced for the demand it has
                    // NOW from one produced for demand it has since revoked and re-granted
                    // (#132). The host never interprets it — it is the shell's counter, and
                    // treating it as opaque is what keeps the two ends from disagreeing
                    // about what it means.
                    // Opaque. The host never parses or compares it — it stores the string the
                    // shell sent and hands it back on payloads authorised under it, which is
                    // what keeps the two ends from developing separate opinions about what a
                    // generation means.
                    var declaredGen = message["gen"]?.GetValue<string>() ?? "";
                    // Handed straight to SetWatching and held nowhere else: a second copy is
                    // what let the wrong one be reset at ready.
                    _notifications.SetWatching(message["on"]?.GetValue<bool>() == true, declaredGen);
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

    /// <summary>Whether the widget's own Accept header admits ONLY image media types —
    /// the declaration that lets the ladder recognize an HTML answer as a wall even
    /// behind a 200. A range at quality zero is an exclusion, not an admission —
    /// "image/*, text/html;q=0" admits only images — so q=0 ranges are dropped before
    /// the test. Absent or broader Accepts return false: text/html was then an
    /// admissible answer and the response is the site's to give.</summary>
    private static bool AcceptsOnlyImages(JsonNode message)
    {
        if (message["headers"] is not JsonObject headers) return false;
        foreach (var (name, value) in headers)
        {
            if (!string.Equals(name, "Accept", StringComparison.OrdinalIgnoreCase))
                continue;
            var admitted = (value?.GetValue<string>() ?? "")
                .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Where(t => !HasZeroQuality(t))
                .ToList();
            return admitted.Count > 0 && admitted.All(t =>
                t.Split(';')[0].Trim().StartsWith("image/", StringComparison.OrdinalIgnoreCase));
        }
        return false;
    }

    private static bool HasZeroQuality(string mediaRange)
    {
        foreach (var param in mediaRange.Split(';').Skip(1))
        {
            var kv = param.Split('=', 2);
            if (kv.Length == 2 && kv[0].Trim().Equals("q", StringComparison.OrdinalIgnoreCase)
                && double.TryParse(kv[1].Trim(), System.Globalization.CultureInfo.InvariantCulture, out var q))
                return q <= 0;
        }
        return false;
    }

    private static bool IsHtmlContent(System.Net.Http.Headers.MediaTypeHeaderValue? contentType) =>
        contentType?.MediaType is { } media
        && (media.Equals("text/html", StringComparison.OrdinalIgnoreCase)
            || media.Equals("application/xhtml+xml", StringComparison.OrdinalIgnoreCase));

    /// <summary>The browser tier reports its content type as raw header text.</summary>
    private static bool IsHtmlMedia(string? contentType)
    {
        var media = contentType?.Split(';')[0].Trim();
        return media is { }
            && (media.Equals("text/html", StringComparison.OrdinalIgnoreCase)
                || media.Equals("application/xhtml+xml", StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>What every exhausted soft-wall path returns: 502 names the truth —
    /// something answered in the origin's place — where the proxy's masquerading 200
    /// would send the field chasing a widget decode failure.</summary>
    private static void SetWallResult(JsonObject result)
    {
        result["status"] = 502;
        result["statusText"] = "bot wall";
        result["contentType"] = null;
        result["bodyBase64"] = "";
        result["headers"] = new JsonObject();
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
    /// a hostname that isn't a literal private IP or localhost doesn't qualify).
    /// Internal because it is THE private-host policy: the media relay
    /// (<see cref="MediaRelay"/>) must gate on exactly the same set the insecure
    /// proxy tier does.</summary>
    internal static bool IsPrivateHost(Uri uri)
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
    /// <summary>Kept as a name at this call site; the number itself lives in FetchLimits,
    /// because the browser fallback tier has to enforce the same one (#117).</summary>
    private const int ProxyMaxBodyBytes = FetchLimits.MaxBodyBytes;

    /// <summary>The ceiling for one proxied request: the widget's own, clamped.</summary>
    /// <remarks>WW.fetch lets a widget lower its ceiling per call, and until this the number
    /// stayed in the page — so the host still fetched, buffered and base64-encoded the full
    /// 5 MiB before the wrapper there could refuse it, which is the entire cost the lower
    /// ceiling exists to avoid. FetchLimits.EffectiveCap does the clamping: the value comes
    /// from a widget, so it may only ever reduce.</remarks>
    private static int RequestedCap(JsonNode message) =>
        FetchLimits.EffectiveCap(
            message["maxBytes"] is JsonValue mv && mv.TryGetValue<double>(out var asked) ? (long)asked : 0);

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
            var cap = RequestedCap(message);
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) ||
                (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
                throw new InvalidOperationException("only absolute http(s) URLs are allowed");
            // DELETE joins the list because REST APIs spell "this is finished" that way
            // and the widgets had no way to say it: Jellyfin's playback-stopped endpoint
            // is a DELETE, so every position report the panel tried to file on stopping
            // died here with "method not allowed". No wider than PUT, which already
            // mutates, and it rides the same private-host and origin gates.
            if (method is not ("GET" or "POST" or "PUT" or "HEAD" or "DELETE"))
                throw new InvalidOperationException($"method {method} not allowed");

            var insecureRequested = message["insecure"]?.GetValue<bool>() ?? false;
            var lanDevice = insecureRequested && IsPrivateHost(uri);
            // Any widget that reaches a private host through this proxy marks the
            // authority as a legitimate media-relay target (see MediaRelay for why
            // that list exists and what it does and doesn't authorize).
            if (IsPrivateHost(uri))
                MediaRelay.AllowHost(uri);

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

            // A wall can masquerade as SUCCESS: reddit's image CDN answers the .NET
            // fingerprint with its block page at HTTP 200 (field log: fifteen different
            // .jpeg URLs, every "image" ~336 KB of identical text/html). The caller
            // declared what it can accept — a 200 whose media type an image-only Accept
            // never admitted is the wall wearing a success code. Decided from the
            // HEADERS, before the body is consumed: a wall page bigger than the
            // caller's cap would otherwise throw "response too large" right here and
            // the escalation below would never run, even though the browser tier could
            // return a real image well inside that same cap. The known wall's body is
            // never read at all.
            var imageOnly = method == "GET" && AcceptsOnlyImages(message);
            var softWall = response.IsSuccessStatusCode && imageOnly
                && IsHtmlContent(response.Content.Headers.ContentType);
            // A HEAD response carries no body but still declares the Content-Length the
            // body WOULD have — for the Jellyfin playback probe that is a whole movie,
            // and ReadCappedAsync would refuse the declared size of bytes that will
            // never be transferred. Status and headers are the entire answer.
            var bytes = softWall || method == "HEAD"
                ? Array.Empty<byte>()
                : await ReadCappedAsync(response, cap);

            result["status"] = (int)response.StatusCode;
            result["statusText"] = response.ReasonPhrase ?? "";
            result["contentType"] = response.Content.Headers.ContentType?.ToString();
            result["bodyBase64"] = Convert.ToBase64String(bytes);
            // The allow-listed response headers (#169). Without these the escalation
            // silently downgraded what a widget could read: rate-limit and pagination
            // metadata exists only in headers, and this tier answers precisely the
            // requests most likely to carry it.
            result["headers"] = ForwardableResponseHeaders(response);
            Log.Info($"proxy fetch {SafeUrl.Describe(uri)} -> {(int)response.StatusCode} ({bytes.Length} bytes)"
                + (softWall ? " — HTML answering an image-only request; escalating" : ""));

            // The known wall's connection is released BEFORE the serialized browser
            // tier: its body is never read, and holding the open stream through a
            // retry that can take tens of seconds — behind every other caller in the
            // fetcher's queue — accumulates sockets for responses already condemned.
            if (softWall)
                response.Dispose();

            // TLS-fingerprinting bot walls (Reddit) 403 every .NET client; retry those
            // through a real Chromium navigation, which they do trust — and the
            // masquerading 200 escalates the same way.
            if (((int)response.StatusCode is 403 or 429 && method == "GET") || softWall)
            {
                _browserFetcher ??= new BrowserFetcher();
                // The widget's own ceiling reaches this tier too. It is entered on the remote
                // server's 403/429 — which for Reddit, whose TLS fingerprinting is the reason
                // this tier exists, is every request — so a cap that stopped at the proxy tier
                // would be missing from the one path its widget actually takes.
                var alt = await _browserFetcher.FetchAsync(uri.ToString(), browserHeaders, cap);
                if (alt is { TooLarge: true })
                {
                    // The hidden browser got PAST the wall and found the body too large. The
                    // 403 sitting in `result` describes the tier that never saw the body, so
                    // returning it reports an authorization problem for a resource whose only
                    // problem is its size — and the widget's "too large" state, which exists
                    // precisely for this, never appears. Same message as the proxy tier's own
                    // refusal, so the shim types both as a RangeError.
                    result["error"] = "response too large";
                    result.Remove("bodyBase64");
                }
                else if (alt is { } browser && browser.Status < 400)
                {
                    if (imageOnly && IsHtmlMedia(browser.ContentType))
                    {
                        // The browser was walled too — a 2xx HTML answer to an
                        // image-only request is inadmissible whichever tier produced
                        // it, and copying it as success would re-report the wall as a
                        // widget decode failure. Gated on the CALLER's declaration,
                        // not on which wall status opened this block: the proxy's own
                        // 403 enters here too, and Chromium can be served the HTML
                        // challenge on that path just as well.
                        Log.Warn($"browser fetch {SafeUrl.Describe(uri)} -> {browser.Status} but HTML to an image-only request; a wall on every tier");
                        SetWallResult(result);
                    }
                    else
                    {
                        result["status"] = browser.Status;
                        result["statusText"] = "";
                        result["contentType"] = browser.ContentType;
                        result["bodyBase64"] = Convert.ToBase64String(browser.Body);
                        // REPLACED, never merged. Every other field here describes the browser's
                        // answer; leaving the proxy's headers beside them would hand the widget
                        // a 200 carrying the 403's Retry-After — metadata about a response that
                        // is no longer the one being reported. Assigned unconditionally so an
                        // empty collection still clears what the proxy tier put there.
                        result["headers"] = ToHeaderNode(browser.Headers);
                        Log.Info($"browser fetch {SafeUrl.Describe(uri)} -> {browser.Status} ({browser.Body.Length} bytes)");
                    }
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
                    if (softWall)
                    {
                        // On the 403 path the proxy's own status stays — it already says
                        // failure. Here it says 200, and that 200 is a KNOWN wall: the
                        // browser's refusal is the honest answer, not the masquerade.
                        result["status"] = blocked.Status;
                        result["statusText"] = "";
                        result["contentType"] = blocked.ContentType;
                        result["bodyBase64"] = Convert.ToBase64String(blocked.Body);
                        result["headers"] = ToHeaderNode(blocked.Headers);
                    }
                }
                else if (softWall)
                {
                    // The browser tier returned nothing at all (navigation failure or a
                    // refused landing). Returning the proxy's 200 would report success
                    // carrying HTML already ruled inadmissible — the widget would blame
                    // its own decoder.
                    SetWallResult(result);
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

    /// <summary>
    /// The per-instance protected store (#175, re-scoped in #226): secure-get / secure-set / secure-delete.
    ///
    /// <para>THE SCOPE COMES FROM THE SHELL, never from the widget. Both `widgetId` and
    /// `instanceId` on this message are stamped by shell.js from the SLOT that sent it — a
    /// slot it identified by WindowProxy identity and re-checked by origin — because a
    /// widget naming its own scope could name another tile's and read its tokens. The store
    /// scopes per instance under the widget id (#226); the host passes both through and
    /// re-validates neither's provenance, because that provenance is the shell's to
    /// establish and the host cannot re-derive it: by the time a message arrives here the
    /// sender is the shell. An absent/blank instance id is refused downstream as a bad
    /// scope, never widened into a shared bucket.</para>
    ///
    /// <para>Deliberately NOT routed in <see cref="HandlePreviewRequest"/>. The settings
    /// preview runs widget code outside a slot, so it has no trustworthy scope to be given
    /// — and a preview must not read or write live credentials in any case.</para>
    /// </summary>
    private void HandleSecureStore(JsonNode? message)
    {
        var id = message?["id"]?.GetValue<string>() ?? "";
        var type = message?["type"]?.GetValue<string>() ?? "";
        var widgetId = message?["widgetId"]?.GetValue<string>();
        var instanceId = message?["instanceId"]?.GetValue<string>();
        var key = message?["key"]?.GetValue<string>();
        var result = new JsonObject { ["id"] = id };

        try
        {
            // Load/persist and the write-lock live in SecureStoreHost — one gate for
            // every writer of the file, now that evict-on-cap (#226) and uninstall also
            // mutate it from other call sites.
            switch (type)
            {
                case "secure-get":
                    result["ok"] = true;
                    // Absent and unreadable are one answer on purpose: in both cases
                    // the widget's next move is to go and get a new credential.
                    result["value"] = SecureStoreHost.Read(doc => WidgetSecrets.Get(doc, widgetId, instanceId, key));
                    break;

                case "secure-set":
                    var wrote = WidgetSecrets.WriteResult.Unavailable;
                    SecureStoreHost.Mutate(doc =>
                    {
                        wrote = WidgetSecrets.Set(doc, widgetId, instanceId, key, message?["value"]?.GetValue<string>());
                        return wrote == WidgetSecrets.WriteResult.Ok;
                    });
                    result["ok"] = wrote == WidgetSecrets.WriteResult.Ok;
                    if (wrote != WidgetSecrets.WriteResult.Ok)
                    {
                        // Named rather than collapsed into false: the widget's
                        // fallback differs. "unavailable" means keep it in memory and
                        // carry on; the rest are the widget's own bug. The names come
                        // from WireName, not from the enum member — the documented
                        // vocabulary is kebab-case, and a rename must not quietly
                        // change what widgets branch on.
                        result["error"] = WidgetSecrets.WireName(wrote);
                    }
                    break;

                case "secure-delete":
                    SecureStoreHost.Mutate(doc => WidgetSecrets.Delete(doc, widgetId, instanceId, key));
                    // Deleting something absent is not a failure — the caller's
                    // intent ("this must not be stored") holds either way.
                    result["ok"] = true;
                    break;

                default:
                    result["ok"] = false;
                    result["error"] = "unsupported";
                    break;
            }
        }
        catch (Exception ex)
        {
            // Never the key, never the value: this runs on a path whose entire purpose is
            // that credentials do not end up somewhere they can be read.
            Log.Warn($"secure store {type} failed for '{widgetId}': {ex.GetType().Name}");
            result["ok"] = false;
            result["error"] = "unavailable";
        }
        PostToShell("secure-result", result);
    }

    /// <summary>
    /// The allow-listed response headers of a proxied response, as a JSON object (#169).
    ///
    /// Both collections are walked, because .NET splits them: <c>ETag</c> and
    /// <c>Retry-After</c> live on the message while <c>Last-Modified</c> lives on the
    /// content, and reading only one silently drops half the list.
    ///
    /// Repeated names are joined with ", " per RFC 9110 §5.3 — <c>Link</c> is routinely
    /// sent as several lines and a widget parsing pagination needs all of them, not
    /// whichever arrived last.
    /// </summary>
    private static JsonObject ForwardableResponseHeaders(HttpResponseMessage response)
    {
        var pairs = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
        void Collect(IEnumerable<KeyValuePair<string, IEnumerable<string>>> from)
        {
            foreach (var (name, values) in from)
            {
                if (!ProxyHeaderRules.IsForwardableResponseHeader(name)) continue;
                if (!pairs.TryGetValue(name, out var list)) pairs[name] = list = new List<string>();
                list.AddRange(values);
            }
        }
        Collect(response.Headers);
        Collect(response.Content.Headers);

        var node = new JsonObject();
        foreach (var (name, values) in pairs) node[name] = string.Join(", ", values);
        return node;
    }

    /// <summary>The hidden-browser tier's headers, already filtered in the page, as the
    /// same JSON shape. Kept separate from the collection above because that tier reads
    /// its response through a page fetch rather than an HttpResponseMessage.</summary>
    private static JsonObject ToHeaderNode(IReadOnlyDictionary<string, string>? headers)
    {
        var node = new JsonObject();
        if (headers is null) return node;
        foreach (var (name, value) in headers)
        {
            // Filtered again on this side. The page script is generated from the same
            // list, but it runs in a document the remote site controls, so what comes
            // back is the site's word for it rather than the host's.
            if (ProxyHeaderRules.IsForwardableResponseHeader(name)) node[name] = value;
        }
        return node;
    }

    private static async Task<byte[]> ReadCappedAsync(HttpResponseMessage response, int maxBytes)
    {
        if (response.Content.Headers.ContentLength is { } length && FetchLimits.DeclaredTooLarge(length, maxBytes))
            throw new InvalidOperationException("response too large");

        await using var stream = await response.Content.ReadAsStreamAsync();
        using var buffer = new MemoryStream();
        var chunk = new byte[81920];
        int read;
        while ((read = await stream.ReadAsync(chunk)) > 0)
        {
            if (FetchLimits.WouldExceed(buffer.Length, read, maxBytes))
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
        var blanked = SecretPolicy.Reveal(layout, RevealPlan());
        // Two widgets may legitimately share a name (an imported iCUE "StreamDeck" beside
        // the stock "Stream Deck"), and every picker on the panel prints the name. The
        // label is decided once, here and in SettingsWindow.WidgetCatalog, from the whole
        // installed set — a widget cannot know on its own whether it is contested.
        var labels = WidgetIdentity.DisplayNames(
            _library.Widgets.Select(w => (w.Manifest.Id, (string?)w.Manifest.Name, (string?)w.Manifest.Author)));
        var widgets = _library.Widgets.Select(w => new
        {
            id = w.Manifest.Id,
            name = w.Manifest.Name,
            displayName = labels.TryGetValue(w.Manifest.Id, out var label) ? label : w.Manifest.Name,
            url = $"https://{w.VirtualHost}/index.html",
            supportedSlots = w.Manifest.SupportedSlots,
            properties = w.Manifest.Properties,
        });

        var tokens = new JsonObject();
        foreach (var (name, value) in PaletteEngine.Derive(layout.Theme))
            tokens[name] = value;

        return new JsonObject
        {
            ["layout"] = RevealedLayoutNode(layout, blanked),
            ["widgets"] = JsonSerializer.SerializeToNode(widgets, BridgeJson),
            ["sensors"] = JsonSerializer.SerializeToNode(_hub.LatestSensors, BridgeJson),
            ["media"] = JsonSerializer.SerializeToNode(_hub.LatestMedia, BridgeJson),
            ["backgroundHost"] = BackgroundHost,
            ["theme"] = tokens,
            // The relay credential rides the same payload as the revealed secrets:
            // this channel already only reaches the dashboard shell, and the shell
            // forwards it only to verified widget documents (ww-init). See MediaRelay.
            ["mediaRelayToken"] = MediaRelay.Token,
            ["status"] = new JsonObject { ["elevated"] = _hub.IsElevated, ["apiVersion"] = 1 },
            // What makes this document's generations distinguishable from the previous
            // document's. The shell counts from zero in every document, so without a base
            // two documents produce the same strings and a payload authorised for the old
            // one can equal what the new one will produce.
            ["genBase"] = _documentSeq,
        };
    }

    private long _lastCaptureTicks;
    private (string DataUri, int W, int H, string Hash)? _lastCapture;

    /// <summary>
    /// Capture-only fast path for the live Stream Deck mirror: no profile re-parse, and no
    /// pixels for an asker that says it already has this frame.
    /// </summary>
    /// <remarks>
    /// Two separate concerns, which used to be tangled into one cached RESULT:
    ///
    ///   the throttle is a COST control — several widgets polling at once share one
    ///   PrintWindow per interval, so what is cached is the CAPTURE;
    ///   the dedup is a per-consumer question — "have you seen this frame?" — and the
    ///   consumer answers it, in <paramref name="have"/>.
    ///
    /// Caching the result conflated them, and that only worked while the answer was
    /// broadcast to every live widget at once. Routing replies to the requester made the
    /// second widget in a polling pair receive "unchanged" about pixels it was never sent.
    ///
    /// The obvious repair — remember per consumer here — was tried and is gone. Every
    /// version of it had the same shape of bug: this object outlives the documents it
    /// describes, so a slot reload, a shell reload, a reply that expired before it landed,
    /// or an eviction from a bounded table each left an entry claiming a widget had pixels
    /// it had never received, and the mirror stayed blank until the deck changed. Asking
    /// the only party that KNOWS has no such failure: the answer dies with the document.
    ///
    /// A widget can lie in <paramref name="have"/>, and it only reaches itself — a wrong
    /// hash costs it a redundant frame or a stale one on its own screen. It cannot name
    /// another widget's baseline because there is no longer a table to name into.
    /// </remarks>
    private void HandleSdCapture(string requestId, string have)
    {
        var now = Environment.TickCount64;
        if (now - _lastCaptureTicks >= 100)
        {
            _lastCaptureTicks = now;
            _lastCapture = _streamDeck!.CaptureVsdWindow();
        }

        JsonObject result;
        if (_lastCapture is not { } capture)
            result = new JsonObject { ["available"] = false };
        else if (!string.IsNullOrEmpty(have) && string.Equals(have, capture.Hash, StringComparison.Ordinal))
            result = new JsonObject { ["unchanged"] = true };
        else
            result = new JsonObject
            {
                ["image"] = capture.DataUri,
                ["w"] = capture.W,
                ["h"] = capture.H,
                // The receipt the next request quotes back. Sent WITH the pixels, so a
                // reply that never arrives advances nothing.
                ["hash"] = capture.Hash,
            };

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

    /// <summary>The credential names of every widget the library REFUSED, as of the same
    /// reveal. Ordinal, and paired with <see cref="_revealedManifests"/> — the two are
    /// snapshotted together and consumed together by <see cref="RevealPlan"/>, because a
    /// value this plan WITHHELD is a blank in the shell's copy, and only the same plan
    /// makes the next save restore it instead of writing that blank to disk.</summary>
    private Dictionary<string, List<string>>? _revealedRedactions;

    private IReadOnlyList<string>? RedactionsRevealedWith(string widgetId) =>
        _revealedRedactions is not null && _revealedRedactions.TryGetValue(widgetId, out var names)
            ? names
            : null;

    /// <summary>The plan that produced the shell's layout, and therefore the only plan its
    /// saves may be sealed against. Rebuilt per call — a plan caches, so holding one
    /// across operations would answer the second with the first one's library.</summary>
    private SecretPlan RevealPlan() =>
        SecretPlan.FromManifests(ManifestRevealedWith, RedactionsRevealedWith);

    /// <summary>The revealed layout as JSON, carrying the reveal-side restorable marker.
    ///
    /// The model cannot hold a projection — that is what keeps every marker out of
    /// layout.json — so the names are stamped here, on the node about to be sent, exactly
    /// where `Mask` puts its own for the settings editor. Without it the panel cannot tell
    /// a field the host emptied from one that was always empty, renders no Clear, and a
    /// demoted credential is undeletable there (#153).</summary>
    private static JsonNode? RevealedLayoutNode(
        DashboardLayout layout,
        IReadOnlyDictionary<(int Page, int Slot), IReadOnlyList<string>> blanked)
    {
        var node = JsonSerializer.SerializeToNode(layout);
        SecretPolicy.StampMarkers(node, SecretPolicy.RestorableMarkerKey, blanked);
        return node;
    }

    private void SnapshotManifests()
    {
        // Ordinal — see ManifestFor. Collapsing case here would let one widget's manifest
        // decide what to decrypt for another.
        var snapshot = new Dictionary<string, WidgetManifest>(StringComparer.Ordinal);
        foreach (var w in _library.Widgets)
            snapshot[w.Manifest.Id] = w.Manifest;
        _revealedManifests = snapshot;

        // Refusals are snapshotted in the same breath and, unlike the settings window's,
        // are simply rebuilt: this runs once per reveal and nothing consults the snapshot
        // before the layout it describes exists. There is no rescan path that replaces it
        // underneath a shell already holding withheld blanks — BuildInitPayload is the
        // only caller, and it re-reveals from disk.
        var redactions = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var r in _library.AllRefusals)
        {
            if (string.IsNullOrEmpty(r.Id) || r.RedactNames.Count == 0)
                continue;
            if (!redactions.TryGetValue(r.Id, out var names))
                redactions[r.Id] = names = [];
            foreach (var n in r.RedactNames)
                if (!string.IsNullOrEmpty(n) && !names.Contains(n, StringComparer.Ordinal))
                    names.Add(n);
        }
        _revealedRedactions = redactions;
    }

    private void PostToShellThreadSafe(string type, JsonNode? data, string? gen = null)
    {
        if (!_shellReady || !IsHandleCreated || IsDisposed)
            return;
        try
        {
            BeginInvoke(() => PostToShell(type, data, gen));
        }
        catch (ObjectDisposedException)
        {
            // Window torn down between the check and the invoke; nothing to do.
        }
    }

    /// <summary>The last demand generation the shell told us about (#132).</summary>
    /// <remarks>
    /// Written from the web-message handler and read from PostToShell. Those are both the UI
    /// thread today, but a push can originate on a worker — NotificationCenter raises its
    /// events from a timer thread — and PostToShellThreadSafe
    /// marshals rather than blocks, so the read is not guaranteed to be on the writer's
    /// thread. Volatile rather than a lock: a stale read costs one dropped push, which the
    /// next poll replaces, while a lock on the push path would be contention for nothing.
    /// </remarks>
    /// <summary>How many shell documents this process has served.</summary>
    /// <remarks>The generation the shell counts restarts at 0 in every document, so two
    /// documents produce the same numbers. This makes the stamp document-unique: the shell
    /// composes its counter onto the base it is given in init, and a payload authorised for
    /// a previous document can never equal one the current document will produce.
    ///
    /// Deterministic rather than random on purpose. A random seed makes a collision
    /// unlikely; a monotonic sequence makes it impossible, and this guard exists precisely
    /// because "unlikely" was not the standard.
    ///
    /// UI thread only — assigned in the ready handler and read when building init.</remarks>
    private long _documentSeq;

    private void PostToShell(string type, JsonNode? data, string? gen = null)
    {
        if (_webView.CoreWebView2 is null)
            return;
        // Stamped on EVERY envelope, in the one place every envelope is built, so the field
        // means the same thing everywhere and no future channel can be added without it.
        // Which channels the shell actually GATES on it is the shell's decision and is
        // deliberately narrower — see the note in handleHostMessage.
        var envelope = new JsonObject
        {
            ["type"] = type,
            ["data"] = data,
            // Present ONLY when the producing path supplies one, captured at the moment the
            // payload was authorised. There is deliberately no fallback: a channel stamped
            // here instead would be stamped at post time, which is the race this whole
            // change exists to close, wearing the costume of a fix. A future gated channel
            // must carry its own generation from its own authorisation point, and the
            // absence of the field is what forces that rather than letting it inherit a
            // number that means nothing.
            ["gen"] = gen,
        };
        _webView.CoreWebView2.PostWebMessageAsJson(envelope.ToJsonString());
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _hub.SensorsUpdated -= OnSensorsUpdated;
            _hub.MediaUpdated -= OnMediaUpdated;
            _notifications.Dispose();
            _browserFetcher?.Dispose();
            _webView.Dispose();
        }
        base.Dispose(disposing);
    }
}
