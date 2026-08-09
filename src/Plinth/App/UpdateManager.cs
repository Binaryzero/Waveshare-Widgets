using System.IO.Compression;
using System.Reflection;
using System.Text.Json;

namespace Plinth.App;

/// <summary>
/// One-click update from this repository's GitHub releases, replacing the manual
/// exit → download → unzip → overwrite loop (field report: "high friction").
///
/// The shape of an update: check <c>releases/latest</c>, pick the asset matching this
/// install's flavor (framework-dependent vs self-contained, told apart by coreclr.dll
/// beside the exe), download it under the app's own data dir, validate the archive
/// fully, extract to a staging folder, then swap file by file — Windows locks a
/// running binary against WRITES but not against RENAMES, so the live file is renamed
/// aside to *.old and the new one moved into place. The relaunched instance passes
/// --wait-for so it outlives the single-instance mutex, and sweeps the *.old files.
///
/// Trust model, stated plainly: releases are not code-signed, so the only authenticity
/// this can offer is the TLS channel to api.github.com/objects.githubusercontent.com
/// and the repository being pinned by constant. Auto-checks only NOTIFY; nothing
/// downloads or installs without the user's explicit click on the tray item.
/// </summary>
public static class UpdateManager
{
    private const string Owner = "Binaryzero";
    private const string Repo = "Waveshare-Widgets";
    private const long MaxAssetBytes = 500L * 1024 * 1024;

    private static string UpdatesDir => Path.Combine(AppPaths.DataDir, "updates");

    public sealed record UpdateInfo(Version Version, string Tag, string AssetName, string AssetUrl, long Size);

    /// <summary>The running build's numeric version — the part before '+sha'. A build
    /// without a stamp (dev runs) reports 0.0.0 and thus always sees an update, which
    /// is the honest answer for a build no release ever described.</summary>
    public static Version CurrentVersion()
    {
        var info = typeof(AppVersion).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "";
        var numeric = info.Split('+')[0].Split('-')[0];
        return Version.TryParse(numeric, out var v) ? v : new Version(0, 0, 0);
    }

    /// <summary>Queries the latest release. Returns null when this build is current
    /// (or newer), when no matching asset exists, or on any network failure — the
    /// caller distinguishes "no update" from "check failed" by the thrown exception.</summary>
    public static async Task<UpdateInfo?> CheckAsync()
    {
        using var http = NewClient();
        var json = await http.GetStringAsync($"https://api.github.com/repos/{Owner}/{Repo}/releases/latest");
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        var tag = root.TryGetProperty("tag_name", out var t) ? t.GetString() ?? "" : "";
        var numeric = tag.TrimStart('v').Split('-')[0].Split('+')[0];
        if (!Version.TryParse(numeric, out var latest))
            return null;
        if (latest <= CurrentVersion())
            return null;

        // The flavor must match the install: dropping a framework-dependent build over
        // a self-contained one strands the runtime files of the old flavor in place.
        var selfContained = File.Exists(Path.Combine(AppContext.BaseDirectory, "coreclr.dll"));
        var wanted = $"Plinth-v{numeric}-win-x64{(selfContained ? "-self-contained" : "")}.zip";
        if (root.TryGetProperty("assets", out var assets) && assets.ValueKind == JsonValueKind.Array)
        {
            foreach (var asset in assets.EnumerateArray())
            {
                var name = asset.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "";
                if (!string.Equals(name, wanted, StringComparison.OrdinalIgnoreCase))
                    continue;
                var url = asset.TryGetProperty("browser_download_url", out var u) ? u.GetString() ?? "" : "";
                var size = asset.TryGetProperty("size", out var s) ? s.GetInt64() : 0;
                if (url.StartsWith("https://", StringComparison.OrdinalIgnoreCase) && size is > 0 and <= MaxAssetBytes)
                    return new UpdateInfo(latest, tag, name, url, size);
            }
        }
        Log.Warn($"Update check: release {tag} exists but has no asset named '{wanted}'");
        return null;
    }

