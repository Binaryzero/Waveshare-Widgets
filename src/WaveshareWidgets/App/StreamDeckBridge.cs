using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace WaveshareWidgets.App;

/// <summary>
/// Native Virtual Stream Deck bridge. Reads the Elgato Stream Deck "Virtual Stream Deck"
/// profile from disk (buttons, titles, icons) and triggers real plugin actions
/// (Discord, OBS, Hue, …) by PostMessage-clicking the VSD's hidden Qt overlay window —
/// the same technique StreamDeckEmbeded uses, reimplemented in-process. Requires Elgato
/// Stream Deck software running with a Virtual Stream Deck; there is no way to run Elgato
/// plugins without it.
/// </summary>
public sealed class StreamDeckBridge
{
    public sealed record DeckButton(int Row, int Col, string Title, string Image);
    public sealed record DeckProfile(string Name, int Rows, int Cols, IReadOnlyList<DeckButton> Buttons,
        IReadOnlyList<string> AvailableProfiles);

    private static string ProfilesDir => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), // Roaming
        "Elgato", "StreamDeck", "ProfilesV3");

    /// <summary>All Virtual Stream Deck profiles: (display name, profile directory).</summary>
    private List<(string Name, string Dir)> ListVsdProfiles()
    {
        var result = new List<(string, string)>();
        if (!Directory.Exists(ProfilesDir))
            return result;

        foreach (var profileDir in Directory.GetDirectories(ProfilesDir, "*.sdProfile"))
        {
            var manifestPath = Path.Combine(profileDir, "manifest.json");
            if (!File.Exists(manifestPath))
                continue;
            try
            {
                using var manifest = JsonDocument.Parse(File.ReadAllText(manifestPath));
                var root = manifest.RootElement;
                if (root.TryGetProperty("Device", out var device) &&
                    device.TryGetProperty("Model", out var model) &&
                    model.GetString() == "UI Stream Deck")
                {
                    var name = root.TryGetProperty("Name", out var n) ? n.GetString() ?? "" : "";
                    if (string.IsNullOrWhiteSpace(name))
                        name = Path.GetFileNameWithoutExtension(profileDir);
                    result.Add((name, profileDir));
                }
            }
            catch { /* skip unreadable */ }
        }
        return result;
    }

    /// <summary>
    /// Reads a Virtual Stream Deck profile. When <paramref name="preferredName"/> is set,
    /// picks the profile with that name; otherwise the first one. Returns null if none exist.
    /// </summary>
    public DeckProfile? ReadProfile(string? preferredName = null)
    {
        try
        {
            var profiles = ListVsdProfiles();
            if (profiles.Count == 0)
                return null;

            var chosen = profiles.FirstOrDefault(p =>
                string.Equals(p.Name, preferredName, StringComparison.OrdinalIgnoreCase));
            if (chosen.Dir is null)
                chosen = profiles[0];

            using var manifest = JsonDocument.Parse(File.ReadAllText(Path.Combine(chosen.Dir, "manifest.json")));
            var available = profiles.Select(p => p.Name).ToList();
            return ParseProfile(chosen.Dir, manifest.RootElement, available);
        }
        catch (Exception ex)
        {
            Log.Warn($"Stream Deck profile read failed: {ex.Message}");
        }
        return null;
    }

    private static DeckProfile ParseProfile(string profileDir, JsonElement manifest, IReadOnlyList<string> available)
    {
        var name = manifest.TryGetProperty("Name", out var n) ? n.GetString() ?? "Stream Deck" : "Stream Deck";
        var buttons = new List<DeckButton>();
        var pagesDir = Path.Combine(profileDir, "Profiles");

        // The current page holds the visible buttons.
        string? currentPage = null;
        if (manifest.TryGetProperty("Pages", out var pages) && pages.TryGetProperty("Current", out var cur))
            currentPage = cur.GetString();

        if (Directory.Exists(pagesDir))
        {
            var pageDirs = Directory.GetDirectories(pagesDir);
            // Prefer the current page; fall back to the first page that parses.
            var ordered = pageDirs.OrderByDescending(d =>
                string.Equals(Path.GetFileName(d), currentPage, StringComparison.OrdinalIgnoreCase));

            foreach (var pageDir in ordered)
            {
                var pageManifest = Path.Combine(pageDir, "manifest.json");
                if (!File.Exists(pageManifest))
                    continue;
                try
                {
                    using var doc = JsonDocument.Parse(File.ReadAllText(pageManifest));
                    ParsePage(pageDir, doc.RootElement, buttons);
                    if (buttons.Count > 0)
                        break;
                }
                catch (Exception ex)
                {
                    Log.Warn($"Stream Deck page parse failed ({pageDir}): {ex.Message}");
                }
            }
        }

        // Infer the grid from the highest visual coordinates present (overridable in the widget).
        var rows = buttons.Count > 0 ? buttons.Max(b => b.Row) + 1 : 3;
        var cols = buttons.Count > 0 ? buttons.Max(b => b.Col) + 1 : 5;
        return new DeckProfile(name, rows, cols, buttons, available);
    }

    private static void ParsePage(string pageDir, JsonElement pageManifest, List<DeckButton> buttons)
    {
        if (!pageManifest.TryGetProperty("Controllers", out var controllers) ||
            controllers.ValueKind != JsonValueKind.Array || controllers.GetArrayLength() == 0)
            return;

        var controller = controllers[0];
        if (!controller.TryGetProperty("Actions", out var actions) || actions.ValueKind != JsonValueKind.Object)
            return;

        foreach (var action in actions.EnumerateObject())
        {
            // Key is "row,col" in profile space; the VSD renders it transposed.
            var parts = action.Name.Split(',');
            if (parts.Length != 2 || !int.TryParse(parts[0], out var profileRow) || !int.TryParse(parts[1], out var profileCol))
                continue;
            var visualRow = profileCol;
            var visualCol = profileRow;

            var data = action.Value;
            var state = data.TryGetProperty("State", out var st) && st.TryGetInt32(out var s) ? s : 0;

            string title = "";
            string image = "";
            if (data.TryGetProperty("States", out var states) && states.ValueKind == JsonValueKind.Array && states.GetArrayLength() > 0)
            {
                var stateEl = state < states.GetArrayLength() ? states[state] : states[0];
                if (stateEl.TryGetProperty("Title", out var t))
                    title = t.GetString() ?? "";

                var imageRel = FindImage(stateEl) ?? (states.GetArrayLength() > 0 ? FindImage(states[0]) : null);
                if (imageRel is not null)
                    image = LoadImageDataUri(Path.Combine(pageDir, imageRel));
            }

            buttons.Add(new DeckButton(visualRow, visualCol, title, image));
        }
    }

    private static string? FindImage(JsonElement stateEl) =>
        stateEl.TryGetProperty("Image", out var img) && img.ValueKind == JsonValueKind.String
            ? img.GetString()
            : null;

    private static string LoadImageDataUri(string path)
    {
        try
        {
            if (!File.Exists(path))
                return "";
            var bytes = File.ReadAllBytes(path);
            if (bytes.Length > 2_000_000)
                return "";
            var ext = Path.GetExtension(path).TrimStart('.').ToLowerInvariant();
            var mime = ext == "svg" ? "image/svg+xml" : $"image/{(ext == "" ? "png" : ext)}";
            return $"data:{mime};base64,{Convert.ToBase64String(bytes)}";
        }
        catch
        {
            return "";
        }
    }

    /// <summary>
    /// Triggers a button by clicking the VSD overlay window at the button's cell center.
    /// This fires whatever plugin action Stream Deck has bound to that key.
    /// </summary>
    public bool ClickCell(int row, int col, int rows, int cols)
    {
        if (rows <= 0 || cols <= 0)
            return false;

        var vsd = FindVsdWindow();
        if (vsd == IntPtr.Zero)
        {
            Log.Warn("Stream Deck: VSD overlay window not found (is the Virtual Stream Deck open?)");
            return false;
        }

        if (!GetClientRect(vsd, out var rect) || rect.Right <= 0 || rect.Bottom <= 0)
            return false;

        var cellW = rect.Right / (double)cols;
        var cellH = rect.Bottom / (double)rows;
        var x = (int)(cellW * col + cellW / 2);
        var y = (int)(cellH * row + cellH / 2);
        var lParam = (IntPtr)((y << 16) | (x & 0xFFFF));

        PostMessage(vsd, WM_LBUTTONDOWN, (IntPtr)1, lParam);
        Thread.Sleep(40);
        PostMessage(vsd, WM_LBUTTONUP, IntPtr.Zero, lParam);
        Log.Info($"Stream Deck: clicked cell row={row} col={col} at ({x},{y})");
        return true;
    }

    /// <summary>
    /// Moves the VSD overlay off-screen and drops its always-on-top flag so it stops
    /// floating over the desktop while our widget drives it. The window stays "visible"
    /// (so it's still found and clickable) but sits at -32000,-32000. Reversible: turning
    /// this off restores it near the top-left of the primary monitor.
    /// </summary>
    public void HideVsdWindow(bool hide)
    {
        var vsd = FindVsdWindow();
        if (vsd == IntPtr.Zero)
            return;
        try
        {
            if (hide)
                SetWindowPos(vsd, HWND_NOTOPMOST, -32000, -32000, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE);
            else
                SetWindowPos(vsd, HWND_TOP, 60, 60, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE);
        }
        catch (Exception ex)
        {
            Log.Warn($"Stream Deck: failed to reposition VSD window: {ex.Message}");
        }
    }

    private static IntPtr FindVsdWindow()
    {
        var streamDeckPids = new HashSet<uint>();
        foreach (var proc in System.Diagnostics.Process.GetProcessesByName("StreamDeck"))
        {
            streamDeckPids.Add((uint)proc.Id);
            proc.Dispose();
        }
        if (streamDeckPids.Count == 0)
            return IntPtr.Zero;

        var found = IntPtr.Zero;
        EnumWindows((hWnd, _) =>
        {
            GetWindowThreadProcessId(hWnd, out var pid);
            if (!streamDeckPids.Contains(pid) || !IsWindowVisible(hWnd))
                return true;

            var sb = new StringBuilder(256);
            GetClassName(hWnd, sb, sb.Capacity);
            var cn = sb.ToString();
            // The VSD popup is a borderless Qt overlay: class "Qt<version>QWindowToolSaveBits".
            if (cn.StartsWith("Qt", StringComparison.Ordinal) && cn.EndsWith("QWindowToolSaveBits", StringComparison.Ordinal))
            {
                found = hWnd;
                return false; // stop enumerating
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    // --- Win32 ---

    private const uint WM_LBUTTONDOWN = 0x0201;
    private const uint WM_LBUTTONUP = 0x0202;
    private static readonly IntPtr HWND_TOP = IntPtr.Zero;
    private static readonly IntPtr HWND_NOTOPMOST = new(-2);
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOACTIVATE = 0x0010;

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder buf, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool GetClientRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
}
