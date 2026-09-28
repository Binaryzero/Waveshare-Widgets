using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Plinth.Sensors;
using Plinth.Widgets;

namespace Plinth.App;

/// <summary>
/// The desktop settings window (opened from the tray, shown on the main monitor):
/// a web-based editor for pages, slots, and per-widget properties that reads and
/// writes layout.json without the user touching JSON. It is the only editor: the panel
/// only displays, and this window's save reloads it.
/// </summary>
public sealed class SettingsWindow : Form
{
    private const string ShellHost = "app.plinth";
    private const string BackgroundHost = "backgrounds.plinth";

    // Extensions accepted for background wallpapers (static + animated). WebView2 is
    // Chromium, so AVIF (including animated AVIF) decodes natively.
    private static readonly string[] ImageExtensions = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif"];
    private static readonly string[] VideoExtensions = [".mp4", ".webm", ".mov", ".m4v"];

    private static readonly JsonSerializerOptions BridgeJson = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private readonly SensorHub _hub;
    private readonly WidgetLibrary _library;
    private readonly WebView2 _webView = new();

    /// <summary>Raised after a layout is saved so the dashboard can reload.</summary>
    public event Action? LayoutSaved;

    /// <summary>The live dashboard window, when there is one. The preview replica's widget
    /// data requests (fetch/ping/media-list/audio-get) go through its real handlers, and
    /// Find asks the placed widget on it (#210).</summary>
    public DashboardWindow? Dashboard { get; set; }

    /// <summary>The bounds the window was placed at, re-asserted once the handle exists
    /// in case creation rescaled them (see <see cref="OnLoad"/>).</summary>
    private readonly Rectangle _placedBounds;

    /// <summary>Whether it was left maximized. Applied in <see cref="OnLoad"/>, after the
    /// placed bounds are in force, so they are what un-maximizing returns to.</summary>
    private readonly bool _placedMaximized;

    /// <summary>The display it was placed on, for the minimum once the frame is known.</summary>
    private readonly WindowPlacement.Display _placedDisplay;

    private bool _placementSaved;

    /// <summary>The panel's display, as last found: its size is what the preview is drawn
    /// at (<see cref="PanelMoved"/>).</summary>
    private string? _panelDeviceName;

    /// <summary>The panel page last sent to the editor, as JSON, so an unchanged one is not
    /// sent again on every placement tick.</summary>
    private string? _postedPanel;

    /// <param name="panelDeviceName">The panel's display, when one is found. The window
    /// never opens there: it is the dashboard's, and a 1280x400 one cannot hold it.</param>
    public SettingsWindow(SensorHub hub, WidgetLibrary library, string? panelDeviceName = null)
    {
        _hub = hub;
        _library = library;
        _panelDeviceName = panelDeviceName;

        Text = "Plinth — Settings";
        // Sized for the display it opens on, in that display's pixels, and where it was
        // left last time (WindowPlacement). Set before the handle exists, so the window
        // is created on its display at its size rather than moved there afterwards.
        StartPosition = FormStartPosition.Manual;
        var (placement, display) = PlaceWindow(panelDeviceName);
        _placedDisplay = display;
        _placedMaximized = placement.Maximized;
        MinimumSize = WindowPlacement.MinimumFor(display);   // the frame is added in OnLoad
        Bounds = _placedBounds = placement.Bounds;
        // FormClosed, not FormClosing: a close something cancels must not record a place the
        // window is still open at. Dispose saves too, for the tray's Exit, which disposes
        // an open window without closing it.
        FormClosed += (_, _) => SavePlacement();
        BackColor = Color.FromArgb(11, 14, 20);

        _webView.Dock = DockStyle.Fill;
        _webView.DefaultBackgroundColor = Color.FromArgb(11, 14, 20);
        Controls.Add(_webView);
        Icon = AppIcon.Window;

        Load += async (_, _) => await InitializeAsync();
    }

