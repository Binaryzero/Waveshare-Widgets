using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;

namespace Plinth.App;

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
/// answer for traditional desktop programs. Packaged (Store) applications are the other
/// half: many create no .lnk anywhere on disk, so they are read from the AppsFolder
/// namespace and listed by their app id, launched through <see cref="AppIds"/> (#219).
/// A name the Start Menu already supplies keeps its shortcut.</para>
///
/// <para>Start Menu entries are the SHORTCUTS themselves, not resolved targets: every launch
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
    public static IReadOnlyList<App> List() => List(out _, out _);

    /// <param name="truncated">True when a bound stopped the walk, so the caller can say
    /// so instead of presenting a partial list as the whole answer.</param>
    /// <param name="storeListed">False when the AppsFolder could not be read, so the
    /// picker does not claim a Store app is absent when it was never asked.</param>
    public static IReadOnlyList<App> List(out bool truncated, out bool storeListed)
    {
        var byName = new Dictionary<string, App>(StringComparer.OrdinalIgnoreCase);

        // One counter across BOTH trees: the bound is on the work this call does, and
        // two separately-bounded walks are not a bound on the pair of them.
        var visited = 0;
        // Depth is a bound too, and a silent one: a shortcut nested below MaxDepth is
        // skipped with both counters near zero, so `truncated` would say false and the
        // picker would tell the user their application is not installed.
        var depthCut = false;

        // Machine first so the per-user pass overwrites it, not the other way round.
        foreach (var root in new[] { Environment.SpecialFolder.CommonStartMenu, Environment.SpecialFolder.StartMenu })
        {
            var dir = Environment.GetFolderPath(root);
            if (string.IsNullOrEmpty(dir))
                continue;
            var programs = Path.Combine(dir, "Programs");
            Collect(Directory.Exists(programs) ? programs : dir, 0, byName, ref visited, ref depthCut);
        }

        truncated = visited >= MaxVisited || byName.Count >= MaxEntries || depthCut;
        if (truncated)
            Log.Warn($"Installed-app walk stopped early ({byName.Count} apps, {visited} entries seen); the picker is showing a partial list");

        var folder = ReadAppsFolder(out storeListed, out var folderCut);
        var taken = new HashSet<string>(byName.Keys, StringComparer.OrdinalIgnoreCase);
        var store = AppIds.Additions(folder, taken, IsNoise, Math.Max(0, MaxEntries - byName.Count), out var storeCut);
        foreach (var (name, target) in store)
            byName[name] = new App(name, target);
        if (folderCut || storeCut)
        {
            truncated = true;
            Log.Warn($"Store app list stopped early ({store.Count} added, {folder.Count} read); the picker is showing a partial list");
        }

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
        var apps = List(out var truncated, out var storeListed);
        var arr = new JsonArray();
        foreach (var app in apps)
            arr.Add(new JsonObject { ["name"] = app.Name, ["path"] = app.Path });
        return new JsonObject { ["apps"] = arr, ["truncated"] = truncated, ["storeListed"] = storeListed };
    }

    /// <summary><see cref="ToJson"/> on a thread of its own. The AppsFolder is a shell COM
    /// namespace, which wants an STA thread, and reading it can take a second on a slow
    /// machine; the window's UI thread is where the request arrives and where nothing
    /// should wait that long. Never faults: a failure answers with an empty, cut-short
    /// list, so the picker says so instead of waiting on a reply that never comes.</summary>
    public static Task<JsonObject> ToJsonAsync()
    {
        var done = new TaskCompletionSource<JsonObject>(TaskCreationOptions.RunContinuationsAsynchronously);
        var thread = new Thread(() =>
        {
            try { done.SetResult(ToJson()); }
            catch (Exception ex)
            {
                Log.Warn($"Installed-app list failed: {ex.Message}");
                done.SetResult(new JsonObject { ["apps"] = new JsonArray(), ["truncated"] = true, ["storeListed"] = false });
            }
        })
        { IsBackground = true, Name = "Installed apps" };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        return done.Task;
    }

    /// <summary>Most AppsFolder items read. The folder mirrors the Start Menu plus every
    /// packaged app, so it is a few hundred entries on an ordinary machine.</summary>
    private const int MaxFolderItems = 3_000;

    /// <summary>Name and Path of every AppsFolder item, through the Shell.Application
    /// automation object. A packaged app's Path is its app id; <see cref="AppIds.Additions"/>
    /// decides what is kept.</summary>
    private static List<(string Name, string Path)> ReadAppsFolder(out bool listed, out bool truncated)
    {
        listed = false;
        truncated = false;
        var found = new List<(string, string)>();
        object? shell = null, folder = null, items = null;
        try
        {
            var type = Type.GetTypeFromProgID("Shell.Application");
            if (type is null)
                return found;
            shell = Activator.CreateInstance(type);
            folder = Call(shell, "NameSpace", "shell:AppsFolder")
                ?? Call(shell, "NameSpace", "shell:::{4234d49b-0245-4df3-b780-3893943456e1}");
            if (folder is null)
                return found;
            items = Call(folder, "Items");
            var count = Convert.ToInt32(Prop(items, "Count"));
            for (var i = 0; i < count; i++)
            {
                if (i >= MaxFolderItems) { truncated = true; break; }
                object? item = null;
                try
                {
                    item = Call(items, "Item", i);
                    if (Prop(item, "Name") is string name && Prop(item, "Path") is string path)
                        found.Add((name, path));
                }
                catch (Exception ex) when (ex is COMException or TargetInvocationException or InvalidCastException)
                {
                    // One unreadable item is not a reason to drop the rest.
                }
                finally { Release(item); }
            }
            listed = true;
        }
        catch (Exception ex)
        {
            Log.Warn($"Store apps could not be listed: {ex.Message}");
        }
        finally
        {
            Release(items);
            Release(folder);
            Release(shell);
        }
        return found;
    }

    private static object? Call(object? target, string method, params object[] args) =>
        target?.GetType().InvokeMember(method, BindingFlags.InvokeMethod, null, target, args);

    private static object? Prop(object? target, string name) =>
        target?.GetType().InvokeMember(name, BindingFlags.GetProperty, null, target, null);

    private static void Release(object? com)
    {
        if (com is not null && OperatingSystem.IsWindows() && Marshal.IsComObject(com))
            Marshal.ReleaseComObject(com);
    }

    private static void Collect(string dir, int depth, Dictionary<string, App> into,
        ref int visited, ref bool depthCut)
    {
        if (depth > MaxDepth) { depthCut = true; return; }
        if (into.Count >= MaxEntries || visited >= MaxVisited)
            return;

        // ONE unfiltered enumeration, and every entry is charged to the budget before
        // anything is filtered. `EnumerateFiles(dir, "*.lnk")` filters in the OS call, so
        // a folder holding a hundred thousand .txt files is scanned in full while the
        // counter barely moves — the bound would still have been advertised and still not
        // have existed, on a synchronous WebView handler. FileSystemInfo also carries the
        // attributes the enumeration already returned, so telling a directory from a file
        // costs no extra stat.
        IEnumerable<FileSystemInfo> entries;
        try
        {
            entries = new DirectoryInfo(dir).EnumerateFileSystemInfos();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Security.SecurityException)
        {
            // One unreadable folder is not a reason to return nothing — a redirected or
            // permission-odd Start Menu is common enough that failing the whole list over
            // it would leave the picker empty with no explanation.
            return;
        }

        try
        {
            foreach (var info in entries)
            {
                if (++visited >= MaxVisited || into.Count >= MaxEntries)
                    return;
                if ((info.Attributes & FileAttributes.Directory) != 0)
                {
                    Collect(info.FullName, depth + 1, into, ref visited, ref depthCut);
                    continue;
                }
                if (!info.Name.EndsWith(".lnk", StringComparison.OrdinalIgnoreCase))
                    continue;
                var name = Path.GetFileNameWithoutExtension(info.Name);
                if (string.IsNullOrWhiteSpace(name) || IsNoise(name))
                    continue;
                into[name] = new App(name, info.FullName);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Security.SecurityException)
        {
            // Lazy enumeration can throw part-way through; whatever was added stays added.
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
