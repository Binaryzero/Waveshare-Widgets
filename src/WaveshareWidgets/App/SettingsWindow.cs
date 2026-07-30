using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using WaveshareWidgets.Sensors;
using WaveshareWidgets.Widgets;

namespace WaveshareWidgets.App;

/// <summary>
/// The desktop settings window (opened from the tray, shown on the main monitor):
/// a web-based editor for pages, slots, and per-widget properties that reads and
/// writes layout.json without the user touching JSON.
/// </summary>
public sealed class SettingsWindow : Form
{
    private const string ShellHost = "app.wsw";
    private const string BackgroundHost = "backgrounds.wsw";

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

    /// <summary>The live dashboard window; routes the preview replica's widget data
    /// requests (fetch/ping/media-list/audio-get) through the real handlers.</summary>
    public DashboardWindow? Dashboard { get; set; }

    public SettingsWindow(SensorHub hub, WidgetLibrary library)
    {
        _hub = hub;
        _library = library;

        Text = "Waveshare Widgets — Settings";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(780, 480);
        Size = new Size(1000, 640);
        BackColor = Color.FromArgb(11, 14, 20);

        _webView.Dock = DockStyle.Fill;
        _webView.DefaultBackgroundColor = Color.FromArgb(11, 14, 20);
        Controls.Add(_webView);

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
            core.WebMessageReceived += OnWebMessageReceived;
            core.SetVirtualHostNameToFolderMapping(ShellHost, AppPaths.ShellDir, CoreWebView2HostResourceAccessKind.Allow);
            // So the editor can preview chosen background images/videos.
            core.SetVirtualHostNameToFolderMapping(BackgroundHost, AppPaths.BackgroundsDir, CoreWebView2HostResourceAccessKind.Allow);
            // The live replica embeds the real shell with real widget iframes, so their
            // origins (and the media library) must resolve here too.
            core.SetVirtualHostNameToFolderMapping("media.wsw", AppPaths.MediaDir, CoreWebView2HostResourceAccessKind.Allow);
            foreach (var w in _library.Widgets)
                core.SetVirtualHostNameToFolderMapping(w.VirtualHost, w.Folder, CoreWebView2HostResourceAccessKind.Allow);
            // The replica's widget iframes rely on the injected shim, same as the panel.
            var shim = File.ReadAllText(Path.Combine(AppPaths.ShellDir, "widget-api.js")) + "\n" +
                       File.ReadAllText(Path.Combine(AppPaths.ShellDir, "icue-compat.js"));
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
                "Waveshare Widgets", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            var message = JsonNode.Parse(e.WebMessageAsJson);
            switch (message?["type"]?.GetValue<string>())
            {
                case "settings-ready":
                    PostInit();
                    break;

                case "save-layout":
                    HandleSave(message["layout"], message["seq"]?.GetValue<long>());
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

                case "sd-profiles":
                    Post(new JsonObject
                    {
                        ["type"] = "sd-profiles-result",
                        ["profiles"] = JsonSerializer.SerializeToNode(StreamDeckBridge.ListProfileNames()),
                    });
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
        AddRedactionManifests(snapshot);
        _maskedManifests = snapshot;
    }

    /// <summary>Stands a redaction-only manifest in for every REFUSED widget.
    ///
    /// A refusal removes the widget from the library, so <see cref="ManifestAsMasked"/>
    /// returns null for its slots, <see cref="SecretPolicy.Mask"/> skips them, and the
    /// plaintext credential the widget was refused over is posted to the editor in the
    /// clear — the refusal creating the exposure it exists to prevent. The stand-in keeps
    /// those names on the secret pipeline, so Mask blanks them and Seal restores or
    /// encrypts them instead of the editor's blank overwriting the stored value.</summary>
    private void AddRedactionManifests(Dictionary<string, WidgetManifest> snapshot)
    {
        foreach (var r in _library.Rejected)
        {
            if (string.IsNullOrEmpty(r.Id) || r.RedactNames.Count == 0)
                continue;
            // MERGE into an existing entry, never replace it and never skip it.
            //
            // Replacing loses every OTHER secret the old manifest declared — that entry is
            // what masked the layout the editor is holding, so Seal would blank them. But
            // skipping is just as wrong, and that is what a bare TryAdd did: a widget can
            // be refused by the same folder edit that RETYPED one of its properties, and
            // the stale entry still calls that property `text`. A credential typed into
            // the field before the rescan then goes to layout.json in the clear — the very
            // hole the redaction metadata exists to close, reopened by the order of events.
            //
            // Secret wins, exactly as in the property union above.
            snapshot[r.Id] = snapshot.TryGetValue(r.Id, out var existing)
                ? existing.WithSecretsForced(r.RedactNames)
                : WidgetManifest.RedactionOnly(r.Id, r.Name, r.RedactNames);
        }
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
            // Name-collision rule: THE NEW DEFINITION WINS, for a property the new
            // manifest still declares. Absent properties keep their old definition purely
            // by never colliding — which is the case the union exists for, since a removed
            // or briefly-unparseable manifest says nothing about a property that may still
            // hold a live credential.
            //
            // This replaces the "secret wins" rule I wrote in #61 round five. That rule
            // was a heuristic standing in for this one, and it was right in only one
            // direction:
            //
            //   text -> secret   both rules seal the value. Correct.
            //   secret -> text   secret-wins seals a value the CURRENT manifest calls
            //                    ordinary — and SecretPolicy.Reveal consults that current
            //                    manifest, so it never decrypts, and the widget is handed
            //                    the literal "dpapi:v1:…" string.
            //
            // Sealing and revealing have to agree about which manifest is authoritative.
            // Reveal cannot use this snapshot (it runs on the dashboard, against the live
            // library), so the snapshot must not out-vote it about a property the author
            // has just made a fresh statement about. Erring toward secret sounded safe
            // and was not: it produced a value nothing could ever read back.
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
                union[at] = p;
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
        // in a folder that was empty at init. TryAdd leaves any real manifest alone (that
        // is the one that masked the layout the editor holds); it only fills the gap where
        // there is nothing at all, so the next save seals the slot instead of writing the
        // credential back out in the clear.
        AddRedactionManifests(_maskedManifests);
    }

    /// <summary>The widget palette as the editor sees it. Shared by the initial payload
    /// and the live refresh, so the two can never describe the library differently.</summary>
    private object WidgetCatalog() => _library.Widgets.Select(w => new
    {
        id = w.Manifest.Id,
        name = w.Manifest.Name,
        author = w.Manifest.Author,
        version = w.Manifest.Version,
        url = $"https://{w.VirtualHost}/index.html",
        supportedSlots = w.Manifest.SupportedSlots,
        properties = w.Manifest.Properties,
    });

    /// <summary>Widgets on disk that the library refused to load. Without this the
    /// refusal is a line in app.log and, to the user, a tile that stopped existing.
    ///
    /// A refusal whose id loaded from ANOTHER folder is suppressed here, and only here.
    /// The widget is present, so warning that it is unavailable sends the user hunting
    /// for a problem they do not have — but the refusal record itself must survive, because
    /// <see cref="AddRedactionManifests"/> reads the same list for its RedactNames and the
    /// layout can still hold a plaintext credential written while the refused copy was
    /// active. Suppressing at the source destroyed that metadata along with the warning.
    ///
    /// ORDINAL, matching the identity that decided what loaded: ids differing only in case
    /// are two distinct widgets to <c>Rescan</c>, so a rejected "Foo" really is unavailable
    /// even while "foo" works, and hiding its warning would leave a layout referencing
    /// "Foo" with an unexplained empty tile.</summary>
    private object RejectedCatalog()
    {
        var loaded = new HashSet<string>(_library.Widgets.Select(w => w.Manifest.Id), StringComparer.Ordinal);
        return _library.Rejected.Where(r => !loaded.Contains(r.Id)).Select(r => new
        {
            id = r.Id,
            name = r.Name,
            folder = r.Folder,
            reason = r.Reason,
        });
    }

    /// <summary>Re-sends the palette and the refusal list after the watcher rescans.
    ///
    /// Fixing an offending widget in the widgets folder is the documented workflow, and
    /// the folder is watched — but <see cref="WidgetLibrary.Changed"/> only reloaded the
    /// dashboard, so the settings window kept showing "not loaded" for a widget the user
    /// had already repaired, until they closed and reopened the whole window.
    ///
    /// Deliberately NOT a full settings-init: that would re-seed the layout from disk and
    /// throw away unsaved edits. Only the catalog and the banner move.</summary>
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
                // existed at open; remap the WHOLE library, as the install path does.
                foreach (var w in _library.Widgets)
                    _webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                        w.VirtualHost, w.Folder, CoreWebView2HostResourceAccessKind.Allow);

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