    private async Task InitializeAsync()
    {
        try
        {
            var environment = await WebViewEnvironment.GetAsync();
            await _webView.EnsureCoreWebView2Async(environment);

            var core = _webView.CoreWebView2;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            // NO MediaRelay here, on purpose: the editor channel is credential-free
            // by design — its init masks every secret — so the replica's widgets hold
            // neither API keys nor the relay token, and could not play media anyway.
            // Wiring the relay without the token would only be a 403 generator.
            WebViewEnvironment.MirrorRendererConsole(core);
            core.WebMessageReceived += OnWebMessageReceived;
            _hosts.MapFixed(core, ShellHost, AppPaths.ShellDir);
            // So the editor can preview chosen background images/videos.
            _hosts.MapFixed(core, BackgroundHost, AppPaths.BackgroundsDir);
            // The live replica embeds the real shell with real widget iframes, so their
            // origins (and the media library) must resolve here too.
            _hosts.MapFixed(core, "media.plinth", AppPaths.MediaDir);
            _hosts.Sync(core, _library.Widgets);
            // The replica's widget iframes rely on the injected shim, same as the panel.
            var shim = File.ReadAllText(Path.Combine(AppPaths.ShellDir, "widget-api.js")) + "\n" +
                       File.ReadAllText(Path.Combine(AppPaths.ShellDir, "icue-compat.js")) +
                       "\n" + File.ReadAllText(Path.Combine(AppPaths.ShellDir, "icue-common.js"));
            await core.AddScriptToExecuteOnDocumentCreatedAsync(shim);
            _hub.SensorsUpdated += OnSensorsUpdated;
            _hub.MediaUpdated += OnMediaUpdated;
            // Fires on the watcher's thread; OnLibraryChanged marshals before touching
            // the WebView. Unsubscribed below — this window is opened and closed
            // repeatedly, and a surviving handler would post into a dead WebView.
            _library.Changed += OnLibraryChanged;
            FormClosed += (_, _) =>
            {
                _hub.SensorsUpdated -= OnSensorsUpdated;
                _hub.MediaUpdated -= OnMediaUpdated;
                _library.Changed -= OnLibraryChanged;
            };
            core.Navigate($"https://{ShellHost}/settings.html");
        }
        catch (Exception ex)
        {
            Log.Error($"Settings window failed to start: {ex.Message}");
            MessageBox.Show(this, "Failed to start the settings window. Is the WebView2 Runtime installed?",
                "Plinth", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }

    /// <summary>Origins already reported as rejected, keyed on the REDACTED form — the
    /// same string the warning prints, which is the only key that makes a duplicate line
    /// impossible. See the matching field on DashboardWindow for why the raw source is
    /// not equivalent.</summary>
    private readonly HashSet<string> _rejectedOrigins = new(StringComparer.OrdinalIgnoreCase);

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        // Who sent this, before what it says (#72). This window matters as much as the
        // dashboard: its preview replica hosts REAL widget iframes, and its handler saves
        // layouts and installs packages.
        if (!MessageOrigin.IsShell(e.Source, ShellHost))
        {
            var origin = SafeUrl.Describe(e.Source);
            if (_rejectedOrigins.Add(origin))
                Log.Warn($"Ignored a settings message from an unexpected origin: {origin}");
            return;
        }
        try
        {
            var message = JsonNode.Parse(e.WebMessageAsJson);
            switch (message?["type"]?.GetValue<string>())
            {
                case "settings-ready":
                    PostInit();
                    break;

                // The stale banner's Reload (#281). Same payload as the first init — the
                // editor asks for it only once the user has agreed to lose the working
                // copy, so there is nothing here to be careful of that PostInit isn't.
                case "reload-layout":
                    PostInit();
                    break;

                case "save-layout":
                    HandleSave(message["layout"], message["seq"]?.GetValue<long>(),
                        message["generation"]?.GetValue<long>());
                    break;

                case "mask-retained":
                    HandleMaskRetained(message);
                    break;

                // The user opened a tile marked "Updated" (#227).
                case "tile-reviewed":
                    if (message["instanceId"]?.GetValue<string>() is { Length: > 0 } reviewed)
                        WidgetCatalogState.Shared?.MarkReviewed(reviewed);
                    break;

                case "install-widget":
                    HandleInstall();
                    break;

                case "open-widgets-folder":
                    Process.Start(new ProcessStartInfo(AppPaths.WidgetsDir) { UseShellExecute = true });
                    break;

                case "open-media-folder":
                    Process.Start(new ProcessStartInfo(AppPaths.MediaDir) { UseShellExecute = true });
                    break;

                case "pick-background":
                    HandlePickBackground(message["target"]?.GetValue<string>() ?? "");
                    break;

                case "pick-file":
                    HandlePickFile(message["id"]?.GetValue<string>() ?? "");
                    break;

                case "preview-data":
                    // Widget data requests surfaced by the embedded replica. Marshaled
                    // back onto the UI thread because the fetch/ping handlers reply from
                    // worker threads.
                    if (Dashboard is { IsDisposed: false } dashboard)
                    {
                        dashboard.HandlePreviewRequest(message["message"], (type, data) =>
                        {
                            try
                            {
                                BeginInvoke(() => Post(new JsonObject
                                {
                                    ["type"] = "preview-host",
                                    ["message"] = new JsonObject { ["type"] = type, ["data"] = data },
                                }));
                            }
                            catch (ObjectDisposedException) { /* window closed */ }
                        });
                    }
                    else
                    {
                        // No dashboard window (panel not detected): the settings window
                        // still opens with a live preview, so answer immediately instead
                        // of silently dropping the request — widgets would otherwise sit
                        // on their API timeouts instead of rendering their fallbacks.
                        HandlePreviewWithoutDashboard(message["message"]);
                    }
                    break;

                case "discover":
                    HandleDiscover(message);
                    break;

                case "sd-profiles":
                    Post(new JsonObject
                    {
                        ["type"] = "sd-profiles-result",
                        ["profiles"] = JsonSerializer.SerializeToNode(StreamDeckBridge.ListProfileNames()),
                    });
                    break;

                case "list-apps":
                    // Answers "which programs are on this PC" so a path target can be
                    // picked rather than known (#210). Enumerated per request instead of
                    // cached: the editor asks once when a picker opens, and a list built
                    // at startup would miss anything installed since.
                    _ = PostInstalledAppsAsync();
                    break;
            }
        }
        catch (Exception ex)
        {
            Log.Warn($"Bad settings message: {ex.Message}");
        }
    }

    /// <summary>Immediate answers for the replica's data requests when no dashboard
    /// window exists (panel not detected). The media library is served for real (the
    /// listing is dashboard-independent); fetch and ping fail fast so widgets show
    /// their error/empty states; audio reports the widget's designed "unavailable".</summary>
    private void HandlePreviewWithoutDashboard(JsonNode? message)
    {
        var id = message?["id"]?.GetValue<string>() ?? "";
        switch (message?["type"]?.GetValue<string>())
        {
            case "fetch":
                PostPreview("fetch-result", new JsonObject
                {
                    ["id"] = id,
                    ["error"] = "dashboard not running (panel not detected)",
                });
                break;

            case "ping":
                var results = new JsonArray();
                if (message["hosts"] is JsonArray hosts)
                    foreach (var h in hosts)
                    {
                        var host = h?.GetValue<string>()?.Trim();
                        if (!string.IsNullOrEmpty(host) && results.Count < 16)
                            results.Add(new JsonObject
                            {
                                ["host"] = host,
                                ["ok"] = false,
                                ["error"] = "dashboard not running (panel not detected)",
                            });
                    }
                PostPreview("ping-result", new JsonObject { ["id"] = id, ["results"] = results });
                break;

            case "media-list":
                PostPreview("media-list-result", DashboardWindow.BuildMediaList(id));
                break;

            case "audio-get":
                PostPreview("audio-result", new JsonObject { ["id"] = id, ["available"] = false });
                break;
        }

        void PostPreview(string type, JsonNode? data) => Post(new JsonObject
        {
            ["type"] = "preview-host",
            ["message"] = new JsonObject { ["type"] = type, ["data"] = data },
        });
    }

    private void OnSensorsUpdated(IReadOnlyList<SensorReading> sensors) =>
        PostPreviewThreadSafe("sensors", JsonSerializer.SerializeToNode(sensors, BridgeJson));

    private void OnMediaUpdated(MediaState media) =>
        PostPreviewThreadSafe("media", JsonSerializer.SerializeToNode(media, BridgeJson));

    /// <summary>"Find…" on a setting the widget can look up itself (#210). This window never
    /// holds the widget's decrypted settings, so the question goes to the placed widget on
    /// the panel, and only its list of choices comes back. No panel, no lookup: the answer
    /// says so at once and the field stays typeable.</summary>
    private void HandleDiscover(JsonNode message)
    {
        var id = message["id"]?.GetValue<string>() ?? "";
        if (id.Length is 0 or > 64)
            return;
        void Answer(JsonObject result)
        {
            result["type"] = "discover-result";
            result["id"] = id;
            if (IsDisposed || !IsHandleCreated)
                return;
            try { BeginInvoke(() => Post(result)); }
            catch (ObjectDisposedException) { /* window closed */ }
        }

        var instanceId = message["instanceId"]?.GetValue<string>() ?? "";
        var property = message["property"]?.GetValue<string>() ?? "";
        var field = message["field"]?.GetValue<string>();
        if (instanceId.Length is 0 or > 128 || property.Length is 0 or > 128 || field is { Length: > 128 })
        {
            Answer(DashboardWindow.DiscoveryRefused("not-placed"));
            return;
        }
        // The user's search, when the first answer was cut short (Find by query). A widget
        // may filter by it; nothing else reads it. Non-string or absent reads as none.
        var query = message["query"] is JsonValue q && q.TryGetValue<string>(out var text) ? text.Trim() : "";
        if (query.Length > 100)
            query = query[..100];
        if (Dashboard is { IsDisposed: false } dashboard)
            dashboard.RequestDiscovery(instanceId, property, field, query, Answer);
        else
            Answer(DashboardWindow.DiscoveryRefused("no-dashboard"));
    }

    /// <summary>The installed-app list, built off the UI thread (it reads a shell COM
    /// namespace) and posted back when ready (#219).</summary>
    private async Task PostInstalledAppsAsync()
    {
        var payload = await InstalledApps.ToJsonAsync();
        payload["type"] = "apps-result";
        if (!IsHandleCreated || IsDisposed)
            return;
        try { BeginInvoke(() => Post(payload)); }
        catch (ObjectDisposedException) { /* window closed */ }
    }

    /// <summary>Live data for the embedded replica, marshaled onto the UI thread.</summary>
    private void PostPreviewThreadSafe(string type, JsonNode? data)
    {
        if (!IsHandleCreated || IsDisposed)
            return;
        try
        {
            BeginInvoke(() => Post(new JsonObject
            {
                ["type"] = "preview-host",
                ["message"] = new JsonObject { ["type"] = type, ["data"] = data },
            }));
        }
        catch (ObjectDisposedException) { /* window closed */ }
    }

    /// <summary>Manifest lookup for the secret pipeline (which properties are credentials).
    ///
    /// ORDINAL, because that is the identity the library itself uses: <c>Rescan</c> resolves
    /// duplicates with an ordinal compare, so 'Foo' and 'foo' are two distinct widgets that
    /// both load. A case-insensitive lookup here answers a question the library never asked —
    /// it hands a refused 'Foo' the manifest of an unrelated 'foo', and Mask then blanks that
    /// widget's secret names instead of this one's, posting the credential 'Foo' was refused
    /// over to the editor untouched.</summary>
    private WidgetManifest? ManifestFor(string widgetId) =>
        _library.Widgets.FirstOrDefault(w => string.Equals(w.Manifest.Id, widgetId, StringComparison.Ordinal))?.Manifest;

    /// <summary>The manifests that produced the CURRENTLY masked payload. Save must seal
    /// against these, not against whatever the library holds by then: if a widget is
    /// uninstalled — or its manifest briefly fails to parse — between init and Save, a
    /// live lookup stops calling the property a secret, Seal never walks it, and the
    /// blank the editor is holding overwrites the stored ciphertext. This window is not
    /// rebuilt on library changes, so the snapshot is the only honest lookup.</summary>
    private Dictionary<string, WidgetManifest>? _maskedManifests;

    private WidgetManifest? ManifestAsMasked(string widgetId)
    {
        if (_maskedManifests is not null && _maskedManifests.TryGetValue(widgetId, out var snapshot))
            return snapshot;
        return ManifestFor(widgetId);
    }

    /// <summary>Rebuilds the baseline from the current library. Only legitimate when the
    /// layout is (re)masked in the same breath — the snapshot's job is to describe the
    /// manifests that produced the MASKED LAYOUT the editor is holding, not the palette.</summary>
    private void SnapshotManifests()
    {
        // Ordinal — the library's own notion of widget identity. See ManifestFor.
        var snapshot = new Dictionary<string, WidgetManifest>(StringComparer.Ordinal);
        foreach (var w in _library.Widgets)
            snapshot[w.Manifest.Id] = w.Manifest;
        _maskedManifests = snapshot;
        _maskedRedactions = null;
        SnapshotRedactions();
    }

    /// <summary>The credential names of every widget the library REFUSED, as of the
    /// masking. Keyed by widget id, ordinal, and it only ever GROWS — see
    /// <see cref="SnapshotRedactions"/>.
    ///
    /// This is what replaced the redaction-only stand-in manifests. A refusal removes the
    /// widget from the library, so a manifest lookup for its slots returns null and Mask
    /// walks straight past the plaintext credential the widget was refused over — the
    /// refusal creating the exposure it exists to prevent. The old answer was to fabricate
    /// a manifest saying those names were `secret`; the answer now is to say it directly,
    /// per address, as <c>ProtectWithoutReveal</c>. Two things fall out of that which the
    /// fabrication could not do: a refusal SHADOWED by a same-id widget that loaded can be
    /// carried at all (#67, #104 — one manifest cannot represent two widgets), and the
    /// value is withheld from the dashboard payload rather than merely masked here.</summary>
    private Dictionary<string, List<string>>? _maskedRedactions;

    private IReadOnlyList<string>? RedactionsAsMasked(string widgetId) =>
        _maskedRedactions is not null && _maskedRedactions.TryGetValue(widgetId, out var names)
            ? names
            : null;

    /// <summary>The plan the masked payload was built with, and therefore the only plan
    /// the next save may be sealed against. Built at each call site rather than held: a
    /// plan caches its classifications, so one instance spanning two operations would
    /// answer the second with the first one's library.</summary>
    private SecretPlan MaskedPlan() => SecretPlan.FromManifests(ManifestAsMasked, RedactionsAsMasked);

    /// <summary>Folds the library's current refusals into the snapshot. ADDITIVE — a name
    /// that ever appeared is never dropped.
    ///
    /// Same reasoning as the manifest union, and the same asymmetry: a name that was a
    /// credential at masking time left a blank in the editor, and only a plan that still
    /// names it makes Seal restore the stored value instead of writing that blank over it.
    /// If the user fixes the folder and the widget loads on the next rescan, forgetting
    /// the name here is what destroys the credential on the next save.
    ///
    /// Growing costs a value a trip through a cipher it no longer needs, and the reveal it
    /// is withheld from lasts until the editor is reopened. Shrinking costs the value.
    ///
    /// Two refused folders can share an id, so this unions across records rather than
    /// assuming one.</summary>
    private void SnapshotRedactions()
    {
        var into = _maskedRedactions ?? new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var r in _library.AllRefusals)
        {
            if (string.IsNullOrEmpty(r.Id) || r.RedactNames.Count == 0)
                continue;
            if (!into.TryGetValue(r.Id, out var names))
                into[r.Id] = names = [];
            foreach (var n in r.RedactNames)
                if (!string.IsNullOrEmpty(n) && !names.Contains(n, StringComparer.Ordinal))
                    names.Add(n);
        }
        _maskedRedactions = into;
    }

