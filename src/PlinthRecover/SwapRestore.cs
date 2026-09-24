using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;

namespace Plinth.Recover;

/// <summary>
/// Puts an install back the way it was before an update's file swap was cut off (#239).
///
/// <para>Plinth's own startup recovery already does this, but it lives in Plinth.dll: on the
/// self-contained build the swap also replaces the .NET runtime files, and a swap cut off by
/// a power loss can leave a mix of runtimes that fails before any of Plinth's code runs. This
/// runs from PlinthRecover.exe instead, which is built for the .NET Framework that ships with
/// Windows and is started from a copy outside the install, so nothing the swap replaces can
/// stop it.</para>
///
/// <para>It does only the file moves, and only when the journal is unambiguous. The journal
/// itself and all bookkeeping (the sweep marker, retiring the journal, quarantine of a
/// journal that does not parse) stay with Plinth's recovery, which runs next and finds
/// nothing left to restore. Anything unusual is left alone for it.</para>
///
/// <para>Shared by the helper (.NET Framework 4.7.2) and its probe (tools/SwapRecovery, .NET 8),
/// so it uses only what both have: no ranges, no records, no newer string overloads.</para>
/// </summary>
internal static class SwapRestore
{
    public const string JournalName = "swap-journal.txt";
    public const string DoneName = "swap-journal.done";
    public const string HelperFileName = "PlinthRecover.exe";
    public const string RunOnceKey = @"Software\Microsoft\Windows\CurrentVersion\RunOnce";

    /// <summary>Windows documents Run and RunOnce command lines as limited to 260 characters.</summary>
    public const int MaxCommandLength = 260;

    private static readonly Regex StampShape = new Regex(@"^old-\d+-\d+$");

    public static bool IsStamp(string? value) => value != null && StampShape.IsMatch(value);

    /// <summary>One value per transaction, so two installs' updates never share one.</summary>
    public static string ValueName(string stamp) => "Plinth update recovery " + stamp;

    /// <summary>The helper's copy under the updates folder, named for its transaction.</summary>
    public static string CopyName(string stamp) => "recover-" + stamp + ".exe";

