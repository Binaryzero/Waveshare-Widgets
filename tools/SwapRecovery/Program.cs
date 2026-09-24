// Update recovery helper (issue #239).
//
// R1-R4   a cut-off swap is undone: replaced and retired files come back, added files and
//         half-copied ones go, and the journal and anything not this update's stay
// R5      nothing moves when the journal is another update's, finished, torn in its header,
//         or has a record that points outside the install
// R6      a torn last record is never acted on
// R7      a linked folder is not walked into, and Plinth's updates folder is left out
// R8      a second run finds nothing to do
// C1-C2   the sign-in command line and the copy's name
// W1-W14  the wiring: the updater arms the helper (its copy flushed) before the journal and
//         disarms it only once no journal is left; the helper shares Plinth's lock and
//         registers itself again when it cannot finish; the build ships it
//
// `verify <dir>` (build.yml and release.yml, on Windows, after publishing):
// V1-V5   the published helper is there, needs only the .NET Framework in Windows, and
//         undoes a cut-off swap for real, but not while Plinth holds its lock; one a lock
//         stops registers itself again for the next sign-in, and one that finishes does not
using System.Diagnostics;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Text.RegularExpressions;
using Plinth.Recover;

var failures = 0;
void Check(string name, bool ok, string? detail = null)
{
    Console.WriteLine($"  {(ok ? "PASS" : "FAIL")} {name}{(detail is null ? "" : " - " + detail)}");
    if (!ok) failures++;
}

var sep = Path.DirectorySeparatorChar;
var tmp = Path.Combine(Path.GetTempPath(), $"swaprecovery-{Environment.ProcessId}");
Directory.CreateDirectory(tmp);
var updatesDir = Path.Combine(tmp, "data", "updates");
const string Stamp = "old-1-2";
var log = new List<string>();

string NewInstall(string name)
{
    var dir = Path.Combine(tmp, name);
    Directory.CreateDirectory(dir);
    return dir;
}
void Put(string path, string text)
{
    Directory.CreateDirectory(Path.GetDirectoryName(path)!);
    File.WriteAllText(path, text);
}
string Read(string path) => File.Exists(path) ? File.ReadAllText(path) : "<missing>";
// The updater's own journal form: the install, the stamp, then one added file per line.
string JournalText(string install, string stamp, params string[] additions) =>
    install + Environment.NewLine + stamp + Environment.NewLine
    + string.Concat(additions.Select(a => a + Environment.NewLine));

// A swap cut off partway: Plinth.dll swapped (its original set aside), coreclr.dll's new
// copy still hopping in beside it, one file added, one retired (#240).
string CutOffSwap(string name)
{
    var install = NewInstall(name);
    Put(Path.Combine(install, "Plinth.dll"), "new");
    Put(Path.Combine(install, "Plinth.dll." + Stamp), "old");
    Put(Path.Combine(install, "coreclr.dll"), "old");
    Put(Path.Combine(install, "coreclr.dll.new-" + Stamp), "new, half copied");
    Put(Path.Combine(install, "Shell", "added.js"), "added");
    Put(Path.Combine(install, "retired.dll." + Stamp), "retired");
    Put(Path.Combine(install, "other.dll.old-9-9"), "another update's");
    Put(Path.Combine(install, "notes.txt.old-backup"), "the user's");
    Put(Path.Combine(install, SwapRestore.JournalName), JournalText(install, Stamp, $"Shell{sep}added.js"));
    return install;
}

if (args.Length == 2 && args[0] == "verify")
    return Verify(Path.GetFullPath(args[1]));

// ---- R1-R4 -----------------------------------------------------------------------------
var install1 = CutOffSwap("cutoff");
var journal1 = Path.Combine(install1, SwapRestore.JournalName);
var journalBefore = File.ReadAllText(journal1);
var r = SwapRestore.Run(journal1, Stamp, updatesDir, log.Add);
Check("R1 a replaced file gets its original back, and the swap's copy of it goes",
    Read(Path.Combine(install1, "Plinth.dll")) == "old"
    && !File.Exists(Path.Combine(install1, "Plinth.dll." + Stamp))
    && !File.Exists(Path.Combine(install1, "Plinth.dll." + Stamp + ".shed")),
    Read(Path.Combine(install1, "Plinth.dll")));