    /// <summary>Adds newly-seen manifests to the baseline WITHOUT dropping any.
    ///
    /// Used when the library changes under an editor that is still holding a layout
    /// masked with the old manifests. Replacing the snapshot there loses credentials: if
    /// a credentialed widget is removed, refused, or becomes briefly unparseable, its
    /// manifest disappears from the baseline, <see cref="SecretPolicy.Seal"/> stops
    /// walking that widget's secret fields on the next save, and the masked empty string
    /// is written straight over the stored ciphertext.
    ///
    /// A manifest that once masked the layout has to stay reachable until the layout
    /// itself is remasked, which only happens in <see cref="PostInit"/>. Stale entries
    /// are harmless — Seal consults them by widget id for slots that already exist.</summary>
    private void MergeManifestSnapshot()
    {
        if (_maskedManifests is null) { SnapshotManifests(); return; }
        foreach (var w in _library.Widgets)
        {
            if (!_maskedManifests.TryGetValue(w.Manifest.Id, out var masked))
            {
                _maskedManifests[w.Manifest.Id] = w.Manifest;
                continue;
            }

            // UNION the property lists — neither manifest alone is sufficient, and
            // getting this wrong loses a credential in one direction or the other:
            //
            //   keep only the OLD  -> a secret ADDED by the reload is unknown to Seal, so
            //                         a credential the user types into the new field is
            //                         written to layout.json as plaintext.
            //   keep only the NEW  -> a secret the reload REMOVED or retyped is unknown,
            //                         so the editor's masked blank overwrites the stored
            //                         ciphertext.
            //
            // Name-collision rule: SECRET WINS, from whichever side declares it.
            //
            // This snapshot answers exactly one question — how was the layout the editor
            // is HOLDING masked — because that layout is what the next save writes. A
            // property that was `secret` at masking time left a blank in the editor, and
            // only a lookup that still calls it secret makes Seal restore the stored
            // ciphertext instead of writing that blank over it.
            //
            // So the new manifest does NOT get to demote a property here, however fresh
            // its statement is. I briefly made it "new wins" to stop Seal encrypting a
            // value the current manifest calls ordinary, and that traded a display bug for
            // permanent data loss: an unrelated edit saved while the editor still held the
            // masked blank destroyed the credential. The demotion is real and does need
            // handling — but on the REVEAL side, where a widget can simply be refused the
            // ciphertext, not here, where the value itself is at stake.
            //
            // Erring toward secret costs a value a trip through a cipher it did not need.
            // Erring the other way costs the value.
            //
            // ORDINAL, matching the only comparer that decides anything downstream: setting
            // keys are JSON object keys and SecretPolicy.SecretNames is an ordinal set. A
            // case-insensitive index collapses `apiToken` and `ApiToken` into one entry, so a
            // reload that renames a secret by case alone leaves the NEW name out of the union
            // — the editor renders and accepts it while Seal, walking ordinal names, seals
            // only the old one and writes the credential to layout.json in the clear.
            var union = new List<WidgetProperty>(masked.Properties);
            var byName = new Dictionary<string, int>(StringComparer.Ordinal);
            for (var i = 0; i < union.Count; i++)
                if (!string.IsNullOrEmpty(union[i].Name)) byName[union[i].Name] = i;
            foreach (var p in w.Manifest.Properties)
            {
                // A nameless property cannot be addressed by anything — not the editor, not
                // a settings key, not Seal. `"name": null` in a third-party manifest used to
                // reach the index and throw ArgumentNullException from inside the invoked UI
                // delegate, where the BeginInvoke catch cannot see it and the whole settings
                // window goes down. There is nothing to merge, so there is nothing to do.
                if (string.IsNullOrEmpty(p.Name)) continue;
                if (!byName.TryGetValue(p.Name, out var at)) { byName[p.Name] = union.Count; union.Add(p); continue; }
                if (p.Type == "secret" && union[at].Type != "secret") union[at] = p;
            }

            _maskedManifests[w.Manifest.Id] = new WidgetManifest
            {
                Id = w.Manifest.Id,
                Name = w.Manifest.Name,
                Author = w.Manifest.Author,
                Version = w.Manifest.Version,
                Description = w.Manifest.Description,
                MinApiVersion = w.Manifest.MinApiVersion,
                PreviewIcon = w.Manifest.PreviewIcon,
                SupportedSlots = w.Manifest.SupportedSlots,
                Properties = union,
            };
        }

        // A widget can also be refused BETWEEN init and save — or appear already-refused
        // in a folder that was empty at init — so the refusals are folded in on every
        // change too, additively. A credential typed into a field before the rescan that
        // refused the widget would otherwise reach layout.json in the clear.
        SnapshotRedactions();
    }

