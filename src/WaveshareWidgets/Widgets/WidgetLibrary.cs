using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
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

                var host = $"{Slug(manifest.Id)}.widgets.wsw";
                var duplicate = widgets.FindIndex(w => w.VirtualHost == host);
                if (duplicate >= 0)
                {
                    // Same id in two folders (e.g. a stale package install alongside the
                    // seeded stock copy). First-alphabetical used to win silently, which
                    // could pin a months-old copy in front of every fresh re-seed — the
                    // HIGHER manifest version wins now, and the loser is named.
                    var kept = widgets[duplicate];
                    var keepNew = Version.TryParse(manifest.Version, out var nv) &&
                                  (!Version.TryParse(kept.Manifest.Version, out var kv) || nv > kv);
                    Log.Warn($"Duplicate widget id '{manifest.Id}': keeping " +
                             $"'{(keepNew ? folder : kept.Folder)}' (v{(keepNew ? manifest.Version : kept.Manifest.Version)}), " +
                             $"shadowing '{(keepNew ? kept.Folder : folder)}' — delete one to silence this");
                    if (keepNew)
                        widgets[duplicate] = new InstalledWidget(manifest, folder, host);
                    continue;
                }
                usedHosts.Add(host);
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
