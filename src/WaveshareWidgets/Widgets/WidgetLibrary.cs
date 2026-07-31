using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace WaveshareWidgets.Widgets;

/// <summary>An installed widget: its manifest, folder on disk, and the virtual host
/// the dashboard serves it from (one host per widget = one browser origin per widget).</summary>
public sealed record InstalledWidget(WidgetManifest Manifest, string Folder, string VirtualHost);

/// <summary>A widget on disk that the library refused to load, and why (issue #57).
///
/// Refusing is the whole point of the credential rule, but a refusal that only reaches
/// app.log means the user's first symptom is a tile that quietly stopped existing. The
/// settings window reads this list so the reason is visible where the widget isn't.
///
/// <paramref name="RedactNames"/> is redaction metadata, not display data: a refused
/// widget has no manifest in the library, so nothing downstream can tell which of its
/// stored settings are credentials. Carrying the names here keeps those slots on the
/// secret pipeline (see <see cref="WidgetManifest.RedactionOnly"/>) instead of having the
/// refusal itself publish the plaintext it was raised over.</summary>
public sealed record RejectedWidget(
    string Id, string Name, string Folder, string Reason, IReadOnlyList<string> RedactNames);

/// <summary>The outcome of installing a package: what was installed, and whether it is
/// being served yet.</summary>
/// <param name="Widget">Null when the package is on disk but its origin could not be
/// assigned this scan — the host map was unreadable. A retry is already scheduled. This is
/// a PENDING install, not a failed one, and the two must not be reported alike.</param>
public sealed record InstallResult(WidgetManifest Manifest, InstalledWidget? Widget);

/// <summary>
/// Manages the user's widgets folder: seeds stock widgets on first run, scans installed
/// widget folders, installs .wswidget packages (zip of manifest.json + index.html), and
/// watches the folder so edits hot-reload the dashboard.
/// </summary>
public sealed partial class WidgetLibrary : IDisposable
{
    private FileSystemWatcher? _watcher;
    private System.Threading.Timer? _debounce;

    public IReadOnlyList<InstalledWidget> Widgets { get; private set; } = [];

    /// <summary>Widgets found on disk but refused, with the reason. Rebuilt by every
    /// <see cref="Rescan"/>; surfaced in the settings window so a refusal is not a
    /// silently missing tile.</summary>
    public IReadOnlyList<RejectedWidget> Rejected { get; private set; } = [];

    /// <summary>Raised (on a background thread) when widget files change on disk.</summary>
    public event Action? Changed;

    public void Initialize()
    {
        SeedStockWidgets();
        Rescan();

        _watcher = new FileSystemWatcher(AppPaths.WidgetsDir)
        {
            IncludeSubdirectories = true,
            NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite,
        };
        _watcher.Changed += (_, _) => ScheduleReload();
        _watcher.Created += (_, _) => ScheduleReload();
        _watcher.Deleted += (_, _) => ScheduleReload();
        _watcher.Renamed += (_, _) => ScheduleReload();
        _watcher.EnableRaisingEvents = true;
    }

    /// <summary>Backoff for re-running a scan that had to withhold widgets because the host
    /// map was unreadable. Doubles to a ceiling rather than hammering the file, and resets
    /// whenever a scan gets through.</summary>
    private System.Threading.Timer? _hostMapRetry;
    private int _hostMapRetryDelay = InitialHostMapRetryMs;
    private const int InitialHostMapRetryMs = 2000;
    private const int MaxHostMapRetryMs = 60000;

    private void ScheduleHostMapRetry()
    {
        _hostMapRetry?.Dispose();
        var delay = _hostMapRetryDelay;
        _hostMapRetryDelay = Math.Min(_hostMapRetryDelay * 2, MaxHostMapRetryMs);
        _hostMapRetry = new System.Threading.Timer(_ =>
        {
            Rescan();
            Changed?.Invoke();   // the windows are showing a library missing those widgets
        }, null, delay, Timeout.Infinite);
    }

    private void ScheduleReload()
    {
        // Editors fire bursts of events; wait for the writes to settle.
        _debounce?.Dispose();
        _debounce = new System.Threading.Timer(_ =>
        {
            Rescan();
            Changed?.Invoke();
        }, null, 800, Timeout.Infinite);
    }

    /// <summary>Name of the fingerprint marker written next to each seeded copy.</summary>
    private const string SeedMarker = ".stock-seed";

