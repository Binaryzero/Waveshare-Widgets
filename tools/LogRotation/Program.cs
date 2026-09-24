// Probes for app.log management (#256), run against the real RollingLog source in a
// temp directory. Exit code 0 = all pass.
//
//   L1 · a new session starts a new file: the last run's log becomes app.1.log
//   L2 · sessions shift down the line and only four are kept; the oldest is dropped
//   L3 · a session that outgrows the cap ROLLS: the earlier lines are still in app.1.log,
//        not deleted, and the live file never passes the cap
//   L4 · the whole directory stays bounded, (keep + 1) × cap, however much is written
//   L5 · one enormous line is clipped and says so, rather than filling the file alone
//   L6 · an empty log is not rolled into an empty app.1.log that pushes a real one out
//   L7 · a roll that cannot finish still writes every line, and retrying it does not eat
//        the kept files — a log that loses lines when something holds a file open is worse
//        than one briefly over its cap
//   L8 · a roll blocked on the LIVE file (a viewer holding app.log open without delete
//        sharing) leaves every kept file exactly as it was, however often it is retried
//   L9 · lines written before StartSession (a second launch on its way out, or anything
//        before the single-instance lock) never roll the log
//   L10 · a run that died mid-roll, its log stranded under the staging name, is filed as
//         app.1.log by the next session — not left there for that whole run (#298)
//   L11 · a session roll blocked at startup is retried on later lines, so the run does not
//         stay mixed into the previous one; the new file says where its first lines went
//   L12 · a file that outgrew the cap while a roll was blocked is cut to the cap (keeping
//         its tail) when it is archived, so the directory's bound comes back
//   F1 · falsification — the old logger's rule (one file, delete past the cap) fails L1
//        and L3
using System.Text;
using Plinth;

var failures = 0;
void Check(string name, bool ok, string? detail = null)
{
    Console.WriteLine($"  {(ok ? "PASS" : "FAIL")} {name}{(detail is null ? "" : " - " + detail)}");
    if (!ok) failures++;
}

const long Cap = 4_000;