Check("R2 a retired file comes back",
    Read(Path.Combine(install1, "retired.dll")) == "retired" && !File.Exists(Path.Combine(install1, "retired.dll." + Stamp)));
Check("R3 an added file and a half-copied one are removed, and the file it was copied over is untouched",
    !File.Exists(Path.Combine(install1, "Shell", "added.js"))
    && !File.Exists(Path.Combine(install1, "coreclr.dll.new-" + Stamp))
    && Read(Path.Combine(install1, "coreclr.dll")) == "old");
Check("R3b ...and the counts say so, with the journal read as this update's, still open",
    r.Skipped is null && r.Restored == 2 && r.Removed == 2 && r.Failed == 0 && r.Relaunch,
    $"skipped={r.Skipped} restored={r.Restored} removed={r.Removed} failed={r.Failed} relaunch={r.Relaunch}");
Check("R4 the journal is left exactly as it was, for Plinth's recovery to retire",
    File.Exists(journal1) && File.ReadAllText(journal1) == journalBefore);
Check("R4b another update's set-aside file and a user's own backup are left alone",
    Read(Path.Combine(install1, "other.dll.old-9-9")) == "another update's"
    && Read(Path.Combine(install1, "notes.txt.old-backup")) == "the user's");

// ---- R8 (on R1's install) --------------------------------------------------------------
var again = SwapRestore.Run(journal1, Stamp, updatesDir, log.Add);
Check("R8 a second run finds nothing to do",
    again.Skipped is null && again.Restored == 0 && again.Removed == 0 && again.Failed == 0,
    $"restored={again.Restored} removed={again.Removed} failed={again.Failed}");

// ---- R5 --------------------------------------------------------------------------------
void Untouched(string label, string journalText, bool relaunch, string? done = null, string? extra = null)
{
    // Letters and digits only: Windows drops a folder name's trailing dots, so a label
    // ending in ".." would name a folder that is never created.
    var install = NewInstall("skip-" + Regex.Replace(label, "[^A-Za-z0-9]+", "-"));
    Put(Path.Combine(install, "Plinth.dll"), "new");
    Put(Path.Combine(install, "Plinth.dll." + Stamp), "old");
    if (extra is not null) Put(extra, "kept");
    if (done is not null) Put(Path.Combine(install, SwapRestore.DoneName), done);
    var journal = Path.Combine(install, SwapRestore.JournalName);
    Put(journal, journalText.Replace("{install}", install));
    var result = SwapRestore.Run(journal, Stamp, updatesDir, log.Add);
    Check($"R5 {label}: nothing moves",
        result.Skipped is not null && result.Restored == 0 && result.Removed == 0
        && Read(Path.Combine(install, "Plinth.dll")) == "new" && File.Exists(Path.Combine(install, "Plinth.dll." + Stamp))
        && (extra is null || File.Exists(extra)),
        result.Skipped);
    Check($"R5 {label}: Plinth is {(relaunch ? "" : "not ")}started again", result.Relaunch == relaunch);
}
Untouched("a journal naming another folder", JournalText(Path.Combine(tmp, "elsewhere"), Stamp), relaunch: false);
Untouched("another update's journal", JournalText("{install}", "old-7-8"), relaunch: false);
Untouched("a finished update", JournalText("{install}", Stamp), relaunch: false, done: Stamp + Environment.NewLine);
Untouched("a torn header", "{install}" + Environment.NewLine + "old-1", relaunch: true);
var outside = Path.Combine(tmp, "outside.txt");
Untouched("a record naming a file by its full path", JournalText("{install}", Stamp, outside), relaunch: true, extra: outside);
Untouched("a record climbing out with ..", JournalText("{install}", Stamp, $"Shell{sep}..{sep}..{sep}outside.txt"), relaunch: true, extra: outside);
Untouched("a record with a . segment", JournalText("{install}", Stamp, $".{sep}Plinth.exe"), relaunch: true);
var missing = SwapRestore.Run(Path.Combine(tmp, "no-such-install", SwapRestore.JournalName), Stamp, updatesDir, log.Add);
Check("R5 a journal that cannot be read: nothing moves, and nothing is started", missing.Skipped is not null && !missing.Relaunch);

