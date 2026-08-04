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
/// answer for traditional desktop programs. It is NOT the whole answer: packaged
/// AppX/MSIX/UWP applications are registered in the AppsFolder namespace and many create
/// no .lnk anywhere on disk, so they are absent here. Covering them needs COM enumeration
/// AND a different launch path — an AppUserModelId is started through
/// `explorer.exe shell:AppsFolder\&lt;aumid&gt;`, not by Process.Start on a path — which is a
/// second mechanism rather than a wider glob. The pickers say where their list came from
/// when a search finds nothing, so the absence has an explanation rather than looking
/// like a broken picker.</para> The entries are the SHORTCUTS themselves, not resolved targets: every launch
/// path in this app goes through <c>Process.Start(… UseShellExecute = true)</c>, which
/// starts a .lnk exactly as Explorer does — with the shortcut's own arguments, working
/// directory and app-id intact. Resolving to the underlying .exe would need COM and would
/// throw away all three, which is how "launches but opens the wrong profile" happens.</para>
/// </summary>
internal static class InstalledApps
{
    /// <summary>Bounds, not budgets. The two Start Menu trees are small (hundreds of
    /// entries), but they are USER-WRITABLE directories walked synchronously from a
    /// WebView message handler, so a pathological one must stop the walk rather than the
    /// window.
    ///
    /// <para>MaxVisited counts filesystem entries SEEN, not applications kept. Bounding on
    /// the kept count was wrong in the direction that matters: a menu full of duplicate
    /// names or `Uninstall …` shortcuts leaves that count near zero while the recursion
    /// keeps walking, so the advertised bound never fired on precisely the shapes it
    /// existed for.</para></summary>
    private const int MaxVisited = 20_000;
    private const int MaxEntries = 800;
    private const int MaxDepth = 6;

    internal readonly record struct App(string Name, string Path);

    /// <summary>Machine-wide and per-user Start Menu programs, merged, de-duplicated by
    /// display name and sorted. Per-user wins a tie: if someone has their own shortcut for
    /// a name the machine also publishes, theirs is the one they see in their own menu.</summary>
    public static IReadOnlyList<App> List() => List(out _);

    /// <param name="truncated">True when a bound stopped the walk, so the caller can say
    /// so instead of presenting a partial list as the whole answer.</param>
    public static IReadOnlyList<App> List(out bool truncated)
    {
        var byName = new Dictionary<string, App>(StringComparer.OrdinalIgnoreCase);

        // One counter across BOTH trees: the bound is on the work this call does, and
        // two separately-bounded walks are not a bound on the pair of them.
        var visited = 0;

        // Machine first so the per-user pass overwrites it, not the other way round.
        foreach (var root in new[] { Environment.SpecialFolder.CommonStartMenu, Environment.SpecialFolder.StartMenu })
        {
            var dir = Environment.GetFolderPath(root);
            if (string.IsNullOrEmpty(dir))
                continue;
            var programs = Path.Combine(dir, "Programs");
            Collect(Directory.Exists(programs) ? programs : dir, 0, byName, ref visited);
        }

        truncated = visited >= MaxVisited || byName.Count >= MaxEntries;
        if (truncated)
            Log.Warn($"Installed-app walk stopped early ({byName.Count} apps, {visited} entries seen); the picker is showing a partial list");

        return byName.Values
            .OrderBy(a => a.Name, StringComparer.CurrentCultureIgnoreCase)
            .ToList();
    }

    /// <summary>The same payload for either WebView. Shared so the desktop editor and the
    /// on-device sheet cannot drift into showing different applications — the panel is the
    /// surface that needs this most, and it is the one nobody re-checks.
    ///
    /// <para>It carries `truncated` because the cap is otherwise invisible to the person
    /// it affects: a log line reaches the developer, while the user searching for the
    /// application that fell off the end is told "no match — it may be a Store app",
    /// which is a confident wrong answer. A bound that only the log knows about is a
    /// silent one.</para></summary>
    public static JsonObject ToJson()
    {
        var apps = List(out var truncated);
        var arr = new JsonArray();
        foreach (var app in apps)
            arr.Add(new JsonObject { ["name"] = app.Name, ["path"] = app.Path });
        return new JsonObject { ["apps"] = arr, ["truncated"] = truncated };
    }

    private static void Collect(string dir, int depth, Dictionary<string, App> into, ref int visited)
    {
        if (depth > MaxDepth || into.Count >= MaxEntries || visited >= MaxVisited)
            return;

        // Enumerate, do not GetFiles: the array form materialises the whole directory
        // before a single bound is consulted, so one folder with a hundred thousand files
        // is allocated in full and only then found to be too big. Streaming lets the
        // counter stop it mid-directory.
        try
        {
            foreach (var file in Directory.EnumerateFiles(dir, "*.lnk"))
            {
                if (++visited >= MaxVisited || into.Count >= MaxEntries)
                    return;
                var name = Path.GetFileNameWithoutExtension(file);
                if (string.IsNullOrWhiteSpace(name) || IsNoise(name))
                    continue;
                into[name] = new App(name, file);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Security.SecurityException)
        {
            // One unreadable folder is not a reason to return nothing — a redirected or
            // permission-odd Start Menu is common enough that failing the whole list over
            // it would leave the picker empty with no explanation. Enumeration can throw
            // part-way through, so whatever was already added stays added.
        }

        try
        {
            foreach (var sub in Directory.EnumerateDirectories(dir))
            {
                if (++visited >= MaxVisited)
                    return;
                Collect(sub, depth + 1, into, ref visited);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Security.SecurityException)
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
