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
/// settings window reads this list so the reason is visible where the widget isn't.</summary>
public sealed record RejectedWidget(string Id, string Name, string Folder, string Reason);

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
        var retiredNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "fans" };
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

    /// <summary>Short stable discriminator for host-slug collisions between distinct ids.</summary>
    private static string ShortHash(string value)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        return Convert.ToHexString(bytes, 0, 4).ToLowerInvariant();
    }

    /// <summary>Persisted widget-id → virtual-host assignments. Hosts are browser
    /// origins (localStorage, credentials), so an entry is written once and kept
    /// forever — an unreadable file starts a fresh map rather than crashing scan.</summary>
    private static Dictionary<string, string> LoadHostMap()
    {
        try
        {
            if (File.Exists(AppPaths.HostMapFile))
                return JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(AppPaths.HostMapFile))
                       ?? new Dictionary<string, string>();
        }
        catch (Exception ex)
        {
            Log.Warn($"Could not read widget host map: {ex.Message} — starting a new one");
        }
        return new Dictionary<string, string>();
    }

    private static void SaveHostMap(Dictionary<string, string> map)
    {
        try
        {
            DurableStore.Write(AppPaths.HostMapFile,
                JsonSerializer.Serialize(map, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch (Exception ex)
        {
            Log.Warn($"Could not save widget host map: {ex.Message}");
        }
    }

    private static bool IsDigits(string s)
    {
        if (s.Length == 0)
            return false;
        foreach (var c in s)
        {
            if (c is < '0' or > '9')
                return false;
        }
        return true;
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
        foreach (var file in Directory.GetFiles(dir, "*", SearchOption.AllDirectories)
                     .OrderBy(f => Path.GetRelativePath(dir, f).Replace('\\', '/'), StringComparer.Ordinal))
        {
            var rel = Encoding.UTF8.GetBytes(Path.GetRelativePath(dir, file).Replace('\\', '/') + "\n");
            sha.TransformBlock(rel, 0, rel.Length, null, 0);
            var content = File.ReadAllBytes(file);
            sha.TransformBlock(content, 0, content.Length, null, 0);
        }
        sha.TransformFinalBlock([], 0, 0);
        return Convert.ToHexString(sha.Hash!);
    }

    public void Rescan()
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
                    rejected.Add(new RejectedWidget(manifest.Id, manifest.Name, folder, credentialError));
                    continue;
                }

                var duplicate = resolved.FindIndex(w => w.Manifest.Id == manifest.Id);
                if (duplicate >= 0)
                {
                    // Same id in two folders (e.g. a stale package install alongside the
                    // seeded stock copy). First-alphabetical used to win silently, which
                    // could pin a months-old copy in front of every fresh re-seed — the
                    // HIGHER manifest version wins now, and the loser is named.
                    var kept = resolved[duplicate];
                    var keepNew = CompareManifestVersions(manifest.Version, kept.Manifest.Version) > 0;
                    Log.Warn($"Duplicate widget id '{manifest.Id}': keeping " +
                             $"'{(keepNew ? folder : kept.Folder)}' (v{(keepNew ? manifest.Version : kept.Manifest.Version)}), " +
                             $"shadowing '{(keepNew ? kept.Folder : folder)}' — delete one to silence this");
                    if (keepNew)
                        resolved[duplicate] = (manifest, folder);
                    continue;
                }
                resolved.Add((manifest, folder));
            }
            catch (Exception ex)
            {
                Log.Warn($"Skipping widget in '{folder}': {ex.Message}");
            }
        }

        // Pass 2: assign hosts from a PERSISTED id → host map, so an id keeps the
        // same host forever — even across installs/uninstalls of a slug-colliding
        // widget. Deciding from the currently-installed set alone let the clean
        // host swap owners between runs (install a collider, restart, uninstall
        // it, restart: the suffixed widget silently adopted the clean origin and
        // its predecessor's localStorage/credentials). Once a host is in the map
        // it is reserved for that id permanently and never reused for another.
        // Layouts reference widgets by id, never by host, so suffixes are transparent.
        var hostMap = LoadHostMap();
        var mapChanged = false;
        var usedHosts = new HashSet<string>(hostMap.Values, StringComparer.OrdinalIgnoreCase);
        var widgets = new List<InstalledWidget>();
        foreach (var (manifest, folder) in resolved)
        {
            if (!hostMap.TryGetValue(manifest.Id, out var host))
            {
                var slug = Slug(manifest.Id);
                host = $"{slug}.widgets.wsw";
                if (!usedHosts.Add(host))
                {
                    host = $"{slug}-{ShortHash(manifest.Id)}.widgets.wsw";
                    var bump = 2;
                    while (!usedHosts.Add(host))
                        host = $"{slug}-{ShortHash(manifest.Id)}{bump++}.widgets.wsw";
                    Log.Warn($"Widget id '{manifest.Id}' shares its host slug with a previously seen widget — serving it from '{host}'");
                }
                hostMap[manifest.Id] = host;
                mapChanged = true;
            }
            widgets.Add(new InstalledWidget(manifest, folder, host));
        }
        if (mapChanged)
            SaveHostMap(hostMap);

        Widgets = widgets.OrderBy(w => w.Manifest.Name, StringComparer.OrdinalIgnoreCase).ToList();

        // Drop rejections for ids that ended up loading anyway. Refusals are recorded
        // during the scan, before duplicate resolution, so a stale copy of a widget that
        // violates the rule would otherwise report "not loaded — unavailable" while the
        // good copy of the same id sits in the palette working fine. The log line stays
        // (that folder IS being refused); only the user-facing claim is withdrawn.
        // ORDINAL, matching the duplicate resolution above (`w.Manifest.Id == manifest.Id`).
        // Ids differing only in case are two distinct widgets to that check, so both load —
        // meaning a rejected "Foo" really is unavailable even while "foo" works, and
        // suppressing its warning would leave a layout referencing "Foo" with an
        // unexplained empty tile. The suppression must use the same notion of identity
        // that decided what loaded, or it answers a different question than it asks.
        var loadedIds = new HashSet<string>(widgets.Select(w => w.Manifest.Id), StringComparer.Ordinal);
        Rejected = rejected.Where(r => !loadedIds.Contains(r.Id)).ToList();
        Log.Info($"Widget library: {Widgets.Count} widget(s) installed"
               + (Rejected.Count > 0 ? $", {Rejected.Count} refused" : ""));
    }

    /// <summary>Compares SemVer-ish manifest versions ("1.2.3", "2.0.0-beta.1",
    /// "2.0.0+build.7"). Every numeric identifier — core parts AND prerelease
    /// numerics — compares as an arbitrary-precision digit string, so nothing is
    /// bounded by Int32/Int64 the way <see cref="Version"/> or an integer parse
    /// would be. Equal cores rank a release above any prerelease. Unparseable
    /// cores (non-digit parts) rank lowest; two unparseables tie (the first copy
    /// found keeps its spot).</summary>
    private static int CompareManifestVersions(string? a, string? b)
    {
        var (coreA, preA, okA) = SplitSemVer(a);
        var (coreB, preB, okB) = SplitSemVer(b);
        if (okA != okB)
            return okA ? 1 : -1;
        if (!okA)
            return 0;
        for (var i = 0; i < Math.Max(coreA.Length, coreB.Length); i++)
        {
            var cmp = CompareDigitStrings(
                i < coreA.Length ? coreA[i] : "0",
                i < coreB.Length ? coreB[i] : "0");
            if (cmp != 0)
                return cmp;
        }
        var releaseA = preA.Length == 0;
        var releaseB = preB.Length == 0;
        if (releaseA != releaseB)
            return releaseA ? 1 : -1;
        return ComparePrerelease(preA, preB);
    }

    /// <summary>Numeric compare of two all-digit strings with no magnitude bound:
    /// trim leading zeros, shorter ranks lower, equal lengths compare digit-wise.</summary>
    private static int CompareDigitStrings(string a, string b)
    {
        var trimmedA = a.TrimStart('0');
        var trimmedB = b.TrimStart('0');
        return trimmedA.Length != trimmedB.Length
            ? trimmedA.Length.CompareTo(trimmedB.Length)
            : string.CompareOrdinal(trimmedA, trimmedB);
    }

    /// <summary>SemVer §11 prerelease comparison: dot-separated identifiers compare
    /// pairwise — numeric ones numerically (and below any alphanumeric identifier),
    /// alphanumeric ones ordinally; when one list prefixes the other, the shorter
    /// ranks lower. So "beta.2" &lt; "beta.10" &lt; "beta.10.x" (a plain ordinal
    /// compare would have put beta.2 above beta.10).</summary>
    private static int ComparePrerelease(string a, string b)
    {
        var idsA = a.Split('.');
        var idsB = b.Split('.');
        for (var i = 0; i < Math.Max(idsA.Length, idsB.Length); i++)
        {
            if (i >= idsA.Length)
                return -1;
            if (i >= idsB.Length)
                return 1;
            // Numeric identifiers compare as arbitrary-precision numbers (SemVer puts
            // no 64-bit bound on them): all-digit strings compare by trimmed length,
            // then digit-by-digit — no integer parse to overflow.
            var isNumA = IsDigits(idsA[i]);
            var isNumB = IsDigits(idsB[i]);
            int cmp;
            if (isNumA && isNumB)
            {
                cmp = CompareDigitStrings(idsA[i], idsB[i]);
            }
            else if (isNumA != isNumB)
            {
                cmp = isNumA ? -1 : 1;
            }
            else
            {
                cmp = string.CompareOrdinal(idsA[i], idsB[i]);
            }
            if (cmp != 0)
                return cmp;
        }
        return 0;
    }

    private static (string[] Core, string Prerelease, bool Ok) SplitSemVer(string? version)
    {
        var v = (version ?? "").Trim();
        var plus = v.IndexOf('+');
        if (plus >= 0)
            v = v[..plus]; // build metadata never affects precedence
        var dash = v.IndexOf('-');
        var prerelease = dash >= 0 ? v[(dash + 1)..] : "";
        var core = dash >= 0 ? v[..dash] : v;
        var parts = core.Split('.');
        // Core parts stay digit STRINGS (compared arbitrary-precision) — parsing
        // them into Version/int would cap valid SemVer numerics at Int32.
        var ok = core.Length > 0;
        foreach (var part in parts)
        {
            if (!IsDigits(part))
            {
                ok = false;
                break;
            }
        }
        return (parts, prerelease, ok);
    }

    /// <summary>Installs a .wswidget package (a zip containing manifest.json + index.html at its root).</summary>
    public InstalledWidget InstallPackage(string packagePath)
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

        var targetDir = Path.Combine(AppPaths.WidgetsDir, Slug(manifest.Id));

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
            Directory.Delete(stageDir, recursive: true);
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
            if (Directory.Exists(backupDir))
                Directory.Delete(backupDir, recursive: true);
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
                Directory.Delete(stageDir, recursive: true);
            // The backup goes ONLY once something is definitely installed at the target —
            // either the new copy or the restored old one. Deleting it unconditionally
            // meant a failed move followed by a failed restore destroyed the last copy,
            // which is the very outcome the backup exists to prevent.
            if (swapped && Directory.Exists(backupDir))
                Directory.Delete(backupDir, recursive: true);
        }
        Log.Info($"Installed widget '{manifest.Id}' v{manifest.Version} from {Path.GetFileName(packagePath)}");

        Rescan();
        return Widgets.First(w => w.Manifest.Id == manifest.Id);
    }

    /// <summary>Lowercases the widget id into a hostname-safe label ("com.example.CPU" -> "com-example-cpu").</summary>
    public static string Slug(string id)
    {
        var slug = SlugPattern().Replace(id.ToLowerInvariant(), "-").Trim('-');
        return slug.Length == 0 ? "widget" : slug;
    }

    [GeneratedRegex("[^a-z0-9-]+")]
    private static partial Regex SlugPattern();

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
    }
}
