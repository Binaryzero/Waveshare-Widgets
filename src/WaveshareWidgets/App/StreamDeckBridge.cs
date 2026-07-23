using System.Drawing;
using System.Drawing.Imaging;
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
    /// picks the profile with that name; otherwise the most recently edited one (the deck
    /// the user is actually using — directory enumeration order is not stable, and "first
    /// found" made the mirrored deck flip between runs). Returns null if none exist.
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
                chosen = profiles
                    .OrderByDescending(p => SafeLastWrite(Path.Combine(p.Dir, "manifest.json")))
                    .First();

            using var manifest = JsonDocument.Parse(File.ReadAllText(Path.Combine(chosen.Dir, "manifest.json")));
            var available = profiles.Select(p => p.Name).OrderBy(n => n, StringComparer.OrdinalIgnoreCase).ToList();
            return ParseProfile(chosen.Dir, manifest.RootElement, available);
        }
        catch (Exception ex)
        {
            Log.Warn($"Stream Deck profile read failed: {ex.Message}");
        }
        return null;
    }

    private static DateTime SafeLastWrite(string path)
    {
        try { return File.GetLastWriteTimeUtc(path); }
        catch { return DateTime.MinValue; }
    }

    /// <summary>Normalizes a page id/dir name for matching (Pages.Current vs directory names).</summary>
    private static string PageKey(string idOrPath) =>
        Path.GetFileNameWithoutExtension(idOrPath.TrimEnd(Path.DirectorySeparatorChar)).Trim().ToLowerInvariant();

    private static DeckProfile ParseProfile(string profileDir, JsonElement manifest, IReadOnlyList<string> available)
    {
        var name = manifest.TryGetProperty("Name", out var n) ? n.GetString() ?? "Stream Deck" : "Stream Deck";
        var buttons = new List<DeckButton>();
        var pagesDir = Path.Combine(profileDir, "Profiles");

        // The current page holds the visible buttons.
        string? currentPage = null;
        if (manifest.TryGetProperty("Pages", out var pages) && pages.TryGetProperty("Current", out var cur))
            currentPage = cur.GetString();

        var chosenPage = "(none)";
        var matchedCurrent = false;
        if (Directory.Exists(pagesDir))
        {
            var pageDirs = Directory.GetDirectories(pagesDir);
            matchedCurrent = currentPage is not null && pageDirs.Any(d => PageKey(d) == PageKey(currentPage));
            // Prefer the current page (extension/case-insensitive match); fall back to the
            // first page that parses with buttons. Stable secondary order so the fallback
            // doesn't flip between polls.
            var ordered = pageDirs
                .OrderByDescending(d => currentPage is not null && PageKey(d) == PageKey(currentPage))
                .ThenBy(d => d, StringComparer.OrdinalIgnoreCase);

            foreach (var pageDir in ordered)
            {
                var pageManifest = Path.Combine(pageDir, "manifest.json");
                if (!File.Exists(pageManifest))
                    continue;
                try
                {
                    // Parse into a scratch list so a page that throws mid-parse can never
                    // leave partial buttons behind to merge with the next page's.
                    var pageButtons = new List<DeckButton>();
                    using var doc = JsonDocument.Parse(File.ReadAllText(pageManifest));
                    ParsePage(pageDir, doc.RootElement, pageButtons);
                    if (pageButtons.Count > 0)
                    {
                        buttons = pageButtons;
                        chosenPage = Path.GetFileName(pageDir);
                        break;
                    }
                }
                catch (Exception ex)
                {
                    Log.Warn($"Stream Deck page parse failed ({pageDir}): {ex.Message}");
                }
            }
        }

        // Bounding box of occupied keys — a lower bound on the grid, never the grid itself.
        var minRows = buttons.Count > 0 ? buttons.Max(b => b.Row) + 1 : 3;
        var minCols = buttons.Count > 0 ? buttons.Max(b => b.Col) + 1 : 5;

        // The real grid must come from the device size: with "Hide unused keys" OFF the
        // VSD window shows the FULL grid, so dividing it by the bounding box lands clicks
        // on the wrong keys whenever the layout doesn't reach the last row/column.
        var (rows, cols) = (minRows, minCols);
        var (sizeA, sizeB) = ReadDeviceSize(manifest);
        var parsedTotal = buttons.Count;
        if (sizeA is int a && sizeB is int b2)
        {
            // Profile coordinates render transposed, so the manifest's axis labels can't
            // be trusted either way. Prefer the orientation that contains the occupied
            // keys; multi-page profiles stack pages vertically (see below), so rows may
            // legitimately overflow — then require only the columns to fit. Landscape
            // wins ties (every VSD is wider than tall).
            var candidates = new[] { (r: b2, c: a), (r: a, c: b2) };
            var pick =
                candidates.Where(o => o.r >= minRows && o.c >= minCols)
                    .OrderByDescending(o => o.c >= o.r)
                    .Select(o => ((int r, int c)?)o).FirstOrDefault()
                ?? candidates.Where(o => o.c >= minCols)
                    .OrderByDescending(o => o.c >= o.r)
                    .Select(o => ((int r, int c)?)o).FirstOrDefault();
            if (pick is { } size)
                (rows, cols) = (size.r, size.c);

            // Multi-page decks keep every page in ONE actions table, page N occupying
            // rows [N*deviceRows, (N+1)*deviceRows). Rendering the whole stack shows
            // phantom repeats of other pages; keep only the current page's band.
            if (buttons.Count > 0 && buttons.Max(bt => bt.Row) >= rows)
            {
                var band = ExtractBand(buttons, PageIndexOf(manifest, currentPage), rows);
                if (band.Count == 0)
                    band = ExtractBand(buttons, 0, rows);
                if (band.Count > 0)
                    buttons = band;
            }
            // Safety: never render (or click) outside the device grid.
            buttons = buttons.Where(bt => bt.Row < rows && bt.Col < cols).ToList();
        }
        else if (!_loggedMissingSize)
        {
            _loggedMissingSize = true;
            var deviceJson = manifest.TryGetProperty("Device", out var dev) ? dev.GetRawText() : "(none)";
            Log.Warn($"Stream Deck: profile has no Device.Size; grid inferred from occupied keys " +
                     $"({minRows}x{minCols}). Device element: {deviceJson}");
        }

        // One line per distinct parse outcome (not per poll) so app.log shows exactly which
        // profile/page/grid the panel is mirroring — the fastest way to diagnose mismatches.
        var withIcons = buttons.Count(b => b.Image != "");
        var summary = $"Stream Deck: mirroring '{name}' page {chosenPage} " +
                      $"(current='{currentPage ?? "?"}', matched={matchedCurrent}) — " +
                      $"showing {buttons.Count}/{parsedTotal} buttons, {withIcons} with icons, grid {rows}x{cols} " +
                      $"(device {sizeB?.ToString() ?? "?"}x{sizeA?.ToString() ?? "?"}, occupied {minRows}x{minCols})";
        if (summary != _lastParseSummary)
        {
            _lastParseSummary = summary;
            Log.Info(summary);
        }

        return new DeckProfile(name, rows, cols, buttons, available);
    }

    private static bool _loggedMissingSize;
    private static string? _lastParseSummary;

    /// <summary>Index of the current page in the profile's Pages.Pages order (0 if unknown).</summary>
    private static int PageIndexOf(JsonElement manifest, string? currentPage)
    {
        if (currentPage is null)
            return 0;
        if (manifest.TryGetProperty("Pages", out var pages) &&
            pages.TryGetProperty("Pages", out var list) && list.ValueKind == JsonValueKind.Array)
        {
            var index = 0;
            foreach (var el in list.EnumerateArray())
            {
                if (el.ValueKind == JsonValueKind.String && PageKey(el.GetString() ?? "") == PageKey(currentPage))
                    return index;
                index++;
            }
        }
        return 0;
    }

    /// <summary>Buttons of vertically-stacked page <paramref name="pageIndex"/>, rebased to row 0.</summary>
    private static List<DeckButton> ExtractBand(List<DeckButton> buttons, int pageIndex, int rows)
    {
        var offset = pageIndex * rows;
        return buttons
            .Where(b => b.Row >= offset && b.Row < offset + rows)
            .Select(b => b with { Row = b.Row - offset })
            .ToList();
    }

    /// <summary>Reads Device.Size from the profile manifest (axis meaning resolved by caller).</summary>
    private static (int?, int?) ReadDeviceSize(JsonElement manifest)
    {
        if (!manifest.TryGetProperty("Device", out var device) ||
            !device.TryGetProperty("Size", out var size))
            return (null, null);

        int? Read(params string[] names)
        {
            foreach (var key in names)
                if (size.TryGetProperty(key, out var v) && v.TryGetInt32(out var i) && i > 0 && i <= 32)
                    return i;
            return null;
        }
        return (Read("Columns", "Cols", "Width"), Read("Rows", "Height"));
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

            var pluginUuid = data.TryGetProperty("Plugin", out var plugin) &&
                             plugin.TryGetProperty("UUID", out var pu) ? pu.GetString() ?? "" : "";
            var actionUuid = data.TryGetProperty("UUID", out var au) ? au.GetString() ?? "" : "";
            var actionName = data.TryGetProperty("Name", out var nm) ? nm.GetString() ?? "" : "";

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

            // Dynamic plugins (weather, statuses) rewrite their key images continuously;
            // a poll can catch the file mid-rewrite or momentarily deleted. Keep the last
            // good image rather than letting the key flicker blank.
            var imageCacheKey = pageDir + "|" + action.Name;
            lock (LastGoodStateImage)
            {
                if (image != "")
                    LastGoodStateImage[imageCacheKey] = image;
                else if (LastGoodStateImage.TryGetValue(imageCacheKey, out var previous))
                    image = previous;
            }

            // Buttons that use a plugin's DEFAULT icon store no image in the profile at
            // all; resolve it from the installed plugin's own files, like the VSD does.
            if (image == "")
                image = ResolvePluginIcon(pluginUuid, actionUuid, state);

            // Last resort: show the action's name rather than an anonymous dot.
            if (image == "" && title == "")
                title = actionName;

            buttons.Add(new DeckButton(visualRow, visualCol, title, image));
        }
    }

    private static string? FindImage(JsonElement stateEl) =>
        stateEl.TryGetProperty("Image", out var img) && img.ValueKind == JsonValueKind.String
            ? img.GetString()
            : null;

    // ---- default plugin icons -------------------------------------------------------

    // Resolved (pluginUuid|actionUuid|state) -> data URI ("" = not found). Plugin files
    // don't change while Stream Deck runs, and this avoids re-scanning every poll.
    private static readonly Dictionary<string, string> IconCache = [];

    // (pageDir|cell) -> last successfully-read custom key image; see ParsePage.
    private static readonly Dictionary<string, string> LastGoodStateImage = [];

    /// <summary>
    /// Finds the default icon for a plugin action by searching the installed plugin's
    /// files (user plugins under %APPDATA%, system plugins under Program Files), covering
    /// the icon layout conventions used by Elgato and popular plugins (Discord, Hue, the
    /// openapp/website/hotkey system actions, …). Same approach as StreamDeckEmbeded.
    /// </summary>
    private static string ResolvePluginIcon(string pluginUuid, string actionUuid, int state)
    {
        if (pluginUuid == "" && actionUuid == "")
            return "";
        var key = $"{pluginUuid}|{actionUuid}|{state}";
        lock (IconCache)
        {
            if (IconCache.TryGetValue(key, out var cached))
                return cached;
        }
        var resolved = "";
        try
        {
            resolved = ResolvePluginIconCore(pluginUuid, actionUuid, state);
        }
        catch (Exception ex)
        {
            Log.Warn($"Stream Deck: icon lookup failed for {actionUuid}: {ex.Message}");
        }
        lock (IconCache)
        {
            IconCache[key] = resolved;
        }
        return resolved;
    }

    private static string ResolvePluginIconCore(string pluginUuid, string actionUuid, int state)
    {
        var userPlugins = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "Elgato", "StreamDeck", "Plugins");
        var systemPlugins = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            "Elgato", "StreamDeck", "Plugins");

        var pluginDirs = new List<string>();
        void AddIfExists(string dir) { if (Directory.Exists(dir)) pluginDirs.Add(dir); }
        if (pluginUuid != "")
            AddIfExists(Path.Combine(userPlugins, pluginUuid + ".sdPlugin"));
        if (actionUuid != "")
            AddIfExists(Path.Combine(systemPlugins, actionUuid + ".sdPlugin")); // per-action system plugins (openapp, website, …)
        if (pluginUuid != "")
            AddIfExists(Path.Combine(systemPlugins, pluginUuid + ".sdPlugin"));
        if (pluginDirs.Count == 0)
            return "";

        // "com.elgato.discord.mute" -> "mute"; multi-part suffixes get joined variants.
        var suffix = pluginUuid != "" && actionUuid.StartsWith(pluginUuid + ".", StringComparison.Ordinal)
            ? actionUuid[(pluginUuid.Length + 1)..]
            : actionUuid.Split('.').LastOrDefault() ?? "";
        var variants = new List<string> { suffix };
        if (suffix.Contains('.'))
        {
            var parts = suffix.Split('.');
            variants.Add(string.Concat(parts));
            variants.Add(string.Concat(parts.Reverse()));
            variants.Add(parts[^1]);
        }

        // Known action-name -> icon-directory mappings (Philips Hue's layout).
        var mapped = suffix switch
        {
            "power" => "onoff",
            "brightness" or "brightness.set" => "brightness-set",
            "brightness.adjust" => "brightness-adjust",
            "color.set" => "color-set",
            "color.cycle" => "color-cycle",
            "temperature.set" => "temperature-set",
            "temperature.adjust" => "temperature-adjust",
            "scene" => "scene",
            _ => null,
        };

        var lastPart = actionUuid.Split('.').LastOrDefault() ?? "";
        var candidates = new List<string>();
        foreach (var dir in pluginDirs)
        {
            foreach (var name in variants)
            {
                if (name == "")
                    continue;
                foreach (var ext in new[] { "svg", "png" })
                {
                    candidates.Add(Path.Combine(dir, "images", "actions", $"{name}_{state}.{ext}")); // Discord convention
                    candidates.Add(Path.Combine(dir, "images", "actions", $"{name}_0.{ext}"));
                    candidates.Add(Path.Combine(dir, "images", "actions", $"{name}.{ext}"));
                    candidates.Add(Path.Combine(dir, "actions", name, $"actionimage.{ext}"));        // Hue convention
                    candidates.Add(Path.Combine(dir, "actions", name, $"keyimage.{ext}"));
                }
                candidates.Add(Path.Combine(dir, "imgs", "actions", name, "key@2x.png"));            // legacy Elgato convention
                candidates.Add(Path.Combine(dir, "imgs", "actions", name, "key.png"));
                candidates.Add(Path.Combine(dir, "imgs", "actions", name, "icon@2x.png"));
                candidates.Add(Path.Combine(dir, "imgs", "actions", name, "icon.png"));
            }
            if (mapped is not null)
            {
                candidates.Add(Path.Combine(dir, "actions", mapped, "actionimage.svg"));
                candidates.Add(Path.Combine(dir, "actions", mapped, "keyimage.svg"));
                candidates.Add(Path.Combine(dir, "actions", mapped, "actionimage.png"));
            }
            if (lastPart != "")
            {
                candidates.Add(Path.Combine(dir, "Images", $"btn_{lastPart}.svg"));                  // system plugins
                candidates.Add(Path.Combine(dir, "Images", $"{lastPart}.svg"));
                candidates.Add(Path.Combine(dir, "Images", $"btn_{lastPart}.png"));
                candidates.Add(Path.Combine(dir, "Images", $"{lastPart}.png"));
            }
            // Fallbacks: the plugin's category/plugin icon beats an anonymous blank key.
            candidates.Add(Path.Combine(dir, "images", "category.svg"));
            candidates.Add(Path.Combine(dir, "images", "category@2x.png"));
            candidates.Add(Path.Combine(dir, "images", "category.png"));
            candidates.Add(Path.Combine(dir, "images", "plugin.svg"));
            candidates.Add(Path.Combine(dir, "images", "plugin@2x.png"));
            candidates.Add(Path.Combine(dir, "images", "plugin.png"));
            candidates.Add(Path.Combine(dir, "pluginIcon@2x.png"));
            candidates.Add(Path.Combine(dir, "pluginIcon.png"));
        }

        foreach (var candidate in candidates)
        {
            if (!File.Exists(candidate))
                continue;
            var uri = LoadImageDataUri(candidate);
            if (uri != "")
                return uri;
        }
        return "";
    }

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
        Log.Info($"Stream Deck: clicked cell row={row} col={col} of {rows}x{cols} at ({x},{y}) " +
                 $"in {rect.Right}x{rect.Bottom} window (cell {cellW:F0}x{cellH:F0})");
        return true;
    }

    /// <summary>
    /// Captures the VSD overlay window's live pixels — the only way to mirror DYNAMIC key
    /// faces (weather readouts, status colors), which plugins render at runtime and which
    /// the on-disk profile can't represent. PrintWindow with PW_RENDERFULLCONTENT works
    /// even while the window is parked off-screen by <see cref="HideVsdWindow"/>. Returns
    /// null when the window is missing or the capture comes back blank (some GPU pipelines
    /// refuse PrintWindow) so the caller can fall back to profile parsing.
    /// </summary>
    public (string DataUri, int W, int H, string Hash)? CaptureVsdWindow()
    {
        var vsd = FindVsdWindow();
        if (vsd == IntPtr.Zero)
            return null;
        if (!GetClientRect(vsd, out var rect) || rect.Right <= 0 || rect.Bottom <= 0)
            return null;

        try
        {
            using var bmp = new Bitmap(rect.Right, rect.Bottom);
            using (var g = Graphics.FromImage(bmp))
            {
                var hdc = g.GetHdc();
                try
                {
                    if (!PrintWindow(vsd, hdc, PW_CLIENTONLY | PW_RENDERFULLCONTENT))
                        return null;
                }
                finally
                {
                    g.ReleaseHdc(hdc);
                }
            }

            // A refused capture yields a uniform (usually black) bitmap; sample a small
            // grid and require at least two distinct colors before trusting it.
            var first = bmp.GetPixel(1, 1).ToArgb();
            var uniform = true;
            for (var sy = 0; sy < 4 && uniform; sy++)
                for (var sx = 0; sx < 4 && uniform; sx++)
                    if (bmp.GetPixel(sx * (rect.Right - 2) / 3 + 1, sy * (rect.Bottom - 2) / 3 + 1).ToArgb() != first)
                        uniform = false;
            if (uniform)
            {
                if (!_loggedBlankCapture)
                {
                    _loggedBlankCapture = true;
                    Log.Warn("Stream Deck: window capture came back uniform; live mirroring unavailable, using profile icons");
                }
                return null;
            }

            // Content hash lets the caller skip shipping frames that didn't change —
            // that's what makes a fast poll cheap when the deck is idle.
            var hash = HashBitmap(bmp);

            // JPEG (opaque window, photographic key faces): ~5-10x smaller than PNG,
            // which is what makes a sub-second refresh viable over the bridge.
            using var ms = new MemoryStream();
            var codec = ImageCodecInfo.GetImageEncoders().First(c => c.FormatID == ImageFormat.Jpeg.Guid);
            using var prms = new EncoderParameters(1);
            prms.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 82L);
            bmp.Save(ms, codec, prms);
            return ("data:image/jpeg;base64," + Convert.ToBase64String(ms.ToArray()), rect.Right, rect.Bottom, hash);
        }
        catch (Exception ex)
        {
            Log.Warn($"Stream Deck: window capture failed: {ex.Message}");
            return null;
        }
    }

    private static bool _loggedBlankCapture;

    /// <summary>Fast sampled FNV-1a over the raw pixel buffer (change detection, not crypto).</summary>
    private static string HashBitmap(Bitmap bmp)
    {
        var data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height),
            ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            var length = Math.Abs(data.Stride) * bmp.Height;
            unchecked
            {
                var hash = 1469598103934665603UL;
                for (var offset = 0; offset + 4 <= length; offset += 128)
                {
                    hash = (hash ^ (uint)Marshal.ReadInt32(data.Scan0, offset)) * 1099511628211UL;
                }
                return hash.ToString("x16");
            }
        }
        finally
        {
            bmp.UnlockBits(data);
        }
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
    private const uint PW_CLIENTONLY = 0x1;
    private const uint PW_RENDERFULLCONTENT = 0x2;

    [DllImport("user32.dll")]
    private static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
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