    /// <summary>The widget palette as the editor sees it. Shared by the initial payload
    /// and the live refresh, so the two can never describe the library differently.</summary>
    private object WidgetCatalog()
    {
        // See DashboardWindow.BuildInitPayload: the label is a property of the whole
        // installed set, not of one manifest, so both payloads derive it the same way.
        var labels = WidgetIdentity.DisplayNames(
            _library.Widgets.Select(w => (w.Manifest.Id, (string?)w.Manifest.Name, (string?)w.Manifest.Author)));
        return _library.Widgets.Select(w => new
        {
            id = w.Manifest.Id,
            name = w.Manifest.Name,
            displayName = labels.TryGetValue(w.Manifest.Id, out var label) ? label : w.Manifest.Name,
            author = w.Manifest.Author,
            version = w.Manifest.Version,
            url = $"https://{w.VirtualHost}/index.html",
            supportedSlots = w.Manifest.SupportedSlots,
            properties = w.Manifest.Properties,
            // New in a recent update and not yet placed (#227): the palette badges it.
            isNew = WidgetCatalogState.Shared?.IsNew(w.Manifest.Id, DateTime.UtcNow) ?? false,
        });
    }

    /// <summary>Widgets on disk that the library refused to load. Without this the
    /// refusal is a line in app.log and, to the user, a tile that stopped existing.</summary>
    private object RejectedCatalog() => RefusalBanner.Entries(_library.AllRefusals,
        id => _library.Widgets.FirstOrDefault(w => w.Manifest.Id == id)?.Manifest).Select(e => new
    {
        id = e.Refusal.Id,
        name = e.Refusal.Name,
        folder = e.Refusal.Folder,
        reason = e.Refusal.Reason,
        // An older refused copy beside one that loaded, keeping these settings from it
        // (#151). The banner says so, and says to remove the folder.
        shadowed = e.Shadowed,
        withheld = e.Withheld,
    });