    private void PostInit()
    {
        var widgets = WidgetCatalog();
        var rejected = RejectedCatalog();

        // The editor never receives a credential: secret values are blanked and replaced
        // by a per-slot "secretsSet" hint, so the field can show a saved state while the
        // stored ciphertext stays in layout.json (restored on save if left untouched).
        var layoutNode = JsonSerializer.SerializeToNode(LayoutStore.Load());
        SnapshotManifests();
        SecretPolicy.Mask(layoutNode, ManifestAsMasked);

        Post(new JsonObject
        {
            ["type"] = "settings-init",
            ["data"] = new JsonObject
            {
                ["layout"] = layoutNode,
                ["widgets"] = JsonSerializer.SerializeToNode(widgets, BridgeJson),
                ["rejectedWidgets"] = JsonSerializer.SerializeToNode(rejected, BridgeJson),
                ["sensors"] = JsonSerializer.SerializeToNode(_hub.LatestSensors, BridgeJson),
                // Seed the replica's now-playing state: MediaUpdated only fires on
                // change, so without this an already-playing track never appears.
                ["media"] = JsonSerializer.SerializeToNode(_hub.LatestMedia, BridgeJson),
                ["backgroundHost"] = BackgroundHost,
                ["status"] = new JsonObject { ["elevated"] = _hub.IsElevated, ["version"] = AppVersion.Describe },
            },
        });
    }

