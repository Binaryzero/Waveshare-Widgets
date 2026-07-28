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
            FormClosed += (_, _) =>
            {
                _hub.SensorsUpdated -= OnSensorsUpdated;
                _hub.MediaUpdated -= OnMediaUpdated;
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

                case "preview-data":
                    // Widget data requests surfaced by the embedded replica. Marshaled
                    // back onto the UI thread because the fetch/ping handlers reply from
                    // worker threads.
                    Dashboard?.HandlePreviewRequest(message["message"], (type, data) =>
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

    private void PostInit()
    {
        var widgets = _library.Widgets.Select(w => new
        {
            id = w.Manifest.Id,
            name = w.Manifest.Name,
            author = w.Manifest.Author,
            version = w.Manifest.Version,
            url = $"https://{w.VirtualHost}/index.html",
            supportedSlots = w.Manifest.SupportedSlots,
            properties = w.Manifest.Properties,
        });

        Post(new JsonObject
        {
            ["type"] = "settings-init",
            ["data"] = new JsonObject
            {
                ["layout"] = JsonSerializer.SerializeToNode(LayoutStore.Load()),
                ["widgets"] = JsonSerializer.SerializeToNode(widgets, BridgeJson),
                ["sensors"] = JsonSerializer.SerializeToNode(_hub.LatestSensors, BridgeJson),
                // Seed the replica's now-playing state: MediaUpdated only fires on
                // change, so without this an already-playing track never appears.
                ["media"] = JsonSerializer.SerializeToNode(_hub.LatestMedia, BridgeJson),
                ["backgroundHost"] = BackgroundHost,
                ["status"] = new JsonObject { ["elevated"] = _hub.IsElevated },
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

            LayoutStore.Save(layout);
            LayoutSaved?.Invoke();
            var ok = new JsonObject { ["type"] = "saved" };
            if (seq is not null) ok["seq"] = seq.Value;
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