    /// <summary>Stock widgets upgrade in place whenever the app ships DIFFERENT CONTENT —
    /// a fingerprint of the shipped folder is recorded at seed time and compared on every
    /// start. Manifest versions used to gate this, which silently stranded every install
    /// whenever a widget changed without a version bump (issue #26). An installed copy
    /// with no marker (pre-fingerprint installs) is re-seeded once, healing stale copies
    /// in the field. To customize a stock widget without it ever being overwritten, copy
    /// the folder and give it a new id.</summary>
    private void SeedStockWidgets()
    {
        // The retired list is AUTHORITATIVE — never inferred from the shipped
        // folder's absence: extracting a release over an old install leaves stale
        // stock-widgets entries behind, which would both skip this cleanup and
        // re-seed the retired widget below.
        var retiredNames = RetiredStockNames;
        var retiredIds = new List<string>();
        foreach (var retired in retiredNames)
        {
            retiredIds.Add($"ws.stock.{retired}");
            var dir = Path.Combine(AppPaths.WidgetsDir, retired);
            if (!Directory.Exists(dir)) continue;
            // Marker-bearing copies are ours. Pre-fingerprint seeds carry NO marker
            // — recognize those by the stock manifest id instead; a folder that is
            // neither marked nor stock-id'd is the user's own work and survives.
            if (!File.Exists(Path.Combine(dir, SeedMarker)) && ManifestIdOf(dir) != $"ws.stock.{retired}") continue;
            try { DeleteTree(dir); Log.Info($"Removed retired stock widget '{retired}'"); }
            catch (Exception ex) { Log.Warn($"Could not remove retired stock widget '{retired}': {ex.Message}"); }
        }
        // The saved layout must shed retired slots too, or the panel renders a
        // permanent "not installed" card in the grid cells the widget held.
        if (retiredIds.Count > 0)
            LayoutStore.RemoveWidgets(retiredIds);

        if (!Directory.Exists(AppPaths.StockWidgetsDir))
        {
            Log.Warn($"Stock widgets folder missing next to the app ({AppPaths.StockWidgetsDir}) — nothing to seed");
            return;
        }

        // Retired stock: a widget the app no longer ships (fans — its sensor
        // pipeline required elevation) must also leave UPGRADED installs, not
        // just fresh ones. Only marker-bearing copies are removed — an unmarked
        // folder is the user's own work and is never touched.

        int seeded = 0, current = 0;
        var failed = new List<string>();
        foreach (var sourceDir in Directory.GetDirectories(AppPaths.StockWidgetsDir))
        {
            var name = Path.GetFileName(sourceDir);
            if (retiredNames.Contains(name)) continue; // stale shipped copy from an overwrite upgrade
            var targetDir = Path.Combine(AppPaths.WidgetsDir, name);
            try
            {
                var fingerprint = Fingerprint(sourceDir);
                if (Directory.Exists(targetDir) && MarkerMatches(targetDir, fingerprint))
                {
                    current++;
                    continue;
                }

                if (Directory.Exists(targetDir) &&
                    !File.Exists(Path.Combine(targetDir, SeedMarker)) &&
                    !SameWidgetId(sourceDir, targetDir))
                {
                    // An UNMARKED folder whose manifest id differs from the stock widget is
                    // the user's own work that merely shares the folder name (adding the
                    // stock "deck" folder made this collision real). Never delete it — move
                    // it aside so both widgets survive; folder names carry no identity, so
                    // the moved widget keeps working. Unmarked SAME-id copies still re-seed
                    // (the documented pre-fingerprint heal); marked copies refresh as stock.
                    var aside = UniqueDir(targetDir + "-user");
                    Directory.Move(targetDir, aside);
                    Log.Warn($"Widget folder '{name}' held a non-stock widget — moved to " +
                             $"'{Path.GetFileName(aside)}' so the stock widget can seed");
                }

                DeleteTree(targetDir);
                CopyDirectory(sourceDir, targetDir);
                File.WriteAllText(Path.Combine(targetDir, SeedMarker), fingerprint);
                seeded++;
                Log.Info($"Seeded stock widget: {name}");
            }
            catch (Exception ex)
            {
                failed.Add(name);
                Log.Warn($"Seeding {name} FAILED — the installed copy is stale: {ex.Message}");
            }
        }
        // One unmissable summary line: this is the first thing to look for in app.log
        // when a field report says widget changes "aren't there" after an update.
        Log.Info($"Stock widget seeding: {seeded} refreshed, {current} already current" +
                 (failed.Count > 0 ? $", {failed.Count} FAILED ({string.Join(", ", failed)})" : ""));
    }

    /// <summary>Recursive delete that survives what Windows actually does to installed
    /// files: read-only attributes (copied media, some unzip tools) make
    /// Directory.Delete throw, silently stranding the stale copy.</summary>
    private static void DeleteTree(string dir)
    {
        if (!Directory.Exists(dir))
            return;
        foreach (var file in Directory.GetFiles(dir, "*", SearchOption.AllDirectories))
        {
            var attributes = File.GetAttributes(file);
            if ((attributes & FileAttributes.ReadOnly) != 0)
                File.SetAttributes(file, attributes & ~FileAttributes.ReadOnly);
        }
        Directory.Delete(dir, recursive: true);
    }

    /// <summary>Do two widget folders declare the same manifest id? Any read/parse
    /// failure counts as "different" — an ambiguous target is treated as user
    /// content and preserved rather than deleted.</summary>
    private static string? ManifestIdOf(string dir)
    {
        try { return JsonNode.Parse(File.ReadAllText(Path.Combine(dir, "manifest.json")))?["id"]?.GetValue<string>(); }
        catch { return null; }
    }

    private static bool SameWidgetId(string dirA, string dirB)
    {
        try
        {
            var idA = JsonNode.Parse(File.ReadAllText(Path.Combine(dirA, "manifest.json")))?["id"]?.GetValue<string>();
            var idB = JsonNode.Parse(File.ReadAllText(Path.Combine(dirB, "manifest.json")))?["id"]?.GetValue<string>();
            return !string.IsNullOrEmpty(idA) && idA == idB;
        }
        catch
        {
            return false;
        }
    }