    /// <summary>Saves the posted layout. The optional <paramref name="seq"/> is a
    /// client request id echoed verbatim in the reply, so the editor can match each
    /// acknowledgement to the exact snapshot it saved — two saves racing one ack
    /// must not clear the dirty marker for work the second save still holds.</summary>
    private void HandleSave(JsonNode? layoutNode, long? seq)
    {
        try
        {
            var layout = layoutNode.Deserialize<DashboardLayout>();
            if (layout?.Pages is null)
                throw new InvalidDataException("Layout has no pages.");

            foreach (var page in layout.Pages)
                page.Slots.RemoveAll(s => string.IsNullOrWhiteSpace(s.WidgetId));

            // Newly typed secrets get encrypted; masked ones the user didn't retype keep
            // the ciphertext already on disk instead of being wiped.
            var secrets = SecretPolicy.Seal(layout, LayoutStore.Load(), ManifestAsMasked);
            var secretFailures = secrets.Failures;
            LayoutStore.Save(layout);
            LayoutSaved?.Invoke();
            var ok = new JsonObject { ["type"] = "saved" };
            if (seq is not null) ok["seq"] = seq.Value;
            if (secrets.Minted.Count > 0)
            {
                // Ids were stamped onto the host's copy; the editor still holds the
                // id-less slots it sent. Hand the identities back, addressed by the
                // position IT used, or its next save can't find its own credentials.
                var ids = new JsonArray();
                foreach (var m in secrets.Minted)
                    ids.Add(new JsonObject
                    {
                        ["page"] = m.Page,
                        ["slot"] = m.Slot,
                        ["widgetId"] = m.WidgetId,
                        ["instanceId"] = m.InstanceId,
                    });
                ok["mintedIds"] = ids;
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
            Filter = "Widget packages (*.wswidget;*.icuewidget;*.zip)|*.wswidget;*.icuewidget;*.zip",
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
            {
                foreach (var w in _library.Widgets)
                    core.SetVirtualHostNameToFolderMapping(w.VirtualHost, w.Folder, CoreWebView2HostResourceAccessKind.Allow);
            }
            Post(new JsonObject { ["type"] = "widget-installed", ["name"] = installed.Manifest.Name });
            PostInit(); // refresh widget list and sensor snapshot in the editor
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"Could not install widget:\n{ex.Message}", "Waveshare Widgets",
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

    protected override void Dispose(bool disposing)
    {
        if (disposing)
            _webView.Dispose();
        base.Dispose(disposing);
    }
}
