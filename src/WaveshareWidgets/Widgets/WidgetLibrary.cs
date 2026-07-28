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
        if (!Directory.Exists(AppPaths.StockWidgetsDir))
        {
            Log.Warn($"Stock widgets folder missing next to the app ({AppPaths.StockWidgetsDir}) — nothing to seed");
            return;
        }

        int seeded = 0, current = 0;
        var failed = new List<string>();
        foreach (var sourceDir in Directory.GetDirectories(AppPaths.StockWidgetsDir))
        {
            var name = Path.GetFileName(sourceDir);
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
        var widgets = new List<InstalledWidget>();
        var usedHosts = new HashSet<string>();

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

                // Duplicates are decided by the EXACT manifest id — never by the slugged
                // host, where distinct ids can collide ("com.example.foo-bar" and
                // "com.example.foo.bar" both slug to "com-example-foo-bar"); version-
                // resolving across that collision silently uninstalled a different widget.
                var duplicate = widgets.FindIndex(w => w.Manifest.Id == manifest.Id);
                if (duplicate >= 0)
                {
                    // Same id in two folders (e.g. a stale package install alongside the
                    // seeded stock copy). First-alphabetical used to win silently, which
                    // could pin a months-old copy in front of every fresh re-seed — the
                    // HIGHER manifest version wins now, and the loser is named.
                    var kept = widgets[duplicate];
                    var keepNew = CompareManifestVersions(manifest.Version, kept.Manifest.Version) > 0;
                    Log.Warn($"Duplicate widget id '{manifest.Id}': keeping " +
                             $"'{(keepNew ? folder : kept.Folder)}' (v{(keepNew ? manifest.Version : kept.Manifest.Version)}), " +
                             $"shadowing '{(keepNew ? kept.Folder : folder)}' — delete one to silence this");
                    if (keepNew)
                        widgets[duplicate] = new InstalledWidget(manifest, folder, kept.VirtualHost);
                    continue;
                }

                var host = $"{Slug(manifest.Id)}.widgets.wsw";
                if (!usedHosts.Add(host))
                {
                    // A DIFFERENT id that happens to slug to an occupied host: both widgets
                    // stay installed — this one gets a deterministic hash-suffixed host
                    // (layouts reference widgets by id, never by host, so it's transparent).
                    host = $"{Slug(manifest.Id)}-{ShortHash(manifest.Id)}.widgets.wsw";
                    var bump = 2;
                    while (!usedHosts.Add(host))
                        host = $"{Slug(manifest.Id)}-{ShortHash(manifest.Id)}{bump++}.widgets.wsw";
                    Log.Warn($"Widget id '{manifest.Id}' slugs to a host another widget already " +
                             $"uses — serving it from '{host}' instead");
                }
                widgets.Add(new InstalledWidget(manifest, folder, host));
            }
            catch (Exception ex)
            {
                Log.Warn($"Skipping widget in '{folder}': {ex.Message}");
            }
        }

        Widgets = widgets.OrderBy(w => w.Manifest.Name, StringComparer.OrdinalIgnoreCase).ToList();
        Log.Info($"Widget library: {Widgets.Count} widget(s) installed");
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
        if (Directory.Exists(targetDir))
            Directory.Delete(targetDir, recursive: true);

        // ExtractToDirectory guards against zip-slip path traversal.
        archive.ExtractToDirectory(targetDir);
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