    private static string UniqueDir(string baseDir)
    {
        var dir = baseDir;
        for (var i = 2; Directory.Exists(dir); i++)
            dir = baseDir + i;
        return dir;
    }

    /// <summary>The last host map this process read successfully. A rescan that cannot
    /// read the file — antivirus or an indexer holding it is routine on Windows — reuses
    /// this instead of behaving as though no widget had ever been assigned an origin.</summary>
    private static Dictionary<string, string>? _lastGoodHostMap;

    /// <summary>Persisted widget-id → virtual-host assignments. Hosts are browser
    /// origins (localStorage, credentials), so an entry is written once and kept
    /// forever.</summary>
    /// <returns>The map, and whether it is TRUSTWORTHY — i.e. whether it really
    /// represents every assignment ever made. False means the file exists but this
    /// process could not read it, and the caller must not write over it: the entries
    /// it cannot see are the only record of which origins already have an owner.</returns>
    private static (Dictionary<string, string> Map, bool Trustworthy) LoadHostMap()
    {
        if (!File.Exists(AppPaths.HostMapFile))
            return (new Dictionary<string, string>(), true);   // first run: nothing assigned yet

        // Antivirus and the search indexer routinely hold a just-written file open on
        // Windows, and the answer to that is to wait a moment, not to conclude that no
        // widget has ever been assigned an origin. Three tries covers it; what survives
        // all three is reported honestly rather than papered over.
        Exception? lastIoFailure = null;
        for (var attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                var map = JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(AppPaths.HostMapFile))
                          ?? new Dictionary<string, string>();
                _lastGoodHostMap = new Dictionary<string, string>(map, StringComparer.Ordinal);
                return (map, true);
            }
            catch (JsonException ex)
            {
                // Corrupt, not busy: rereading will never work, and DurableStore's atomic
                // writes mean this is damage from outside the app. Move it aside rather than
                // silently overwriting it — it is the only record of who owns which origin,
                // and it is now evidence. A fresh map may be written after this.
                Log.Error($"Widget host map is unreadable ({ex.Message}) — quarantining it and re-minting hosts");
                QuarantineHostMap();
                return (new Dictionary<string, string>(), true);
            }
            catch (Exception ex)
            {
                lastIoFailure = ex;
                Thread.Sleep(100 * (attempt + 1));
            }
        }

        // Still locked. If this process has read the map once, that copy is authoritative
        // enough — nothing outside this app writes it.
        if (_lastGoodHostMap is { } cached)
        {
            Log.Warn($"Could not read widget host map ({lastIoFailure?.Message}) — using the copy read earlier this session");
            return (new Dictionary<string, string>(cached, StringComparer.Ordinal), true);
        }
        Log.Error($"Could not read widget host map ({lastIoFailure?.Message}) — refusing to assign origins without it");
        return (new Dictionary<string, string>(), false);
    }

    private static void QuarantineHostMap()
    {
        try
        {
            var aside = UniqueFile(AppPaths.HostMapFile + ".corrupt");
            File.Move(AppPaths.HostMapFile, aside);
            Log.Error($"Previous widget host map kept at '{aside}'");
        }
        catch (Exception ex)
        {
            Log.Warn($"Could not quarantine the widget host map: {ex.Message}");
        }
    }

    private static string UniqueFile(string basePath)
    {
        var path = basePath;
        for (var i = 2; File.Exists(path); i++)
            path = basePath + i;
        return path;
    }

    private static void SaveHostMap(Dictionary<string, string> map)
    {
        try
        {
            DurableStore.Write(AppPaths.HostMapFile,
                JsonSerializer.Serialize(map, new JsonSerializerOptions { WriteIndented = true }));
            // The lock fallback is only as good as this. Left at the pre-save copy, it
            // described a map that no longer existed: assignments made after the last
            // successful READ were missing from it, so a rescan that could not open the
            // file would treat an out-of-date map as the whole record and hand a newcomer
            // an origin that the missing entry had already reserved.
            _lastGoodHostMap = new Dictionary<string, string>(map, StringComparer.Ordinal);
        }
        catch (Exception ex)
        {
            // Deliberately NOT updating the cache here: nothing was persisted, so the last
            // copy that matches the file is still the one read from it.
            Log.Warn($"Could not save widget host map: {ex.Message}");
        }
    }

    /// <summary>Widgets the app no longer ships. AUTHORITATIVE — never inferred from a
    /// folder's absence, because extracting a release over an old install leaves stale
    /// stock-widgets folders behind.</summary>
    /// <remarks>Shared by the seeder and the provenance map on purpose. When only the
    /// seeder knew, a stale shipped `fans/` folder still authorized `ws.stock.fans` from a
    /// hand-dropped `widgets/fans` — the retirement was enforced in the one place that
    /// copies files and ignored in the one place that decides identity.</remarks>
    private static readonly HashSet<string> RetiredStockNames =
        new(StringComparer.OrdinalIgnoreCase) { "fans" };

    /// <summary>Every widget the app SHIPS: folder name, declared id, and a content
    /// fingerprint. Read from next to the exe and cached for the process.</summary>
    /// <remarks>
    /// This is the provenance side of the reserved-id rule (#94), so it must come from
    /// somewhere a package cannot write. AppContext.BaseDirectory is not a security
    /// boundary in a portable copy — a user who can drop a folder there can already
    /// replace the exe — but it is categorically not reachable by installing a widget,
    /// which is the attack this rule is about.
    ///
    /// The FINGERPRINT is what makes the rule hold. The folder name is not evidence: the
    /// widgets directory is documented as somewhere users unzip archives, and those writes
    /// hot-reload, so `widgets/hue` is a name an attacker can occupy. Only matching content
    /// distinguishes the seeded copy from something wearing its name.
    ///
    /// Cached because it cannot change while the app runs and every rescan asks: the
    /// FileSystemWatcher fires a scan per edit, and re-hashing two dozen shipped folders
    /// each time to answer a question with a constant answer is pure cost.
    /// </remarks>
    private static (IReadOnlyList<WidgetIdentity.StockWidget> Set, bool Complete) StockWidgets()
    {
        if (_stockWidgets is { } cached)
            return (cached, true);
        var list = new List<WidgetIdentity.StockWidget>();
        try
        {
            foreach (var dir in Directory.GetDirectories(AppPaths.StockWidgetsDir))
            {
                if (!File.Exists(Path.Combine(dir, "manifest.json")))
                    continue;   // not a widget folder at all; nothing to be incomplete about
                // ManifestIdOf answers null for BOTH "no manifest" and "could not read it",
                // and only the second is a failed scan. Skipping it silently is how an
                // update replacing one file mid-scan pinned a stock widget as non-existent
                // for the process lifetime — the outer catch never saw it, so the truncated
                // list looked complete and was cached.
                if (ManifestIdOf(dir) is not { Length: > 0 } id)
                    throw new IOException($"shipped manifest for '{Path.GetFileName(dir)}' could not be read");
                list.Add(new WidgetIdentity.StockWidget(Path.GetFileName(dir), id, Fingerprint(dir)));
            }
            // A stale shipped copy from an overwrite upgrade authorizes nobody.
            list = WidgetIdentity.Shipped(list, RetiredStockNames).ToList();
        }
        catch (Exception ex)
        {
            // An incomplete list refuses reserved ids, including the stock widgets' own —
            // the safe direction, and a loud one. But it is NOT cached: an updater holding
            // a file for a moment would otherwise pin "these widgets do not exist" for the
            // lifetime of the process, and every later rescan would return the bad answer
            // instantly without ever looking again. Only a complete scan is worth keeping.
            Log.Error($"Could not read the shipped stock widgets ({ex.Message}) — " +
                      "reserved widget ids will be refused until a later scan succeeds");
            return (WidgetIdentity.Shipped(list, RetiredStockNames), false);
        }
        _stockWidgets = list;
        return (list, true);
    }

    private static IReadOnlyList<WidgetIdentity.StockWidget>? _stockWidgets;

    /// <summary>Where a widget is actually SERVED from.</summary>
    /// <remarks>
    /// For a stock widget: the shipped folder next to the exe, never the seeded copy in the
    /// writable widgets directory — even though the fingerprint check just proved the two
    /// are byte-identical. That check is a moment in time and the mapping is continuous: a
    /// virtual host serves whatever is in its folder RIGHT NOW, watcher events are debounced
    /// 800 ms, and in that window another widget can iframe the stock origin with a
    /// cache-busting query and run whatever was just written there. Validating harder cannot
    /// close a gap between the check and every subsequent read.
    ///
    /// So the origin points somewhere the install path cannot write. The fingerprint's job
    /// changes accordingly: it no longer authorizes the writable copy to be served, it
    /// establishes that the widget the user has is the widget the app ships — and then the
    /// app serves its own.
    ///
    /// Non-stock widgets keep serving from the widgets directory, because editing them there
    /// IS the documented workflow and the origin at risk is their own.
    /// </remarks>
    private static string ServeFrom(string id, string scannedFolder) =>
        WidgetIdentity.ServingFolder(id, scannedFolder, AppPaths.StockWidgetsDir);

    /// <summary>Content fingerprint of an INSTALLED folder, for comparison against the
    /// shipped one. Any failure answers null, which refuses the claim.</summary>
    private static string? InstalledFingerprint(string dir)
    {
        try { return Fingerprint(dir); }
        catch (Exception ex)
        {
            Log.Warn($"Could not fingerprint '{dir}': {ex.Message}");
            return null;
        }
    }

    private static bool MarkerMatches(string installedDir, string fingerprint)
    {
        try
        {
            var marker = Path.Combine(installedDir, SeedMarker);
            return File.Exists(marker) && File.ReadAllText(marker).Trim() == fingerprint;
        }
        catch
        {
            return false; // unreadable marker: treat as stale and re-seed
        }
    }

    /// <summary>Order-independent content hash of a widget folder: relative paths
    /// (normalized) plus file bytes. Any shipped change — html, manifest, assets —
    /// changes the fingerprint.</summary>
    private static string Fingerprint(string dir)
    {
        using var sha = SHA256.Create();
        var buffer = new byte[81920];
        foreach (var file in Directory.GetFiles(dir, "*", SearchOption.AllDirectories)
                     .Where(f => !string.Equals(Path.GetFileName(f), SeedMarker, StringComparison.OrdinalIgnoreCase))
                     .OrderBy(f => Path.GetRelativePath(dir, f).Replace('\\', '/'), StringComparer.Ordinal))
        {
            var rel = Encoding.UTF8.GetBytes(Path.GetRelativePath(dir, file).Replace('\\', '/') + "\n");
            sha.TransformBlock(rel, 0, rel.Length, null, 0);
            // STREAMED, not ReadAllBytes. This now hashes folders nobody has vouched for —
            // a hand-dropped folder claiming a stock id is fingerprinted in order to be
            // refused — so the size of a file here is a number an attacker picks. Reading
            // one whole into memory made a large, highly compressible asset into a large
            // allocation on startup and on every watcher rescan. A fixed buffer costs the
            // same whatever the file claims to be.
            using var stream = File.OpenRead(file);
            int read;
            while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
                sha.TransformBlock(buffer, 0, read, null, 0);
        }
        sha.TransformFinalBlock([], 0, 0);
        return Convert.ToHexString(sha.Hash!);
    }

    /// <summary>Serializes the whole read-map / assign / publish / save transaction.</summary>
    /// <remarks>
    /// There are now two independent timers that call Rescan — the watcher debounce and the
    /// host-map retry — plus the install path and startup. Two of them running at once each
    /// read the same persisted map, compute assignments from a DIFFERENT set of installed
    /// widgets, and then write their own whole-map copy; the later write silently drops an
    /// assignment the other scan had already published in Widgets. That origin is then
    /// recorded nowhere, and the next slug-colliding package is free to take it along with
    /// whatever storage it still holds. Load-and-save is only safe as one indivisible step.
    /// </remarks>
    private readonly object _scanGate = new();

    public void Rescan()
    {
        lock (_scanGate)
            RescanCore();
    }

    private void RescanCore()
    {
        // Pass 1: parse every candidate folder and resolve same-id duplicates
        // (decided by the EXACT manifest id — never by the slugged host, where
        // distinct ids can collide and version-resolving across the collision
        // silently uninstalled a different widget).
        var resolved = new List<(WidgetManifest Manifest, string Folder)>();
        var rejected = new List<RejectedWidget>();
        foreach (var folder in Directory.GetDirectories(AppPaths.WidgetsDir))
        {
            var manifestPath = Path.Combine(folder, "manifest.json");
            var indexPath = Path.Combine(folder, "index.html");
            if (!File.Exists(manifestPath) || !File.Exists(indexPath))
                continue;

            try
            {
                var manifest = JsonSerializer.Deserialize<WidgetManifest>(File.ReadAllText(manifestPath));
                if (manifest is null)
                {
                    Log.Warn($"Skipping widget in '{folder}': unparseable manifest");
                    continue;
                }
                if (!manifest.IsValid(out var error))
                {
                    Log.Warn($"Skipping widget in '{folder}': {error}");
                    continue;
                }

                // iCUE-style widgets declare settings in index.html meta tags, not the manifest.
                if (manifest.Properties.Count == 0)
                    manifest.Properties = IcueManifestReader.ParseProperties(indexPath);

                // AFTER the iCUE parse, not before: at IsValid time an iCUE widget has no
                // properties at all, so checking there would exempt exactly the widgets
                // least likely to have met the build-time validator (issue #57).
                if (!manifest.CredentialsAreTyped(out var credentialError))
                {
                    Log.Warn($"Refusing widget '{manifest.Id}' in '{folder}': {credentialError}");
                    // The names travel with the refusal: this manifest is about to stop
                    // existing as far as the rest of the app is concerned, and it is the
                    // only thing that knows which of the slot's settings are credentials.
                    rejected.Add(new RejectedWidget(manifest.Id, manifest.Name, folder, credentialError,
                        manifest.CredentialPropertyNames()));
                    continue;
                }

                // The reserved id namespace, checked against what the app SHIPS rather
                // than against anything on the writable side of the disk (#94). A package
                // claiming a stock id would otherwise be served from the stock widget's
                // own virtual host — same origin, same localStorage, same tokens.
                if (!WidgetIdentity.MayClaim(manifest.Id, Path.GetFileName(folder),
                        () => InstalledFingerprint(folder), StockWidgets().Set))
                {
                    Log.Warn($"Refusing widget in '{folder}': '{manifest.Id}' is a reserved stock id, " +
                             "and this is not the folder the app seeds it into");
                    rejected.Add(new RejectedWidget(manifest.Id, manifest.Name, folder,
                        $"'{manifest.Id}' is reserved for a widget the app ships. A package cannot claim it.",
                        manifest.CredentialPropertyNames()));
                    continue;
                }

                resolved.Add((manifest, folder));
            }
            catch (Exception ex)
            {
                Log.Warn($"Skipping widget in '{folder}': {ex.Message}");
            }
        }

        // Pass 1b: an id claimed by more than one folder is served from NONE of them.
        //
        // There used to be a tiebreak here, and every version of it was a way to take
        // another widget's origin. Version let the challenger pick the winning number.
        // Preferring the folder the installer writes was better and still wrong: dropping
        // a folder into the widgets directory is a documented install path, so anyone who
        // can get an archive unzipped can create `com-example-cpu/`, claim the id of a
        // widget living under any other name, and inherit its persisted host — and with it
        // the localStorage and credentials scoped to that origin. Refusing the install path
        // (#94 round 4) left this one wide open, because a folder drop never goes near it.
        //
        // There is nothing on disk that says which folder is the rightful owner. So the
        // question is not answered — it is declined. Both copies are refused, both are
        // named, and the user deletes the one they did not put there. An attacker who can
        // write to the widgets folder can already delete a widget outright, so failing
        // closed costs an availability the user never had, and buys back the only thing
        // that mattered: the origin does not move.
        var ambiguous = WidgetIdentity.AmbiguousIds(
            resolved.Select(r => (r.Manifest.Id, Path.GetFileName(r.Folder))));
        if (ambiguous.Count > 0)
        {
            foreach (var (manifest, folder) in resolved.Where(r => ambiguous.Contains(r.Manifest.Id)))
            {
                var others = resolved
                    .Where(o => o.Manifest.Id == manifest.Id && !ReferenceEquals(o.Folder, folder))
                    .Select(o => $"'{Path.GetFileName(o.Folder)}'");
                Log.Warn($"Refusing widget id '{manifest.Id}': claimed by more than one folder " +
                         $"('{Path.GetFileName(folder)}' and {string.Join(", ", others)}) — " +
                         "delete the one you did not install, then reload");
                rejected.Add(new RejectedWidget(manifest.Id, manifest.Name, folder,
                    $"'{manifest.Id}' is claimed by more than one widget folder, so none of them is " +
                    "served — the id decides which stored data a widget can read. Delete the copy " +
                    "you did not install.",
                    manifest.CredentialPropertyNames()));
            }
            resolved.RemoveAll(r => ambiguous.Contains(r.Manifest.Id));
        }

        // Pass 2: assign hosts from a PERSISTED id → host map, so an id keeps the
        // same host forever — even across installs/uninstalls of a slug-colliding
        // widget. Deciding from the currently-installed set alone let the clean
        // host swap owners between runs (install a collider, restart, uninstall
        // it, restart: the suffixed widget silently adopted the clean origin and
        // its predecessor's localStorage/credentials). Once a host is in the map
        // it is reserved for that id permanently and never reused for another.
        // Layouts reference widgets by id, never by host, so suffixes are transparent.
        var (hostMap, trustworthy) = LoadHostMap();
        var assigned = WidgetIdentity.AssignHosts(resolved.Select(r => r.Manifest.Id), hostMap);
        foreach (var (id, host) in assigned)
        {
            if (id.StartsWith(WidgetIdentity.ReservationPrefix, StringComparison.Ordinal))
            {
                hostMap[id] = host;   // a reservation: an origin nobody is served from
                continue;
            }
            if (!string.Equals(host, WidgetIdentity.Slug(id) + WidgetIdentity.HostSuffix, StringComparison.Ordinal))
                Log.Warn($"Widget id '{id}' shares its host slug with another widget — serving it from '{host}'");
            hostMap[id] = host;
        }

        // A map this process could not read is not a map with nothing in it. Minting from
        // an empty one and SERVING the result is how a newly installed widget ends up on
        // the clean origin of an owner that is merely uninstalled, reading storage the
        // browser still holds for it — the file being briefly locked is not consent to
        // reassign anyone's origin. Not saving was only half the answer: nothing may be
        // served either. A rescan retries, and the read above already retried three times.
        if (!trustworthy && assigned.Count > 0)
        {
            Log.Error($"Refusing to serve {assigned.Count} widget(s) whose origin would be minted without the " +
                      "host map — the assignment cannot be checked against origins that already have an owner. " +
                      "Widgets already in the map are unaffected; retrying shortly.");
            // And actually retry. Nothing else would: Initialize scans BEFORE the watcher
            // exists, and the watcher only ever fires for the widgets directory, while the
            // file that could not be read lives elsewhere. Without this, a lock lasting a
            // second at startup withheld those widgets for the entire process lifetime,
            // under a log line promising it would clear.
            ScheduleHostMapRetry();
        }
        var widgets = resolved
            .Where(r => WidgetIdentity.MayServe(r.Manifest.Id, assigned, trustworthy))
            .Select(r => new InstalledWidget(r.Manifest, ServeFrom(r.Manifest.Id, r.Folder), hostMap[r.Manifest.Id]))
            .ToList();
        // Only when the map that was read really is the whole record. Writing a map built
        // on top of one this process could not read would erase the assignments it could
        // not see, and those are exactly the origins that already have an owner.
        if (trustworthy)
            _hostMapRetryDelay = InitialHostMapRetryMs;
        if (assigned.Count > 0 && trustworthy)
            SaveHostMap(hostMap);

        Widgets = widgets.OrderBy(w => w.Manifest.Name, StringComparer.OrdinalIgnoreCase).ToList();

        // Drop rejections for ids that ended up loading anyway. Refusals are recorded
        // during the scan, before duplicate resolution, so a stale copy of a widget that
        // violates the rule would otherwise report "not loaded — unavailable" while the
        // good copy of the same id sits in the palette working fine.
        //
        // ORDINAL, matching the duplicate resolution above: ids differing only in case are
        // two distinct widgets to that check, so a rejected "Foo" really is unavailable
        // even while "foo" works.
        //
        // KNOWN GAP (#67): dropping the record also drops its RedactNames, so a layout
        // holding the refused copy's credential under a key the LOADED copy does not
        // declare goes unmasked. Retaining shadowed rejections to fix that was tried in
        // PR #65 and reverted — one snapshot entry cannot represent two different widgets,
        // and every rule for merging them was wrong in some direction. The fix belongs
        // with per-(slot, key) redaction metadata, not with manifests.
        var loadedIds = new HashSet<string>(widgets.Select(w => w.Manifest.Id), StringComparer.Ordinal);
        Rejected = rejected.Where(r => !loadedIds.Contains(r.Id)).ToList();
        Log.Info($"Widget library: {Widgets.Count} widget(s) installed"
               + (Rejected.Count > 0 ? $", {Rejected.Count} refused" : ""));
    }

    /// <summary>Installs a .wswidget package (a zip containing manifest.json + index.html at its root).</summary>
    public InstallResult InstallPackage(string packagePath)
    {
        using var archive = ZipFile.OpenRead(packagePath);

        var manifestEntry = archive.GetEntry("manifest.json")
            ?? throw new InvalidDataException("Package has no manifest.json at its root.");
        using var manifestStream = manifestEntry.Open();
        var manifest = JsonSerializer.Deserialize<WidgetManifest>(manifestStream)
            ?? throw new InvalidDataException("manifest.json could not be parsed.");
        if (!manifest.IsValid(out var error))
            throw new InvalidDataException(error);
        if (archive.GetEntry("index.html") is null)
            throw new InvalidDataException("Package has no index.html at its root.");

        // Refuse everywhere, the same rule the plaintext-credential guard follows: Rescan
        // will not serve a reserved id from a folder the seeder did not write, and install
        // never produces such a folder, so a package claiming one can only ever be refused
        // later. Saying so here means the user hears it from the install they just ran
        // instead of finding a widget missing (#94).
        if (WidgetIdentity.IsReserved(manifest.Id))
            throw new InvalidDataException(
                $"Refusing to install '{manifest.Name}': '{manifest.Id}' is in the '{WidgetIdentity.ReservedPrefix}' " +
                "namespace, which is reserved for widgets the app ships. Give the widget its own id.");

        var installFolder = WidgetIdentity.InstallFolderName(manifest.Id);

        // ...and refuse to land ON a stock widget's folder. A package whose id merely
        // SLUGS to a stock folder name ("hue") is not claiming a reserved id, but its
        // target directory is the seeded copy, which the swap below would move aside and
        // then delete. That is a stock widget destroyed by an install, restored only by
        // the next launch's re-seed.
        var (shipped, shippedComplete) = StockWidgets();
        // Fail CLOSED on an incomplete shipped set. A partial list is missing names, and a
        // missing name is one this guard would wave through — the install would then land
        // on a seeded stock folder and delete it on success, displacing that widget until
        // the next re-seed. "We could not read the list" is not "the list does not contain
        // it".
        if (!shippedComplete)
            throw new InvalidDataException(
                "Refusing to install: the widgets shipped with the app could not be read just now, " +
                "so it cannot be checked whether this package would displace one. Try again.");
        if (shipped.Any(w => string.Equals(w.FolderName, installFolder, StringComparison.OrdinalIgnoreCase)))
            throw new InvalidDataException(
                $"Refusing to install '{manifest.Name}': its id would occupy the folder of the stock " +
                $"widget '{installFolder}'. Give the widget an id that does not collide.");

        // ---- J1: the canonical folder is where the INSTALLER writes, not proof of who
        // owns the id. A widget installed by direct folder drop lives under whatever name
        // the user chose; a package declaring the same id lands in the canonical folder and
        // would win the duplicate tiebreak on provenance alone — inheriting the persisted
        // virtual host, and with it the original widget's origin-scoped storage. Upgrading
        // in place (same id, canonical folder) is untouched; taking an id that lives
        // somewhere else is refused, and named, so the user can remove one deliberately.
        var incumbent = WidgetIdentity.WouldStealId(
                manifest.Id, Widgets.Select(w => (w.Manifest.Id, Path.GetFileName(w.Folder))))
            ? Widgets.First(w => string.Equals(w.Manifest.Id, manifest.Id, StringComparison.Ordinal))
            : null;
        if (incumbent is not null)
            throw new InvalidDataException(
                $"Refusing to install '{manifest.Name}': the id '{manifest.Id}' already belongs to the " +
                $"widget in '{Path.GetFileName(incumbent.Folder)}'. Installing here would hand this package " +
                "that widget's stored data. Remove the other copy first if you meant to replace it.");

        var targetDir = Path.Combine(AppPaths.WidgetsDir, installFolder);

        // Stage into a sibling temp folder and validate THERE before touching what is
        // already installed. The old order deleted the target first, so a package that
        // failed any check afterwards took the working widget with it — and adding the
        // credential refusal below makes failing a great deal more likely (issue #57).
        // Staged in DataDir, NOT inside WidgetsDir: the FileSystemWatcher watches the
        // widgets folder, so a staging copy there would be picked up as a real widget by
        // any rescan that fired mid-install. Same volume, so the Move below stays atomic.
        var stageDir = Path.Combine(AppPaths.DataDir, ".installing-" + Slug(manifest.Id));
        var backupDir = Path.Combine(AppPaths.DataDir, ".replacing-" + Slug(manifest.Id));
        var swapped = false;   // is SOMETHING installed at targetDir? gates deleting the backup
        if (Directory.Exists(stageDir))
            DeleteTree(stageDir);
        try
        {
            // ExtractToDirectory guards against zip-slip path traversal.
            archive.ExtractToDirectory(stageDir);

            // iCUE-style packages declare their settings in index.html, so the property
            // list only exists once the archive is on disk — which is why this check
            // lives here rather than beside IsValid above.
            if (manifest.Properties.Count == 0)
                manifest.Properties = IcueManifestReader.ParseProperties(Path.Combine(stageDir, "index.html"));
            if (!manifest.CredentialsAreTyped(out var credentialError))
                throw new InvalidDataException(
                    $"Refusing to install '{manifest.Name}': {credentialError}");

            // Move the old copy ASIDE rather than deleting it, so the swap is reversible.
            // Deleting first and then moving leaves nothing installed if the move fails —
            // and it can, transiently: antivirus or an open handle on the staged folder is
            // enough. Losing a working widget to a failed UPGRADE is worse than the failed
            // upgrade itself.
            // A backup already sitting here means a PREVIOUS attempt failed its move AND
            // its rollback, so this folder is the only surviving copy of the user's
            // widget. Deleting it to make room — which is what this used to do — turns a
            // recoverable failure into a permanent one on the retry, and the retry is
            // exactly what someone does next. Recover it instead.
            if (Directory.Exists(backupDir) && !Directory.Exists(targetDir))
            {
                Log.Warn($"Recovering '{manifest.Id}' from a previous failed install at '{backupDir}'");
                Directory.Move(backupDir, targetDir);
            }
            else if (Directory.Exists(backupDir))
            {
                // Both present: the target is installed and working, so the backup is a
                // stale leftover with nothing to protect.
                DeleteTree(backupDir);
            }

            var hadPrevious = Directory.Exists(targetDir);
            if (hadPrevious)
                Directory.Move(targetDir, backupDir);
            try
            {
                Directory.Move(stageDir, targetDir);
                swapped = true;
            }
            catch
            {
                if (hadPrevious && !Directory.Exists(targetDir))
                {
                    try
                    {
                        Directory.Move(backupDir, targetDir);   // put the working copy back
                        swapped = true;                         // the old copy is home again
                    }
                    catch (Exception restoreEx)
                    {
                        // Rollback failed too. The backup is now the ONLY copy of a widget
                        // the user had working, so it must survive — `swapped` stays false
                        // and the finally below leaves it alone. Name the path: recovery is
                        // a manual folder rename, and nobody can do that without it.
                        Log.Error($"Could not restore '{manifest.Id}' after a failed install; "
                                + $"the previous copy is kept at '{backupDir}' — rename it back to "
                                + $"'{targetDir}' to recover it ({restoreEx.Message})");
                    }
                }
                throw;
            }
        }
        finally
        {
            // A refused or half-extracted package must not leave a staging folder behind
            // for the next Rescan to trip over.
            if (Directory.Exists(stageDir))
                DeleteTree(stageDir);
            // The backup goes ONLY once something is definitely installed at the target —
            // either the new copy or the restored old one. Deleting it unconditionally
            // meant a failed move followed by a failed restore destroyed the last copy,
            // which is the very outcome the backup exists to prevent.
            if (swapped && Directory.Exists(backupDir))
                DeleteTree(backupDir);
        }
        Log.Info($"Installed widget '{manifest.Id}' v{manifest.Version} from {Path.GetFileName(packagePath)}");

        Rescan();
        // FirstOrDefault, not First. The scan legitimately withholds a widget whose origin
        // would have to be minted without the host map, and the package is on disk either
        // way — reporting "could not install" for something that is installed, and that a
        // retry will surface in seconds, describes the wrong problem to the user.
        var served = Widgets.FirstOrDefault(w => w.Manifest.Id == manifest.Id);
        return new InstallResult(manifest, served);
    }

    /// <summary>Lowercases the widget id into a hostname-safe label ("com.example.CPU" -> "com-example-cpu").</summary>
    /// <remarks>Lives in <see cref="WidgetIdentity"/> now, with the rest of the rules
    /// about who may be whom. Kept here so a caller reading the library does not have to
    /// know that, and so this stays ONE function — two slug implementations that drifted
    /// would mean the folder an install writes and the folder a scan expects stop being
    /// the same folder.</remarks>
    public static string Slug(string id) => WidgetIdentity.Slug(id);

    private static void CopyDirectory(string source, string target)
    {
        Directory.CreateDirectory(target);
        foreach (var file in Directory.GetFiles(source, "*", SearchOption.AllDirectories))
        {
            var destination = Path.Combine(target, Path.GetRelativePath(source, file));
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            File.Copy(file, destination);
        }
    }

    public void Dispose()
    {
        _watcher?.Dispose();
        _debounce?.Dispose();
        _hostMapRetry?.Dispose();
    }
}