var made = new List<string>();
string NewDir()
{
    var d = Path.Combine(Path.GetTempPath(), "plinth-logrot-" + Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(d);
    made.Add(d);
    return d;
}

string Read(string p) => File.Exists(p) ? File.ReadAllText(p) : "";

// Runs L1-L3 against a sink and returns which failed, so F1 can ask the old rule to fail
// the right ones.
HashSet<string> Run(Func<string, ISink> make, bool quiet)
{
    var failed = new HashSet<string>();
    void Say(string tag, string name, bool ok, string? detail = null)
    {
        if (!ok) failed.Add(tag);
        if (!quiet) Check($"{tag} {name}", ok, detail);
    }

    // ---- L1 ----------------------------------------------------------------------------
    {
        var dir = NewDir();
        var log = make(Path.Combine(dir, "app.log"));
        log.StartSession("== session A");
        log.Append("A: something happened");
        log.StartSession("== session B");
        log.Append("B: first line");
        var live = Read(Path.Combine(dir, "app.log"));
        var prev = Read(Path.Combine(dir, "app.1.log"));
        Say("L1", "a new session starts a new file; the last run's log becomes app.1.log",
            live.StartsWith("== session B") && !live.Contains("session A") && prev.Contains("A: something happened"),
            $"app.log starts \"{live.Split('\n')[0].Trim()}\", app.1.log has A: {prev.Contains("A: something")}");
    }

    // ---- L3 ----------------------------------------------------------------------------
    {
        var dir = NewDir();
        var log = make(Path.Combine(dir, "app.log"));
        log.StartSession("== session");
        log.Append("EARLY line that a bug report needs");
        var filler = new string('x', 200);
        for (var i = 0; i < 40; i++) log.Append($"line {i} {filler}");   // ~8.5 KB: past the 4 KB cap
        var live = new FileInfo(Path.Combine(dir, "app.log"));
        var all = string.Concat(Directory.GetFiles(dir).Select(File.ReadAllText));
        Say("L3", "past the cap the file rolls: the earlier lines survive in app.1.log, the live file stays under the cap",
            all.Contains("EARLY line") && live.Exists && live.Length <= Cap && all.Contains("line 39"),
            $"early kept: {all.Contains("EARLY line")}, app.log {(live.Exists ? live.Length : 0)} bytes (cap {Cap})");
    }
    return failed;
}

Console.WriteLine("\n== RollingLog (shipped)");
Run(p => new Rolling(new RollingLog(p, Cap, 4)), quiet: false);

// ---- L2 · the line of sessions -------------------------------------------------------
{
    var dir = NewDir();
    var log = new RollingLog(Path.Combine(dir, "app.log"), Cap, 4);
    for (var s = 1; s <= 7; s++) { log.StartSession($"== session {s}"); log.Append($"work of session {s}"); }
    var files = Directory.GetFiles(dir).Select(Path.GetFileName).OrderBy(f => f).ToArray();
    var expect = new[] { "app.1.log", "app.2.log", "app.3.log", "app.4.log", "app.log" };
    var order = Enumerable.Range(0, 5).Select(n => Read(log.PathFor(n)).Split('\n')[0].Trim()).ToArray();
    Check("L2 sessions shift down the line; four are kept and the oldest is dropped",
        files.SequenceEqual(expect)
        && order.SequenceEqual(new[] { "== session 7", "== session 6", "== session 5", "== session 4", "== session 3" }),
        $"{string.Join(", ", files)} :: {string.Join(" | ", order)}");
}

// ---- L4 · bounded, however much is written --------------------------------------------
{
    var dir = NewDir();
    var log = new RollingLog(Path.Combine(dir, "app.log"), Cap, 4);
    log.StartSession("== session");
    var filler = new string('y', 300);
    for (var i = 0; i < 2_000; i++) log.Append($"{i} {filler}");     // ~600 KB against a 20 KB budget
    var total = Directory.GetFiles(dir).Sum(f => new FileInfo(f).Length);
    var count = Directory.GetFiles(dir).Length;
    Check("L4 the directory stays bounded at (keep + 1) x cap however much is written",
        total <= 5 * Cap && count <= 5 && Read(log.PathFor(0)).Contains("1999 "),
        $"{count} files, {total} bytes (budget {5 * Cap}), newest line present: {Read(log.PathFor(0)).Contains("1999 ")}");
}

// ---- L5 · one enormous line ----------------------------------------------------------
{
    var huge = "BEGIN " + new string('z', 200_000);
    var clipped = RollingLog.Clip(huge);
    Check("L5 an enormous line is clipped, and says how much was left out",
        clipped.Length < RollingLog.MaxLineChars + 100 && clipped.StartsWith("BEGIN ")
        && clipped.Contains($"{huge.Length - RollingLog.MaxLineChars} more characters not logged"),
        $"{huge.Length} chars -> {clipped.Length}");
}

// ---- L6 · an empty log is not rolled ---------------------------------------------------
{
    var dir = NewDir();
    var log = new RollingLog(Path.Combine(dir, "app.log"), Cap, 4);
    log.StartSession("== real session");
    log.Append("worth keeping");
    log.StartSession("== next");                    // app.1.log = the real session
    File.WriteAllText(log.PathFor(0), "");          // this run's file emptied (by hand, by a crash)
    log.StartSession("== after");
    Check("L6 an empty log is not rolled into an empty app.1.log that pushes a real one out",
        Read(log.PathFor(1)).Contains("worth keeping") && !File.Exists(log.PathFor(2)),
        $"app.1.log has the real session: {Read(log.PathFor(1)).Contains("worth keeping")}");
}

// ---- L7 · a roll that cannot finish -----------------------------------------------------
// The block here is on the LAST step (nothing can be renamed onto a directory squatting on
// app.1.log), after the live file has already been staged: every retry reaches it again.
{
    var dir = NewDir();
    var log = new RollingLog(Path.Combine(dir, "app.log"), Cap, 4);
    for (var n = 2; n <= 4; n++) File.WriteAllText(log.PathFor(n), $"kept session {n}\n");
    log.StartSession("== session");
    Directory.CreateDirectory(log.PathFor(1));
    var filler = new string('w', 200);
    for (var i = 0; i < 30; i++) log.Append($"line {i} {filler}");
    var all = string.Concat(Directory.GetFiles(dir).Select(File.ReadAllText));
    var kept = Enumerable.Range(2, 3).Select(n => Read(log.PathFor(n)).Trim()).ToArray();
    Check("L7 a roll that cannot finish loses no line, and retrying it deletes no kept file",
        Enumerable.Range(0, 30).All(i => all.Contains($"line {i} "))
        && kept.SequenceEqual(Enumerable.Range(2, 3).Select(n => $"kept session {n}")),
        $"{Enumerable.Range(0, 30).Count(i => all.Contains($"line {i} "))}/30 lines on disk; kept {string.Join(" | ", kept)}");
}

// ---- L8 · a blocked roll leaves the kept files alone ------------------------------------
// On Windows (CI) the block is the real one: app.log held open with read/write sharing but
// not delete, so it cannot be renamed. Elsewhere renames ignore share modes, so the stand-in
// is a directory squatting on the staging name the roll moves the live file to first.
{
    var dir = NewDir();
    var log = new RollingLog(Path.Combine(dir, "app.log"), Cap, 4);
    for (var n = 1; n <= 4; n++) File.WriteAllText(log.PathFor(n), $"kept session {n}\n");
    log.StartSession("== session");
    var filler = new string('v', 200);
    while (new FileInfo(log.PathFor(0)).Length < Cap - 300) log.Append($"fill {filler}");
    FileStream? holder = null;
    if (OperatingSystem.IsWindows())
        holder = new FileStream(log.PathFor(0), FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
    else
        Directory.CreateDirectory(log.PathFor(0) + ".rolling");
    for (var i = 0; i < 12; i++) log.Append($"during {i} {filler}");  // every one past the cap retries the roll
    holder?.Dispose();
    var kept = Enumerable.Range(1, 4).Select(n => Read(log.PathFor(n)).Trim()).ToArray();
    var live = Read(log.PathFor(0));
    Check("L8 a roll blocked on the live file leaves every kept file as it was",
        kept.SequenceEqual(Enumerable.Range(1, 4).Select(n => $"kept session {n}"))
        && Enumerable.Range(0, 12).All(i => live.Contains($"during {i} ")),
        $"{(OperatingSystem.IsWindows() ? "real share-mode lock" : "staging stand-in")}: kept {string.Join(" | ", kept)}; "
        + $"{Enumerable.Range(0, 12).Count(i => live.Contains($"during {i} "))}/12 lines written");
}

// ---- L9 · no roll before the session is ours --------------------------------------------
{
    var dir = NewDir();
    var log = new RollingLog(Path.Combine(dir, "app.log"), Cap, 4);
    File.WriteAllText(log.PathFor(0), new string('r', (int)Cap - 100) + "\n");  // the running instance's log, nearly full
    var filler = new string('u', 200);
    for (var i = 0; i < 5; i++) log.Append($"second launch {i} {filler}");       // no StartSession: not the owner
    var rolledEarly = File.Exists(log.PathFor(1));
    log.StartSession("== owner");
    Check("L9 lines written before StartSession never roll the log",
        !rolledEarly && Read(log.PathFor(1)).Contains("second launch 4 ") && !File.Exists(log.PathFor(2)),
        $"rolled before the session: {rolledEarly}; one roll at StartSession: {File.Exists(log.PathFor(1)) && !File.Exists(log.PathFor(2))}");
}

// ---- L10 · a run that died mid-roll ------------------------------------------------------
{
    var dir = NewDir();
    var log = new RollingLog(Path.Combine(dir, "app.log"), Cap, 4);
    File.WriteAllText(log.PathFor(2), "older run\n");
    File.WriteAllText(log.PathFor(0) + ".rolling", "the run that crashed mid-roll\n");   // and no app.log
    log.StartSession("== next run");
    Check("L10 a log stranded under the staging name is filed as app.1.log at the next session",
        Read(log.PathFor(1)).Contains("crashed mid-roll") && !File.Exists(log.PathFor(0) + ".rolling")
        && Read(log.PathFor(0)).StartsWith("== next run") && Read(log.PathFor(2)).Contains("older run"),
        $"app.1.log has it: {Read(log.PathFor(1)).Contains("crashed mid-roll")}; staging left: {File.Exists(log.PathFor(0) + ".rolling")}");
}

// ---- L11 · a blocked session roll is retried ----------------------------------------------
// The same block as L8: a real share-mode lock on Windows, the staging-name stand-in elsewhere.
{
    var dir = NewDir();
    var log = new RollingLog(Path.Combine(dir, "app.log"), Cap, 4);
    File.WriteAllText(log.PathFor(0), "the previous run\n");
    FileStream? holder = null;
    var standIn = log.PathFor(0) + ".rolling";
    if (OperatingSystem.IsWindows())
        holder = new FileStream(log.PathFor(0), FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
    else
        Directory.CreateDirectory(standIn);
    log.StartSession("== this run");
    log.Append("while still held");
    holder?.Dispose();
    if (!OperatingSystem.IsWindows()) Directory.Delete(standIn);
    log.Append("after release");
    var live = Read(log.PathFor(0));
    var prev = Read(log.PathFor(1));
    Check("L11 a session roll blocked at startup is retried once the file is free",
        prev.Contains("the previous run") && !live.Contains("the previous run")
        && live.Contains("after release") && live.Contains("first lines are at the end of app.1.log"),
        $"{(OperatingSystem.IsWindows() ? "real share-mode lock" : "staging stand-in")}: "
        + $"app.log free of the last run: {!live.Contains("the previous run")}; continued note: {live.Contains("first lines are at the end")}");
}

// ---- L12 · an oversized file is cut when it is archived ----------------------------------
{
    var dir = NewDir();
    var log = new RollingLog(Path.Combine(dir, "app.log"), Cap, 4);
    var big = new StringBuilder();
    big.Append("FIRST line of an overgrown file\n");
    for (var i = 0; big.Length < 3 * Cap; i++) big.Append($"grown {i} {new string('g', 100)}\n");
    big.Append("LAST line before the roll\n");
    File.WriteAllText(log.PathFor(0), big.ToString());     // grew to 3x the cap under a long block
    log.StartSession("== next run");
    var archived = new FileInfo(log.PathFor(1));
    var text = Read(log.PathFor(1));
    Check("L12 a file that outgrew the cap is cut to it, keeping the tail, when archived",
        archived.Length <= Cap && text.Contains("LAST line before the roll") && !text.Contains("FIRST line")
        && text.StartsWith("… [") && text.Contains("bytes dropped from the start"),
        $"{big.Length} bytes -> {archived.Length} (cap {Cap}); tail kept: {text.Contains("LAST line")}");
}

// ---- F1 · the old logger's rule --------------------------------------------------------
// Log.cs before #256, verbatim in substance: one file for every session, and past the cap
// the file is deleted before the next line.
Console.WriteLine("\n== F1 falsification: the pre-#256 logger");
var legacyFailed = Run(p => new Legacy(p, Cap), quiet: true);
Check("F1 the old rule (one file, delete past the cap) fails L1 and L3",
    legacyFailed.Contains("L1") && legacyFailed.Contains("L3"),
    $"failed: {string.Join(", ", legacyFailed.OrderBy(x => x))}");

foreach (var d in made) { try { Directory.Delete(d, recursive: true); } catch { /* temp; best effort */ } }

Console.WriteLine(failures == 0 ? "\nALL PASS" : $"\n{failures} FAILURES");
return failures == 0 ? 0 : 1;

interface ISink
{
    void StartSession(string header);
    void Append(string line);
}

sealed class Rolling(RollingLog log) : ISink
{
    public void StartSession(string header) => log.StartSession(header);
    public void Append(string line) => log.Append(line);
}

sealed class Legacy(string path, long cap) : ISink
{
    public void StartSession(string header) => Append(header);   // there was no session
    public void Append(string line)
    {
        if (File.Exists(path) && new FileInfo(path).Length > cap) File.Delete(path);
        File.AppendAllText(path, line + Environment.NewLine);
    }
}