    /// <summary>The stamp a helper copy's file name carries, or null when the name is not one.</summary>
    public static string? StampOfCopy(string fileName)
    {
        if (!fileName.StartsWith("recover-", StringComparison.OrdinalIgnoreCase)
            || !fileName.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
            return null;
        var stamp = fileName.Substring("recover-".Length, fileName.Length - "recover-".Length - ".exe".Length);
        return IsStamp(stamp) ? stamp : null;
    }

    /// <summary>The RunOnce command line: the helper copy, the journal, the stamp. Null when it
    /// cannot be written safely: a quote in a path would end its argument early, and a line
    /// over the limit may not run at all. Neither path can end in a backslash (one names an
    /// exe, the other the journal), which is the other way a quoted argument goes wrong.</summary>
    public static string? Command(string helperCopy, string journal, string stamp)
    {
        if (!IsStamp(stamp) || helperCopy.IndexOf('"') >= 0 || journal.IndexOf('"') >= 0
            || helperCopy.EndsWith("\\", StringComparison.Ordinal) || journal.EndsWith("\\", StringComparison.Ordinal))
            return null;
        var command = "\"" + helperCopy + "\" \"" + journal + "\" " + stamp;
        return command.Length <= MaxCommandLength ? command : null;
    }

    public sealed class Result
    {
        public int Restored;
        public int Removed;
        public int Failed;

        /// <summary>Why nothing was moved, or null when the restore ran.</summary>
        public string? Skipped;

        /// <summary>True when the journal is this transaction's and still open, so Plinth
        /// was running an update when it stopped and should be started again.</summary>
        public bool Relaunch;
    }

    /// <summary>Restores the install the journal at <paramref name="journalPath"/> describes,
    /// when that journal is transaction <paramref name="stamp"/>'s and still open. Never
    /// writes, moves or deletes the journal. <paramref name="updatesDir"/> is Plinth's own
    /// updates folder, left out of the walk as Plinth's recovery leaves it out.</summary>
    public static Result Run(string journalPath, string stamp, string updatesDir, Action<string> log)
    {
        var result = new Result();
        string raw;
        try { raw = File.ReadAllText(journalPath); }
        catch (Exception ex)
        {
            result.Skipped = "the journal could not be read: " + ex.Message;
            return result;
        }
        var installDir = Path.GetDirectoryName(Path.GetFullPath(journalPath))!;

        // The same reading as Plinth's recovery. A record proves itself complete by the newline
        // after it, so a torn last record is a prefix of a name and is never acted on.
        var terminated = raw.Length > 0 && raw[raw.Length - 1] == '\n';
        var lines = raw.Replace("\r", "").Split(new[] { '\n' }, StringSplitOptions.RemoveEmptyEntries);
        if (lines.Length < 2 || (lines.Length == 2 && !terminated))
        {
            // Written in full before the first file moves, so a torn header means nothing
            // moved yet. Plinth still has to retire it, so it is started again.
            result.Skipped = "the journal's header is incomplete";
            result.Relaunch = true;
            return result;
        }
        if (!SameDirectory(lines[0], installDir) || lines[1] != stamp)
        {
            result.Skipped = "the journal belongs to another update";
            return result;
        }
        if (Finished(installDir, stamp))
        {
            result.Skipped = "the update already finished";
            return result;
        }
        result.Relaunch = true;

        var root = installDir.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var additions = new List<string>();
        for (var i = 2; i < lines.Length; i++)
        {
            if (i == lines.Length - 1 && !terminated)
            {
                log("The journal's last record is torn; leaving its file rather than deleting by a cut-off name");
                continue;
            }
            var target = Inside(root, installDir, lines[i]);
            if (target == null)
            {
                // Plinth quarantines a journal like this rather than trusting any of it.
                result.Skipped = "a journal record points outside the install";
                return result;
            }
            additions.Add(target);
        }

        // Plinth's recovery order: staged copies that never swapped in, then the originals
        // set aside, then the files the update added.
        var suffix = "." + stamp;
        foreach (var stray in Walk(installDir, "*.new-" + stamp, updatesDir))
        {
            try { File.Delete(stray); result.Removed++; }
            catch (Exception ex) { result.Failed++; log("Could not remove " + stray + ": " + ex.Message); }
        }
        foreach (var aside in Walk(installDir, "*" + suffix, updatesDir))
        {
            if (!aside.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
                continue;
            var target = aside.Substring(0, aside.Length - suffix.Length);
            try
            {
                if (File.Exists(target))
                {
                    // Atomic, as the swap was: the name never stops resolving to a whole file.
                    var shed = aside + ".shed";
                    File.Replace(aside, target, shed);
                    try { File.Delete(shed); } catch (Exception) { /* Plinth's sweep takes it */ }
                }
                else
                {
                    File.Move(aside, target);
                }
                result.Restored++;
            }
            catch (Exception ex)
            {
                result.Failed++;
                log("Could not restore " + target + ": " + ex.Message);
            }
        }
        foreach (var added in additions)
        {
            try
            {
                if (File.Exists(added))
                {
                    File.Delete(added);
                    result.Removed++;
                }
            }
            catch (Exception ex) { result.Failed++; log("Could not remove " + added + ": " + ex.Message); }
        }
        return result;
    }

    /// <summary>Plinth records a finished recovery whose journal would not delete in a done
    /// file naming the stamp. Nothing is pending then.</summary>
    private static bool Finished(string installDir, string stamp)
    {
        try
        {
            var done = Path.Combine(installDir, DoneName);
            return File.Exists(done) && File.ReadAllText(done).Trim() == stamp;
        }
        catch (Exception)
        {
            return false;
        }
    }

    private static bool SameDirectory(string a, string b)
    {
        try
        {
            return string.Equals(
                Path.GetFullPath(a).TrimEnd(Path.DirectorySeparatorChar),
                Path.GetFullPath(b).TrimEnd(Path.DirectorySeparatorChar),
                StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// <summary>The full path an addition record names, or null when the record is not a
    /// plain relative path inside the install: rooted, with a "." or ".." segment, or
    /// resolving outside it. Plinth never writes one of those.</summary>
    private static string? Inside(string root, string installDir, string rel)
    {
        try
        {
            if (Path.IsPathRooted(rel))
                return null;
            foreach (var segment in rel.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar))
                if (segment == "." || segment == "..")
                    return null;
            var full = Path.GetFullPath(Path.Combine(installDir, rel));
            return full.StartsWith(root, StringComparison.OrdinalIgnoreCase) ? full : null;
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>Files matching <paramref name="pattern"/> under <paramref name="dir"/>. Links
    /// are not followed, an unreadable folder is passed over, and Plinth's updates folder is
    /// left out unless the install itself is inside it.</summary>
    private static IEnumerable<string> Walk(string dir, string pattern, string updatesDir)
    {
        var updates = updatesDir.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var install = dir.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var skipUpdates = updatesDir.Length > 0 && !install.StartsWith(updates, StringComparison.OrdinalIgnoreCase);
        var pending = new Stack<string>();
        pending.Push(dir);
        while (pending.Count > 0)
        {
            var current = pending.Pop();
            if (skipUpdates && (current + Path.DirectorySeparatorChar).StartsWith(updates, StringComparison.OrdinalIgnoreCase))
                continue;
            string[] files;
            try { files = Directory.GetFiles(current, pattern); }
            catch (Exception) { files = new string[0]; }
            foreach (var file in files)
                yield return file;
            string[] subs;
            try { subs = Directory.GetDirectories(current); }
            catch (Exception) { continue; }
            foreach (var sub in subs)
            {
                try
                {
                    if ((File.GetAttributes(sub) & FileAttributes.ReparsePoint) != 0)
                        continue;
                }
                catch (Exception) { continue; }
                pending.Push(sub);
            }
        }
    }
}