    /// <summary>Downloads and validates the archive. Returns the zip path, staged under
    /// the app's own data dir — never a shared temp folder another account can write.</summary>
    public static async Task<string> DownloadAsync(UpdateInfo info)
    {
        Directory.CreateDirectory(UpdatesDir);
        var zipPath = Path.Combine(UpdatesDir, info.AssetName);
        using (var http = NewClient())
        await using (var body = await http.GetStreamAsync(info.AssetUrl))
        await using (var file = File.Create(zipPath))
        {
            // Capped copy: the advertised size was checked, but the CAP is enforced on
            // the bytes actually received, not on metadata the server could understate.
            var buffer = new byte[81920];
            long total = 0;
            int read;
            while ((read = await body.ReadAsync(buffer)) > 0)
            {
                total += read;
                if (total > MaxAssetBytes)
                    throw new InvalidOperationException($"update download exceeded {MaxAssetBytes} bytes");
                await file.WriteAsync(buffer.AsMemory(0, read));
            }
        }

        // Full validation BEFORE any file in the install is touched: every entry must
        // resolve inside the extraction root (zip entries carry attacker-shaped paths —
        // "..\" climbs out; the guard is on the RESOLVED path), and the archive must
        // actually contain the application, not be an error page saved as .zip.
        using var zip = ZipFile.OpenRead(zipPath);
        var sawApp = false;
        foreach (var entry in zip.Entries)
        {
            var resolved = Path.GetFullPath(Path.Combine("X:\\probe", entry.FullName.Replace('/', '\\')));
            if (!resolved.StartsWith("X:\\probe\\", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException($"archive entry escapes the extraction root: {entry.FullName}");
            if (entry.Name.Equals("Plinth.dll", StringComparison.OrdinalIgnoreCase)
                || entry.Name.Equals("Plinth.exe", StringComparison.OrdinalIgnoreCase))
                sawApp = true;
        }
        if (!sawApp)
            throw new InvalidOperationException("archive does not contain Plinth — refusing to install it");
        return zipPath;
    }

    /// <summary>Extracts to staging and swaps into the install directory. Returns the
    /// path of the exe to relaunch. Every replaced file is renamed aside as *.old-*,
    /// never deleted while possibly loaded; the next start sweeps them.</summary>
    public static string Apply(string zipPath)
    {
        var baseDir = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        var staging = Path.Combine(UpdatesDir, "staging");
        if (Directory.Exists(staging))
            Directory.Delete(staging, recursive: true);
        // ExtractToDirectory re-checks entry containment itself (.NET 8 throws on
        // traversal), a second lock on the door DownloadAsync already validated.
        ZipFile.ExtractToDirectory(zipPath, staging);

        var stamp = "old-" + Environment.ProcessId;
        foreach (var source in Directory.EnumerateFiles(staging, "*", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(staging, source);
            var target = Path.Combine(baseDir, rel);
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            if (File.Exists(target))
                File.Move(target, $"{target}.{stamp}");
            File.Move(source, target);
        }
        Directory.Delete(staging, recursive: true);
        try { File.Delete(zipPath); } catch (IOException) { /* swept next start */ }

        Log.Info($"Update applied from {Path.GetFileName(zipPath)}; relaunching");
        return Environment.ProcessPath ?? Path.Combine(baseDir, "Plinth.exe");
    }

    /// <summary>Best-effort sweep of the rename-aside remnants and stale staging.
    /// Called at startup; a file still locked stays for the start after.</summary>
    public static void CleanupAtStartup()
    {
        try
        {
            foreach (var old in Directory.EnumerateFiles(AppContext.BaseDirectory, "*.old-*", SearchOption.AllDirectories))
                try { File.Delete(old); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            var staging = Path.Combine(UpdatesDir, "staging");
            if (Directory.Exists(staging))
                Directory.Delete(staging, recursive: true);
        }
        catch (Exception ex)
        {
            Log.Warn($"Update cleanup: {ex.Message}");
        }
    }

    private static HttpClient NewClient()
    {
        var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = true });
        // GitHub's API refuses requests without a User-Agent.
        http.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", $"Plinth/{CurrentVersion()}");
        http.Timeout = TimeSpan.FromMinutes(5);
        return http;
    }
}
