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
            Filter = "Widget packages (*.wswidget;*.zip)|*.wswidget;*.zip",
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
