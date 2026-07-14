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

    // Extensions accepted for background wallpapers (static + animated).
    private static readonly string[] ImageExtensions = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"];
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
                    HandleSave(message["layout"]);
                    break;

                case "install-widget":
                    HandleInstall();
                    break;

                case "open-widgets-folder":
                    Process.Start(new ProcessStartInfo(AppPaths.WidgetsDir) { UseShellExecute = true });
                    break;

                case "pick-background":
                    HandlePickBackground(message["target"]?.GetValue<string>() ?? "");
                    break;
            }
        }
        catch (Exception ex)
        {
            Log.Warn($"Bad settings message: {ex.Message}");
        }
    }

    private void PostInit()
    {
        var widgets = _library.Widgets.Select(w => new
        {
            id = w.Manifest.Id,
            name = w.Manifest.Name,
            author = w.Manifest.Author,
            version = w.Manifest.Version,
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
                ["backgroundHost"] = BackgroundHost,
                ["status"] = new JsonObject { ["elevated"] = _hub.IsElevated },
            },
        });
    }

    private void HandleSave(JsonNode? layoutNode)
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
            Post(new JsonObject { ["type"] = "saved" });
        }
        catch (Exception ex)
        {
            Log.Warn($"Layout save failed: {ex.Message}");
            Post(new JsonObject { ["type"] = "save-failed", ["message"] = ex.Message });
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
            Filter = "Images & video (*.png;*.jpg;*.jpeg;*.webp;*.gif;*.bmp;*.mp4;*.webm;*.mov;*.m4v)" +
                     "|*.png;*.jpg;*.jpeg;*.webp;*.gif;*.bmp;*.mp4;*.webm;*.mov;*.m4v" +
                     "|Images (*.png;*.jpg;*.jpeg;*.webp;*.gif;*.bmp)|*.png;*.jpg;*.jpeg;*.webp;*.gif;*.bmp" +
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