// ---- R6 --------------------------------------------------------------------------------
var install6 = NewInstall("torn-record");
Put(Path.Combine(install6, "a.txt"), "added");
Put(Path.Combine(install6, "b.tx"), "not an addition");
Put(Path.Combine(install6, "b.txt"), "added, record torn");
Put(Path.Combine(install6, SwapRestore.JournalName), JournalText(install6, Stamp, "a.txt") + "b.tx");
var r6 = SwapRestore.Run(Path.Combine(install6, SwapRestore.JournalName), Stamp, updatesDir, log.Add);
Check("R6 a torn last record is not read as the shorter name it looks like, and complete records still count",
    !File.Exists(Path.Combine(install6, "a.txt")) && File.Exists(Path.Combine(install6, "b.tx")) && File.Exists(Path.Combine(install6, "b.txt")),
    $"removed={r6.Removed}");

// ---- R7 --------------------------------------------------------------------------------
var install7 = NewInstall("links");
var linked = Path.Combine(tmp, "linked-target");
Put(Path.Combine(linked, "x.dll." + Stamp), "not the install's");
Directory.CreateSymbolicLink(Path.Combine(install7, "link"), linked);
var inData = Path.Combine(install7, "data", "updates");
Put(Path.Combine(inData, "quarantined.dll." + Stamp), "Plinth's own");
Put(Path.Combine(install7, SwapRestore.JournalName), JournalText(install7, Stamp));
SwapRestore.Run(Path.Combine(install7, SwapRestore.JournalName), Stamp, inData, log.Add);
Check("R7 a linked folder is not walked into",
    File.Exists(Path.Combine(linked, "x.dll." + Stamp)) && !File.Exists(Path.Combine(linked, "x.dll")));
Check("R7b Plinth's updates folder is left out when it sits inside the install",
    File.Exists(Path.Combine(inData, "quarantined.dll." + Stamp)));
var install7c = Path.Combine(tmp, "data", "updates", "unpacked-here");
Directory.CreateDirectory(install7c);
Put(Path.Combine(install7c, "Plinth.dll." + Stamp), "old");
Put(Path.Combine(install7c, SwapRestore.JournalName), JournalText(install7c, Stamp));
SwapRestore.Run(Path.Combine(install7c, SwapRestore.JournalName), Stamp, updatesDir, log.Add);
Check("R7c ...but not when the install itself is inside it, or nothing would be restored",
    Read(Path.Combine(install7c, "Plinth.dll")) == "old");

// ---- C1-C2 -----------------------------------------------------------------------------
var copy = @"C:\Users\u\AppData\Local\Plinth\updates\recover-old-1-2.exe";
var jpath = @"D:\Apps\Plinth\swap-journal.txt";
Check("C1 the sign-in command quotes both paths and ends with the stamp",
    SwapRestore.Command(copy, jpath, Stamp) == $"\"{copy}\" \"{jpath}\" {Stamp}", SwapRestore.Command(copy, jpath, Stamp));
