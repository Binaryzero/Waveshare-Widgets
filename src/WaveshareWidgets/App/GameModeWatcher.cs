using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;

namespace WaveshareWidgets.App;

/// <summary>
/// Detects "game mode": a foreground window covering an entire monitor (borderless or
/// exclusive fullscreen). Polled every 3 s — cheap win32 reads, no hooks. The shell uses
/// it to pause animations and hide slots the user marked hide-in-game, so the panel
/// costs nothing extra while a game is running.
/// </summary>
public sealed class GameModeWatcher : IDisposable
{
    private const int PollMs = 3000;

    // Shell/system surfaces that legitimately run fullscreen but are not games.
    private static readonly string[] IgnoredProcesses =
        ["explorer", "searchhost", "startmenuexperiencehost", "shellexperiencehost",
         "lockapp", "waresharewidgets", "wavesharewidgets", "dwm", "idle"];

    private System.Threading.Timer? _timer;
    private bool _active;
    private string _process = "";

    /// <summary>Raised (worker thread) when game-mode flips; payload {active, process}.</summary>
    public event Action<JsonObject>? Changed;

    public void Start() => _timer ??= new System.Threading.Timer(_ => Poll(), null, PollMs, PollMs);

    private void Poll()
    {
        try
        {
            var (active, process) = Detect();
            if (active == _active && process == _process)
                return;
            _active = active;
            _process = process;
            Changed?.Invoke(new JsonObject { ["active"] = active, ["process"] = process });
        }
        catch (Exception ex)
        {
            Log.Warn($"game-mode poll failed: {ex.Message}");
        }
    }

    private static (bool, string) Detect()
    {
        var hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero || !GetWindowRect(hwnd, out var rect))
            return (false, "");

        var monitor = MonitorFromWindow(hwnd, 2 /* MONITOR_DEFAULTTONEAREST */);
        var info = new MONITORINFO { cbSize = Marshal.SizeOf<MONITORINFO>() };
        if (!GetMonitorInfo(monitor, ref info))
            return (false, "");

        // Fullscreen = the window covers the whole monitor (not just the work area).
        var m = info.rcMonitor;
        var covers = rect.Left <= m.Left && rect.Top <= m.Top && rect.Right >= m.Right && rect.Bottom >= m.Bottom;
        if (!covers)
            return (false, "");

        GetWindowThreadProcessId(hwnd, out var pid);
        string name;
        try { name = Process.GetProcessById((int)pid).ProcessName; }
        catch { return (false, ""); }

        if (IgnoredProcesses.Contains(name.ToLowerInvariant()))
            return (false, "");
        return (true, name);
    }

    public void Dispose() { _timer?.Dispose(); _timer = null; }

    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Auto)] private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
}