    /// <summary>Re-sends the palette and the refusal list after the watcher rescans.
    ///
    /// Fixing an offending widget in the widgets folder is the documented workflow, and
    /// the folder is watched — but <see cref="WidgetLibrary.Changed"/> only reloaded the
    /// dashboard, so the settings window kept showing "not loaded" for a widget the user
    /// had already repaired, until they closed and reopened the whole window.
    ///
    /// Deliberately NOT a full settings-init: that would re-seed the layout from disk and
    /// throw away unsaved edits. Only the catalog and the banner move.</summary>
    /// <summary>The origins this window serves. Shared implementation with the dashboard,
    /// because the two had drifted: only one of them stopped serving what the library no
    /// longer lists.</summary>
    private readonly VirtualHostMap _hosts = new();

    private void OnLibraryChanged()
    {
        if (IsDisposed || !IsHandleCreated) return;
        try
        {
            BeginInvoke(() =>
            {
                if (IsDisposed || _webView.CoreWebView2 is null) return;

                // A widget added or repaired since the window opened has a virtual host
                // this WebView has never been told about, so its preview iframe would not
                // resolve until Settings was reopened. InitializeAsync maps only what
                // existed at open, so the whole library is synced here.
                //
                // Sync, not a map-everything loop: a widget the library has REFUSED since
                // this window opened — a replaced stock folder, a manifest that started
                // declaring a plaintext credential — has to stop being served, and adding
                // mappings can only ever add. It stayed reachable at its old origin, where
                // any other widget could iframe it and run it inside the origin whose
                // stored data the refusal was protecting.
                _hosts.Sync(_webView.CoreWebView2, _library.Widgets);

                // MERGE, never replace: the editor is still holding a layout masked with
                // the previous manifests, and dropping one would make Seal skip its
                // secret fields and overwrite the stored ciphertext with a masked blank.
                MergeManifestSnapshot();

                Post(new JsonObject
                {
                    ["type"] = "widgets-changed",
                    ["widgets"] = JsonSerializer.SerializeToNode(WidgetCatalog(), BridgeJson),
                    ["rejectedWidgets"] = JsonSerializer.SerializeToNode(RejectedCatalog(), BridgeJson),
                });
            });
        }
        catch (ObjectDisposedException)
        {
            // The rescan lands on a background timer thread, so the window can be torn
            // down between the checks above and the invoke. Unhandled here it would come
            // off the timer callback with no catch above it and take the app down.
        }
        catch (InvalidOperationException)
        {
            // Handle destroyed after the IsHandleCreated check — same race, same answer.
        }
    }

    /// <summary>layout.json as the editor is allowed to see it: read from disk, then
    /// masked against the CURRENT baseline.
    ///
    /// <para>The editor never receives a credential — secret values are blanked and
    /// replaced by a per-slot "secretsSet" hint, so the field can show a saved state while
    /// the stored ciphertext stays in layout.json (restored on save if left untouched).
    /// </para>
    ///
    /// <para>The baseline is the CALLER'S to set, so this deliberately does not touch it:
    /// <see cref="SnapshotManifests"/> replaces it, which is only legitimate because the
    /// editor is about to adopt what comes back. It has to happen BEFORE the mask, because
    /// <c>MaskedPlan</c> reads it.</para></summary>
    private JsonNode? MaskedLayoutFromDisk()
    {
        var layoutNode = JsonSerializer.SerializeToNode(LayoutStore.Load());
        SecretPolicy.Mask(layoutNode, MaskedPlan());
        return layoutNode;
    }

    private void PostInit()
    {
        var widgets = WidgetCatalog();
        var rejected = RejectedCatalog();

        SnapshotManifests();   // this layout IS what the editor will hold — see MaskedPlan
        var layoutNode = MaskedLayoutFromDisk();
        var panel = PanelPage();
        _postedPanel = panel?.ToJsonString();

        Post(new JsonObject
        {
            ["type"] = "settings-init",
            ["data"] = new JsonObject
            {
                ["layout"] = layoutNode,
                ["widgets"] = JsonSerializer.SerializeToNode(widgets, BridgeJson),
                ["rejectedWidgets"] = JsonSerializer.SerializeToNode(rejected, BridgeJson),
                // Placed tiles whose widget changed its settings in an update (#227), by
                // instance id; each is marked until the user opens it.
                ["reviewTiles"] = JsonSerializer.SerializeToNode(WidgetCatalogState.Shared?.ReviewTiles ?? [], BridgeJson),
                ["sensors"] = JsonSerializer.SerializeToNode(_hub.LatestSensors, BridgeJson),
                // Seed the replica's now-playing state: MediaUpdated only fires on
                // change, so without this an already-playing track never appears.
                ["media"] = JsonSerializer.SerializeToNode(_hub.LatestMedia, BridgeJson),
                ["backgroundHost"] = BackgroundHost,
                // The version of layout.json this masked copy came from (#281). Echoed on
                // every save so the host can tell a fresh payload from one built before a
                // write it has since committed.
                ["generation"] = LayoutStore.Generation,
                ["status"] = new JsonObject { ["elevated"] = _hub.IsElevated, ["version"] = AppVersion.Describe },
                // The page size the dashboard lays out at, so the preview shows the panel's
                // own tiles. Null when no panel is connected; the editor assumes 1280x400.
                ["panel"] = panel,
            },
        });
    }

    /// <summary>The dashboard's display as the tray's placement tick last found it (null:
    /// none). A display switch, a hotplug or a scaling change sends the new page size, so
    /// the preview and the size labels follow without reopening the window. Nothing is sent
    /// when it did not change, or when no panel is connected (the preview keeps the last).</summary>
    public void PanelMoved(string? deviceName)
    {
        if (deviceName is not null) _panelDeviceName = deviceName;
        var page = PanelPage();
        if (page is null) return;
        var text = page.ToJsonString();
        if (text == _postedPanel) return;
        _postedPanel = text;
        Post(new JsonObject { ["type"] = "panel-changed", ["panel"] = page });
    }

    /// <summary>The panel's page size in CSS pixels (its pixels at its display scale) and
    /// its model, or null when no panel is connected.</summary>
    private JsonObject? PanelPage()
    {
        var screen = Screen.AllScreens.FirstOrDefault(s => s.DeviceName == _panelDeviceName)
            ?? Screen.AllScreens.FirstOrDefault(s => PanelLocator.LooksLikePanel(s.Bounds));
        if (screen is null) return null;
        var page = PanelModels.CssSize(screen.Bounds.Size, DpiOf(screen));
        return new JsonObject
        {
            ["width"] = page.Width,
            ["height"] = page.Height,
            ["model"] = PanelModels.Match(screen.Bounds.Size)?.Name,
        };
    }

