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
    /// transaction to roll back, not litter.
    /// It lives IN THE INSTALL, beside the transaction it describes — not in the
    /// per-account data dir. A shared portable install can be run by two Windows
    /// accounts, and a journal in account A's %LocalAppData% is invisible to
    /// account B, whose sweep would then delete A's unrestored originals as litter.
    /// Writing it is also the transaction's entry permission check: an install this
    /// account cannot write fails HERE, before any file is touched.</summary>
    private static string JournalFile => Path.Combine(AppContext.BaseDirectory, "swap-journal.txt");

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
            var c = (IsDigits(a[i]), IsDigits(b[i])) switch
            {
                (true, true) => CompareDigits(a[i], b[i]),
                (true, false) => -1,
                (false, true) => 1,
                _ => string.CompareOrdinal(a[i], b[i]),
            };
            if (c != 0)
                return c;
        }
        return a.Length.CompareTo(b.Length);
    }

    private static bool IsDigits(string s) => s.Length > 0 && s.All(char.IsAsciiDigit);

    /// <summary>Numeric identifiers compare as NUMBERS of any size — parsing into a
    /// bounded integer silently demoted identifiers past long.MaxValue to ordinal
    /// string order, where "99...9" (20 digits) outranks "10...0" (21 digits).
    /// Leading zeros are trimmed (SemVer forbids them; tolerance costs nothing),
    /// then longer means larger and equal lengths compare digit by digit.</summary>
    private static int CompareDigits(string x, string y)
    {
        var tx = x.TrimStart('0');
        var ty = y.TrimStart('0');
        if (tx.Length != ty.Length)
            return tx.Length - ty.Length;
        var byDigits = string.CompareOrdinal(tx, ty);
        return byDigits != 0 ? byDigits : x.Length - y.Length;
    }

    /// <summary>"v1.2.3-beta.2+meta" → numeric triple + prerelease identifiers
    /// (null for a final). Build metadata is dropped: it never joins precedence.</summary>
    private static bool TryParseTag(string tag, out Version numeric, out string? prerelease)
    {
        var core = (tag.StartsWith('v') ? tag[1..] : tag).Split('+')[0];
        var dash = core.IndexOf('-');
        prerelease = dash < 0 ? null : core[(dash + 1)..];
        return Version.TryParse(dash < 0 ? core : core[..dash], out numeric!);
    }

    /// <summary>Queries this install's channel for its next release. Returns null
    /// when this build is current (or newer); throws when the check itself fails —
    /// network errors, and a newer release whose matching asset is missing (a
    /// publish job may have failed or still be uploading), which must not read as
    /// "you are up to date".</summary>
    public static async Task<UpdateInfo?> CheckAsync()
    {
        using var http = NewClient();
        // BOTH channels choose by SemVer precedence over the full paginated list —
        // never by /releases/latest, which GitHub assigns by PUBLISH date: a v1.2.1
        // backport published after v2.0.0 becomes "latest" and would hide the real
        // next release forever. The channel split is a FILTER, not a mechanism: a
        // stable install considers finals only (a beta must never be offered to it),
        // a prerelease install considers everything — beta.2 supersedes beta.1, and
        // a final outranking the newest beta promotes it back onto stable. The list
        // is creation-ordered, so all pages are read before choosing (bounded — a
        // thousand releases is beyond any state this repo reaches, and an unbounded
        // loop trusts the server too much).
        var stableChannel = CurrentPrerelease() is null;
        JsonElement? best = null;
        Version? bestNum = null;
        string? bestPre = null;
        for (var page = 1; page <= 10; page++)
        {
            using var doc = JsonDocument.Parse(await http.GetStringAsync(
                $"https://api.github.com/repos/{Owner}/{Repo}/releases?per_page=100&page={page}"));
            if (doc.RootElement.GetArrayLength() == 0)
                break;
            foreach (var r in doc.RootElement.EnumerateArray())
            {
                if (r.TryGetProperty("draft", out var d) && d.GetBoolean())
                    continue;
                var rTag = r.TryGetProperty("tag_name", out var rt) ? rt.GetString() ?? "" : "";
                if (!TryParseTag(rTag, out var num, out var pre))
                    continue;
                // The tag suffix AND the API's own flag: a maintainer can mark a
                // final-looking release as prerelease after publication, and the
                // stable channel must honor that edit too. One exception: under a
                // standing repair advisory the INSTALLED version stays eligible even
                // flagged — it is this install's only in-app repair, and dropping it
                // here would strand the advisory with no path. Other prereleases
                // stay off the stable channel regardless.
                if (stableChannel && (pre is not null
                    || (r.TryGetProperty("prerelease", out var flagged) && flagged.GetBoolean())))
                {
                    if (!(RepairAdvised
                          && ComparePrecedence(num, pre, CurrentVersion(), CurrentPrerelease()) == 0))
                        continue;
                }
                if (bestNum is null || ComparePrecedence(num, pre, bestNum, bestPre) > 0)
                {
                    best = r.Clone();
                    bestNum = num;
                    bestPre = pre;
                }
            }
        }
        if (best is null)
            return null;
        var root = best.Value;

        var tag = root.TryGetProperty("tag_name", out var t) ? t.GetString() ?? "" : "";
        // The version TEXT (what release.yml stamps into the asset file name, build
        // metadata and prerelease suffix included) and the numeric triple (what
        // precedence is decided on) are different jobs — normalizing before the name
        // lookup made every +metadata release unfindable.
        var versionText = tag.StartsWith('v') ? tag[1..] : tag;
        if (!TryParseTag(tag, out var latest, out var latestPre))
            return null;
        var cmp = ComparePrecedence(latest, latestPre, CurrentVersion(), CurrentPrerelease());
        // A standing repair advisory turns "same version" into a valid answer: the
        // interrupted swap may have replaced Plinth.dll before dying, so this build
        // REPORTS the newest release while the rest of the install is mixed — and
        // reinstalling that release is exactly the repair the advisory promises.
        // Only strictly older releases stay refused.
        if (RepairAdvised ? cmp < 0 : cmp <= 0)
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
        // A release that EXISTS but lacks its asset is not "you are up to date" — a
        // publish job may have failed or uploads may still be in flight. The thrown
        // message reaches the interactive dialog as the reason; the silent daily
        // check logs it and stays quiet, same as any other check failure.
        throw new InvalidOperationException(
            $"release {tag} is newer but has no asset named '{wanted}' yet — it may still be uploading");
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
            // Declared lengths are only a PRE-SCREEN — metadata a crafted archive can
            // understate — so Apply's extraction counts the bytes actually inflated
            // and enforces the same ceiling there.
            expanded += entry.Length;
            if (entry.Length > MaxExpandedBytes || expanded > MaxExpandedBytes)
                throw new InvalidOperationException($"archive expands past {MaxExpandedBytes} bytes — refusing it");
            if (IsUpdaterControlFile(entry.FullName))
                throw new InvalidOperationException($"archive entry collides with an updater control file: {entry.FullName}");
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
        // A journal on disk is an UNFINISHED transaction — an earlier failed apply
        // whose rollback could not complete. Writing a new one would truncate it and
        // orphan the surviving originals under the old stamp for the sweep. That
        // recovery belongs to startup; refuse until it has run.
        if (File.Exists(JournalFile))
            throw new InvalidOperationException(
                "an earlier update did not finish rolling back — restart Plinth to let it recover, then try again");

        // Root-aware trim: a portable install at a volume root would otherwise become
        // the DRIVE-RELATIVE path "D:", and every Path.Combine from it would resolve
        // against that drive's current directory instead of the install.
        var baseDir = Path.TrimEndingDirectorySeparator(AppContext.BaseDirectory);
        var staging = Path.Combine(UpdatesDir, "staging");
        // Running FROM staging (or beneath it) is not a location an update
        // transaction can be built under; refuse whole.
        if (InstallInsideStaging(staging))
            throw new InvalidOperationException(
                "Plinth is running from the updater's staging folder — move the install somewhere else before updating");
        if (Directory.Exists(staging))
            Directory.Delete(staging, recursive: true);
        // Manual extraction, cap enforced on bytes ACTUALLY inflated: the declared
        // entry lengths validation pre-screened are metadata a crafted archive can
        // understate, and deflate emits up to ~1000x its compressed input — a lying
        // central directory could otherwise fill the drive during extraction.
        // Containment is re-checked here on the resolved path, the same second lock
        // ExtractToDirectory provided.
        var stagingRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(staging)) + Path.DirectorySeparatorChar;
        using (var archive = ZipFile.OpenRead(zipPath))
        {
            long inflated = 0;
            var buffer = new byte[81920];
            foreach (var entry in archive.Entries)
            {
                var dest = Path.GetFullPath(Path.Combine(staging, entry.FullName.Replace('/', Path.DirectorySeparatorChar)));
                if (!dest.StartsWith(stagingRoot, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException($"archive entry escapes staging: {entry.FullName}");
                if (entry.FullName.EndsWith('/') || entry.FullName.EndsWith('\\'))
                {
                    Directory.CreateDirectory(dest);
                    continue;
                }
                Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                using var src = entry.Open();
                using var dst = File.Create(dest);
                int read;
                while ((read = src.Read(buffer, 0, buffer.Length)) > 0)
                {
                    inflated += read;
                    if (inflated > MaxExpandedBytes)
                        throw new InvalidOperationException($"archive inflated past {MaxExpandedBytes} bytes — refusing it");
                    dst.Write(buffer, 0, read);
                }
            }
        }

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
        var vetted = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            foreach (var source in Directory.EnumerateFiles(staging, "*", SearchOption.AllDirectories))
            {
                var rel = Path.GetRelativePath(staging, source);
                if (IsUpdaterControlFile(rel))
                    continue;
                var target = Path.Combine(baseDir, rel);
                // Vetting comes BEFORE creation: CreateDirectory follows an existing
                // junction while materializing missing segments, so checking after
                // the fact would validate a directory already planted outside the
                // install. Missing ancestors are fine — they are about to be created
                // as ordinary directories beneath ones proven real.
                EnsureNoReparseAncestors(Path.GetDirectoryName(target)!, baseDir, vetted);
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
                    // The rollback set too: a cross-volume Move is copy-then-delete,
                    // and a copy dying partway (drive full, cable pulled) leaves a
                    // partial target that a rollback tracking only COMPLETED moves
                    // would never clean. Deleting a never-created file is a no-op.
                    WriteJournalDurable(rel + Environment.NewLine, append: true);
                    placed.Add(target);
                    File.Move(source, target);
                }
                placed.Add(target);
            }
        }
        catch (Exception ex)
        {
            Log.Warn($"Update swap failed after {placed.Count} file(s); rolling back: {ex.Message}");
            var unrestored = 0;
            foreach (var stray in EnumerateFilesSafe(baseDir, $"*.new-{stamp}"))
                try { if (!InsideUpdatesDir(stray)) File.Delete(stray); } catch (Exception) { unrestored++; }
            // Replacements roll back ATOMICALLY, exactly as startup recovery does —
            // delete-then-restore held open the same missing-name instant here that
            // the forward path closed, on the binary that must survive a failed
            // update most of all. Only genuine additions are deletions.
            var replacedTargets = new HashSet<string>(renamed.Select(r => r.Target), StringComparer.OrdinalIgnoreCase);
            foreach (var (target, aside) in renamed)
            {
                try
                {
                    if (File.Exists(target))
                    {
                        var shed = aside + ".shed";
                        File.Replace(aside, target, shed);
                        File.Delete(shed);
                    }
                    else
                    {
                        File.Move(aside, target);
                    }
                }
                catch (Exception) { unrestored++; }
            }
            foreach (var newFile in placed.Where(p => !replacedTargets.Contains(p)))
                try { File.Delete(newFile); } catch (Exception) { unrestored++; }
            // The journal outlives an INCOMPLETE rollback on purpose: deleting it
            // would hand the surviving asides to the startup sweep as litter, and the
            // partial install would become permanent. Startup recovery retries instead.
            if (unrestored > 0)
            {
                Log.Warn($"Update rollback left {unrestored} file(s) unrestored — the journal is kept and startup recovery will retry");
            }
            else
            {
                // Same reasoning as recovery: a COMPLETE rollback consumed this
                // stamp's backups, so the journal retires whether or not the marker
                // persisted — a kept journal would refuse future sessions over a
                // coherent install for the sake of near-empty cleanup.
                if (!WriteSweepMarker(stamp))
                    Log.Warn("Sweep marker could not persist; this stamp's remnants (if any) stay unswept");
                try { File.Delete(JournalFile); } catch (IOException) { /* recovery re-runs harmlessly */ }
            }
            throw;
        }
        // Best-effort from here: every file is swapped — the install IS the new
        // version, and a transient failure on cleanup must not report the update as
        // failed and cancel the relaunch, leaving the old process running over new
        // files. A journal that resists deletion means the next start rolls the
        // completed update back to a WHOLE old install and offers it again — the
        // recoverable wrong answer, named in the log.
        var journalGone = false;
        if (WriteSweepMarker(stamp))
        {
            try { File.Delete(JournalFile); journalGone = true; }
            catch (Exception ex) { Log.Warn($"Update committed but the journal would not delete ({ex.Message}); the next start will roll it back — run the update again after"); }
        }
        else
        {
            Log.Warn("Sweep marker could not persist; journal kept — the next start rolls this update back and it can be retried");
        }
        // A committed swap IS the repair a standing advisory asked for — but only
        // once the journal is truly gone: a surviving journal means the next start
        // ROLLS BACK to the very mixed install the advisory describes, and clearing
        // it first would leave that state silent.
        if (journalGone)
            try { File.Delete(RepairAdvisedFile); } catch (Exception) { /* advisory stays; balloon repeats */ }
        try { Directory.Delete(staging, recursive: true); }
        catch (Exception ex) { Log.Warn($"Staging cleanup after update: {ex.Message}"); }
        // ALL failures, not just IOException: an ACL that allows creating the zip
        // but denies deleting it would otherwise turn a fully committed update
        // into a reported failure — and the old process would keep running over
        // the new files instead of relaunching.
        try { File.Delete(zipPath); }
        catch (Exception ex) { Log.Warn($"Archive cleanup after update: {ex.Message}"); }

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

    /// <summary>An active journal means an unfinished transaction: recovery still
    /// owes the install a repair. Callers use this to refuse running a session
    /// over a known-mixed install.</summary>
    public static bool RecoveryPending => File.Exists(JournalFile);

    /// <summary>True when the LIVE install sits at or beneath the staging folder —
    /// a portable copy run from updates/staging. Deleting staging then deletes the
    /// install itself, with no journal to restore a single file; every staging
    /// wipe checks this first.</summary>
    private static bool InstallInsideStaging(string staging)
    {
        var installPrefix = Path.TrimEndingDirectorySeparator(CanonicalDir(AppContext.BaseDirectory))
            + Path.DirectorySeparatorChar;
        var stagingPrefix = Path.TrimEndingDirectorySeparator(CanonicalDir(staging))
            + Path.DirectorySeparatorChar;
        return installPrefix.StartsWith(stagingPrefix, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Component-by-component link resolution. GetFullPath is LEXICAL —
    /// it never touches the filesystem — so an install launched through a junction
    /// whose target lies under staging compared as unrelated paths and walked past
    /// the containment guard. ResolveLinkTarget resolves only a leaf, so each
    /// component is resolved on the way down; an unreadable component keeps its
    /// lexical form, which fails safe (the guard then refuses more, never less).</summary>
    private static string CanonicalDir(string path)
    {
        var full = Path.GetFullPath(path);
        var root = Path.GetPathRoot(full)!;
        var current = root;
        foreach (var part in full[root.Length..].Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
        {
            current = Path.Combine(current, part);
            try
            {
                var info = new DirectoryInfo(current);
                if (info.LinkTarget is not null && info.ResolveLinkTarget(returnFinalTarget: true) is { } resolved)
                    current = resolved.FullName;
            }
            catch (Exception) { /* unreadable component — keep the lexical path */ }
        }
        return current;
    }

    /// <summary>Root-level names the updater itself owns inside the install. An
    /// archive entry with one of these names would replace the LIVE transaction
    /// journal mid-swap — the rollback record swapped out by the very transaction
    /// it records — so validation refuses them and the swap loop skips them.</summary>
    private static bool IsUpdaterControlFile(string entryName) =>
        entryName.Equals("swap-journal.txt", StringComparison.OrdinalIgnoreCase)
        || entryName.Equals("swap-journal.txt.bad", StringComparison.OrdinalIgnoreCase)
        || entryName.Equals("repair-advised.txt", StringComparison.OrdinalIgnoreCase);

    /// <summary>Durable record that quarantine left this install PARTIALLY SWAPPED:
    /// originals preserved away, the dead transaction's files in place. A blocking
    /// refusal would brick the one in-app repair path (the updater runs inside the
    /// session it would refuse), so the marker is ADVISORY — the quarantine session
    /// refuses once, later sessions run and surface it, and a successful update
    /// commit (a full coherent swap) or a reinstall retires it.</summary>
    private static string RepairAdvisedFile => Path.Combine(AppContext.BaseDirectory, "repair-advised.txt");

    public static bool RepairAdvised => File.Exists(RepairAdvisedFile);

    /// <summary>Targets never sit beneath a reparse point: a junctioned Shell/
    /// would send the swap OUTSIDE the install, where recovery's walker — which
    /// refuses reparse points for exactly that reason — could never find the
    /// asides, and the journal would retire clean over unreachable damage.
    /// Checked per directory and cached; throwing here aborts the transaction
    /// while rollback is still trivial.</summary>
    private static void EnsureNoReparseAncestors(string dir, string baseDir, HashSet<string> vetted)
    {
        var stop = Path.TrimEndingDirectorySeparator(baseDir);
        for (var d = Path.TrimEndingDirectorySeparator(dir);
             d.Length > stop.Length && d.StartsWith(stop, StringComparison.OrdinalIgnoreCase);
             d = Path.GetDirectoryName(d)!)
        {
            if (!vetted.Add(d))
                return;
            if (Directory.Exists(d) && File.GetAttributes(d).HasFlag(FileAttributes.ReparsePoint))
                throw new InvalidOperationException($"update target sits beneath a link: {d}");
        }
    }

    /// <summary>Records that a transaction FINISHED and its stamp's remnants are
    /// litter. The sweep deletes only what a marker names — filename SHAPE alone
    /// can never establish ownership: a user's config.json.old-2024-01 beside a
    /// portable install fits any heuristic. Best-effort: a marker that fails to
    /// write means litter survives, which is the safe direction.</summary>
    /// <summary>Returns whether the marker reached STABLE STORAGE — callers order
    /// this before deleting the journal, because the sweep deletes only stamps a
    /// marker names: a journal gone with no marker persisted leaves every backup of
    /// that stamp untracked forever, roughly an install's worth per occurrence.
    /// A false return keeps the journal, and the next start retries.</summary>
    private static bool WriteSweepMarker(string stamp)
    {
        try
        {
            Directory.CreateDirectory(UpdatesDir);
            // The marker NAMES ITS INSTALL: several portable copies share one data
            // dir, and a copy that starts first would otherwise consume another
            // copy's marker against its own tree — finding nothing, retiring the
            // marker, and leaving the real remnants untracked forever.
            using var fs = new FileStream(Path.Combine(UpdatesDir, $"sweep-{stamp}.txt"),
                FileMode.Create, FileAccess.Write, FileShare.Read);
            fs.Write(System.Text.Encoding.UTF8.GetBytes(AppContext.BaseDirectory));
            fs.Flush(flushToDisk: true);
            return true;
        }
        catch (Exception ex)
        {
            Log.Warn($"Could not record sweep marker for {stamp}: {ex.Message}");
            return false;
        }
    }

    /// <summary>The journal must name THIS installation. A portable copy carries
    /// its journal with it, and acting on the ORIGINAL directory the copied file
    /// names would repair the wrong install while this one's sweep destroyed its
    /// own unrestored asides; a damaged first line gets the same refusal.</summary>
    private static bool NamesThisInstall(string recordedBase)
    {
        try
        {
            // Canonical, not lexical: an install journaled while launched through a
            // junction and recovered through its resolved path (or vice versa) is
            // the SAME install, and a lexical mismatch would quarantine originals
            // that a plain rollback could have restored.
            return string.Equals(
                Path.TrimEndingDirectorySeparator(CanonicalDir(recordedBase)),
                Path.TrimEndingDirectorySeparator(CanonicalDir(AppContext.BaseDirectory)),
                StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// <summary>True when the path lies inside the updater's own data tree. A
    /// portable copy CAN be installed at the data dir or an ancestor of it, which
    /// puts updates/ (staging, quarantine, archives) inside every install scan —
    /// and quarantine would then be swept by the very pass it exists to hide from.
    /// Each scan over the install skips this subtree.</summary>
    private static bool InsideUpdatesDir(string path)
    {
        var updates = Path.TrimEndingDirectorySeparator(UpdatesDir) + Path.DirectorySeparatorChar;
        // The exclusion only makes sense for a data tree that DESCENDS from the
        // install. If the install itself sits beneath the data dir — a zip
        // extracted beside the download the apply-failure dialog points at —
        // "inside updates/" would describe every file, and recovery would skip
        // all asides while reporting a clean rollback.
        var install = Path.TrimEndingDirectorySeparator(AppContext.BaseDirectory) + Path.DirectorySeparatorChar;
        if (install.StartsWith(updates, StringComparison.OrdinalIgnoreCase))
            return false;
        return path.StartsWith(updates, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Whether an EnumerateFilesSafe walk saw everything. A caller whose
    /// CORRECTNESS depends on completeness (recovery deciding a transaction is
    /// finished, quarantine deciding every remnant is preserved) must check this —
    /// a silently omitted subtree would otherwise read as "nothing left there".</summary>
    private sealed class WalkReport
    {
        public bool Complete = true;
    }

    /// <summary>Recursive file walk that survives unreadable subtrees: an
    /// inaccessible directory is REPORTED, not thrown — EnumerateFiles throws at
    /// MoveNext, outside any per-file try, so one unreadable folder anywhere in a
    /// portable install would otherwise cancel an entire rollback, recovery, or
    /// sweep wholesale, every launch. Reparse points are never followed: a junction
    /// back to an ancestor loops the walk forever, and one leading out of the
    /// install would put an UNRELATED tree under scans that delete things.</summary>
    private static IEnumerable<string> EnumerateFilesSafe(string root, string pattern, WalkReport? report = null)
    {
        var pending = new Stack<string>();
        pending.Push(root);
        while (pending.Count > 0)
        {
            var dir = pending.Pop();
            string[] files;
            try { files = Directory.GetFiles(dir, pattern); }
            catch (Exception) { files = []; if (report is { }) report.Complete = false; }
            foreach (var file in files)
                yield return file;
            string[] subs;
            try { subs = Directory.GetDirectories(dir); }
            catch (Exception) { if (report is { }) report.Complete = false; continue; }
            foreach (var sub in subs)
            {
                try
                {
                    if (File.GetAttributes(sub).HasFlag(FileAttributes.ReparsePoint))
                        continue;
                }
                catch (Exception) { if (report is { }) report.Complete = false; continue; }
                pending.Push(sub);
            }
        }
    }

    public enum StartupOutcome
    {
        /// <summary>No transaction touched anything; run normally.</summary>
        Proceed,
        /// <summary>Recovery RESTORED files under this very process — the loaded
        /// assemblies may be the dead transaction's code facing restored old files;
        /// the caller must relaunch instead of running this session.</summary>
        Relaunch,
        /// <summary>An active journal remains and nothing could be repaired yet —
        /// the install is known-mixed. Running a session over it is refused; the
        /// next start retries recovery.</summary>
        Refuse,
    }

    public static StartupOutcome CleanupAtStartup()
    {
        var restoredAny = false;
        try
        {
            // The sweep runs ONLY when no transaction remains open. Recovery that
            // could not finish (a target antivirus still holds) keeps its journal and
            // forfeits this start's sweep — an unrestored original must never be
            // reclassified as litter, and the start after gets to retry.
            (var clean, restoredAny, var manualRepair) = RecoverInterruptedSwap();
            if (!clean)
                return Outcome(restoredAny, manualRepair);
            // The sweep is driven by RECORD, never by filename shape: nothing but the
            // updater's own ledger can establish ownership of a suffix. Each finished
            // transaction leaves a marker naming its stamp; only those exact stamps
            // are swept, and a marker retires only once a COMPLETE walk found its
            // remnants gone — an unreadable subtree keeps it for the next start.
            if (Directory.Exists(UpdatesDir))
                foreach (var marker in Directory.GetFiles(UpdatesDir, "sweep-*.txt"))
                {
                    var stamp = Path.GetFileNameWithoutExtension(marker)["sweep-".Length..];
                    if (!StampShape.IsMatch(stamp))
                    {
                        try { File.Delete(marker); } catch (IOException) { }
                        continue;
                    }
                    // Another copy's marker is not ours to act on OR retire — its
                    // remnants live under a different install tree. An empty
                    // recorded install (pre-binding marker) is treated as ours.
                    string markerInstall;
                    try { markerInstall = File.ReadAllText(marker).Trim(); }
                    catch (Exception) { continue; }
                    if (markerInstall.Length > 0 && !NamesThisInstall(markerInstall))
                        continue;
                    var walk = new WalkReport();
                    var swept = true;
                    foreach (var pattern in new[] { "*." + stamp, "*." + stamp + ".shed", "*.new-" + stamp })
                        foreach (var file in EnumerateFilesSafe(AppContext.BaseDirectory, pattern, walk))
                            if (!InsideUpdatesDir(file))
                                try { File.Delete(file); }
                                catch (IOException) { swept = false; }
                                catch (UnauthorizedAccessException) { swept = false; }
                    // The marker retires only once every remnant is GONE: traversal
                    // completeness alone would drop it over a still-locked aside,
                    // and that old binary would then sit unclaimed forever.
                    if (walk.Complete && swept)
                        try { File.Delete(marker); } catch (IOException) { }
                }
            var staging = Path.Combine(UpdatesDir, "staging");
            // The same containment rule as Apply, because startup reaches this
            // delete FIRST: run from staging, this recursive wipe would take the
            // live install's own files with no journal to restore them.
            if (Directory.Exists(staging) && !InstallInsideStaging(staging))
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
            return Outcome(restoredAny, manualRepair: false);
        }
        catch (Exception ex)
        {
            Log.Warn($"Update cleanup: {ex.Message}");
            // Whatever failed AFTER recovery must not erase what recovery DID: files
            // restored under already-loaded images still demand the relaunch.
            return Outcome(restoredAny, manualRepair: false);
        }

        // Restores demand a relaunch whatever else happened; an ACTIVE journal with
        // nothing restored is a known-mixed install a session must not run over —
        // and so is the quarantine aftermath, whose journal is already retired but
        // whose install just lost its originals to preservation.
        static StartupOutcome Outcome(bool restoredAny, bool manualRepair) =>
            restoredAny ? StartupOutcome.Relaunch
            : manualRepair || RecoveryPending ? StartupOutcome.Refuse
            : StartupOutcome.Proceed;
    }

    /// <summary>Clean: the install may be swept — no journal existed, or every
    /// recorded backup was restored (anything less keeps the journal so the next
    /// start retries). RestoredAny: recovery MOVED files back under the running
    /// process, so the images already loaded may be the dead transaction's code —
    /// the caller relaunches into the restored install.</summary>
    private static (bool Clean, bool RestoredAny, bool ManualRepair) RecoverInterruptedSwap()
    {
        // Hoisted OUTSIDE the try: restoration that happened must outlive whatever
        // throws after it — the caller's relaunch decision rides on this count.
        var restored = 0;
        try
        {
        if (!File.Exists(JournalFile))
            return (true, false, false);
        var raw = File.ReadAllText(JournalFile);
        // A record proves itself complete by the newline AFTER it (or a successor
        // line). A torn append is a PREFIX of a name — "lib.dll.config" cut to
        // "lib.dll" — and a prefix must never aim anything at the install.
        var terminated = raw.Length > 0 && raw[^1] == '\n';
        var lines = raw.Replace("\r", "").Split('\n', StringSplitOptions.RemoveEmptyEntries);
        var headerComplete = lines.Length > 2 || terminated;
        // Body records are vetted as strictly as the header: every addition was
        // written as a relative path inside the install, so one that now resolves
        // OUTSIDE it is disk corruption — and skipping it while deleting the journal
        // as clean would leave the actually-installed addition untracked forever.
        // A corrupt body gets the same treatment as a corrupt header.
        var bodyValid = true;
        if (headerComplete && lines.Length >= 2 && NamesThisInstall(lines[0]))
        {
            var vroot = lines[0].TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            foreach (var rel in lines.Skip(2))
            {
                if (rel.Length == 0)
                    continue;
                try
                {
                    // Rooted records are corruption by definition — additions are
                    // written as RELATIVE paths, and Path.Combine hands a rooted
                    // value straight through, where one that happens to point inside
                    // the install would pass containment and delete a file the
                    // updater never added.
                    if (Path.IsPathRooted(rel)
                        || !Path.GetFullPath(Path.Combine(lines[0], rel))
                            .StartsWith(vroot, StringComparison.OrdinalIgnoreCase))
                    {
                        bodyValid = false;
                        break;
                    }
                }
                catch (Exception)
                {
                    bodyValid = false;
                    break;
                }
            }
        }
        // A journal that does not parse is not a license to guess — restore nothing
        // rather than aim renames at names a corrupted file suggests. But simply
        // stepping aside would hand next start's sweep the very remnants that may
        // include originals: they are QUARANTINED out of the install first, preserved
        // for manual recovery, and only then does the journal retire as .bad.
        // The stamp must match the updater's EXACT shape, not merely begin like it: a
        // truncated "old-123" would pass a prefix check, find no backups under its
        // malformed suffix, retire the journal — and hand the real stamped originals
        // to the sweep.
        if (!(headerComplete && bodyValid && lines.Length >= 2 && NamesThisInstall(lines[0]) && StampShape.IsMatch(lines[1])))
        {
            Log.Warn("Swap journal did not parse; quarantining remnants");
            // The journal retires ONLY once every remnant is preserved. A quarantine
            // stopped short (antivirus holding a backup) keeps the journal active, so
            // the sweep stays off and the next start finishes the job — retiring
            // early would let that sweep destroy the unquarantined original.
            if (!QuarantineRemnants())
            {
                Log.Warn("Quarantine incomplete; journal kept and nothing swept — retrying next start");
                return (false, false, true);
            }
            // The DURABLE advisory persists BEFORE the journal retires: with the
            // journal already .bad and this write failed, no later launch would see
            // any state at all over the quarantined, partially swapped install. If
            // the advisory cannot persist, the journal stays active and the next
            // start retries this whole path (quarantine re-runs empty).
            // Persisting means the PLATTER, with the same flush discipline as the
            // journal: WriteAllText only closes the handle, and a power cut could
            // let the rename below reach disk while the advisory never did.
            try
            {
                using var fs = new FileStream(RepairAdvisedFile, FileMode.Create, FileAccess.Write, FileShare.Read);
                fs.Write(System.Text.Encoding.UTF8.GetBytes(DateTime.UtcNow.ToString("O")));
                fs.Flush(flushToDisk: true);
            }
            catch (Exception ex)
            {
                Log.Warn($"Could not record the repair advisory: {ex.Message}; journal kept so the next start retries");
                return (false, false, true);
            }
            try { File.Move(JournalFile, JournalFile + ".bad", overwrite: true); }
            catch (Exception ex) { Log.Warn($"Could not retire the journal: {ex.Message}"); }
            return (false, false, true);
        }

        var baseDir = lines[0];
        var stamp = lines[1];
        var suffix = "." + stamp;
        var failures = 0;
        var walk = new WalkReport();
        // Incomplete Replace hops first: a *.new-<stamp> beside its target is staged
        // bytes that never swapped in — plain deletions, no original at risk.
        foreach (var stray in EnumerateFilesSafe(baseDir, "*.new-" + stamp, walk))
            try { if (!InsideUpdatesDir(stray)) File.Delete(stray); } catch (Exception) { failures++; }
        foreach (var aside in EnumerateFilesSafe(baseDir, "*" + suffix, walk))
        {
            if (InsideUpdatesDir(aside))
                continue;
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
        // A torn FINAL record is dropped, not guessed at: the addition it described
        // (if it ever landed) stays behind as litter — the lesser wrong, against
        // deleting whichever old file the truncated prefix happens to name.
        var additions = lines.Skip(2);
        if (!terminated && lines.Length > 2)
        {
            additions = lines.Skip(2).SkipLast(1);
            Log.Warn("Swap journal's last addition record is torn; leaving its file (if placed) rather than deleting by a truncated name");
        }
        var root = baseDir.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        foreach (var rel in additions)
        {
            if (rel.Length == 0)
                continue;
            var target = Path.GetFullPath(Path.Combine(baseDir, rel));
            if (Path.IsPathRooted(rel) || !target.StartsWith(root, StringComparison.OrdinalIgnoreCase))
            {
                // Pre-validation routes escaping records to quarantine before this
                // loop runs; reaching here anyway is a failure, never a clean skip.
                Log.Warn($"Swap recovery: journaled addition escapes the install dir: {rel}");
                failures++;
                continue;
            }
            try { if (File.Exists(target)) File.Delete(target); } catch (Exception) { failures++; }
        }
        // A walk that could not read every directory is an INCOMPLETE scan, not a
        // clean one: an aside sitting in the unreadable subtree would otherwise be
        // absent from a "successful" recovery, the journal would retire, and a later
        // start would sweep that original once the directory turned readable again.
        if (!walk.Complete)
        {
            failures++;
            Log.Warn("Swap recovery could not read every directory; treating the scan as incomplete");
        }
        if (failures > 0)
        {
            // The journal outlives an incomplete recovery: deleting it would hand the
            // surviving backups to the sweep as litter and make the partial install
            // permanent. This start runs on what it has; the next one retries.
            Log.Warn($"Swap recovery incomplete ({restored} restored, {failures} failed); journal kept, nothing swept — retrying next start");
            return (false, restored > 0, false);
        }
        Log.Warn($"An update was interrupted mid-swap; rolled back at startup ({restored} file(s) restored)");
        // A COMPLETE recovery consumed the stamp's backups — restores moved the
        // asides back, strays were deleted — so the marker here is nearly vestigial.
        // The journal retires even when the marker cannot persist: keeping it would
        // map RecoveryPending to Refuse on every future launch, bricking a COHERENT
        // install over cleanup bookkeeping. The unswept crumbs are the bounded trade.
        if (!WriteSweepMarker(stamp))
            Log.Warn("Sweep marker could not persist; this stamp's remnants (if any) stay unswept");
        File.Delete(JournalFile);
        return (true, restored > 0, false);
        }
        catch (Exception ex)
        {
            // Not clean — the journal (if any) stays and the next start retries —
            // but the restores already performed are still reported.
            Log.Warn($"Swap recovery did not finish cleanly: {ex.Message}");
            return (false, restored > 0, false);
        }
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
        var walk = new WalkReport();
        foreach (var file in EnumerateFilesSafe(AppContext.BaseDirectory, "*.*old-*", walk))
        {
            if (InsideUpdatesDir(file) || (!AsideName.IsMatch(file) && !StrayName.IsMatch(file)))
                continue;
            try
            {
                // Never overwrite: a quarantine retried after a lock, or a second
                // malformed journal, starts its numbering over — and the file already
                // preserved under that name is the original this exists to keep.
                var name = Path.GetFileName(file);
                var dest = Path.Combine(dir, name);
                for (var i = 1; File.Exists(dest); i++)
                    dest = Path.Combine(dir, $"{i}-{name}");
                File.Move(file, dest);
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
        // A subtree the walk could not read may hold a remnant: "every remnant is
        // preserved" cannot be claimed from a partial scan.
        return failed == 0 && walk.Complete;
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