Check("C1b a path with a quote in it is refused", SwapRestore.Command(copy, @"D:\a""b\swap-journal.txt", Stamp) is null);
Check("C1c a path ending in a backslash is refused (it would escape its closing quote)", SwapRestore.Command(copy, @"D:\Apps\", Stamp) is null);
Check("C1d a stamp that is not the updater's shape is refused", SwapRestore.Command(copy, jpath, "old-1") is null);
var fixedLength = $"\"{copy}\" \"\" {Stamp}".Length;
var atLimit = @"D:\" + new string('p', SwapRestore.MaxCommandLength - fixedLength - 3);
Check("C1e a command at Windows' 260-character limit is written, one past it is not",
    SwapRestore.Command(copy, atLimit, Stamp)?.Length == SwapRestore.MaxCommandLength
    && SwapRestore.Command(copy, atLimit + "p", Stamp) is null);
Check("C2 a copy's name gives back its stamp",
    SwapRestore.StampOfCopy(SwapRestore.CopyName("old-123-456")) == "old-123-456");
Check("C2b ...and other names in the updates folder give none",
    SwapRestore.StampOfCopy("recover-old-1.exe") is null && SwapRestore.StampOfCopy("recover-old-1-2.exe.bak") is null
    && SwapRestore.StampOfCopy("Plinth-v1.0.0-win-x64.zip") is null);
Check("C2c each update gets its own sign-in entry", SwapRestore.ValueName("old-1-2") != SwapRestore.ValueName("old-1-3"));

// ---- W1-W11 ----------------------------------------------------------------------------
// Asserted on the source: Apply swaps the running install, and RunOnce is Windows' own.
string? FindUpwards(string rel)
{
    for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        if (File.Exists(Path.Combine(dir.FullName, rel)))
            return Path.Combine(dir.FullName, rel);
    return null;
}
string Source(string rel)
{
    var path = FindUpwards(rel);
    if (path is null) Check($"setup: {rel} found", false);
    return path is null ? "" : File.ReadAllText(path);
}
var updater = Source("src/Plinth/App/UpdateManager.cs");
var helperMain = Source("src/PlinthRecover/Program.cs");
var restore = Source("src/PlinthRecover/SwapRestore.cs");
var plinthMain = Source("src/Plinth/Program.cs");
var plinthProj = Source("src/Plinth/Plinth.csproj");
var helperProj = Source("src/PlinthRecover/PlinthRecover.csproj");

var armAt = updater.IndexOf("ArmRecoveryHelper(baseDir, stamp);", StringComparison.Ordinal);
var journalAt = updater.IndexOf("WriteJournalDurable(baseDir + Environment.NewLine + stamp", StringComparison.Ordinal);
Check("W1 the helper is armed before the journal is written", armAt > 0 && journalAt > armAt);
Check("W1b ...and disarmed if writing the journal fails, since nothing has moved",
    Regex.IsMatch(updater, @"WriteJournalDurable\(baseDir \+ Environment\.NewLine \+ stamp[^;]*;\s*\}\s*catch\s*\{[^{}]*DisarmRecoveryHelper\(stamp\);\s*throw;"));
Check("W2 a committed update disarms it only once the journal is gone",
    Regex.IsMatch(updater, @"if \(journalGone\)\s*\{\s*DisarmRecoveryHelper\(stamp\);"));
Check("W3 a complete rollback disarms it only once the journal is gone",
    Regex.IsMatch(updater, @"File\.Delete\(JournalFile\);[^\n]*\n(\s*//[^\n]*\n)*\s*if \(!File\.Exists\(JournalFile\)\)\s*DisarmRecoveryHelper\(stamp\);"));
Check("W4 startup recovery disarms it after a complete rollback",
    Regex.IsMatch(updater, @"DisarmRecoveryHelper\(stamp\);\s*return \(true, restored > 0, false\);"));
Check("W5 the sign-in entry is flushed to disk before arming returns",
    Regex.IsMatch(updater, @"key\.SetValue\(SwapRestore\.ValueName\(stamp\), command, RegistryValueKind\.String\);[\s\S]{0,300}?key\.Flush\(\);"));
var helperLock = Regex.Match(helperMain, @"InstanceLock = @""([^""]+)""").Groups[1].Value;
var plinthLock = Regex.Match(plinthMain, @"new Mutex\(initiallyOwned: false, @""([^""]+)""\)").Groups[1].Value;
Check("W6 the helper takes the lock Plinth takes, so the two never move files at once",
    helperLock.Length > 0 && helperLock == plinthLock, $"{helperLock} / {plinthLock}");
Check("W6b ...and never waits for it: a running Plinth has done its own recovery",
    helperMain.Contains("mutex.WaitOne(TimeSpan.Zero)"));
Check("W7 the build puts the helper beside Plinth.exe, as content rather than a reference",
    Regex.IsMatch(plinthProj, @"<ProjectReference Include=""\.\.\\PlinthRecover\\PlinthRecover\.csproj""[^>]*ReferenceOutputAssembly=""false""[^>]*OutputItemType=""Content"""));
Check("W7b Plinth compiles the same names the helper reads",
    plinthProj.Contains(@"<Compile Include=""..\PlinthRecover\SwapRestore.cs"""));
Check("W8 the helper is built for the .NET Framework in Windows, not the runtime an update replaces",
    Regex.IsMatch(helperProj, @"<TargetFramework>net4\d+</TargetFramework>"));
var cleanAt = updater.IndexOf("if (!clean)", StringComparison.Ordinal);
var sweepAt = updater.IndexOf("SweepRecoveryHelpers();", StringComparison.Ordinal);
Check("W9 old copies are swept only once no update is left open", cleanAt > 0 && sweepAt > cleanAt);
Check("W10 the helper never writes, moves or deletes the journal",
    helperMain.Contains("File.Exists(journal)") && restore.Contains("File.ReadAllText(journalPath)")
    && !Regex.IsMatch(helperMain + restore, @"(File\.(Delete|Move|Replace|Copy|Write\w*|Append\w*|Open\w*|Create\w*)|new FileStream)\(\s*journal"));
Check("W11 a helper run is logged where the owner already looks",
    helperMain.Contains("\"app.log\""));
// Windows removes a RunOnce entry before running it, so a restore that could not finish
// has to put its own entry back, or a still-broken install gets no second try.
var rearmAt = helperMain.IndexOf("if (result.Failed > 0)", StringComparison.Ordinal);
var relaunchAt = helperMain.IndexOf("Process.Start(", StringComparison.Ordinal);
Check("W12 a restore that could not put every file back registers the helper again, before Plinth starts",
    Regex.IsMatch(helperMain, @"if \(result\.Failed > 0\)\s*Rearm\(journal, args\[1\]\);")
    && rearmAt > 0 && relaunchAt > rearmAt);
Check("W12b ...naming this same copy, flushed, under this update's own entry",
    Regex.IsMatch(helperMain, @"SwapRestore\.Command\(Assembly\.GetEntryAssembly\(\)!\.Location, journal, stamp\)[\s\S]{0,300}?key\.SetValue\(SwapRestore\.ValueName\(stamp\), command, RegistryValueKind\.String\);\s*key\.Flush\(\);"));
Check("W12c ...and a restore that threw counts as one that could not finish",
    helperMain.Contains("new SwapRestore.Result { Relaunch = true, Failed = 1 }"));
Check("W14 disarming keeps the copy when its sign-in entry could not be removed",
    Regex.IsMatch(updater, @"DeleteValue\(SwapRestore\.ValueName\(stamp\), throwOnMissingValue: false\);\s*\}\s*catch \(Exception ex\)\s*\{[\s\S]{0,400}?return;\s*\}\s*try \{ File\.Delete\(Path\.Combine\(UpdatesDir, SwapRestore\.CopyName\(stamp\)\)\); \}"));
Check("W13 the helper's copy is flushed to disk before its entry and the journal are written",
    Regex.IsMatch(updater, @"target\.Flush\(flushToDisk: true\);\s*\}\s*using var key = Registry\.CurrentUser\.CreateSubKey\(SwapRestore\.RunOnceKey\);")
    && !Regex.IsMatch(updater, @"File\.Copy\(shipped, copy"));

try { Directory.Delete(tmp, recursive: true); } catch (Exception) { }
Console.WriteLine(failures == 0 ? "ALL PASS" : $"{failures} FAILED");
return failures == 0 ? 0 : 1;

// ---- verify <publish dir> ---------------------------------------------------------------
int Verify(string dir)
{
    var exe = Path.Combine(dir, SwapRestore.HelperFileName);
    Check("V1 the published folder has the helper", File.Exists(exe), exe);
    if (!File.Exists(exe))
        return 1;
    string[] refs;
    using (var pe = new PEReader(File.OpenRead(exe)))
    {
        var md = pe.GetMetadataReader();
        refs = md.AssemblyReferences.Select(h => md.GetString(md.GetAssemblyReference(h).Name)).ToArray();
    }
    Check("V2 it binds to the .NET Framework in Windows (mscorlib), not the runtime an update replaces",
        refs.Contains("mscorlib") && !refs.Contains("System.Runtime") && !refs.Contains("System.Private.CoreLib"),
        string.Join(", ", refs));

    if (!OperatingSystem.IsWindows())
    {
        Console.WriteLine("  NOTE V3-V5 start the helper, so they run on Windows only");
    }
    else
    {
        // A leftover entry from an earlier run on this machine would pass V4c and V5 falsely.
        ClearEntry();
        // As the updater runs it: a copy outside the install, given the journal and stamp.
        var outsideCopy = Path.Combine(tmp, "updates-copy", SwapRestore.CopyName(Stamp));
        Directory.CreateDirectory(Path.GetDirectoryName(outsideCopy)!);
        File.Copy(exe, outsideCopy, overwrite: true);
        int RunHelper(string journal)
        {
            using var p = Process.Start(new ProcessStartInfo(outsideCopy)
            {
                ArgumentList = { journal, Stamp },
                UseShellExecute = false,
            })!;
            return p.WaitForExit(60_000) ? p.ExitCode : -1;
        }

        var held = CutOffSwap("verify-held");
        using (var plinthLock = new Mutex(true, @"Global\Plinth.SingleInstance", out var created))
        {
            var code = RunHelper(Path.Combine(held, SwapRestore.JournalName));
            Check("V3 while Plinth holds its lock, the helper leaves the install alone",
                created && code == 0 && Read(Path.Combine(held, "Plinth.dll")) == "new"
                && File.Exists(Path.Combine(held, "Plinth.dll." + Stamp)),
                $"exit {code}, lock created here: {created}");
            if (created)
                plinthLock.ReleaseMutex();
        }

        var cut = CutOffSwap("verify-run");
        var journal = Path.Combine(cut, SwapRestore.JournalName);
        var before = File.ReadAllText(journal);
        var exit = RunHelper(journal);
        Check("V4 run from outside the install, the published helper undoes a cut-off swap",
            exit == 0 && Read(Path.Combine(cut, "Plinth.dll")) == "old" && Read(Path.Combine(cut, "retired.dll")) == "retired"
            && !File.Exists(Path.Combine(cut, "Shell", "added.js")) && !File.Exists(Path.Combine(cut, "coreclr.dll.new-" + Stamp)),
            $"exit {exit}, Plinth.dll: {Read(Path.Combine(cut, "Plinth.dll"))}");
        Check("V4b ...and leaves the journal for Plinth's recovery",
            File.Exists(journal) && File.ReadAllText(journal) == before);
        Check("V4c ...and, having put everything back, registers nothing for the next sign-in",
            Entry() is null, Entry());

        // Windows removes the entry before running it; a lock held at sign-in stops one file.
        var blocked = CutOffSwap("verify-blocked");
        var blockedJournal = Path.Combine(blocked, SwapRestore.JournalName);
        int blockedExit;
        using (File.Open(Path.Combine(blocked, "Plinth.dll"), FileMode.Open, FileAccess.Read, FileShare.None))
            blockedExit = RunHelper(blockedJournal);
        var entry = Entry();
        Check("V5 a restore a lock stopped registers the helper again for the next sign-in, naming the same copy",
            blockedExit == 0 && string.Equals(entry, SwapRestore.Command(outsideCopy, blockedJournal, Stamp), StringComparison.OrdinalIgnoreCase),
            entry ?? "<no entry>");
        ClearEntry();
        var secondExit = RunHelper(blockedJournal);
        Check("V5b ...and that next run, with the lock gone, finishes the job and registers nothing",
            secondExit == 0 && Read(Path.Combine(blocked, "Plinth.dll")) == "old" && Entry() is null,
            $"exit {secondExit}, Plinth.dll: {Read(Path.Combine(blocked, "Plinth.dll"))}");
        ClearEntry();

        [System.Runtime.Versioning.SupportedOSPlatform("windows")]
        static string? Entry()
        {
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(SwapRestore.RunOnceKey);
            return key?.GetValue(SwapRestore.ValueName(Stamp)) as string;
        }
        [System.Runtime.Versioning.SupportedOSPlatform("windows")]
        static void ClearEntry()
        {
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(SwapRestore.RunOnceKey, writable: true);
            key?.DeleteValue(SwapRestore.ValueName(Stamp), throwOnMissingValue: false);
        }
    }
    try { Directory.Delete(tmp, recursive: true); } catch (Exception) { }
    Console.WriteLine(failures == 0 ? "ALL PASS" : $"{failures} FAILED");
    return failures == 0 ? 0 : 1;
}
