using System.Diagnostics;
using Microsoft.Win32;
using WaveshareWidgets.Sensors;
using WaveshareWidgets.Widgets;

namespace WaveshareWidgets.App;

/// <summary>
/// The long-lived application shell: tray icon + menu, sensor hub lifetime, panel
/// detection/hotplug handling, and the dashboard window.
/// </summary>
public sealed class TrayApplicationContext : ApplicationContext
{
    private const string AutostartValueName = "WaveshareWidgets";

    private readonly AppConfig _config;
    private readonly SensorHub _hub = new();
    private readonly WidgetLibrary _library = new();
    private readonly NotifyIcon _trayIcon;
    private DashboardWindow? _dashboard;
    private string? _currentScreenDevice;

    public TrayApplicationContext()
    {
        AppPaths.EnsureCreated();
        _config = AppConfig.Load();

        _library.Initialize();
        _library.Changed += () => _dashboard?.ReloadDashboard();

        _hub.Start(_config.PollIntervalMs);

        _trayIcon = new NotifyIcon
        {
            Icon = CreateTrayIcon(),
            Text = "Waveshare Widgets",
            Visible = true,
            ContextMenuStrip = BuildTrayMenu(),
        };

        // The panel powers up ~10 s after HDMI connect and may be absent at logon;
        // re-evaluate placement whenever the display topology changes.
        SystemEvents.DisplaySettingsChanged += (_, _) => PlaceDashboard();

        PlaceDashboard();
    }

    private void PlaceDashboard()
    {
        try
        {
            var screen = PanelLocator.Find(_config.DisplayDeviceName);
            if (screen is null)
            {
                _currentScreenDevice = null;
                if (_dashboard is { IsDisposed: false })
                    _dashboard.Hide();
                _trayIcon.Text = "Waveshare Widgets — panel not detected";
                Log.Info("No 1280x400 / 400x1280 display found; dashboard hidden");
                return;
            }

            _trayIcon.Text = $"Waveshare Widgets — {screen.DeviceName} ({screen.Bounds.Width}x{screen.Bounds.Height})";

            if (_dashboard is null || _dashboard.IsDisposed)
            {
                _dashboard = new DashboardWindow(_config, _hub, _library);
                _dashboard.Show();
                _currentScreenDevice = screen.DeviceName;
                _ = InitializeDashboardAsync(screen);
                return;
            }

            _dashboard.Show();
            if (_currentScreenDevice != screen.DeviceName || _dashboard.Bounds != screen.Bounds)
            {
                _currentScreenDevice = screen.DeviceName;
                _dashboard.MoveToScreen(screen);
            }
        }
        catch (Exception ex)
        {
            Log.Error($"Failed to place dashboard: {ex.Message}");
        }
    }

    private async Task InitializeDashboardAsync(Screen screen)
    {
        try
        {
            await _dashboard!.InitializeAsync(screen);
            Log.Info($"Dashboard running on {screen.DeviceName} ({screen.Bounds.Width}x{screen.Bounds.Height})");
        }
        catch (Exception ex)
        {
            Log.Error($"WebView2 initialization failed: {ex}");
            _trayIcon.ShowBalloonTip(10_000, "Waveshare Widgets",
                "Failed to start the dashboard. Is the WebView2 Runtime installed? See app.log for details.",
                ToolTipIcon.Error);
        }
    }