    /// <summary>Desktop-side restore (#226): the editor puts a removed tile back on a page
    /// in its OWN copy, as an ordinary edit that Save &amp; apply writes, and asks the host
    /// only for the def masked, with no disk write.
    ///
    /// <para>The editor cannot mask it itself. Its attic holds the defs as they rest on
    /// disk, sealed, and its secret control loads whatever string it is given into a
    /// revealable password input, so a ciphertext-bearing def on a page would show as a
    /// credential the user can un-hide and accidentally type over. A DEMOTED envelope (#66)
    /// in the def would ride the replica into a real widget iframe, reopening #120, because
    /// the client scrub only knows names the CURRENT manifest calls secret. The mask that
    /// answers both hinges on <c>CanUnprotect</c>, a DPAPI predicate with no JavaScript
    /// mirror.</para>
    ///
    /// <para>The blanks it returns are the masked "untouched" kind, so the save that seats
    /// the slot puts the credential back from the stored attic entry by identity, exactly
    /// as it does for a live tile's (SecretPolicy.BuildStoredIndex walks the stored attic
    /// for that reason). Only the def the editor sent is touched, and masking only ever
    /// blanks: nothing it returns is more than the editor already held.</para></summary>
    private void HandleMaskRetained(JsonNode? message)
    {
        if (message?["def"] is not JsonObject def || AsText(def["widgetId"]) is not { Length: > 0 })
            return;
        var wrapper = new JsonObject
        {
            ["pages"] = new JsonArray
            {
                new JsonObject { ["name"] = "mask", ["slots"] = new JsonArray { def.DeepClone() } },
            },
        };
        MergeManifestSnapshot();
        SecretPolicy.Mask(wrapper, MaskedPlan());
        Post(new JsonObject
        {
            ["type"] = "retained-masked",
            ["token"] = message["token"]?.DeepClone(),
            ["def"] = wrapper["pages"]?[0]?["slots"]?[0]?.DeepClone(),
        });
    }

    private static string? AsText(JsonNode? node) =>
        node is JsonValue v && v.TryGetValue<string>(out var text) ? text : null;

    /// <summary>What a save that deleted removed widgets does once its write has landed
    /// (#226): tombstone what it destroyed, so a payload built before this save cannot ship
    /// a deleted entry straight back. Tombstoned only where something was destroyed: an
    /// empty forget means a live tile still owns the identity, and tombstoning it would
    /// strip that tile's own attic entry if it is ever removed.</summary>
    private static void SettleDeletes(IReadOnlyList<(string WidgetId, string InstanceId)> destroyed)
    {
        foreach (var (widgetId, instanceId) in destroyed)
            LayoutStore.MarkDestroyed(widgetId, instanceId);
    }

    /// <summary>Saves the posted layout. The optional <paramref name="seq"/> is a
    /// client request id echoed verbatim in the reply, so the editor can match each
    /// acknowledgement to the exact snapshot it saved — two saves racing one ack
    /// must not clear the dirty marker for work the second save still holds.
    ///
    /// <para><paramref name="generation"/> is the version of layout.json this payload was
    /// built from (#281). Behind, and moved by somebody else, means the payload would
    /// revert a write it never saw.</para></summary>
    private void HandleSave(JsonNode? layoutNode, long? seq, long? generation)
    {
        try
        {
            // First, before anything is deserialized, sealed or written: a refusal leaves
            // the file untouched rather than rolling it back.
            //
            // `seq` rides the refusal because the editor's pendingSaves is keyed by it —
            // an unanswered seq strands an entry that later mis-clears the dirty marker.
            // `clearedCredentials` rides it because def.secretsCleared exists ONLY in this
            // payload and travels on no other message: a refused save silently un-clears
            // a credential the user removed, and the editor cannot know that unless told.
            if (LayoutStore.IsStale(generation, LayoutStore.SettingsWriter))
            {
                var refused = new JsonObject
                {
                    ["type"] = "save-refused",
                    ["reason"] = "stale",
                    ["generation"] = LayoutStore.Generation,
                    ["clearedCredentials"] =
                        SecretPolicy.ReadClearedMarkers(layoutNode).Count > 0
                        || SecretPolicy.ReadRetainedClearedMarkers(layoutNode).Count > 0,
                };
                if (seq is not null) refused["seq"] = seq.Value;
                Post(refused);
                Log.Info("Settings save refused: built from a superseded layout");
                return;
            }
            var layout = layoutNode.Deserialize<DashboardLayout>();
            if (layout?.Pages is null)
                throw new InvalidDataException("Layout has no pages.");

            foreach (var page in layout.Pages)
                page.Slots.RemoveAll(s => string.IsNullOrWhiteSpace(s.WidgetId));

            var disk = LayoutStore.Load();
            // The attic reconcile (#226), before Seal so unioned-in entries ride the same
            // pipeline: this editor's copy of the attic can be stale against disk, and
            // taking its list verbatim would silently drop the retained tiles only the disk
            // still knows about — their sealed credentials with them.
            LayoutStore.MergeRetainedFromDisk(layout, disk);
            // ...except the ones this editor DELETED, which the merge just put back. A
            // Delete is an edit like any other here, applied by this save, so the payload
            // names them rather than merely omitting them.
            var deleted = LayoutStore.DropDeletedRetained(
                layout, disk, LayoutStore.ReadRetainedDeletes(layoutNode));
            // Newly typed secrets get encrypted; masked ones the user didn't retype keep
            // the ciphertext already on disk instead of being wiped.
            // Read off the RAW node: the model carries no extension data, so by the time
            // there is a DashboardLayout this projection is already gone. See
            // SecretPolicy.ClearedMarkerKey.
            var secrets = SecretPolicy.Seal(layout, disk, MaskedPlan(),
                SecretPolicy.ReadClearedMarkers(layoutNode),
                SecretPolicy.ReadRetainedClearedMarkers(layoutNode),
                SecretPolicy.ReadCopiedFromMarkers(layoutNode));
            var secretFailures = secrets.Failures;
            // Cap the attic and destroy what fell off (#226): liveness-guarded (#188), and
            // destroy-before-Save so a failed save can strand a re-authenticating tile but
            // never a live credential for a destroyed one.
            var evicted = LayoutStore.CapRetained(layout);
            var forget = LayoutStore.InstancesToForget(evicted, layout, disk);
            // A Delete's derived credentials go FIRST, and fail CLOSED, unlike eviction
            // below: this is the user asking for them destroyed, and saving without having
            // done it would drop the entry while stranding a working bucket that nothing
            // names any more. Nothing has been written yet, so throwing here leaves the
            // entry on disk and this editor dirty, to try again.
            //
            // Liveness is judged by this payload alone, not by the disk's pages as for
            // eviction. That guard is for a stale payload that dropped a tile the disk still
            // holds, and this save got past the generation check, so its pages are the
            // disk's as of the last write it saw. A deleted identity still on a disk page is
            // one the user removed and then deleted in this editor, and the guard would keep
            // its credentials for good. A payload with no generation is never refused, so it
            // keeps the guard.
            var destroyed = LayoutStore.InstancesToForget(deleted, layout, generation is null ? disk : null);
            if (destroyed.Count > 0)
            {
                try
                {
                    SecureStoreHost.ForgetInstances(destroyed);
                }
                catch (Exception ex)
                {
                    throw new IOException(
                        "A removed widget's saved credentials could not be deleted, so nothing was saved. Try again.", ex);
                }
            }
            if (forget.Count > 0)
            {
                try
                {
                    SecureStoreHost.ForgetInstances(forget);
                    Log.Info($"Purged derived credentials for {forget.Count} evicted retained tile(s)");
                }
                catch (Exception ex)
                {
                    // Never the ids: they scope credentials.
                    Log.Warn($"Could not purge evicted retained credentials: {ex.GetType().Name}");
                }
            }
            var landed = LayoutStore.Save(layout, LayoutStore.SettingsWriter);
            if (landed)
                SettleDeletes(destroyed);
            LayoutSaved?.Invoke();
            // Placing a widget ends its "New" badge (#227) — once the placement is on disk.
            // A swallowed write failure placed nothing, and the badge would be gone for good.
            if (landed)
                WidgetCatalogState.Shared?.MarkPlaced(
                    (layout.Pages ?? []).SelectMany(pg => pg.Slots ?? []).Select(sl => sl.WidgetId ?? "").Where(id => id.Length > 0));
            var ok = new JsonObject { ["type"] = "saved", ["landed"] = landed };
            if (seq is not null) ok["seq"] = seq.Value;
            // What this editor's next payload must echo. Read AFTER the write, so a
            // swallowed write failure hands back the generation that is still on disk and
            // the next save is judged against the truth rather than against a bump that
            // never happened.
            ok["generation"] = LayoutStore.Generation;
            if (evicted.Count > 0)
            {
                // Which attic entries the cap dropped — the editor splices them from its
                // copy, or it re-ships them on every save and the attic never converges
                // (the union+cap keep the disk correct regardless; this stops the loop).
                var gone = new JsonArray();
                foreach (var ev in evicted)
                    gone.Add(new JsonObject
                    {
                        ["widgetId"] = ev.Def?.WidgetId,
                        ["instanceId"] = ev.Def?.InstanceId,
                    });
                ok["evictedIds"] = gone;
            }
            if (secretFailures.Count > 0)
            {
                // The rest of the layout saved, but a credential did not: reporting a
                // plain "Saved" would tell the user a token is active when it is not.
                var names = new JsonArray();
                foreach (var f in secretFailures)
                {
                    names.Add($"{f.WidgetId}.{f.Property}");
                    Log.Warn($"Secret not saved (protection unavailable): {f.WidgetId}.{f.Property}");
                }
                ok["secretsFailed"] = names;
            }
            Post(ok);
        }
        catch (Exception ex)
        {
            Log.Warn($"Layout save failed: {ex.Message}");
            var failed = new JsonObject { ["type"] = "save-failed", ["message"] = ex.Message };
            if (seq is not null) failed["seq"] = seq.Value;
            Post(failed);
        }
    }

