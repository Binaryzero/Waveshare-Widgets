using System.Text.Json.Nodes;

namespace WaveshareWidgets.App;

/// <summary>
/// The list of applications a user can actually start, for the settings pickers (#210).
///
/// <para>Launcher and Control Deck targets were free text with a file dialog beside them,
/// which asks the user to know where an application LIVES — a thing nobody knows for
/// anything installed from a store, and a thing that moves under them when an app
/// updates. On the panel it was worse: the dialog needs a Win32 owner window, so
/// <c>picker: "file"</c> degraded to a bare text box there and the address had to be
/// typed on a touch strip.</para>
///
/// <para>This reads the Start Menu instead, which is where Windows already keeps the
/// answer. The entries are the SHORTCUTS themselves, not resolved targets: every launch
/// path in this app goes through <c>Process.Start(… UseShellExecute = true)</c>, which
/// starts a .lnk exactly as Explorer does — with the shortcut's own arguments, working
/// directory and app-id intact. Resolving to the underlying .exe would need COM and would
/// throw away all three, which is how "launches but opens the wrong profile" happens.</para>
/// </summary>
internal static class InstalledApps
{
    /// <summary>A bound, not a budget. The two Start Menu trees are small (hundreds of
    /// entries), but they are user-writable directories walked on a UI thread's request,
    /// so the walk must terminate on a pathological one rather than trusting the shape.</summary>
    private const int MaxEntries = 800;
    private const int MaxDepth = 6;

    internal readonly record struct App(string Name, string Path);

    /// <summary>Machine-wide and per-user Start Menu programs, merged, de-duplicated by
    /// display name and sorted. Per-user wins a tie: if someone has their own shortcut for
    /// a name the machine also publishes, theirs is the one they see in their own menu.</summary>
    public static IReadOnlyList<App> List()
    {
        var byName = new Dictionary<string, App>(StringComparer.OrdinalIgnoreCase);

        // Machine first so the per-user pass overwrites it, not the other way round.
        foreach (var root in new[] { Environment.SpecialFolder.CommonStartMenu, Environment.SpecialFolder.StartMenu })
        {
            var dir = Environment.GetFolderPath(root);
            if (string.IsNullOrEmpty(dir))
                continue;
            var programs = Path.Combine(dir, "Programs");
            Collect(Directory.Exists(programs) ? programs : dir, 0, byName);
        }

        return byName.Values
            .OrderBy(a => a.Name, StringComparer.CurrentCultureIgnoreCase)
            .ToList();
    }

    /// <summary>The same list as a payload for either WebView. Shared so the desktop
    /// editor and the on-device sheet cannot drift into showing different applications —
    /// the panel is the surface that needs this most, and it is the one nobody re-checks.</summary>
    public static JsonArray ToJson()
    {
        var arr = new JsonArray();
        foreach (var app in List())
            arr.Add(new JsonObject { ["name"] = app.Name, ["path"] = app.Path });
        return arr;
    }

    private static void Collect(string dir, int depth, Dictionary<string, App> into)
    {
        if (depth > MaxDepth || into.Count >= MaxEntries)
            return;
        string[] entries;
        try
        {
            entries = Directory.GetFiles(dir, "*.lnk");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // One unreadable folder is not a reason to return nothing — a redirected or
            // permission-odd Start Menu is common enough that failing the whole list over
            // it would leave the picker empty with no explanation.
            return;
        }

        foreach (var file in entries)
        {
            if (into.Count >= MaxEntries)
                return;
            var name = Path.GetFileNameWithoutExtension(file);
            if (string.IsNullOrWhiteSpace(name) || IsNoise(name))
                continue;
            into[name] = new App(name, file);
        }

        try
        {
            foreach (var sub in Directory.GetDirectories(dir))
                Collect(sub, depth + 1, into);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Same reasoning: keep whatever this level already yielded.
        }
    }

    /// <summary>Entries that sit in the Start Menu but are not an application anyone wants
    /// on a tile. Deliberately SHORT: a missing application is worse than a noisy row,
    /// because the row can be scrolled past and the absence just looks like the picker is
    /// broken. "uninstall" is the one that earns its place on safety alone — a mis-tap on a
    /// 1280x400 strip should not be able to start removing software. A bare "help" filter
    /// was tried and dropped: it also hides anything named Helper, HelpDesk or similar.</summary>
    private static bool IsNoise(string name) =>
        name.Contains("uninstall", StringComparison.OrdinalIgnoreCase)
        || name.Contains("readme", StringComparison.OrdinalIgnoreCase)
        || name.Contains("release notes", StringComparison.OrdinalIgnoreCase);
}