    private ContextMenuStrip BuildTrayMenu()
    {
        var menu = new ContextMenuStrip();

        menu.Items.Add("Reload dashboard", null, (_, _) => _dashboard?.ReloadDashboard());
        menu.Items.Add("Open widgets folder", null, (_, _) => OpenInExplorer(AppPaths.WidgetsDir));
        menu.Items.Add("Edit layout (JSON)", null, (_, _) =>
        {
            LayoutStore.Save(LayoutStore.Load()); // materialize the default on first use
            OpenInExplorer(AppPaths.LayoutFile);
        });
        menu.Items.Add("Install widget…", null, (_, _) => InstallWidgetInteractive());

        var displayMenu = new ToolStripMenuItem("Display");
        displayMenu.DropDownOpening += (_, _) => PopulateDisplayMenu(displayMenu);
        menu.Items.Add(displayMenu);

        var autostart = new ToolStripMenuItem("Start with Windows") { CheckOnClick = true };
        autostart.Checked = IsAutostartEnabled();
        autostart.CheckedChanged += (_, _) => SetAutostart(autostart.Checked);
        menu.Items.Add(autostart);

        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit", null, (_, _) => ExitThread());
        return menu;
    }

    private void PopulateDisplayMenu(ToolStripMenuItem parent)
    {
        parent.DropDownItems.Clear();

        var auto = new ToolStripMenuItem("Auto-detect (1280x400)") { Checked = _config.DisplayDeviceName is null };
        auto.Click += (_, _) =>
        {
            _config.DisplayDeviceName = null;
            _config.Save();
            PlaceDashboard();
        };
        parent.DropDownItems.Add(auto);
        parent.DropDownItems.Add(new ToolStripSeparator());

        foreach (var screen in Screen.AllScreens)
        {
            var label = $"{screen.DeviceName}  {screen.Bounds.Width}x{screen.Bounds.Height}{(screen.Primary ? "  (primary)" : "")}";
            var item = new ToolStripMenuItem(label) { Checked = _config.DisplayDeviceName == screen.DeviceName };
            var deviceName = screen.DeviceName;
            item.Click += (_, _) =>
            {
                _config.DisplayDeviceName = deviceName;
                _config.Save();
                PlaceDashboard();
            };
            parent.DropDownItems.Add(item);
        }
    }

    private void InstallWidgetInteractive()
    {
        using var dialog = new OpenFileDialog
        {
            Title = "Install widget package",
            Filter = "Widget packages (*.wswidget;*.zip)|*.wswidget;*.zip",
        };
        if (dialog.ShowDialog() != DialogResult.OK)
            return;

        try
        {
            var installed = _library.InstallPackage(dialog.FileName);
            _trayIcon.ShowBalloonTip(5_000, "Waveshare Widgets",
                $"Installed '{installed.Manifest.Name}' v{installed.Manifest.Version}. Add it to a page via Edit layout.",
                ToolTipIcon.Info);
            _dashboard?.ReloadDashboard();
        }
        catch (Exception ex)
        {
            MessageBox.Show($"Could not install widget:\n{ex.Message}", "Waveshare Widgets",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private static void OpenInExplorer(string path)
    {
        try
        {
            Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            Log.Warn($"Failed to open '{path}': {ex.Message}");
        }
    }

    private static bool IsAutostartEnabled()
    {
        using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run");
        return key?.GetValue(AutostartValueName) is not null;
    }

    private static void SetAutostart(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run");
        if (enabled)
            key.SetValue(AutostartValueName, $"\"{Environment.ProcessPath}\"");
        else
            key.DeleteValue(AutostartValueName, throwOnMissingValue: false);
    }

    private static Icon CreateTrayIcon()
    {
        // Drawn at runtime so the project needs no binary icon asset.
        using var bmp = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bmp))
        {
            g.Clear(Color.FromArgb(16, 20, 28));
            using var font = new Font("Segoe UI", 16, FontStyle.Bold, GraphicsUnit.Pixel);
            using var brush = new SolidBrush(Color.FromArgb(0, 212, 255));
            var size = g.MeasureString("W", font);
            g.DrawString("W", font, brush, (32 - size.Width) / 2, (32 - size.Height) / 2);
        }
        return Icon.FromHandle(bmp.GetHicon());
    }

    protected override void ExitThreadCore()
    {
        _trayIcon.Visible = false;
        _trayIcon.Dispose();
        _dashboard?.Dispose();
        _hub.Dispose();
        _library.Dispose();
        base.ExitThreadCore();
    }
}