    private void HandleInstall()
    {
        using var dialog = new OpenFileDialog
        {
            Title = "Install widget package",
            Filter = "Widget packages (*.plinthwidget;*.icuewidget;*.zip)|*.plinthwidget;*.icuewidget;*.zip",
        };
        if (dialog.ShowDialog(this) != DialogResult.OK)
            return;

        try
        {
            var installed = _library.InstallPackage(dialog.FileName);
            // The replica renders real widget iframes, so virtual hosts must
            // resolve in THIS WebView too (InitializeAsync only mapped the
            // widgets present when the window opened). Remap the WHOLE library,
            // not just the new arrival — the install's rescan can also pick up
            // widgets dropped into the folder since the window opened.
            if (_webView.CoreWebView2 is { } core)
                _hosts.Sync(core, _library.Widgets);
            Post(new JsonObject
            {
                ["type"] = "widget-installed",
                ["name"] = installed.Manifest.Name,
                // On disk but not yet served: the host map could not be read and a retry is
                // already scheduled. The editor says so rather than showing a widget that
                // is not in the catalog it just received.
                ["pending"] = installed.Widget is null,
            });
            // A package can replace an installed widget with one whose settings changed
            // (#227). Compare again now, so its placed tiles are flagged while the new
            // version is already running rather than after the next restart.
            if (WidgetCatalogState.Shared is { } catalog)
            {
                var onDisk = LayoutStore.Load();
                catalog.Refresh(
                    _library.Widgets.Select(w => (w.Manifest.Id, WidgetCatalogState.ShapeOf(w.Manifest))),
                    (onDisk.Pages ?? []).SelectMany(p => p.Slots ?? []).Select(sl => (sl.WidgetId ?? "", sl.InstanceId)),
                    DateTime.UtcNow);
            }
            PostInit(); // refresh widget list and sensor snapshot in the editor
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"Could not install widget:\n{ex.Message}", "Plinth",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private const long MaxBackgroundBytes = 256L * 1024 * 1024;

    /// <summary>
    /// Lets the user pick a background image or video; copies it into BackgroundsDir under
    /// a content-hashed name (so re-picking the same file reuses one copy) and returns the
    /// stored file name to the editor, tagged with <paramref name="target"/> (which spec to
    /// update: "global" or "page:&lt;index&gt;").
    /// </summary>
    /// <summary>File browser for path-valued widget settings (deck/launcher targets):
    /// text fields are a miserable way to enter "C:\...\app.exe" (#48). Cancel posts
    /// a null path so the editor can stop waiting.</summary>
    private void HandlePickFile(string id)
    {
        using var dialog = new OpenFileDialog
        {
            Title = "Choose a program or file to launch",
            Filter = "Programs (*.exe;*.bat;*.cmd;*.lnk)|*.exe;*.bat;*.cmd;*.lnk|All files (*.*)|*.*",
            CheckFileExists = true,
        };
        var ok = dialog.ShowDialog(this) == DialogResult.OK;
        Post(new JsonObject
        {
            ["type"] = "file-picked",
            ["id"] = id,
            ["path"] = ok ? dialog.FileName : null,
        });
    }

    private void HandlePickBackground(string target)
    {
        using var dialog = new OpenFileDialog
        {
            Title = "Choose a background image or video",
            Filter = "Images & video (*.png;*.jpg;*.jpeg;*.webp;*.gif;*.bmp;*.avif;*.mp4;*.webm;*.mov;*.m4v)" +
                     "|*.png;*.jpg;*.jpeg;*.webp;*.gif;*.bmp;*.avif;*.mp4;*.webm;*.mov;*.m4v" +
                     "|Images (*.png;*.jpg;*.jpeg;*.webp;*.gif;*.bmp;*.avif)|*.png;*.jpg;*.jpeg;*.webp;*.gif;*.bmp;*.avif" +
                     "|Video (*.mp4;*.webm;*.mov;*.m4v)|*.mp4;*.webm;*.mov;*.m4v",
        };
        if (dialog.ShowDialog(this) != DialogResult.OK)
            return;

        try
        {
            var sourcePath = dialog.FileName;
            var ext = Path.GetExtension(sourcePath).ToLowerInvariant();
            var isImage = ImageExtensions.Contains(ext);
            var isVideo = VideoExtensions.Contains(ext);
            if (!isImage && !isVideo)
                throw new InvalidOperationException("Unsupported file type.");

            var info = new FileInfo(sourcePath);
            if (info.Length > MaxBackgroundBytes)
                throw new InvalidOperationException($"File is too large ({info.Length / (1024 * 1024)} MB; max 256 MB).");

            Directory.CreateDirectory(AppPaths.BackgroundsDir);

            // Content hash keeps the folder from filling with duplicate copies on re-pick.
            string hash;
            using (var stream = File.OpenRead(sourcePath))
                hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(stream))[..16].ToLowerInvariant();

            var storedName = hash + ext;
            var destPath = Path.Combine(AppPaths.BackgroundsDir, storedName);
            if (!File.Exists(destPath))
                File.Copy(sourcePath, destPath, overwrite: false);

            Post(new JsonObject
            {
                ["type"] = "background-picked",
                ["target"] = target,
                ["source"] = storedName,
                ["kind"] = isVideo ? "video" : "image",
            });
        }
        catch (Exception ex)
        {
            Log.Warn($"Background pick failed: {ex.Message}");
            Post(new JsonObject { ["type"] = "background-failed", ["message"] = ex.Message });
        }
    }

    private void Post(JsonObject envelope)
    {
        if (_webView.CoreWebView2 is not null)
            _webView.CoreWebView2.PostWebMessageAsJson(envelope.ToJsonString());
    }

    private static (WindowPlacement.Placement, WindowPlacement.Display) PlaceWindow(string? panelDeviceName)
    {
        var screens = Screen.AllScreens;
        var displays = screens.Select(s => new WindowPlacement.Display(
            s.WorkingArea,
            DpiOf(s),
            s.DeviceName == panelDeviceName || PanelLocator.LooksLikePanel(s.Bounds),
            s.Primary)).ToList();
        var cursor = Array.FindIndex(screens, s => s.DeviceName == Screen.FromPoint(Cursor.Position).DeviceName);
        WindowPlacement.Placement? saved = null;
        try
        {
            if (File.Exists(AppPaths.SettingsWindowFile))
                saved = WindowPlacement.Parse(File.ReadAllText(AppPaths.SettingsWindowFile));
        }
        catch (Exception ex)
        {
            Log.Warn($"Could not read the settings window's last position: {ex.Message}");
        }
        return WindowPlacement.Choose(displays, cursor, saved);
    }

    private void SavePlacement()
    {
        if (_placementSaved || !IsHandleCreated)
            return;
        _placementSaved = true;
        try
        {
            // RestoreBounds is the normal-state rectangle while maximized or minimized;
            // a window closed from the taskbar while minimized reopens restored.
            var bounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            DurableStore.Write(AppPaths.SettingsWindowFile, WindowPlacement.Serialize(
                new WindowPlacement.Placement(bounds, WindowState == FormWindowState.Maximized)));
        }
        catch (Exception ex)
        {
            Log.Warn($"Could not save the settings window's position: {ex.Message}");
        }
    }

    protected override void OnLoad(EventArgs e)
    {
        // The frame is known now that the handle exists, so the minimum can be the page's.
        var frame = Size - ClientSize;
        MinimumSize = WindowPlacement.MinimumFor(_placedDisplay, frame);
        // The window was created on its display at the size placed for that display. If
        // creation rescaled it anyway, put the placed size back: it is on the same display
        // now, so this cannot start another DPI change. Placed again with the frame in the
        // minimum: raising MinimumSize grows the window where it stands, so one left flush
        // with the right or bottom edge under the new minimum would hang past it (#329).
        // Still in the normal state here, so these are also the bounds a maximized window
        // restores to.
        var placed = WindowPlacement.Fit(_placedBounds, _placedDisplay, frame);
        if (Bounds != placed)
            Bounds = placed;
        if (_placedMaximized)
            WindowState = FormWindowState.Maximized;
        base.OnLoad(e);
    }

    protected override void OnDpiChanged(DpiChangedEventArgs e)
    {
        base.OnDpiChanged(e);
        // Dragged to a display with another scale: the minimum is logical, so it follows,
        // with the frame at the new scale.
        MinimumSize = WindowPlacement.MinimumFor(new WindowPlacement.Display(
            Screen.FromControl(this).WorkingArea, e.DeviceDpiNew, false, false), Size - ClientSize);
    }

    /// <summary>A display's effective DPI (what WebView2 renders the page at there), or
    /// 96 where Windows cannot say.</summary>
    private static int DpiOf(Screen screen)
    {
        try
        {
            var area = screen.WorkingArea;
            var monitor = MonitorFromPoint(new NativePoint { X = area.Left + area.Width / 2, Y = area.Top + area.Height / 2 },
                MonitorDefaultToNearest);
            if (monitor != IntPtr.Zero && GetDpiForMonitor(monitor, MdtEffectiveDpi, out var dpi, out _) == 0 && dpi > 0)
                return (int)dpi;
        }
        catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException)
        {
            // shcore.dll's GetDpiForMonitor is Windows 8.1+; older means 96.
        }
        return 96;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativePoint { public int X; public int Y; }

    private const uint MonitorDefaultToNearest = 2;
    private const int MdtEffectiveDpi = 0;

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromPoint(NativePoint pt, uint flags);

    [DllImport("shcore.dll")]
    private static extern int GetDpiForMonitor(IntPtr monitor, int dpiType, out uint dpiX, out uint dpiY);

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            // The tray's Exit disposes an open window without closing it, so FormClosed
            // never runs and the place it was left would be lost.
            SavePlacement();
            _webView.Dispose();
        }
        base.Dispose(disposing);
    }
}
