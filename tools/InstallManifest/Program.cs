// Update retirements (issue #240).
//
// M1-M2   the list round-trips, and a torn last line is dropped rather than trusted
// M3-M4   a file the previous release shipped and this one lacks is retired; one both ship
//         is kept, whatever the case of its name
// M5      nothing is retired on the first update (no previous list)
// M6      paths that are never the release's to remove are never retired
// M7      the wiring: the list rides the journaled swap, retirements join its rollback
// M8      a file of the same name that this updater did not write is not trusted
// M9      release zips carry the list, so an extracted install can retire from its first update
using Plinth;

// `verify <dir>`: the list tools/write-install-manifest.ps1 wrote into a publish folder
// reads back, through the updater's own parser, as exactly the files in that folder.
// build.yml runs it on the Windows agent, where the script can run.
if (args.Length == 2 && args[0] == "verify")
{
    var dir = Path.GetFullPath(args[1]);
    var listed = InstallManifest.Parse(File.ReadAllText(Path.Combine(dir, InstallManifest.FileName)));
    var actual = Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories)
        .Select(f => Path.GetRelativePath(dir, f))
        .Where(r => !r.Equals(InstallManifest.FileName, StringComparison.OrdinalIgnoreCase))
        .ToHashSet(StringComparer.OrdinalIgnoreCase);
    var missing = actual.Where(f => !listed.Contains(f, StringComparer.OrdinalIgnoreCase)).ToList();
    var extra = listed.Where(f => !actual.Contains(f)).ToList();
    Console.WriteLine($"  {listed.Count} listed, {actual.Count} on disk");
    foreach (var f in missing.Take(10)) Console.WriteLine($"  FAIL not listed: {f}");
    foreach (var f in extra.Take(10)) Console.WriteLine($"  FAIL listed but absent: {f}");
    var good = listed.Count > 0 && missing.Count == 0 && extra.Count == 0;
    Console.WriteLine(good ? "install manifest matches the folder" : "install manifest does NOT match the folder");
    return good ? 0 : 1;
}

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
    // Names no Windows file can have. The NUL is the one that mattered: Path.GetFullPath
    // throws on it inside the swap, and the rollback restores the same list.
    "bad\0name.dll", "tab\tname.dll", "a|b.dll", "q?.dll", "star*.dll", "\"quoted\".dll", "<x>.dll",
];
var hostileRetire = InstallManifest.Retirements(hostile, next, Control);
Check("M6 rooted, UNC, dot-segment, stream, invalid-character, control-file, manifest and blank paths are never retired",
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
    // An archive may carry a list (release zips do, M9) but is never trusted for it: the
    // staged copy is overwritten with the list computed from what was actually shipped.
    var writeAt = code.IndexOf("File.WriteAllText(Path.Combine(staging, InstallManifest.FileName), InstallManifest.Serialize(shipped));", StringComparison.Ordinal);
    var shippedAt = code.IndexOf("var shipped = Directory.EnumerateFiles(staging", StringComparison.Ordinal);
    Check("M7c an archive's own list is overwritten with one computed from what it ships",
        shippedAt > 0 && writeAt > shippedAt
        && System.Text.RegularExpressions.Regex.IsMatch(code, @"var shipped = Directory\.EnumerateFiles\(staging[\s\S]{0,300}!rel\.Equals\(InstallManifest\.FileName"));
    Check("M7d a listed name the path API refuses is skipped, not thrown mid-swap",
        System.Text.RegularExpressions.Regex.IsMatch(code,
            @"try \{ target = Path\.GetFullPath\(Path\.Combine\(baseDir, rel\)\); \}\s*catch \(Exception ex\) when \(ex is ArgumentException"));
}

// ---- M8 --------------------------------------------------------------------------------
// Releases before this one never wrote the list, so a file by that name on the first
// update is someone else's — and reading it as the release's files would delete theirs.
Check("M8 the list starts with the header", InstallManifest.Serialize(["a.dll"]).StartsWith(InstallManifest.Header + "\n"));
Check("M8b a same-named file without the header is not read as a list",
    InstallManifest.Parse("my-notes.txt\nPlinth.dll\nsaves\\game.sav\n").Count == 0);
Check("M8c ...nor one whose first line only resembles it",
    InstallManifest.Parse(InstallManifest.Header + " \nPlinth.dll\n").Count == 0
    && InstallManifest.Parse(" " + InstallManifest.Header + "\nPlinth.dll\n").Count == 0);
Check("M8d a header alone is an empty list", InstallManifest.Parse(InstallManifest.Header + "\n").Count == 0);
Check("M8e a list torn inside its header is not read", InstallManifest.Parse(InstallManifest.Header[..10]).Count == 0);
var headed = InstallManifest.Retirements(InstallManifest.Parse("Plinth.dll\nuser-file.dat\n"), next, Control);
Check("M8f so on the first update a stray file of that name retires nothing", headed.Count == 0, Show(headed));
Check("M8g a byte-order mark in front of the header is tolerated",
    InstallManifest.Parse("\uFEFF" + InstallManifest.Serialize(["a.dll"])).SequenceEqual(["a.dll"]));

// ---- M9 --------------------------------------------------------------------------------
// A copy installed by extracting a release zip has no list unless the zip carries one, and
// then the first in-app update cannot retire anything. The release workflow writes it.
var release = FindUpwards(".github/workflows/release.yml");
var releaseYml = release is null ? "" : File.ReadAllText(release);
var script = FindUpwards("tools/write-install-manifest.ps1");
var scriptText = script is null ? "" : File.ReadAllText(script);
var manifestStep = releaseYml.IndexOf("./tools/write-install-manifest.ps1 publish/fdd publish/scd", StringComparison.Ordinal);
var packageStep = releaseYml.IndexOf("- name: Package", StringComparison.Ordinal);
Check("M9 both release zips get the list, written before they are packed",
    manifestStep > 0 && packageStep > manifestStep);
Check("M9b ...with the header the updater requires, character for character",
    scriptText.Contains("\"" + InstallManifest.Header + "`n\"", StringComparison.Ordinal));
Check("M9c ...and without listing itself",
    scriptText.Contains("Where-Object { $_ -ne '" + InstallManifest.FileName + "' }", StringComparison.Ordinal));
// The script's own output is checked end to end by `verify`, on the Windows agent.

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
