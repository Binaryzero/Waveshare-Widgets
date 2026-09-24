// Update retirements (issue #240).
//
// M1-M2   the list round-trips, and a torn last line is dropped rather than trusted
// M3-M4   a file the previous release shipped and this one lacks is retired; one both ship
//         is kept, whatever the case of its name
// M5      nothing is retired on the first update (no previous list)
// M6      paths that are never the release's to remove are never retired
// M7      the wiring: the list rides the journaled swap, retirements join its rollback
using Plinth;

var failures = 0;
void Check(string name, bool ok, string? detail = null)
{
    Console.WriteLine($"  {(ok ? "PASS" : "FAIL")} {name}{(detail is null ? "" : " - " + detail)}");
    if (!ok) failures++;
}
static bool Control(string rel) => rel.Equals("swap-journal.txt", StringComparison.OrdinalIgnoreCase)
    || rel.Equals("swap-journal.done", StringComparison.OrdinalIgnoreCase);
string Show(IEnumerable<string> xs) => "[" + string.Join(", ", xs) + "]";

// ---- M1-M2 ----------------------------------------------------------------------------
string[] files = ["Plinth.exe", "Plinth.dll", @"Shell\shell.js", @"runtimes\win\lib\old.dll"];
var text = InstallManifest.Serialize(files);
Check("M1 the list round-trips", InstallManifest.Parse(text).Order().SequenceEqual(files.Order()), Show(InstallManifest.Parse(text)));
var torn = text + @"Shell\shel";
Check("M2 a torn last line is dropped, not read as a shorter name",
    !InstallManifest.Parse(torn).Contains(@"Shell\shel") && InstallManifest.Parse(torn).Count == files.Length,
    Show(InstallManifest.Parse(torn)));

// ---- M3-M5 ----------------------------------------------------------------------------
string[] next = ["Plinth.exe", "PLINTH.DLL", @"shell\SHELL.js", "New.dll"];
var retire = InstallManifest.Retirements(files, next, Control);
Check("M3 a file the previous release shipped and this one lacks is retired",
    retire.SequenceEqual([@"runtimes\win\lib\old.dll"]), Show(retire));
Check("M4 a file both releases ship is kept, whatever its case",
    !retire.Any(r => r.Equals("Plinth.dll", StringComparison.OrdinalIgnoreCase)
        || r.Equals(@"Shell\shell.js", StringComparison.OrdinalIgnoreCase)), Show(retire));
Check("M5 the first update after this shipped retires nothing",
    InstallManifest.Retirements(InstallManifest.Parse(null), next, Control).Count == 0);

// ---- M6 --------------------------------------------------------------------------------
string[] hostile =
[
    @"C:\Windows\System32\drivers\etc\hosts", @"\\server\share\x.dll", @"\rooted.dll", "/rooted.dll",
    @"sub\..\Plinth.exe", @".\Plinth.exe", @"file.dll:stream", "swap-journal.txt", "SWAP-JOURNAL.DONE",
    InstallManifest.FileName, "", "   ",
];
var hostileRetire = InstallManifest.Retirements(hostile, next, Control);
Check("M6 rooted, UNC, dot-segment, stream, control-file, manifest and blank paths are never retired",
    hostileRetire.Count == 0, Show(hostileRetire));
var dupes = InstallManifest.Retirements(["a.dll", "A.DLL", "a.dll"], next, Control);
Check("M6b a name listed twice is retired once", dupes.Count == 1, Show(dupes));

// ---- M7 --------------------------------------------------------------------------------
// The retirement is only as safe as the transaction it rides. Asserted on the source,
// because Apply swaps the running install and cannot run here.
var updater = FindUpwards("src/Plinth/App/UpdateManager.cs");
if (updater is null)
    Check("M7 setup: UpdateManager.cs found", false);
else
{
    var code = File.ReadAllText(updater);
    var manifestAt = code.IndexOf("Path.Combine(staging, InstallManifest.FileName)", StringComparison.Ordinal);
    var journalAt = code.IndexOf("WriteJournalDurable(baseDir + Environment.NewLine + stamp", StringComparison.Ordinal);
    Check("M7 the new list is written into staging before the journal opens, so the swap places it",
        manifestAt > 0 && journalAt > manifestAt);
    Check("M7b a retired file is renamed aside under the stamp and joins the rollback list",
        System.Text.RegularExpressions.Regex.IsMatch(code,
            @"var aside = \$""\{target\}\.\{stamp\}"";\s*File\.Move\(target, aside\);\s*renamed\.Add\(\(target, aside\)\);"));
    Check("M7c an archive that ships its own list is refused",
        code.Contains("entry.FullName.Equals(InstallManifest.FileName, StringComparison.OrdinalIgnoreCase)"));
}

Console.WriteLine(failures > 0 ? $"{failures} FAILURES" : "ALL PASS");
return failures > 0 ? 1 : 0;

static string? FindUpwards(string relative)
{
    var dir = new DirectoryInfo(AppContext.BaseDirectory);
    while (dir is not null)
    {
        var candidate = Path.Combine(dir.FullName, relative.Replace('/', Path.DirectorySeparatorChar));
        if (File.Exists(candidate)) return candidate;
        dir = dir.Parent;
    }
    return null;
}
