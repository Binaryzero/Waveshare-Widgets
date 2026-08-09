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
    private const long MaxExpandedBytes = 2L * 1024 * 1024 * 1024;

    private static string UpdatesDir => Path.Combine(AppPaths.DataDir, "updates");

    /// <summary>On-disk record that a swap is IN FLIGHT: base dir on line one, the
    /// rename-aside stamp on line two, added files by relative path after. Written
    /// before the first file moves, deleted after the last — its existence at startup
    /// means a swap was interrupted, and the *.old files under that stamp are a
    /// transaction to roll back, not litter.</summary>
    private static string JournalFile => Path.Combine(UpdatesDir, "swap-journal.txt");

    /// <summary>Journal intents reach STABLE STORAGE before any swap they authorize.
    /// WriteAllText closes the handle without forcing the data down, so a power cut
    /// could persist the renames while the journal naming them was still nothing —
    /// and the next start would sweep the originals as litter.</summary>
    private static void WriteJournalDurable(string content, bool append)
    {
        using var fs = new FileStream(JournalFile, append ? FileMode.Append : FileMode.Create,
            FileAccess.Write, FileShare.Read);
        fs.Write(System.Text.Encoding.UTF8.GetBytes(content));
        fs.Flush(flushToDisk: true);
    }

    public sealed record UpdateInfo(Version Version, string Tag, string AssetName, string AssetUrl, long Size);

    /// <summary>The running build's numeric triple — the part before any '-pre' or
    /// '+sha'. Release artifacts are stamped by release.yml from the tag; CI dev
    /// artifacts are stamped 0.0.0-ci.N and so rank below every release, always
    /// seeing the next one. A local unstamped build carries the csproj's fixed
    /// version and gets whatever that number implies — it belongs to a developer.</summary>
    public static Version CurrentVersion()
    {
        var info = typeof(AppVersion).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "";
        var numeric = info.Split('+')[0].Split('-')[0];
        return Version.TryParse(numeric, out var v) ? v : new Version(0, 0, 0);
    }

    /// <summary>The running build's prerelease identifiers ("beta.2"), null for a
    /// final.</summary>
    private static string? CurrentPrerelease()
    {
        var info = typeof(AppVersion).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "";
        var core = info.Split('+')[0];
        var dash = core.IndexOf('-');
        return dash < 0 ? null : core[(dash + 1)..];
    }

    /// <summary>SemVer precedence, the part after the numeric triple: a final outranks
    /// its own prereleases, and prereleases compare identifier by identifier — numeric
    /// ones numerically and below alphanumeric ones, a longer list winning a shared
    /// prefix — so beta.2 supersedes beta.1 and beta.10 supersedes beta.9. The release
    /// workflow accepts prerelease tags, which makes all of this a supported input,
    /// not an edge case. Build metadata never participates.</summary>
    private static int ComparePrecedence(Version aNumeric, string? aPre, Version bNumeric, string? bPre)
    {
        var byNumber = aNumeric.CompareTo(bNumeric);
        if (byNumber != 0)
            return byNumber;
        if (aPre is null || bPre is null)
            return (aPre is null ? 1 : 0) - (bPre is null ? 1 : 0);
        var a = aPre.Split('.');
        var b = bPre.Split('.');
        for (var i = 0; i < Math.Min(a.Length, b.Length); i++)
        {
            var c = (long.TryParse(a[i], out var an), long.TryParse(b[i], out var bn)) switch
            {
                (true, true) => an.CompareTo(bn),
                (true, false) => -1,
                (false, true) => 1,
                _ => string.CompareOrdinal(a[i], b[i]),
            };
            if (c != 0)
                return c;
        }
        return a.Length.CompareTo(b.Length);
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
        // The version TEXT (what release.yml stamps into the asset file name, build
        // metadata and prerelease suffix included) and the numeric triple (what
        // precedence is decided on) are different jobs — normalizing before the name
        // lookup made every +metadata release unfindable.
        var versionText = tag.StartsWith('v') ? tag[1..] : tag;
        var numeric = versionText.Split('-')[0].Split('+')[0];
        if (!Version.TryParse(numeric, out var latest))
            return null;
        var latestCore = versionText.Split('+')[0];
        var dashAt = latestCore.IndexOf('-');
        var latestPre = dashAt < 0 ? null : latestCore[(dashAt + 1)..];
        if (ComparePrecedence(latest, latestPre, CurrentVersion(), CurrentPrerelease()) <= 0)
            return null;

        // The flavor must match the install: dropping a framework-dependent build over
        // a self-contained one strands the runtime files of the old flavor in place.
        var selfContained = File.Exists(Path.Combine(AppContext.BaseDirectory, "coreclr.dll"));
        var wanted = $"Plinth-v{versionText}-win-x64{(selfContained ? "-self-contained" : "")}.zip";
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
        try
        {
            return await DownloadAndValidateAsync(info, zipPath);
        }
        catch
        {
            // A refused or interrupted download must not squat in the data dir —
            // differently named releases would otherwise accumulate at up to 500 MB
            // apiece with nothing ever reusing their file names.
            try { File.Delete(zipPath); } catch (IOException) { /* swept next start */ }
            throw;
        }
    }

    private static async Task<string> DownloadAndValidateAsync(UpdateInfo info, string zipPath)
    {
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
        var sawExe = false;
        var sawDll = false;
        long expanded = 0;
        foreach (var entry in zip.Entries)
        {
            var resolved = Path.GetFullPath(Path.Combine("X:\\probe", entry.FullName.Replace('/', '\\')));
            if (!resolved.StartsWith("X:\\probe\\", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException($"archive entry escapes the extraction root: {entry.FullName}");
            // The download cap bounds COMPRESSED bytes; a hostile ratio expands a small
            // zip until the system drive is full before the install is ever touched.
            // Entry lengths are declared metadata, but ExtractToDirectory enforces them:
            // inflating past the declared Length fails the entry.
            expanded += entry.Length;
            if (entry.Length > MaxExpandedBytes || expanded > MaxExpandedBytes)
                throw new InvalidOperationException($"archive expands past {MaxExpandedBytes} bytes — refusing it");
            // FullName, not Name: the application must sit at the archive ROOT. A
            // publish output accidentally wrapped in a folder still contains a
            // Plinth.exe by basename — installing it would add a nested tree, leave
            // the root exe untouched, and re-offer the same update forever.
            if (entry.FullName.Equals("Plinth.exe", StringComparison.OrdinalIgnoreCase))
                sawExe = true;
            else if (entry.FullName.Equals("Plinth.dll", StringComparison.OrdinalIgnoreCase))
                sawDll = true;
        }
        // BOTH, not either: an incomplete asset that still carries the apphost would
        // otherwise install, relaunch the OLD managed app through the new apphost,
        // and offer the same update again forever.
        if (!(sawExe && sawDll))
            throw new InvalidOperationException("archive does not contain the whole application — refusing to install it");
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

        // Tick joins the pid so a recycled process id can never collide with a stale
        // remnant from an earlier failed swap.
        var stamp = $"old-{Environment.ProcessId}-{Environment.TickCount64}";
        // The swap is journaled so a mid-flight failure (antivirus lock, full disk)
        // never strands a MIXED install: everything placed comes back out and every
        // renamed original goes back, and only then does the failure surface. An
        // install that cannot be updated must still be the install that runs.
        // The journal is ON DISK before the first move: an in-memory list survives an
        // exception but not a kill or a power cut, and the startup sweep would then
        // DELETE the very backups a recovery needs. With the file present, the next
        // start rolls the transaction back instead.
        WriteJournalDurable(baseDir + Environment.NewLine + stamp + Environment.NewLine, append: false);
        var renamed = new List<(string Target, string Aside)>();
        var placed = new List<string>();
        try
        {
            foreach (var source in Directory.EnumerateFiles(staging, "*", SearchOption.AllDirectories))
            {
                var rel = Path.GetRelativePath(staging, source);
                var target = Path.Combine(baseDir, rel);
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                if (File.Exists(target))
                {
                    // ATOMIC per file: rename-aside-then-move-in left an instant in
                    // which the target name resolved to NOTHING — a power cut there
                    // with Plinth.exe as the target and no runnable binary remains to
                    // perform any recovery. File.Replace swaps name, content, and
                    // backup in one operation, so the name never stops resolving to a
                    // complete file; it needs both files on the target's volume, so
                    // the staged bytes hop in next to the target first. Crash states
                    // shrink to "some files new, some old" — which the journal
                    // recovery below rolls back — never "a file missing".
                    var incoming = $"{target}.new-{stamp}";
                    File.Copy(source, incoming, overwrite: true);
                    var aside = $"{target}.{stamp}";
                    File.Replace(incoming, target, aside);
                    renamed.Add((target, aside));
                }
                else
                {
                    // An ADDITION — a file the old install never had — leaves no aside
                    // for recovery to find, so it is identifiable only by the record:
                    // its relative path joins the journal BEFORE the move (intent
                    // first), and recovery removes whatever of the record exists.
                    WriteJournalDurable(rel + Environment.NewLine, append: true);
                    File.Move(source, target);
                }
                placed.Add(target);
            }
        }
        catch (Exception ex)
        {
            Log.Warn($"Update swap failed after {placed.Count} file(s); rolling back: {ex.Message}");
            var unrestored = 0;
            foreach (var stray in Directory.EnumerateFiles(baseDir, $"*.new-{stamp}", SearchOption.AllDirectories))
                try { File.Delete(stray); } catch (Exception) { unrestored++; }
            foreach (var newFile in placed)
                try { File.Delete(newFile); } catch (Exception) { unrestored++; }
            foreach (var (target, aside) in renamed)
                try { if (!File.Exists(target)) File.Move(aside, target); } catch (Exception) { unrestored++; }
            // The journal outlives an INCOMPLETE rollback on purpose: deleting it
            // would hand the surviving asides to the startup sweep as litter, and the
            // partial install would become permanent. Startup recovery retries instead.
            if (unrestored > 0)
                Log.Warn($"Update rollback left {unrestored} file(s) unrestored — the journal is kept and startup recovery will retry");
            else
                try { File.Delete(JournalFile); } catch (IOException) { /* recovery re-runs harmlessly */ }
            throw;
        }
        // Best-effort from here: every file is swapped — the install IS the new
        // version, and a transient failure on cleanup must not report the update as
        // failed and cancel the relaunch, leaving the old process running over new
        // files. A journal that resists deletion means the next start rolls the
        // completed update back to a WHOLE old install and offers it again — the
        // recoverable wrong answer, named in the log.
        try { File.Delete(JournalFile); }
        catch (Exception ex) { Log.Warn($"Update committed but the journal would not delete ({ex.Message}); the next start will roll it back — run the update again after"); }
        try { Directory.Delete(staging, recursive: true); }
        catch (Exception ex) { Log.Warn($"Staging cleanup after update: {ex.Message}"); }
        try { File.Delete(zipPath); } catch (IOException) { /* swept next start */ }

        Log.Info($"Update applied from {Path.GetFileName(zipPath)}; relaunching");
        return Environment.ProcessPath ?? Path.Combine(baseDir, "Plinth.exe");
    }

    /// <summary>Recovery first, sweep second — strictly in that order. A journal on
    /// disk means a swap died mid-flight (kill, power cut), and the *.old files under
    /// its stamp are the ORIGINAL install: they are restored, not deleted. Only once
    /// no transaction is open do the remaining remnants become litter to sweep.
    /// Runs only as the single instance; both halves move files in the install dir.</summary>
    /// <summary>Only names carrying the updater's exact pid-tick shape are litter.
    /// This is a portable install — a user's own "foo.dll.old-backup" beside the exe
    /// is not ours, and a bare *.old-* glob would eat it.</summary>
    private static readonly System.Text.RegularExpressions.Regex AsideName =
        new(@"\.old-\d+-\d+(\.shed)?$", System.Text.RegularExpressions.RegexOptions.Compiled);
    private static readonly System.Text.RegularExpressions.Regex StrayName =
        new(@"\.new-old-\d+-\d+$", System.Text.RegularExpressions.RegexOptions.Compiled);
    private static readonly System.Text.RegularExpressions.Regex StampShape =
        new(@"^old-\d+-\d+$", System.Text.RegularExpressions.RegexOptions.Compiled);

    public static void CleanupAtStartup()
    {
        try
        {
            // The sweep runs ONLY when no transaction remains open. Recovery that
            // could not finish (a target antivirus still holds) keeps its journal and
            // forfeits this start's sweep — an unrestored original must never be
            // reclassified as litter, and the start after gets to retry.
            if (!RecoverInterruptedSwap())
                return;
            foreach (var file in Directory.EnumerateFiles(AppContext.BaseDirectory, "*.*old-*", SearchOption.AllDirectories))
                if (AsideName.IsMatch(file) || StrayName.IsMatch(file))
                    try { File.Delete(file); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            var staging = Path.Combine(UpdatesDir, "staging");
            if (Directory.Exists(staging))
                Directory.Delete(staging, recursive: true);
            // Stale archives only, and AGE is the discriminator: the apply-failure
            // dialog names a zip on disk for installing by hand, and a sweep on the
            // very next start would delete the file that message promised. Nothing
            // legitimate needs a fortnight.
            if (Directory.Exists(UpdatesDir))
                foreach (var zip in Directory.EnumerateFiles(UpdatesDir, "*.zip"))
                    try
                    {
                        if (DateTime.UtcNow - File.GetLastWriteTimeUtc(zip) > TimeSpan.FromDays(14))
                            File.Delete(zip);
                    }
                    catch (IOException) { }
        }
        catch (Exception ex)
        {
            Log.Warn($"Update cleanup: {ex.Message}");
        }
    }

    /// <summary>Returns whether the install is clean to sweep: true when no journal
    /// existed or every recorded backup was restored; false keeps the journal (and
    /// the sweep held off) so the next start retries.</summary>
    private static bool RecoverInterruptedSwap()
    {
        if (!File.Exists(JournalFile))
            return true;
        var lines = File.ReadAllLines(JournalFile);
        // A journal that does not parse is not a license to guess — restore nothing
        // rather than aim renames at names a corrupted file suggests. But simply
        // stepping aside would hand next start's sweep the very remnants that may
        // include originals: they are QUARANTINED out of the install first, preserved
        // for manual recovery, and only then does the journal retire as .bad.
        // The stamp must match the updater's EXACT shape, not merely begin like it: a
        // truncated "old-123" would pass a prefix check, find no backups under its
        // malformed suffix, retire the journal — and hand the real stamped originals
        // to the sweep.
        if (!(lines.Length >= 2 && Directory.Exists(lines[0]) && StampShape.IsMatch(lines[1])))
        {
            Log.Warn("Swap journal did not parse; quarantining remnants");
            // The journal retires ONLY once every remnant is preserved. A quarantine
            // stopped short (antivirus holding a backup) keeps the journal active, so
            // the sweep stays off and the next start finishes the job — retiring
            // early would let that sweep destroy the unquarantined original.
            if (!QuarantineRemnants())
            {
                Log.Warn("Quarantine incomplete; journal kept and nothing swept — retrying next start");
                return false;
            }
            try { File.Move(JournalFile, JournalFile + ".bad", overwrite: true); }
            catch (Exception ex) { Log.Warn($"Could not retire the journal: {ex.Message}"); }
            return false;
        }

        var baseDir = lines[0];
        var stamp = lines[1];
        var suffix = "." + stamp;
        var restored = 0;
        var failures = 0;
        // Incomplete Replace hops first: a *.new-<stamp> beside its target is staged
        // bytes that never swapped in — plain deletions, no original at risk.
        foreach (var stray in Directory.EnumerateFiles(baseDir, "*.new-" + stamp, SearchOption.AllDirectories))
            try { File.Delete(stray); } catch (Exception) { failures++; }
        foreach (var aside in Directory.EnumerateFiles(baseDir, "*" + suffix, SearchOption.AllDirectories))
        {
            var target = aside[..^suffix.Length];
            try
            {
                if (File.Exists(target))
                {
                    // The rollback is as atomic as the swap it undoes: delete-then-
                    // move re-opened the very missing-name instant the forward path
                    // closed, on the binary this recovery itself depends on. The shed
                    // file is the dead swap's new content — disposable, and its name
                    // matches the sweep should this crash before the delete.
                    var shed = aside + ".shed";
                    File.Replace(aside, target, shed);
                    File.Delete(shed);
                }
                else
                {
                    File.Move(aside, target);
                }
                restored++;
            }
            catch (Exception ex)
            {
                failures++;
                Log.Warn($"Swap recovery could not restore {Path.GetFileName(target)}: {ex.Message}");
            }
        }
        // The dead swap's ADDITIONS — files the old install never had, identifiable
        // only by the journal record (lines three on). Each is validated to resolve
        // INSIDE the install before deletion, so a corrupt line cannot aim outside.
        var root = baseDir.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        foreach (var rel in lines.Skip(2))
        {
            if (rel.Length == 0)
                continue;
            var target = Path.GetFullPath(Path.Combine(baseDir, rel));
            if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase))
            {
                Log.Warn($"Swap recovery: journaled addition escapes the install dir, skipped: {rel}");
                continue;
            }
            try { if (File.Exists(target)) File.Delete(target); } catch (Exception) { failures++; }
        }
        if (failures > 0)
        {
            // The journal outlives an incomplete recovery: deleting it would hand the
            // surviving backups to the sweep as litter and make the partial install
            // permanent. This start runs on what it has; the next one retries.
            Log.Warn($"Swap recovery incomplete ({restored} restored, {failures} failed); journal kept, nothing swept — retrying next start");
            return false;
        }
        Log.Warn($"An update was interrupted mid-swap; rolled back at startup ({restored} file(s) restored)");
        File.Delete(JournalFile);
        return true;
    }

    /// <summary>For a journal that cannot be read: the remnants under the install may
    /// include originals the sweep must never see, but holding the sweep forever
    /// would let litter grow without bound. They move OUT of the install into
    /// updates/quarantine — preserved for manual recovery — and the sweep resumes
    /// next start. Names are flattened with an index; the point is preservation,
    /// not restorability by machine.</summary>
    private static bool QuarantineRemnants()
    {
        var dir = Path.Combine(UpdatesDir, "quarantine");
        Directory.CreateDirectory(dir);
        var moved = 0;
        var failed = 0;
        foreach (var file in Directory.EnumerateFiles(AppContext.BaseDirectory, "*.*old-*", SearchOption.AllDirectories))
        {
            if (!AsideName.IsMatch(file) && !StrayName.IsMatch(file))
                continue;
            try
            {
                File.Move(file, Path.Combine(dir, $"{moved}-{Path.GetFileName(file)}"), overwrite: true);
                moved++;
            }
            catch (Exception ex)
            {
                failed++;
                Log.Warn($"Quarantine failed for {Path.GetFileName(file)}: {ex.Message}");
            }
        }
        if (moved > 0)
            Log.Warn($"{moved} update remnant(s) moved to {dir} — the journal naming them did not parse");
        return failed == 0;
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
